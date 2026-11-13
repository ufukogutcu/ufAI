import { randomUUID, createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyRequest } from "fastify";
import type { AgentExecution } from "./agent-execution.js";
import type { ConnectionService } from "./connection-service.js";
import { MediaService, effectiveMedia } from "./media-service.js";
import { ConnectionError } from "./model-providers.js";
export interface InputAttachment {
  versionId: string;
  name: string;
  mode: "inspect" | "file";
}
export interface UploadOptions {
  maxFiles?: number;
  maxBytes?: number;
}
export class SubmissionMedia {
  private active = new Map<
    string,
    {
      agentId: string;
      workspaceId: string;
      controller: AbortController;
      done: Promise<void>;
    }
  >();
  private stopped = false;
  readonly maxFiles: number;
  readonly maxBytes: number;
  constructor(
    private db: Database.Database,
    private media: MediaService,
    private execution: AgentExecution,
    private connections: ConnectionService,
    options: UploadOptions = {},
  ) {
    this.maxFiles =
      options.maxFiles ?? Number(process.env.UFAI_UPLOAD_MAX_FILES ?? 10);
    this.maxBytes =
      options.maxBytes ??
      Number(process.env.UFAI_UPLOAD_MAX_BYTES ?? 256 * 1024 * 1024);
    if (
      !Number.isSafeInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      this.maxFiles > 100 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1
    )
      throw new Error("Invalid upload limits.");
  }
  async receive(req: FastifyRequest, agentId: string, target: string, envelope: import("./messaging.js").MessageEnvelope = {}) {
    if (this.stopped) throw new ConnectionError("ufAI is shutting down.", 503);
    if (this.active.size >= this.media.artifacts.maxIngests)
      throw new ConnectionError("File transfer is busy. Retry shortly.", 429);
    const agent = this.execution.requiredAgent(agentId),
      id = randomUUID(),
      controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((r) => {
      finish = r;
    });
    this.active.set(id, {
      agentId,
      workspaceId: agent.workspaceId,
      controller,
      done,
    });
    const abort = () => controller.abort();
    req.raw.once("aborted", abort);
    req.raw.socket.once("close", abort);
    const disconnect = () => req.raw.destroy();
    controller.signal.addEventListener("abort", disconnect, { once: true });
    const signal = controller.signal;
    let committed = false;
    try {
      let priorAtStart: any;
      let manifest: any,
        content = "",
        requestId = "",
        index = 0,
        total = 0;
      const attachments: InputAttachment[] = [],
        hashes: any[] = [];
      for await (const part of req.parts({
        limits: {
          files: this.maxFiles,
          fields: 1,
          fieldSize: 256 * 1024,
          fileSize: Math.min(
            this.maxBytes,
            this.media.artifacts.maxVersionBytes,
          ),
          parts: this.maxFiles + 1,
        },
      })) {
        signal.throwIfAborted();
        if (part.type === "field") {
          if (
            manifest ||
            part.fieldname !== "message" ||
            part.valueTruncated ||
            typeof part.value !== "string"
          )
            throw new ConnectionError(
              "Send one message manifest before the files.",
              400,
            );
          try {
            manifest = JSON.parse(part.value);
          } catch {
            throw new ConnectionError("Invalid attachment manifest.", 400);
          }
          if (
            !manifest ||
            Object.keys(manifest).some(
              (k) => !["content", "requestId", "attachments"].includes(k),
            ) ||
            typeof manifest.content !== "string" ||
            manifest.content.length > 12000 ||
            typeof manifest.requestId !== "string" ||
            !/^[a-zA-Z0-9_-]{8,100}$/.test(manifest.requestId) ||
            !Array.isArray(manifest.attachments) ||
            !manifest.attachments.length ||
            manifest.attachments.length > this.maxFiles
          )
            throw new ConnectionError(
              "Invalid message or attachment manifest.",
              400,
            );
          content = manifest.content.trim();
          requestId = manifest.requestId;
          for (const a of manifest.attachments)
            if (
              !a ||
              typeof a.name !== "string" ||
              a.name.length > 240 ||
              !a.name ||
              !Number.isSafeInteger(a.size) ||
              a.size < 0 ||
              !["inspect", "file"].includes(a.mode) ||
              Object.keys(a).some((k) => !["name", "size", "mode"].includes(k))
            )
              throw new ConnectionError("Invalid attachment entry.", 400);
          total = manifest.attachments.reduce(
            (n: number, a: any) => n + a.size,
            0,
          );
          if (!Number.isSafeInteger(total) || total > this.maxBytes)
            throw new ConnectionError(
              "Attachments exceed the combined upload limit.",
              413,
            );
          priorAtStart = this.db
            .prepare("SELECT * FROM agent_submissions WHERE requestId=?")
            .get(requestId);
          if (
            priorAtStart &&
            (priorAtStart.agentId !== agentId ||
              priorAtStart.target !== target ||
              priorAtStart.content !== content)
          )
            throw new ConnectionError(
              "This request ID was used for different input.",
              409,
            );
          if (!priorAtStart)
            this.db
              .prepare(
                "INSERT INTO submission_ingests VALUES (?,?,?,?, 'receiving',?)",
              )
              .run(
                id,
                agent.workspaceId,
                agentId,
                requestId,
                new Date().toISOString(),
              );
        } else {
          const entry = manifest?.attachments[index];
          if (
            !entry ||
            part.fieldname !== `file${index}` ||
            part.filename !== entry.name
          ) {
            part.file.resume();
            throw new ConnectionError(
              "File order or filename differs from the manifest.",
              400,
            );
          }
          const onAbort = () =>
            part.file.destroy(
              new ConnectionError("File transfer cancelled.", 409),
            );
          signal.addEventListener("abort", onAbort, { once: true });
          let v;
          try {
            if (priorAtStart) {
              const hash = createHash("sha256");
              let read = 0;
              for await (const bytes of part.file) {
                signal.throwIfAborted();
                read += bytes.length;
                if (read > entry.size)
                  throw new ConnectionError(
                    "File differs from the manifest.",
                    409,
                  );
                hash.update(bytes);
              }
              if (read !== entry.size || part.file.truncated)
                throw new ConnectionError("File transfer was incomplete.", 409);
              hashes.push({
                name: entry.name,
                size: read,
                sha256: hash.digest("hex"),
                mode: entry.mode,
              });
              index++;
              continue;
            }
            v = await this.media.artifacts.publish(
              { workspaceId: agent.workspaceId, agentId },
              {
                stream: part.file,
                size: entry.size,
                name: entry.name,
                origin: "user_upload",
                ingestId: id,
              },
              signal,
            );
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
          if (part.file.truncated)
            throw new ConnectionError("File exceeds the upload limit.", 413);
          const mode =
            entry.mode === "inspect" && v.mediaType.startsWith("image/")
              ? "inspect"
              : "file";
          attachments.push({ versionId: v.id, name: v.name, mode });
          hashes.push({
            name: entry.name,
            size: v.size,
            sha256: v.sha256,
            mode: entry.mode,
          });
          index++;
        }
      }
      signal.throwIfAborted();
      if (!manifest || index !== manifest.attachments.length)
        throw new ConnectionError(
          "All message attachments must finish transferring.",
          400,
        );
      const fingerprint = JSON.stringify(hashes);
      const prior = this.db
        .prepare("SELECT * FROM agent_submissions WHERE requestId=?")
        .get(requestId) as any;
      if (prior) {
        if (
          prior.agentId !== agentId ||
          prior.target !== target ||
          prior.content !== content ||
          prior.attachmentFingerprint !== fingerprint
        )
          throw new ConnectionError(
            "This request ID was used for different input.",
            409,
          );
        return { taskId: prior.taskId, turnId: prior.turnId };
      }
      const inspect = attachments.filter((a) => a.mode === "inspect");
      if (inspect.length) {
        const s = this.connections.snapshot(agent),
          caps = effectiveMedia(
            s.provider,
            this.connections.models.get(s.connectionId, s.modelId),
          );
        await this.media.prepare(
          inspect.map((a) =>
            this.media.reference(a.versionId, agent.workspaceId, id),
          ),
          agent.workspaceId,
          caps,
          id,
        );
      }
      signal.throwIfAborted();
      const accepted = this.db.transaction(() => {
        const reused = !!this.db
          .prepare("SELECT 1 FROM agent_submissions WHERE requestId=?")
          .get(requestId);
        const result = this.execution.submit(
          agentId,
          target,
          content,
          requestId,
          attachments,
          fingerprint,
          envelope,
        );
        if (!reused) {
          this.db
            .prepare(
              "UPDATE artifact_versions SET ingestId=NULL WHERE ingestId=?",
            )
            .run(id);
          this.db.prepare("DELETE FROM submission_ingests WHERE id=?").run(id);
        }
        return { result, reused };
      })();
      committed = !accepted.reused;
      return accepted.result;
    } finally {
      req.raw.socket.off("close", abort);
      req.raw.off("aborted", abort);
      controller.signal.removeEventListener("abort", disconnect);
      try {
        if (!committed) await this.media.artifacts.discardIngest(id);
      } finally {
        this.active.delete(id);
        finish();
      }
    }
  }
  async settleAgents(ids: string[]) {
    const active = [...this.active.values()].filter((a) =>
      ids.includes(a.agentId),
    );
    active.forEach((a) => a.controller.abort());
    await Promise.all(active.map((a) => a.done));
  }
  async settleWorkspace(id: string) {
    const active = [...this.active.values()].filter(
      (a) => a.workspaceId === id,
    );
    active.forEach((a) => a.controller.abort());
    await Promise.all(active.map((a) => a.done));
  }
  async close() {
    this.stopped = true;
    const active = [...this.active.values()];
    active.forEach((a) => a.controller.abort());
    await Promise.all(active.map((a) => a.done));
  }
}
