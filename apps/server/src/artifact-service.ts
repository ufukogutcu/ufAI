import { randomUUID, createHash } from "node:crypto";
import {
  open,
  lstat,
  mkdir,
  link,
  rm,
  readdir,
  opendir,
  copyFile,
} from "node:fs/promises";
import { constants, type ReadStream } from "node:fs";
import { join, basename, dirname, extname, resolve, relative, sep } from "node:path";
import type Database from "better-sqlite3";
import type { ArtifactVersion } from "./contracts.js";
import type { ManagedFiles } from "./managed-files.js";
import type { ToolOwner } from "./process-service.js";
import { managedDirectory, managedFile } from "./host-paths.js";
import { ConnectionError } from "./model-providers.js";
export interface ArtifactOptions {
  maxVersionBytes?: number;
  maxStorageBytes?: number;
  maxIngests?: number;
}
const time = () => new Date().toISOString();
const limit = (option: number | undefined, env: string, fallback: number) => {
  const n = option ?? Number(process.env[env] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${env}.`);
  return n;
};
export type ArtifactOwner = {
  workspaceId: string;
  agentId?: string;
  taskId?: string;
  turnId?: string;
};
// A task can reopen its own attachments and the exact files delivered to it.
const taskAttachmentAccess = `(
  v.producerTaskId=@taskId
  OR EXISTS(SELECT 1 FROM artifact_grants g WHERE g.versionId=v.id AND g.taskId=@taskId)
  OR EXISTS(SELECT 1 FROM artifact_references r JOIN agent_messages m ON m.id=r.messageId
    JOIN agent_tasks t ON t.conversationId=m.conversationId WHERE r.versionId=v.id AND t.id=@taskId)
)`;

export function requireTaskAttachment(db: Database.Database, owner: Pick<ToolOwner, "workspaceId" | "taskId">, id: string) {
  const v = db.prepare(`SELECT v.*, ${taskAttachmentAccess} AS accessible FROM artifact_versions v WHERE v.id=@id`)
    .get({ taskId: owner.taskId, id }) as (ArtifactVersion & { accessible: number; ingestId: string | null }) | undefined;
  if (!v || v.workspaceId !== owner.workspaceId)
    throw new ConnectionError("Attachment is outside this workspace.", 403);
  if (v.state !== "ready" || v.ingestId)
    throw new ConnectionError("Attachment bytes are unavailable.", 409);
  if (!v.accessible)
    throw new ConnectionError("This private file has not been shared with this task.", 403);
  const { accessible: _accessible, ingestId: _ingestId, ...version } = v;
  return version;
}

async function entryInfo(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

async function importDirectory(parent: string, name: string) {
  for (let index = 1; ; index++) {
    const path = join(parent, index === 1 ? name : `${name} ${index}`);
    try { await mkdir(path, { mode: 0o700 }); return path; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await entryInfo(path))?.isDirectory()) return path;
    }
  }
}

function importedFilename(version: ArtifactVersion, index: number) {
  const name = version.name.replace(/[\x00-\x1f\x7f/\\<>:"|?*]/g, "_").replace(/[. ]+$/g, "") || "File";
  const extension = extname(name);
  const keepExtension = Buffer.byteLength(extension) <= 32 ? extension : "";
  const stem = keepExtension ? name.slice(0, -keepExtension.length) : name;
  // 40 code points leave room for the full version ID and extension even with four-byte UTF-8.
  const short = Array.from(stem).slice(0, 40).join("");
  return `${short} [${version.id}${index > 1 ? `-${index}` : ""}]${keepExtension}`;
}

async function hasAttachmentBytes(path: string, version: ArtifactVersion) {
  const info = await managedFile(path);
  if (info.size !== version.size) return false;
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return false;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    let total = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > version.size) return false;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return total === version.size && hash.digest("hex") === version.sha256;
  } finally {
    await input.close();
  }
}

type LegacyImport = ArtifactVersion & { destination: string | null; stagingName: string | null };

export class ArtifactService {
  private pending = new Map<
    string,
    { owner: ArtifactOwner; promise: Promise<ArtifactVersion> }
  >();
  private stopped = false;
  private byteReads = 0;
  private downloads = new Map<ReadStream, string>();
  readonly maxVersionBytes: number;
  readonly maxStorageBytes: number;
  readonly maxIngests: number;
  constructor(
    readonly db: Database.Database,
    private files: ManagedFiles,
    private changed: (workspaceId: string) => void,
    options: ArtifactOptions = {},
  ) {
    this.maxVersionBytes = limit(
      options.maxVersionBytes,
      "UFAI_ARTIFACT_MAX_BYTES",
      256 * 1024 * 1024,
    );
    this.maxStorageBytes = limit(
      options.maxStorageBytes,
      "UFAI_ARTIFACT_STORAGE_BYTES",
      10 * 1024 * 1024 * 1024,
    );
    this.maxIngests = limit(options.maxIngests, "UFAI_ARTIFACT_INGESTS", 2);
  }
  private directory(workspaceId: string) {
    if (!/^[\w-]{1,100}$/.test(workspaceId))
      throw new ConnectionError("Invalid workspace.", 400);
    return join(this.files.root, "workspaces", workspaceId, "artifacts");
  }
  private path(v: ArtifactVersion) {
    return join(this.directory(v.workspaceId), v.id, "bytes");
  }
  async start() {
    let cursor = "";
    while (true) {
      const abandoned = this.db
        .prepare(
          "SELECT id FROM submission_ingests WHERE state!='committed' AND id>? ORDER BY id LIMIT 32",
        )
        .all(cursor) as { id: string }[];
      if (!abandoned.length) break;
      for (const row of abandoned) await this.discardIngest(row.id);
      cursor = abandoned.at(-1)!.id;
      await new Promise<void>((r) => setImmediate(r));
    }
    const staging = this.db
      .prepare(
        "SELECT v.* FROM artifact_versions v WHERE v.state='staging' AND NOT EXISTS(SELECT 1 FROM deletion_operations d WHERE d.workspaceId=v.workspaceId AND d.kind='workspace' AND d.state!='completed')",
      )
      .all() as ArtifactVersion[];
    for (const v of staging) {
      try {
        await managedDirectory(this.directory(v.workspaceId));
        await rm(join(this.directory(v.workspaceId), `.staging-${v.id}`), {
          force: true,
        });
        await managedDirectory(join(this.directory(v.workspaceId), v.id));
        await rm(this.path(v), { force: true });
      } catch {}
      this.db
        .prepare(
          "UPDATE artifact_versions SET state='failed',error='Attachment creation was interrupted. Attach the file again.' WHERE id=?",
        )
        .run(v.id);
    }
    // Bounded batches verify availability without loading file contents.
    let offset = 0;
    while (true) {
      const rows = this.db
        .prepare(
          "SELECT v.* FROM artifact_versions v WHERE v.state='ready' AND NOT EXISTS(SELECT 1 FROM deletion_operations d WHERE d.workspaceId=v.workspaceId AND d.kind='workspace' AND d.state!='completed') ORDER BY v.id LIMIT 32 OFFSET ?",
        )
        .all(offset) as ArtifactVersion[];
      if (!rows.length) break;
      for (const v of rows) await this.check(v);
      offset += rows.filter((v) => this.get(v.id).state === "ready").length;
      await new Promise<void>((r) => setImmediate(r));
    }
    // Paginate workspace enumeration; do not retain SQLite iterators over filesystem awaits.
    let workspaceOffset = 0;
    while (true) {
      const workspaces = this.db
        .prepare(
          "SELECT w.id FROM workspaces w WHERE NOT EXISTS(SELECT 1 FROM deletion_operations d WHERE d.workspaceId=w.id AND d.kind='workspace' AND d.state!='completed') ORDER BY w.id LIMIT 32 OFFSET ?",
        )
        .all(workspaceOffset) as { id: string }[];
      if (!workspaces.length) break;
      for (const w of workspaces) {
        try {
          const root = this.directory(w.id);
          await managedDirectory(root);
          for await (const entry of await opendir(root)) {
            const name = entry.name;
            if (/^\.staging-[\w-]+$/.test(name))
              await rm(join(root, name), { force: true });
            else if (
              /^[0-9a-f-]{36}$/.test(name) &&
              !this.db
                .prepare(
                  "SELECT id FROM artifact_versions WHERE id=? AND workspaceId=?",
                )
                .get(name, w.id)
            ) {
              await managedDirectory(join(root, name));
              await rm(join(root, name), { recursive: true, force: true });
            }
          }
        } catch {}
      }
      workspaceOffset += workspaces.length;
    }
    await this.importLegacyFiles();
  }

  private async importLegacyFiles() {
    const pending = this.db.prepare(`SELECT v.*,i.destination,i.stagingName
      FROM workspace_file_imports i JOIN artifact_versions v ON v.id=i.versionId
      WHERE i.finished=0 AND NOT EXISTS(SELECT 1 FROM deletion_operations d
        WHERE d.kind='workspace' AND d.ownerId=v.workspaceId AND d.state!='completed')
      ORDER BY i.versionId LIMIT 16`);
    const finish = this.db.prepare("UPDATE workspace_file_imports SET finished=1,stagingName=NULL WHERE versionId=?");
    while (true) {
      const batch = pending.all() as LegacyImport[];
      if (!batch.length) return;
      for (const row of batch) {
        try {
          const unavailable = row.state !== "ready" || (await this.check(row, true)).state !== "ready";
          if (!unavailable || row.stagingName)
            await this.importLegacyFile(row, unavailable);
          finish.run(row.id);
        } catch (error) {
          if (!this.db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(row.workspaceId) ||
              this.db.prepare("SELECT 1 FROM deletion_operations WHERE kind='workspace' AND ownerId=? AND state!='completed'").get(row.workspaceId))
            continue;
          throw new Error(`Could not import files for workspace ${row.workspaceId}. Check workspace folder permissions and free space, then restart ufAI.`, { cause: error });
        }
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  private async importLegacyFile(row: LegacyImport, unavailable: boolean) {
    const location = await this.files.repair("workspace", row.workspaceId);
    if (location.state !== "ready") throw new Error("Workspace Folder could not be opened.");
    await this.files.verifyDirectory("workspace", row.workspaceId);
    let directory: string;
    if (row.destination) {
      directory = dirname(join(location.path, row.destination));
      await managedDirectory(directory, !unavailable);
    } else {
      const imports = await importDirectory(location.path, "Imported files");
      const month = /^\d{4}-(0[1-9]|1[0-2])/.exec(row.createdAt)?.[0] ?? "Undated";
      const year = month.slice(0, 4);
      directory = month === "Undated" ? await importDirectory(imports, month) :
        await importDirectory(await importDirectory(imports, year), month.slice(5));
    }

    const stagingName = row.stagingName ?? `.ufai-import-${randomUUID()}`;
    const stage = join(directory, stagingName);
    if (unavailable) {
      await rm(stage, { force: true });
      return;
    }
    const reserve = this.db.prepare("UPDATE workspace_file_imports SET destination=?,stagingName=? WHERE versionId=?");
    let target = row.destination ? join(location.path, row.destination) : "";
    for (let index = 1; ; index++) {
      if (!target) target = join(directory, importedFilename(row, index));
      const info = await entryInfo(target);
      if (!info) break;
      if (row.destination === relative(location.path, target) && info.isFile() && await hasAttachmentBytes(target, row)) {
        if (row.stagingName) await rm(stage, { force: true });
        return;
      }
      target = "";
    }

    reserve.run(relative(location.path, target), stagingName, row.id);
    if (row.stagingName) await rm(stage, { force: true });
    try {
      await copyFile(this.path(row), stage, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        reserve.run(relative(location.path, target), null, row.id);
      throw error;
    }
    try {
      if (!await hasAttachmentBytes(stage, row))
        throw new Error("Imported copy did not match the stored attachment.");
      const file = await open(stage, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await file.sync(); } finally { await file.close(); }
      await this.files.verifyDirectory("workspace", row.workspaceId);
      await managedDirectory(directory);
      this.files.assertAvailable(row.workspaceId);
      // Link the completed temporary copy, so the live file appears in one step.
      await link(stage, target);
    } finally {
      await rm(stage, { force: true });
    }
  }

  get(id: string) {
    const v = this.db
      .prepare("SELECT * FROM artifact_versions WHERE id=?")
      .get(id) as ArtifactVersion | undefined;
    if (!v) throw new ConnectionError("Artifact version not found.", 404);
    return v;
  }
  listAttachments(owner: ToolOwner, limit: number, offset: number, taskOnly = false) {
    return this.db.prepare(`SELECT v.* FROM artifact_versions v WHERE v.workspaceId=@workspaceId
      AND v.ingestId IS NULL AND v.state='ready' AND ${taskAttachmentAccess}
      AND (@taskOnly=0 OR v.producerTaskId=@taskId)
      ORDER BY v.createdAt DESC,v.id LIMIT @limit OFFSET @offset`)
      .all({ taskId: owner.taskId, workspaceId: owner.workspaceId, taskOnly: Number(taskOnly), limit, offset });
  }
  private async check(v: ArtifactVersion, checksum = false) {
    try {
      if (checksum ? !await hasAttachmentBytes(this.path(v), v) : (await managedFile(this.path(v))).size !== v.size)
        throw new Error();
    } catch {
      this.db
        .prepare(
          "UPDATE artifact_versions SET state='unavailable',error='Attachment bytes are missing or unavailable.' WHERE id=? AND state='ready'",
        )
        .run(v.id);
      this.changed(v.workspaceId);
    }
    return this.get(v.id);
  }
  createAttachment(
    owner: ArtifactOwner,
    args: Record<string, any>,
    signal: AbortSignal,
  ) {
    if (this.stopped)
      throw new ConnectionError("Artifact service is shutting down.", 503);
    if (this.pending.size >= this.maxIngests)
      throw new ConnectionError(
        "Attachment storage is busy. Retry shortly.",
        429,
      );
    const token = randomUUID(),
      promise = this.ingest(owner, args, signal);
    this.pending.set(token, { owner, promise });
    void promise.then(
      () => this.pending.delete(token),
      () => this.pending.delete(token),
    );
    return promise;
  }
  private async ingest(
    owner: ArtifactOwner,
    args: Record<string, any>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await this.files.verifyRoot();
    this.files.assertAvailable(owner.workspaceId, owner.agentId);
    const source = args.stream
      ? null
      : resolve(
          owner.taskId
            ? this.files.location("task", owner.taskId).path
            : this.files.root,
          args.path,
        );
    const info = source ? await lstat(source) : null;
    if (info && (!info.isFile() || info.isSymbolicLink()))
      throw new ConnectionError(
        "Use a regular file, not a directory, link, or device.",
        400,
      );
    const expectedSize = info?.size ?? args.size;
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > this.maxVersionBytes
    )
      throw new ConnectionError("File exceeds the artifact size limit.", 413);
    const name =
      (args.name ?? basename(source ?? "file"))
        .replace(/[\x00-\x1f\x7f/\\<>:"|?*]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 240) || "file";
    const id = randomUUID(),
      artifactId = args.artifactId ?? randomUUID();
    if (args.artifactId) {
      const artifact = this.db
        .prepare("SELECT workspaceId FROM artifacts WHERE id=?")
        .get(artifactId) as { workspaceId: string } | undefined;
      if (artifact?.workspaceId !== owner.workspaceId)
        throw new ConnectionError("Artifact is outside this workspace.", 403);
    }
    if (
      args.sourceVersionId &&
      this.get(args.sourceVersionId).workspaceId !== owner.workspaceId
    )
      throw new ConnectionError(
        "Source version is outside this workspace.",
        403,
      );
    this.db.transaction(() => {
      this.files.assertAvailable(owner.workspaceId, owner.agentId);
      signal.throwIfAborted();
      const used = this.db
        .prepare(
          "SELECT coalesce(sum(size),0) AS n FROM artifact_versions WHERE state IN ('ready','staging','unavailable')",
        )
        .get() as { n: number };
      if (used.n + expectedSize > this.maxStorageBytes)
        throw new ConnectionError("Artifact storage limit reached.", 413);
      if (!args.artifactId)
        this.db
          .prepare("INSERT INTO artifacts VALUES (?,?,?,?)")
          .run(artifactId, owner.workspaceId, name, time());
      this.db
        .prepare(
          "INSERT INTO artifact_versions(id,artifactId,workspaceId,producerAgentId,producerTaskId,provenance,sourceVersionId,name,mediaType,size,state,createdAt,origin,ingestId) VALUES (?,?,?,?,?,?,?,?,?,?,'staging',?,?,?)",
        )
        .run(
          id,
          artifactId,
          owner.workspaceId,
          owner.agentId ?? null,
          owner.taskId ?? null,
          JSON.stringify(owner),
          args.sourceVersionId ?? null,
          name,
          "application/octet-stream",
          expectedSize,
          time(),
          args.origin ?? "attachment",
          args.ingestId ?? null,
        );
    })();
    const directory = this.directory(owner.workspaceId),
      staged = join(directory, `.staging-${id}`);
    try {
      await managedDirectory(directory, true);
      await managedDirectory(join(directory, id), true);
      const input = source
        ? await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
        : null;
      const output = await open(staged, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0,
        head = Buffer.alloc(0);
      try {
        if (input && info) {
          const before = await input.stat();
          if (
            !before.isFile() ||
            before.ino !== info.ino ||
            before.dev !== info.dev
          )
            throw new ConnectionError("Changed source.", 409);
        }
        const chunks: AsyncIterable<Buffer> = input
          ? input.createReadStream({ autoClose: false, highWaterMark: 65536 })
          : args.stream;
        for await (const chunk of chunks) {
          signal.throwIfAborted();
          this.files.assertAvailable(owner.workspaceId, owner.agentId);
          size += chunk.length;
          if (size > expectedSize || size > this.maxVersionBytes)
            throw new ConnectionError(
              "File changed or exceeded its size limit.",
              413,
            );
          if (!head.length) head = Buffer.from(chunk.subarray(0, 512));
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length)
            offset += (await output.write(chunk, offset, chunk.length - offset))
              .bytesWritten;
        }
        if (size !== expectedSize)
          throw new ConnectionError("File transfer was incomplete.", 409);
        if (input && info) {
          const after = await input.stat();
          if (
            after.size !== size ||
            after.mtimeMs !== info.mtimeMs ||
            after.ctimeMs !== info.ctimeMs
          )
            throw new ConnectionError("Source changed while copying.", 409);
        }
        await output.sync();
      } finally {
        await Promise.all([input?.close(), output.close()]);
      }
      signal.throwIfAborted();
      this.files.assertAvailable(owner.workspaceId, owner.agentId);
      await managedDirectory(directory);
      await managedDirectory(join(directory, id));
      await link(staged, this.path(this.get(id)));
      await rm(staged, { force: true });
      const mediaType = detect(head);
      this.db
        .prepare(
          "UPDATE artifact_versions SET state='ready',sha256=?,mediaType=? WHERE id=?",
        )
        .run(hash.digest("hex"), mediaType, id);
      this.changed(owner.workspaceId);
      return this.get(id);
    } catch (error) {
      try {
        await managedDirectory(directory);
        await rm(staged, { force: true });
        await managedDirectory(join(directory, id));
        await rm(this.path(this.get(id)), { force: true });
      } catch {}
      this.db
        .prepare(
          "UPDATE artifact_versions SET state='failed',error='Attachment creation failed. Check the source, storage, and permissions.' WHERE id=?",
        )
        .run(id);
      this.changed(owner.workspaceId);
      throw error;
    }
  }
  async discardIngest(ingestId: string) {
    await this.files.verifyRoot();
    const rows = this.db
      .prepare(
        "SELECT * FROM artifact_versions WHERE ingestId=? AND NOT EXISTS(SELECT 1 FROM artifact_references r WHERE r.versionId=artifact_versions.id)",
      )
      .all(ingestId) as ArtifactVersion[];
    for (const v of rows) {
      try {
        await managedDirectory(this.directory(v.workspaceId));
        await rm(join(this.directory(v.workspaceId), `.staging-${v.id}`), {
          force: true,
        });
        await managedDirectory(join(this.directory(v.workspaceId), v.id));
        await rm(this.path(v), { force: true });
        await rm(join(this.directory(v.workspaceId), v.id), {
          recursive: true,
          force: true,
        });
      } catch (e: any) {
        if (e.code !== "ENOENT") continue;
      }
      this.db.prepare("DELETE FROM artifact_versions WHERE id=?").run(v.id);
      this.db
        .prepare(
          "DELETE FROM artifacts WHERE id=? AND NOT EXISTS(SELECT 1 FROM artifact_versions WHERE artifactId=?)",
        )
        .run(v.artifactId, v.artifactId);
    }
    this.db
      .prepare(
        "DELETE FROM submission_ingests WHERE id=? AND NOT EXISTS(SELECT 1 FROM artifact_versions WHERE ingestId=?)",
      )
      .run(ingestId, ingestId);
  }
  async bytes(
    id: string,
    workspaceId: string,
    maxBytes = 20 * 1024 * 1024,
    ingestId?: string,
  ) {
    if (this.byteReads >= 2)
      throw new ConnectionError("Media reads are busy. Retry shortly.", 429);
    this.byteReads++;
    try {
      const v = await this.ready(id, workspaceId, ingestId);
      if (v.size > maxBytes)
        throw new ConnectionError(
          "Media exceeds the native inspection size limit. The original file remains available.",
          413,
        );
      const f = await open(
        this.path(v),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const bytes = Buffer.alloc(v.size);
        let n = 0;
        while (n < bytes.length) {
          const r = await f.read(bytes, n, bytes.length - n, n);
          if (!r.bytesRead) break;
          n += r.bytesRead;
        }
        if (
          n !== v.size ||
          createHash("sha256").update(bytes).digest("hex") !== v.sha256
        )
          throw new ConnectionError("Artifact bytes changed.", 409);
        this.files.assertAvailable(workspaceId);
        return { version: v, bytes };
      } finally {
        await f.close();
      }
    } finally {
      this.byteReads--;
    }
  }
  async materialize(owner: ToolOwner, id: string, name?: string) {
    const v = await this.ready(id, owner.workspaceId);
    const task = await this.files.repair("task", owner.taskId);
    if (task.state !== "ready")
      throw new ConnectionError("Task folder unavailable.", 409);
    const filename = name ?? `${v.id}-${v.name}`;
    if (
      filename !== basename(filename) ||
      filename.includes("\\") ||
      [".", ".."].includes(filename)
    )
      throw new ConnectionError("Use a task-local filename.", 400);
    const target = resolve(task.path, filename);
    if (relative(task.path, target).startsWith(`..${sep}`))
      throw new ConnectionError("Invalid destination.", 400);
    await managedDirectory(task.path);
    await copyFile(this.path(v), target, constants.COPYFILE_EXCL);
    return { path: target, versionId: id, sha256: v.sha256 };
  }
  async ready(id: string, workspaceId?: string, ingestId?: string) {
    await this.files.verifyRoot();
    let v = this.get(id);
    if (
      (v as ArtifactVersion & { ingestId?: string }).ingestId &&
      (v as ArtifactVersion & { ingestId?: string }).ingestId !== ingestId
    )
      throw new ConnectionError("File transfer has not been committed.", 409);
    if (workspaceId && v.workspaceId !== workspaceId)
      throw new ConnectionError("Artifact is outside this workspace.", 403);
    if (v.state === "ready") v = await this.check(v, true);
    if (v.state !== "ready")
      throw new ConnectionError("Artifact bytes are not available.", 409);
    this.files.assertAvailable(v.workspaceId);
    return v;
  }
  async download(id: string) {
    if (this.stopped)
      throw new ConnectionError("Artifact service is shutting down.", 503);
    const v = await this.ready(id);
    await managedFile(this.path(v));
    const file = await open(
      this.path(v),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      this.files.assertAvailable(v.workspaceId);
      if (this.stopped)
        throw new ConnectionError("Artifact service is shutting down.", 503);
    } catch (error) {
      await file.close();
      throw error;
    }
    const stream = file.createReadStream();
    this.downloads.set(stream, v.workspaceId);
    stream.once("close", () => this.downloads.delete(stream));
    return { version: v, stream };
  }
  async settleAgents(ids: string[]) {
    await Promise.allSettled(
      [...this.pending.values()]
        .filter((p) => !!p.owner.agentId && ids.includes(p.owner.agentId))
        .map((p) => p.promise),
    );
  }
  async settleWorkspace(workspaceId?: string) {
    const streams = [...this.downloads]
      .filter(([, id]) => !workspaceId || id === workspaceId)
      .map(([stream]) => stream);
    await Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (stream.closed) {
              resolve();
              return;
            }
            stream.once("close", resolve);
            stream.destroy();
          }),
      ),
    );
  }
  async quiesce() {
    this.stopped = true;
    await this.settleWorkspace();
  }
  async close() {
    await this.quiesce();
    await Promise.allSettled([...this.pending.values()].map((p) => p.promise));
  }
}
function detect(head: Buffer) {
  if (
    head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (head[0] === 255 && head[1] === 216) return "image/jpeg";
  if (
    head.toString("ascii", 0, 4) === "RIFF" &&
    head.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (head.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (head.subarray(0, 2).toString() === "PK") return "application/zip";
  if (head.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (
    head.length &&
    !head.includes(0) &&
    !head.toString("utf8").includes("\ufffd")
  )
    return "text/plain";
  return "application/octet-stream";
}
