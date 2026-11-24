import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { canonical, type Triggers } from "./triggers.js";
import type { SubmissionMedia } from "./submission-media.js";
import { ingestUpload } from "./upload-stream.js";
import { triggerError } from "./trigger-schedule.js";

export class TriggerUploads {
  private active = new Map<
    string,
    { workspaceId: string; controller: AbortController; done: Promise<void> }
  >();
  private stopped = false;
  constructor(
    private triggers: Triggers,
    private limits: SubmissionMedia,
  ) {}
  async start() {
    while (true) {
      const rows = this.triggers.db
        .prepare("SELECT id FROM trigger_ingests LIMIT 32")
        .all() as any[];
      if (!rows.length) break;
      for (const r of rows) {
        await this.triggers.artifacts.discardIngest(r.id);
        this.triggers.db
          .prepare("DELETE FROM trigger_ingests WHERE id=?")
          .run(r.id);
      }
    }
  }
  async receive(req: FastifyRequest, sourceId: string) {
    const t = this.triggers,
      source = t.authenticate(sourceId, req.headers.authorization);
    if (this.stopped) triggerError("Event ingestion is shutting down.", 503);
    if (this.active.size >= t.artifacts.maxIngests)
      triggerError("File transfer is busy. Retry shortly.", 429);
    const id = randomUUID(),
      controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((r) => {
      finish = r;
    });
    this.active.set(id, { workspaceId: source.workspaceId, controller, done });
    const abort = () => controller.abort();
    const disconnect = () => req.raw.destroy();
    controller.signal.addEventListener("abort", disconnect, { once: true });
    req.raw.once("aborted", abort);
    req.raw.socket.once("close", abort);
    let committed = false;
    try {
      t.db
        .prepare("INSERT INTO trigger_ingests VALUES(?,?,?)")
        .run(id, source.workspaceId, t.now());
      let manifest: any,
        input: any,
        prior: any,
        index = 0;
      const hashes: unknown[] = [];
      const attachments: { versionId: string; mode: "file" | "inspect" }[] = [];
      for await (const part of req.parts({
        limits: {
          files: this.limits.maxFiles,
          fields: 1,
          fieldSize: 256 * 1024,
          fileSize: Math.min(this.limits.maxBytes, t.artifacts.maxVersionBytes),
          parts: this.limits.maxFiles + 1,
        },
      })) {
        controller.signal.throwIfAborted();
        if (part.type === "field") {
          if (
            manifest ||
            part.fieldname !== "event" ||
            part.valueTruncated ||
            typeof part.value !== "string"
          )
            triggerError("Send one event manifest before the files.");
          try {
            manifest = JSON.parse(part.value as string);
          } catch {
            triggerError("Invalid event manifest JSON.");
          }
          input = t.eventInput({ ...manifest, attachments: [] });
          prior = t.db
            .prepare(
              "SELECT id,attachments,uploadFingerprint FROM trigger_events WHERE workspaceId=? AND sourceKey=? AND eventId=?",
            )
            .get(source.workspaceId, source.id, input.eventId) as any;
          if (prior && !prior.uploadFingerprint)
            triggerError(
              "This event ID was accepted through a different event format.",
              409,
            );
          if (
            !Array.isArray(manifest.attachments) ||
            !manifest.attachments.length ||
            manifest.attachments.length > this.limits.maxFiles
          )
            triggerError("Provide the upload attachment manifest.");
          let total = 0;
          for (const a of manifest.attachments) {
            if (
              !a ||
              typeof a.name !== "string" ||
              !a.name ||
              a.name.length > 240 ||
              !Number.isSafeInteger(a.size) ||
              a.size < 0 ||
              !["file", "inspect"].includes(a.mode) ||
              Object.keys(a).some((k) => !["name", "size", "mode"].includes(k))
            )
              triggerError("Invalid file manifest entry.");
            total += a.size;
          }
          if (!Number.isSafeInteger(total) || total > this.limits.maxBytes)
            triggerError("Attachments exceed the combined upload limit.", 413);
        } else {
          const entry = manifest?.attachments[index];
          if (
            !entry ||
            part.fieldname !== `file${index}` ||
            part.filename !== entry.name
          ) {
            part.file.resume();
            triggerError(
              "File order or filename differs from the event manifest.",
            );
          }
          const received = await ingestUpload(
            t.artifacts,
            { workspaceId: source.workspaceId },
            part,
            entry,
            id,
            controller.signal,
            "event_upload",
            !!prior,
          );
          hashes.push(received.hash);
          if (received.version)
            attachments.push({
              versionId: received.version.id,
              mode: entry.mode,
            });
          index++;
        }
      }
      if (!manifest || index !== manifest.attachments.length)
        triggerError("All event files must finish transferring.");
      controller.signal.throwIfAborted();
      t.authenticate(sourceId, req.headers.authorization);
      if (prior) {
        if (prior.uploadFingerprint !== canonical(hashes))
          triggerError("Event ID was already used for different files.", 409);
        attachments.push(...JSON.parse(prior.attachments));
      }
      const receipt = t.db.transaction(() => {
        const accepted = t.accept(
          source.workspaceId,
          sourceId,
          sourceId,
          { ...input, attachments },
          { internalUpload: true, ingestId: id },
        );
        const same =
          JSON.stringify(accepted.attachments.map((a) => a.versionId)) ===
          JSON.stringify(attachments.map((a) => a.versionId));
        if (same) {
          t.db
            .prepare("UPDATE trigger_events SET uploadFingerprint=? WHERE id=?")
            .run(canonical(hashes), accepted.id);
          t.db
            .prepare(
              "UPDATE artifact_versions SET ingestId=NULL WHERE ingestId=?",
            )
            .run(id);
          t.db.prepare("DELETE FROM trigger_ingests WHERE id=?").run(id);
          committed = true;
        }
        return accepted;
      })();
      return receipt;
    } finally {
      req.raw.off("aborted", abort);
      req.raw.socket.off("close", abort);
      controller.signal.removeEventListener("abort", disconnect);
      try {
        if (!committed) {
          await t.artifacts.discardIngest(id);
          t.db.prepare("DELETE FROM trigger_ingests WHERE id=?").run(id);
        }
      } finally {
        this.active.delete(id);
        finish();
      }
    }
  }
  async settleWorkspace(workspaceId: string) {
    const jobs = [...this.active.values()].filter(
      (x) => x.workspaceId === workspaceId,
    );
    jobs.forEach((j) => j.controller.abort());
    await Promise.all(jobs.map((j) => j.done));
  }
  async close() {
    this.stopped = true;
    const jobs = [...this.active.values()];
    jobs.forEach((j) => j.controller.abort());
    await Promise.all(jobs.map((j) => j.done));
  }
}
