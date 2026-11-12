import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, sep, parse } from "node:path";
import type Database from "better-sqlite3";
import type {
  DeletionOperation,
  LocationKind,
  ManagedLocation,
} from "./contracts.js";
import type { AgentExecution } from "./agent-execution.js";
import { ConnectionError } from "./model-providers.js";

type LocationRow = Omit<ManagedLocation, "path">;
type DeletionRow = DeletionOperation & { relativePath: string };
const time = () => new Date().toISOString();
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export class ManagedFiles {
  root = "";
  ready = false;
  private temporary = false;
  private stopped = false;
  private worker?: Promise<void>;
  private repairs = new Map<string, Promise<ManagedLocation>>();
  private operations = new Map<string, Promise<void>>();
  private execution?: AgentExecution;
  constructor(
    readonly db: Database.Database,
    private configuredRoot?: string,
  ) {}
  bind(execution: AgentExecution) {
    this.execution = execution;
  }
  async start() {
    const configured = this.configuredRoot ?? process.env.UFAI_FILES_ROOT;
    this.temporary =
      !configured && (!this.db.name || this.db.name === ":memory:");
    this.root = this.temporary
      ? await mkdtemp(join(tmpdir(), "ufai-files-"))
      : resolve(configured ?? `${this.db.name}.files`);
    await this.safeDirectory(this.root, true);
    const marker = join(this.root, ".ufai-owner");
    const owner = (
      this.db
        .prepare("SELECT installationId FROM managed_storage WHERE id=1")
        .get() as { installationId: string }
    ).installationId;
    const checkMarker = async () => {
      const info = await lstat(marker);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (await readFile(marker, "utf8")) !== owner
      )
        throw new Error(
          "Managed file root belongs to another installation or has an invalid ownership marker.",
        );
    };
    try {
      await checkMarker();
    } catch (e) {
      if (!missing(e)) throw e;
      const entries = await readdir(this.root);
      if (
        entries.some(
          (name) =>
            name !== ".ufai-owner" && !name.startsWith(`.ufai-owner-${owner}-`),
        )
      )
        throw new Error(
          "Managed file root is not empty and has no ownership marker.",
        );
      const staged = join(this.root, `.ufai-owner-${owner}-${randomUUID()}`);
      await writeFile(staged, owner, { flag: "wx", mode: 0o600 });
      try {
        try {
          await link(staged, marker);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        await checkMarker();
      } finally {
        await rm(staged, { force: true });
      }
    }
    this.db
      .prepare(
        "UPDATE managed_locations SET state='pending',error=NULL WHERE state='ready'",
      )
      .run();
    this.ready = true;
    // Persisted deletion intent fences execution before any asynchronous cleanup.
    this.db
      .prepare(
        "UPDATE deletion_operations SET state='pending',error=NULL WHERE state!='completed'",
      )
      .run();
    this.drainDeletions();
    this.kick();
    this.execution?.wake();
  }
  async verifyRoot() {
    await this.safeDirectory(this.root, false);
    const marker = join(this.root, ".ufai-owner");
    const info = await lstat(marker);
    const owner = (
      this.db
        .prepare("SELECT installationId FROM managed_storage WHERE id=1")
        .get() as { installationId: string }
    ).installationId;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (await readFile(marker, "utf8")) !== owner
    )
      throw new Error("Invalid managed file root.");
  }
  private async safeDirectory(path: string, create: boolean) {
    const full = resolve(path);
    const base = parse(full).root;
    const parts = full.slice(base.length).split(sep).filter(Boolean);
    let current: string = base;
    for (const part of parts) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error(
            "Managed directories must be real directories, not links.",
          );
      } catch (e) {
        if (!missing(e) || !create) throw e;
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Invalid managed directory.");
      }
    }
  }
  private path(relativePath: string) {
    if (!relativePath.split("/").every((p) => /^[a-zA-Z0-9_-]{1,100}$/.test(p)))
      throw new Error("Invalid managed location.");
    const path = resolve(this.root, relativePath),
      rel = relative(this.root, path);
    if (!rel || rel.startsWith(`..${sep}`) || rel === "..")
      throw new Error("Invalid managed location.");
    return path;
  }
  location(kind: LocationKind, ownerId: string): ManagedLocation {
    const row = this.db
      .prepare("SELECT * FROM managed_locations WHERE kind=? AND ownerId=?")
      .get(kind, ownerId) as LocationRow | undefined;
    if (!row) throw new ConnectionError("Folder owner not found.", 404);
    return { ...row, path: this.root ? this.path(row.relativePath) : "" };
  }
  assertAvailable(
    workspaceId: string,
    agentId?: string,
    clusterId?: string | null,
  ) {
    const operation = this.db
      .prepare(
        `SELECT id FROM deletion_operations WHERE state!='completed' AND
      ((kind='workspace' AND ownerId=?) OR (kind='agent' AND ownerId=?) OR (kind='cluster' AND ownerId=?)) LIMIT 1`,
      )
      .get(workspaceId, agentId ?? "", clusterId ?? "");
    if (operation)
      throw new ConnectionError(
        "Deletion is in progress. Check the deletion operation and retry cleanup if needed.",
        409,
      );
  }
  repair(kind: LocationKind, ownerId: string) {
    const key = `${kind}:${ownerId}`,
      existing = this.repairs.get(key);
    if (existing) return existing;
    if (this.repairs.size >= 16)
      throw new ConnectionError("Folder setup is busy. Retry shortly.", 429);
    const promise = this.performRepair(kind, ownerId);
    this.repairs.set(key, promise);
    void promise.then(
      () => this.repairs.delete(key),
      () => this.repairs.delete(key),
    );
    return promise;
  }
  private async performRepair(kind: LocationKind, ownerId: string) {
    const row = this.location(kind, ownerId);
    this.assertAvailable(
      row.workspaceId,
      kind === "agent"
        ? ownerId
        : kind === "task"
          ? (
              this.db
                .prepare("SELECT agentId FROM agent_tasks WHERE id=?")
                .get(ownerId) as { agentId: string }
            )?.agentId
          : undefined,
      kind === "cluster" ? ownerId : undefined,
    );
    try {
      await this.verifyRoot();
      await this.safeDirectory(this.path(row.relativePath), true);
      this.db
        .prepare(
          "UPDATE managed_locations SET state='ready',error=NULL WHERE id=?",
        )
        .run(row.id);
    } catch {
      this.db
        .prepare(
          "UPDATE managed_locations SET state='error',error='Folder is unavailable. Check its path and permissions, then retry.' WHERE id=?",
        )
        .run(row.id);
    }
    this.execution?.workspaceEvent(row.workspaceId, "locations");
    return this.location(kind, ownerId);
  }
  kick() {
    if (!this.ready || this.stopped || this.worker) return;
    this.worker = this.provision().finally(() => {
      this.worker = undefined;
    });
  }
  private async provision() {
    while (!this.stopped) {
      const rows = this.db
        .prepare(
          `SELECT * FROM managed_locations l WHERE state='pending'
        AND NOT EXISTS(SELECT 1 FROM deletion_operations d WHERE d.state!='completed' AND d.workspaceId=l.workspaceId
          AND (d.kind='workspace' OR (d.kind=l.kind AND d.ownerId=l.ownerId) OR (d.kind='agent' AND l.kind='task' AND l.ownerId IN (SELECT id FROM agent_tasks WHERE agentId=d.ownerId))))
        ORDER BY id LIMIT 16`,
        )
        .all() as LocationRow[];
      if (!rows.length) break;
      for (const row of rows) {
        if (this.stopped) break;
        try {
          await this.repair(row.kind, row.ownerId);
        } catch {
          this.db
            .prepare(
              "UPDATE managed_locations SET state='error',error='Folder is unavailable. Check its path and permissions, then retry.' WHERE id=? AND state='pending'",
            )
            .run(row.id);
        }
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  deletion(id: string): DeletionOperation {
    const row = this.db
      .prepare("SELECT * FROM deletion_operations WHERE id=?")
      .get(id) as DeletionRow | undefined;
    if (!row) throw new ConnectionError("Deletion operation not found.", 404);
    const { relativePath: _, ...result } = row;
    return result;
  }
  requestDeletion(
    kind: DeletionOperation["kind"],
    ownerId: string,
    confirmed: unknown,
  ) {
    if (confirmed !== true)
      throw new ConnectionError(
        "Confirm permanent deletion of the managed files first.",
        400,
      );
    const old = this.db
      .prepare("SELECT id FROM deletion_operations WHERE kind=? AND ownerId=?")
      .get(kind, ownerId) as { id: string } | undefined;
    if (old) {
      if (this.deletion(old.id).state === "completed")
        throw new ConnectionError("Folder owner not found.", 404);
      this.runDeletion(old.id);
      return this.deletion(old.id);
    }
    const location = this.location(kind, ownerId);
    if (
      kind === "workspace" &&
      this.db
        .prepare(
          "SELECT 1 FROM deletion_operations WHERE workspaceId=? AND state!='completed' LIMIT 1",
        )
        .get(ownerId)
    )
      throw new ConnectionError(
        "Another deletion is still in progress in this workspace. Finish it first.",
        409,
      );
    if (kind === "agent") {
      const agent = this.db
        .prepare("SELECT clusterId FROM agents WHERE id=?")
        .get(ownerId) as { clusterId: string | null };
      this.assertAvailable(location.workspaceId, ownerId, agent.clusterId);
    }
    this.assertAvailable(
      location.workspaceId,
      kind === "agent" ? ownerId : undefined,
      kind === "cluster" ? ownerId : undefined,
    );
    if (kind === "cluster") {
      const busy = this.db
        .prepare(
          "SELECT 1 FROM agents a JOIN deletion_operations d ON d.ownerId=a.id AND d.kind='agent' AND d.state!='completed' WHERE a.clusterId=? LIMIT 1",
        )
        .get(ownerId);
      if (busy)
        throw new ConnectionError(
          "A member agent is being deleted. Wait for its deletion first.",
          409,
        );
    }
    const relativePath = dirname(location.relativePath).split(sep).join("/");
    const count = this.db
      .prepare(
        "SELECT count(*) AS n FROM deletion_operations WHERE state!='completed'",
      )
      .get() as { n: number };
    if (count.n >= 100)
      throw new ConnectionError(
        "Too many pending deletions. Finish or retry existing cleanup first.",
        429,
      );
    this.db
      .prepare(
        "DELETE FROM deletion_operations WHERE state='completed' AND id NOT IN (SELECT id FROM deletion_operations WHERE state='completed' ORDER BY updatedAt DESC LIMIT 1000)",
      )
      .run();
    const id = randomUUID(),
      ts = time();
    this.db
      .prepare(
        "INSERT INTO deletion_operations(id,kind,ownerId,workspaceId,relativePath,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, kind, ownerId, location.workspaceId, relativePath, ts, ts);
    this.execution?.workspaceEvent(location.workspaceId, "deletion");
    this.runDeletion(id);
    return this.deletion(id);
  }
  retryDeletion(id: string) {
    const op = this.deletion(id);
    if (op.state !== "completed") this.runDeletion(id);
    return this.deletion(id);
  }
  private drainDeletions() {
    if (this.stopped || !this.ready) return;
    const pending = this.db
      .prepare(
        "SELECT id FROM deletion_operations WHERE state='pending' ORDER BY createdAt,id LIMIT 2",
      )
      .all() as { id: string }[];
    for (const op of pending)
      if (this.operations.size < 2) this.runDeletion(op.id);
  }
  private runDeletion(id: string) {
    if (this.stopped || this.operations.has(id)) return;
    this.db
      .prepare(
        "UPDATE deletion_operations SET state='pending',error=NULL WHERE id=? AND state!='completed'",
      )
      .run(id);
    if (!this.ready || this.operations.size >= 2) return;
    const promise = this.delete(id)
      .catch(() => {})
      .finally(() => {
        this.operations.delete(id);
        this.drainDeletions();
      });
    this.operations.set(id, promise);
  }
  private async delete(id: string) {
    const op = this.db
      .prepare("SELECT * FROM deletion_operations WHERE id=?")
      .get(id) as DeletionRow;
    try {
      this.db
        .prepare(
          "UPDATE deletion_operations SET state='running',error=NULL,updatedAt=? WHERE id=?",
        )
        .run(time(), id);
      // Wait for any folder creation already in flight, then quiesce inference.
      await this.worker;
      await Promise.allSettled([...this.repairs.values()]);
      const ids =
        op.kind === "workspace"
          ? (
              this.db
                .prepare("SELECT id FROM agents WHERE workspaceId=?")
                .all(op.ownerId) as { id: string }[]
            ).map((a) => a.id)
          : op.kind === "agent"
            ? [op.ownerId]
            : (
                this.db
                  .prepare("SELECT id FROM agents WHERE clusterId=?")
                  .all(op.ownerId) as { id: string }[]
              ).map((a) => a.id);
      await this.execution?.settleAgents(ids);
      if (op.kind === "workspace")
        await this.execution?.settleWorkspaceFiles(op.ownerId);
      await this.verifyRoot();
      const target = this.path(op.relativePath);
      try {
        await this.safeDirectory(dirname(target), false);
      } catch (e) {
        if (!missing(e)) throw e;
      }
      // rm unlinks interior symlinks rather than following their targets. Parent paths are checked above.
      await rm(target, { recursive: true, force: true, maxRetries: 2 });
      this.db.transaction(() => {
        if (op.kind === "workspace") {
          const next = this.db
            .prepare(
              `SELECT id FROM workspaces WHERE (createdAt,id) > (SELECT createdAt,id FROM workspaces WHERE id=?) ORDER BY createdAt,id LIMIT 1`,
            )
            .get(op.ownerId) as { id: string } | undefined;
          const previous =
            next ??
            (this.db
              .prepare(
                `SELECT id FROM workspaces WHERE (createdAt,id) < (SELECT createdAt,id FROM workspaces WHERE id=?) ORDER BY createdAt DESC,id DESC LIMIT 1`,
              )
              .get(op.ownerId) as { id: string } | undefined);
          this.db
            .prepare(
              "UPDATE app_settings SET activeWorkspaceId=? WHERE activeWorkspaceId=?",
            )
            .run(previous?.id ?? null, op.ownerId);
        }
        this.db
          .prepare(
            `DELETE FROM ${op.kind === "workspace" ? "workspaces" : op.kind === "agent" ? "agents" : "clusters"} WHERE id=?`,
          )
          .run(op.ownerId);
        this.db
          .prepare(
            "UPDATE deletion_operations SET state='completed',error=NULL,updatedAt=? WHERE id=?",
          )
          .run(time(), id);
      })();
    } catch {
      this.db
        .prepare(
          "UPDATE deletion_operations SET state='failed',error='File cleanup failed. Check the managed folders and permissions, then retry deletion.',updatedAt=? WHERE id=?",
        )
        .run(time(), id);
    }
    this.execution?.workspaceEvent(op.workspaceId, "deletion");
  }
  async close() {
    this.stopped = true;
    await this.worker;
    await Promise.allSettled([...this.repairs.values()]);
    await Promise.allSettled([...this.operations.values()]);
    if (this.temporary && this.root)
      await rm(this.root, { recursive: true, force: true });
  }
}
