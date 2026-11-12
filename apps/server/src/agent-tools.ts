import { randomUUID, createHash } from "node:crypto";
import { readdir, open, lstat, rename, rm, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { constants } from "node:fs";
import type Database from "better-sqlite3";
import type { ToolCall, ToolSpec, ToolResult } from "./execution-types.js";
import type { ManagedFiles } from "./managed-files.js";
import type { ProcessService, ToolOwner } from "./process-service.js";
import type { ArtifactService } from "./artifact-service.js";
import { ConnectionError } from "./model-providers.js";
const str = (description: string, maxLength = 4096) => ({
  type: "string",
  description,
  maxLength,
  minLength: 1,
});
const number = (minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
});
const bool = { type: "boolean" };
const spec = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolSpec => ({
  name,
  description,
  parameters: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});
export const taskTools: ToolSpec[] = [
  spec(
    "files_list",
    "List a bounded page of directory entries. Relative paths start in the task directory.",
    {
      path: str("Directory"),
      offset: number(0, 1000000),
      limit: number(1, 100),
    },
    ["path"],
  ),
  spec(
    "files_read",
    "Read a bounded portion of a UTF-8 text file and its whole-file SHA-256. Binary media is not perceived by this tool.",
    {
      path: str("File"),
      offset: number(0, 16 * 1024 * 1024),
      limit: number(1, 32768),
    },
    ["path"],
  ),
  spec(
    "files_write",
    "Atomically replace a small text file. Existing files require expectedSha256 from files_read; use null to create a new file. Hash checks are cooperative, not a lock against external programs.",
    {
      path: str("File"),
      text: { type: "string", maxLength: 48000 },
      expectedSha256: { type: ["string", "null"], maxLength: 64 },
    },
    ["path", "text", "expectedSha256"],
  ),
  spec(
    "process_start",
    "Start an OS shell command. Use pty for interactive terminal programs. Returns a process handle; background processes may outlive the reply. Use process_wait to yield until completion.",
    {
      command: str("Shell command", 16000),
      cwd: str("Absolute working directory"),
      pty: bool,
      background: bool,
      timeoutMs: { type: ["integer", "null"], minimum: 1, maximum: 86400000 },
      yieldMs: number(0, 1000),
      cols: number(20, 500),
      rows: number(5, 200),
      env: {
        type: "object",
        maxProperties: 32,
        additionalProperties: { type: "string", maxLength: 4096 },
      },
    },
    ["command"],
  ),
  spec(
    "process_output",
    "Read bounded process output using a byte cursor; returns text with terminal controls removed for model context.",
    {
      processId: str("Owned process ID", 100),
      cursor: number(0, Number.MAX_SAFE_INTEGER),
      limit: number(1, 32768),
    },
    ["processId"],
  ),
  spec(
    "process_input",
    "Write stdin or PTY input, including newline or Ctrl+C. Input is not separately retained in the transcript.",
    {
      processId: str("Owned process ID", 100),
      data: { type: "string", maxLength: 16000 },
    },
    ["processId", "data"],
  ),
  spec(
    "process_resize",
    "Resize an owned PTY.",
    {
      processId: str("Owned process ID", 100),
      cols: number(20, 500),
      rows: number(5, 200),
    },
    ["processId", "cols", "rows"],
  ),
  spec(
    "process_stop",
    "Stop an owned process and settle its tracked descendants.",
    { processId: str("Owned process ID", 100) },
    ["processId"],
  ),
  spec(
    "process_wait",
    "Suspend this turn until an owned process finishes. Other tasks may run while waiting. Start independent processes before waiting.",
    { processId: str("Owned process ID", 100) },
    ["processId"],
  ),
  spec(
    "artifacts_list",
    "List published versions in this workspace. Use taskOnly for this task's complete output manifest, including older compacted outputs. Does not inspect media content.",
    { taskOnly: bool, offset: number(0, 1000000), limit: number(1, 100) },
  ),
  spec(
    "artifact_inspect",
    "Get metadata for a published version; this does not visually inspect its bytes.",
    { versionId: str("Version ID", 100) },
    ["versionId"],
  ),
  spec(
    "artifact_publish",
    "Snapshot a stable regular file as an immutable artifact. The ready version is shown as a downloadable output. Publishing again can add a version to an existing artifact.",
    {
      path: str("Source file"),
      name: str("Display name", 240),
      artifactId: str("Existing artifact ID", 100),
      sourceVersionId: str("Source version for provenance", 100),
    },
    ["path"],
  ),
  spec(
    "artifact_materialize",
    "Copy a ready artifact version into this task's directory for CLI use. Existing files are never overwritten.",
    {
      versionId: str("Version ID", 100),
      name: str("Task-local destination filename", 240),
    },
    ["versionId"],
  ),
];
export function validateTool(name: string, args: unknown) {
  const definition = taskTools.find((t) => t.name === name);
  if (!definition) throw new ConnectionError("Unknown tool.", 400);
  validate(args, definition.parameters);
  return args as Record<string, any>;
}
function validate(value: any, schema: any) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (
    !types.includes(kind) &&
    !(types.includes("integer") && Number.isSafeInteger(value))
  )
    throw new ConnectionError("Invalid tool argument type.", 400);
  if (
    typeof value === "string" &&
    (value.length > (schema.maxLength ?? Infinity) ||
      value.length < (schema.minLength ?? 0) ||
      value.includes("\u0000"))
  )
    throw new ConnectionError(
      "Invalid tool text length or NUL character.",
      400,
    );
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    throw new ConnectionError("Invalid tool number.", 400);
  if (kind === "object") {
    if (Object.keys(value).length > (schema.maxProperties ?? 100))
      throw new ConnectionError("Too many tool arguments.", 400);
    for (const key of schema.required ?? [])
      if (!(key in value))
        throw new ConnectionError(`Missing tool argument: ${key}.`, 400);
    for (const [key, v] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new ConnectionError("Invalid tool argument.", 400);
      const child = schema.properties?.[key] ?? schema.additionalProperties;
      if (!child || child === false)
        throw new ConnectionError(`Unknown tool argument: ${key}.`, 400);
      if (typeof child === "object") validate(v, child);
    }
  }
}
export class AgentTools {
  ready = false;
  private counts = new Map<string, number>();
  private inflight = new Map<string, Promise<ToolResult>>();
  private writes = new Map<string, Promise<unknown>>();
  constructor(
    readonly db: Database.Database,
    private files: ManagedFiles,
    readonly processes: ProcessService,
    readonly artifacts: ArtifactService,
    private changed: (workspaceId: string) => void,
    private maxCalls = 128,
  ) {
    db.prepare(
      "UPDATE tool_invocations SET state='interrupted',result=? WHERE state='running'",
    ).run(
      JSON.stringify({
        ok: false,
        error:
          "Execution interrupted; external effects may have occurred. Inspect state before retrying.",
      }),
    );
  }
  item(owner: ToolOwner, kind: string, content: unknown) {
    this.db
      .prepare(
        "INSERT INTO execution_items(id,workspaceId,agentId,taskId,turnId,kind,content,createdAt) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        owner.workspaceId,
        owner.agentId,
        owner.taskId,
        owner.turnId,
        kind,
        typeof content === "string" ? content : JSON.stringify(content),
        new Date().toISOString(),
      );
    this.changed(owner.workspaceId);
  }
  async dispatch(
    owner: ToolOwner,
    call: ToolCall,
    signal: AbortSignal,
    wait: (id: string) => Promise<unknown>,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    this.files.assertAvailable(
      owner.workspaceId,
      owner.agentId,
      this.agentCluster(owner.agentId),
    );
    if (
      !call.id ||
      call.id.length > 200 ||
      Buffer.byteLength(JSON.stringify(call.arguments)) > 65536
    )
      return { ok: false, error: "Tool call exceeds argument limits." };
    const args = call.arguments,
      encoded = JSON.stringify(args),
      key = `${owner.turnId}:${call.id}`;
    const old = this.db
      .prepare("SELECT * FROM tool_invocations WHERE turnId=? AND callId=?")
      .get(owner.turnId, call.id) as any;
    if (old) {
      if (old.name !== call.name || old.arguments !== encoded)
        throw new ConnectionError(
          "Tool call ID was reused with different arguments.",
          409,
        );
      if (this.inflight.has(key)) return this.inflight.get(key)!;
      return old.result
        ? JSON.parse(old.result)
        : {
            ok: false,
            error: "Tool outcome is uncertain. It was not replayed.",
          };
    }
    const count = (this.counts.get(owner.turnId) ?? 0) + 1;
    if (count > this.maxCalls)
      throw new ConnectionError("Tool call limit reached.", 409);
    this.counts.set(owner.turnId, count);
    const stamp = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO tool_invocations VALUES (?,?,?,?,?,'running',NULL,?,?)",
      )
      .run(
        randomUUID(),
        owner.turnId,
        call.id,
        call.name,
        encoded,
        stamp,
        stamp,
      );
    this.item(owner, "tool_call", {
      ...call,
      arguments:
        call.name === "process_input"
          ? { processId: args.processId, data: "[input omitted]" }
          : args,
    });
    const promise = (async () => {
      let result: ToolResult;
      try {
        validateTool(call.name, args);
        result = {
          ok: true,
          ...(await this.execute(owner, call.name, args, signal, wait)),
        };
        if (Buffer.byteLength(JSON.stringify(result)) > 65536)
          result = {
            ok: false,
            error:
              "Tool result exceeded the size limit. Use a smaller page or read limit; inspect state before repeating actions.",
          };
      } catch (e) {
        signal.throwIfAborted();
        result = {
          ok: false,
          error:
            e instanceof ConnectionError
              ? e.message
              : "Tool failed. Check the path, process, permissions, and supplied arguments.",
        };
      }
      signal.throwIfAborted();
      this.files.assertAvailable(owner.workspaceId, owner.agentId);
      this.db
        .prepare(
          "UPDATE tool_invocations SET state='completed',result=?,updatedAt=? WHERE turnId=? AND callId=?",
        )
        .run(
          JSON.stringify(result),
          new Date().toISOString(),
          owner.turnId,
          call.id,
        );
      this.item(owner, "tool_result", {
        callId: call.id,
        name: call.name,
        ...result,
      });
      return result;
    })();
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }
  release(turnId: string) {
    this.counts.delete(turnId);
    this.db
      .prepare(
        "UPDATE tool_invocations SET state='interrupted',result=? WHERE turnId=? AND state='running'",
      )
      .run(
        JSON.stringify({
          ok: false,
          error:
            "Interrupted action: external effects may have occurred; inspect before retrying.",
        }),
        turnId,
      );
  }
  private agentCluster(id: string) {
    return (
      this.db.prepare("SELECT clusterId FROM agents WHERE id=?").get(id) as {
        clusterId: string | null;
      }
    )?.clusterId;
  }
  private owned(owner: ToolOwner, id: string) {
    const p = this.processes.get(id);
    if (p.agentId !== owner.agentId || p.workspaceId !== owner.workspaceId)
      throw new ConnectionError("Process belongs to another agent.", 403);
    return p;
  }
  async locations(owner: ToolOwner) {
    const a = this.db
      .prepare("SELECT clusterId FROM agents WHERE id=?")
      .get(owner.agentId) as { clusterId: string | null };
    const entries = await Promise.all([
      this.files.repair("task", owner.taskId),
      this.files.repair("agent", owner.agentId),
      this.files.repair("workspace", owner.workspaceId),
      ...(a.clusterId ? [this.files.repair("cluster", a.clusterId)] : []),
    ]);
    if (entries.some((x) => x.state !== "ready"))
      throw new ConnectionError(
        "A working folder is unavailable. Repair its location before continuing.",
        409,
      );
    return Object.fromEntries(entries.map((x) => [x.kind, x.path]));
  }
  private async execute(
    owner: ToolOwner,
    name: string,
    a: Record<string, any>,
    signal: AbortSignal,
    wait: (id: string) => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    const path = () =>
      resolve(this.files.location("task", owner.taskId).path, a.path);
    if (name === "files_list") {
      const dir = await openDirectory(path());
      try {
        const entries = [];
        let index = 0;
        for await (const entry of dir) {
          signal.throwIfAborted();
          if (index++ < (a.offset ?? 0)) continue;
          entries.push({
            name: entry.name,
            kind: entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "link"
                : "file",
          });
          if (entries.length >= (a.limit ?? 100)) break;
        }
        return { entries };
      } finally {
        await dir.close().catch(() => {});
      }
    }
    if (name === "files_read") {
      const file = await open(path(), "r");
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 16 * 1024 * 1024)
          throw new ConnectionError(
            "Read a regular text file of at most 16 MiB. Use CLI tools for larger files.",
            413,
          );
        const hash = createHash("sha256"),
          chunk = Buffer.alloc(65536);
        let total = 0;
        const parts: Buffer[] = [];
        const start = a.offset ?? 0,
          end = start + (a.limit ?? 32768);
        while (true) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
          if (!bytesRead) break;
          hash.update(chunk.subarray(0, bytesRead));
          if (total < end && total + bytesRead > start)
            parts.push(
              Buffer.from(
                chunk.subarray(
                  Math.max(0, start - total),
                  Math.min(bytesRead, end - total),
                ),
              ),
            );
          total += bytesRead;
          if (total > 16 * 1024 * 1024)
            throw new ConnectionError(
              "File grew past the text read limit.",
              413,
            );
        }
        const data = Buffer.concat(parts);
        if (data.includes(0))
          throw new ConnectionError(
            "Binary content cannot be read as text.",
            400,
          );
        return {
          path: path(),
          text: data.toString("utf8"),
          sha256: hash.digest("hex"),
          size: total,
          truncated: end < total,
        };
      } finally {
        await file.close();
      }
    }
    if (name === "files_write") {
      const target = path(),
        canonical = join(
          await realpath(dirname(target)),
          target.split(/[\\/]/).at(-1)!,
        );
      const prior = this.writes.get(canonical) ?? Promise.resolve();
      const write = prior
        .catch(() => {})
        .then(async () => {
          signal.throwIfAborted();
          let old: Buffer | undefined;
          try {
            const stat = await lstat(canonical);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.size > 16 * 1024 * 1024
            )
              throw new ConnectionError(
                "Use a regular unlinked text file.",
                409,
              );
            const file = await open(
              canonical,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const chunks: Buffer[] = [];
              const buffer = Buffer.alloc(65536);
              let total = 0;
              while (true) {
                signal.throwIfAborted();
                const { bytesRead } = await file.read(
                  buffer,
                  0,
                  buffer.length,
                  null,
                );
                if (!bytesRead) break;
                total += bytesRead;
                if (total > 16 * 1024 * 1024)
                  throw new ConnectionError(
                    "File grew past the text write limit.",
                    413,
                  );
                chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
              }
              old = Buffer.concat(chunks);
            } finally {
              await file.close();
            }
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          const hash = old
            ? createHash("sha256").update(old).digest("hex")
            : null;
          if (hash !== a.expectedSha256)
            throw new ConnectionError(
              "File changed. Read it again before writing.",
              409,
            );
          if (!old) {
            const file = await open(canonical, "wx");
            try {
              await file.writeFile(a.text);
            } finally {
              await file.close();
            }
          } else {
            const staged = join(
              dirname(canonical),
              `.ufai-write-${randomUUID()}`,
            );
            try {
              const f = await open(staged, "wx");
              try {
                await f.writeFile(a.text);
                await f.sync();
              } finally {
                await f.close();
              }
              signal.throwIfAborted();
              await rename(staged, canonical);
            } finally {
              await rm(staged, { force: true });
            }
          }
          return {
            path: canonical,
            sha256: createHash("sha256").update(a.text).digest("hex"),
          };
        });
      this.writes.set(canonical, write);
      try {
        return await write;
      } finally {
        if (this.writes.get(canonical) === write) this.writes.delete(canonical);
      }
    }
    if (name === "process_start") {
      if (a.timeoutMs === null && !a.background)
        throw new ConnectionError(
          "Only explicit background sessions may omit their deadline.",
          400,
        );
      const args = {
        ...a,
        cwd: a.cwd
          ? resolve(this.files.location("task", owner.taskId).path, a.cwd)
          : undefined,
      };
      return { process: await this.processes.start(owner, args, signal) };
    }
    if (name.startsWith("process_")) {
      this.owned(owner, a.processId);
      if (name === "process_output") {
        const o = await this.processes.output(
          a.processId,
          a.cursor ?? 0,
          a.limit ?? 16384,
        );
        return {
          ...o,
          data: Buffer.from(o.data, "base64")
            .toString("utf8")
            .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""),
          encoding: "utf8",
        };
      }
      if (name === "process_input") {
        this.processes.input(a.processId, a.data);
        return {};
      }
      if (name === "process_resize") {
        this.processes.resize(a.processId, a.cols, a.rows);
        return {};
      }
      if (name === "process_stop")
        return { process: await this.processes.stop(a.processId) };
      if (name === "process_wait") return { process: await wait(a.processId) };
    }
    if (name === "artifacts_list")
      return {
        items: this.db
          .prepare(
            "SELECT * FROM artifact_versions WHERE workspaceId=? AND (?=0 OR producerTaskId=?) ORDER BY createdAt DESC,id LIMIT ? OFFSET ?",
          )
          .all(
            owner.workspaceId,
            Number(!!a.taskOnly),
            owner.taskId,
            a.limit ?? 50,
            a.offset ?? 0,
          ),
      };
    if (name === "artifact_inspect") {
      const v = this.artifacts.get(a.versionId);
      if (v.workspaceId !== owner.workspaceId)
        throw new ConnectionError(
          "Artifact belongs to another workspace.",
          403,
        );
      return { version: v };
    }
    if (name === "artifact_materialize")
      return this.artifacts.materialize(owner, a.versionId, a.name);
    if (name === "artifact_publish") {
      const version = await this.artifacts.publish(owner, a, signal);
      this.item(owner, "artifact", {
        versionId: version.id,
        name: version.name,
      });
      return {
        version,
        parts: [
          { type: "artifact", versionId: version.id, name: version.name },
        ],
      };
    }
    throw new ConnectionError("Unknown tool.", 400);
  }
}
import { opendir as openDirectory } from "node:fs/promises";
