import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import type { OwnedProcess, ProcessOutput } from "./contracts.js";
import type { ManagedFiles } from "./managed-files.js";
import { managedDirectory, managedFile } from "./host-paths.js";
import { ConnectionError } from "./model-providers.js";

export interface ToolOwner {
  workspaceId: string;
  agentId: string;
  taskId: string;
  turnId: string;
}
export interface ProcessOptions {
  logBytes?: number;
}
type Live = {
  child: ChildProcess;
  file: FileHandle;
  end: number;
  done: Promise<void>;
  settle: () => void;
  serial: Promise<void>;
  state?: OwnedProcess["state"];
  checkpoint: number;
  finishing?: boolean;
  inputBytes?: number;
};
const time = () => new Date().toISOString();
export class ProcessService {
  readonly events = new EventEmitter();
  private live = new Map<string, Live>();
  private stopped = false;
  readonly capacity: number;
  constructor(
    readonly db: Database.Database,
    private files: ManagedFiles,
    private changed: (workspaceId: string) => void,
    private options: ProcessOptions = {},
  ) {
    this.capacity = options.logBytes ?? 8 * 1024 * 1024;
    this.events.setMaxListeners(128);
    db.prepare(
      "UPDATE owned_processes SET state='interrupted',error='Process interrupted by restart; it was not relaunched.',updatedAt=? WHERE state IN ('starting','running')",
    ).run(time());
    db.prepare(
      "UPDATE process_waits SET state='interrupted' WHERE state!='completed'",
    ).run();
  }
  get(id: string) {
    const row = this.db
      .prepare("SELECT * FROM owned_processes WHERE id=?")
      .get(id) as OwnedProcess | undefined;
    if (!row) throw new ConnectionError("Process not found.", 404);
    return row;
  }
  private logPath(row: OwnedProcess) {
    return join(
      this.files.location("task", row.taskId).path,
      ".ufai-processes",
      row.id,
    );
  }
  async start(
    owner: ToolOwner,
    args: Record<string, any>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await this.files.verifyRoot();
    this.files.assertAvailable(owner.workspaceId, owner.agentId);
    if (this.stopped)
      throw new ConnectionError("Process service is shutting down.", 503);
    const task = await this.files.repair("task", owner.taskId);
    if (task.state !== "ready")
      throw new ConnectionError("Task folder is unavailable.", 409);
    const id = randomUUID(),
      launchId = randomUUID(),
      created = time();
    const cwd = args.cwd ?? task.path;
    this.files.assertAvailable(owner.workspaceId, owner.agentId);
    signal.throwIfAborted();
    this.db
      .prepare(
        "INSERT INTO owned_processes(id,workspaceId,agentId,taskId,turnId,command,cwd,pty,launchId,state,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,'starting',?,?)",
      )
      .run(
        id,
        owner.workspaceId,
        owner.agentId,
        owner.taskId,
        owner.turnId,
        args.command,
        cwd,
        args.pty ? 1 : 0,
        launchId,
        created,
        created,
      );
    let file: FileHandle | undefined;
    try {
      await managedDirectory(join(task.path, ".ufai-processes"), true);
      file = await open(join(task.path, ".ufai-processes", id), "wx+");
      signal.throwIfAborted();
      this.files.assertAvailable(owner.workspaceId, owner.agentId);
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const child = fork(
        new URL(`./process-supervisor.${extension}`, import.meta.url),
        [],
        {
          env: this.environment({}),
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          execArgv: process.execArgv,
          windowsHide: true,
        },
      );
      let settle!: () => void;
      const live: Live = {
        child,
        file,
        end: 0,
        checkpoint: 0,
        serial: Promise.resolve(),
        done: new Promise<void>((r) => {
          settle = r;
        }),
        settle: () => settle(),
      };
      this.live.set(id, live);
      const finish = async (
        code: number | null,
        exitSignal: string | null,
        error?: string,
      ) => {
        if (!this.live.has(id) || live.finishing) return;
        live.finishing = true;
        // Wait for the guardian's final tree cleanup before resolving Stop/deletion.
        if (child.connected)
          await new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
          });
        this.db
          .prepare(
            "UPDATE owned_processes SET state=?,exitCode=?,signal=?,error=?,outputStart=?,outputEnd=?,updatedAt=? WHERE id=?",
          )
          .run(
            live.state ?? (error ? "failed" : "exited"),
            code,
            exitSignal,
            error ?? null,
            Math.max(0, live.end - this.capacity),
            live.end,
            time(),
            id,
          );
        await live.file.close();
        this.live.delete(id);
        live.settle();
        this.events.emit(id);
        this.changed(owner.workspaceId);
      };
      child.on("message", (raw: any) => {
        live.serial = live.serial
          .then(async () => {
            if (raw.type === "output") {
              const data = Buffer.from(raw.data, "base64");
              let offset = 0;
              while (offset < data.length) {
                const at = live.end % this.capacity,
                  n = Math.min(data.length - offset, this.capacity - at);
                await live.file.write(data, offset, n, at);
                offset += n;
                live.end += n;
              }
              if (Date.now() - live.checkpoint >= 250) {
                live.checkpoint = Date.now();
                this.checkpoint(id, live);
                this.changed(owner.workspaceId);
              }
              if (child.connected) child.send({ type: "ack" });
            } else if (raw.type === "started") {
              this.db
                .prepare(
                  "UPDATE owned_processes SET state='running',updatedAt=? WHERE id=? AND state='starting'",
                )
                .run(time(), id);
              this.changed(owner.workspaceId);
            } else if (raw.type === "exit") {
              this.checkpoint(id, live);
              void finish(raw.code, raw.signal);
            } else if (raw.type === "error") {
              live.state = "failed";
              if (child.connected) child.send({ type: "stop" });
            }
          })
          .catch(() => {
            live.state = "failed";
            if (child.connected) child.disconnect();
          });
      });
      child.once("exit", () => {
        void live.serial
          .then(() => finish(null, null, "Process supervisor ended."))
          .catch(() => {});
      });
      child.once("error", () => {
        void finish(null, null, "Cannot start process supervisor.");
      });
      const shell =
        process.platform === "win32"
          ? (process.env.ComSpec ?? "cmd.exe")
          : "/bin/sh";
      child.send({
        type: "start",
        file: shell,
        args:
          process.platform === "win32"
            ? ["/d", "/s", "/c", args.command]
            : ["-c", args.command],
        cwd,
        env: this.environment(args.env ?? {}),
        pty: !!args.pty,
        cols: args.cols ?? 100,
        rows: args.rows ?? 30,
      });
      await new Promise<void>((r) =>
        setTimeout(r, Math.min(args.yieldMs ?? 100, 1000)),
      );
      return this.get(id);
    } catch (error) {
      if (!this.live.has(id)) await file?.close();
      this.db
        .prepare(
          "UPDATE owned_processes SET state='failed',error='Cannot start command. Check cwd and terminal availability.',updatedAt=? WHERE id=?",
        )
        .run(time(), id);
      throw error;
    }
  }
  private checkpoint(id: string, live: Live) {
    this.db
      .prepare(
        "UPDATE owned_processes SET outputStart=?,outputEnd=?,updatedAt=? WHERE id=?",
      )
      .run(Math.max(0, live.end - this.capacity), live.end, time(), id);
  }
  private environment(overrides: Record<string, string>) {
    const env: Record<string, string> = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "TEMP",
      "TMP",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
    ])
      if (process.env[key]) env[key] = process.env[key]!;
    return { ...env, ...overrides };
  }
  async output(id: string, cursor = 0, limit = 65536): Promise<ProcessOutput> {
    await this.files.verifyRoot();
    const row = this.get(id),
      live = this.live.get(id),
      end = live?.end ?? row.outputEnd,
      start = Math.max(0, end - this.capacity),
      at = Math.max(start, Math.min(cursor, end)),
      size = Math.min(limit, end - at);
    let data = Buffer.alloc(size);
    if (size) {
      const path = this.logPath(row);
      await managedFile(path);
      const file = await open(path, "r");
      try {
        const pos = at % this.capacity,
          n = Math.min(size, this.capacity - pos);
        await file.read(data, 0, n, pos);
        if (n < size) await file.read(data, n, size - n, 0);
      } finally {
        await file.close();
      }
    }
    return {
      data: data.toString("base64"),
      encoding: "base64",
      start: at,
      next: at + size,
      end,
      truncated: cursor < start,
      state: row.state,
    };
  }
  input(id: string, data: string) {
    const row = this.get(id);
    this.files.assertAvailable(row.workspaceId, row.agentId);
    const live = this.live.get(id);
    if (!live?.child.connected || !["starting", "running"].includes(row.state))
      throw new ConnectionError("Process is no longer running.", 409);
    const bytes = Buffer.byteLength(data);
    if ((live.inputBytes ?? 0) + bytes > 65536)
      throw new ConnectionError("Process input is busy.", 429);
    live.inputBytes = (live.inputBytes ?? 0) + bytes;
    live.child.send({ type: "input", data }, () => {
      live.inputBytes = Math.max(0, (live.inputBytes ?? 0) - bytes);
    });
  }
  resize(id: string, cols: number, rows: number) {
    const live = this.live.get(id);
    if (!this.get(id).pty)
      throw new ConnectionError("This process has no terminal.", 409);
    if (live?.child.connected) live.child.send({ type: "resize", cols, rows });
  }
  async stop(id: string, state: OwnedProcess["state"] = "stopped") {
    const live = this.live.get(id);
    if (!live) return this.get(id);
    live.state = state;
    if (live.child.connected) live.child.send({ type: "stop" });
    await live.done;
    return this.get(id);
  }
  async stopAgents(ids: string[]) {
    await Promise.all(
      [...this.live]
        .filter(([id]) => ids.includes(this.get(id).agentId))
        .map(([id]) => this.stop(id)),
    );
  }
  async stopTask(id: string) {
    await Promise.all(
      [...this.live]
        .filter(([pid]) => this.get(pid).taskId === id)
        .map(([pid]) => this.stop(pid)),
    );
  }
  async wait(id: string, signal: AbortSignal) {
    if (!this.live.has(id)) return this.get(id);
    await new Promise<void>((resolve, reject) => {
      const done = () => {
          cleanup();
          resolve();
        },
        abort = () => {
          cleanup();
          reject(signal.reason ?? new Error("Cancelled"));
        },
        cleanup = () => {
          this.events.off(id, done);
          signal.removeEventListener("abort", abort);
        };
      this.events.once(id, done);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (!this.live.has(id)) done();
    });
    return this.get(id);
  }
  async close() {
    this.stopped = true;
    await Promise.all(
      [...this.live.keys()].map((id) => this.stop(id, "interrupted")),
    );
    this.events.removeAllListeners();
  }
}
