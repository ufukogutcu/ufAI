import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { BrowserService } from "./browser-service.js";
import { browserAction } from "./browser-validation.js";
import { guard } from "./connections.js";
import { ConnectionError } from "./model-providers.js";
import { managedDirectory } from "./host-paths.js";
import type { ManagedFiles } from "./managed-files.js";

function invalid(): never { throw new ConnectionError("Invalid browser request.", 400); }

export function registerBrowser(app: FastifyInstance, browsers: BrowserService, files: ManagedFiles) {
  const prefix = "/api/agents/:id/browser";
  app.addHook("onRequest", async request => { if (/^\/api\/agents\/[^/]+\/browser(?:\/|\?|$)/.test(request.url)) guard(request); });
  app.get<{ Params: { id: string } }>(prefix, (request, reply) => { reply.header("Cache-Control", "no-store"); return browsers.state(request.params.id); });
  app.post<{ Params: { id: string } }>(`${prefix}/start`, request => browsers.start(request.params.id));
  app.get<{ Params: { id: string } }>(`${prefix}/stream`, {
    websocket: true,
    preValidation: async request => { browsers.assertEnabled(request.params.id); },
  }, (socket, request) => {
    let viewerId: string;
    try { viewerId = browsers.attach(request.params.id, socket); }
    catch { socket.close(4003, "Browser unavailable"); return; }
    let pending = 0;
    const connectionAbort = new AbortController();
    socket.once("close", () => connectionAbort.abort());
    socket.on("message", raw => {
      if (pending >= 32) { socket.close(4008, "Browser input queue full"); return; }
      let value: { type?: string; take?: boolean; action?: unknown };
      try { value = JSON.parse(raw.toString()); } catch { socket.close(4000, "Invalid message"); return; }
      pending++;
      void (async () => {
        if (value.type === "control" && typeof value.take === "boolean") await browsers.control(request.params.id, viewerId, value.take);
        else if (value.type === "action") await browsers.action(request.params.id, browserAction(value.action), connectionAbort.signal, viewerId);
        else invalid();
      })().catch(error => {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: "error", error: error instanceof ConnectionError ? error.message : "Browser action failed. Refresh the page state before retrying." }));
      }).finally(() => { pending--; });
    });
  });
  app.post<{ Params: { id: string }; Body: { viewerId?: string; action?: unknown } }>(`${prefix}/actions`, async (request, reply) => {
    const { viewerId, action } = request.body ?? {};
    if (typeof viewerId !== "string") invalid();
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once("close", abort);
    try { return await browsers.action(request.params.id, browserAction(action), controller.signal, viewerId); }
    finally { reply.raw.removeListener("close", abort); }
  });
  // A viewer identity is only valid while its origin-checked WebSocket remains connected.
  app.post<{ Params: { id: string }; Querystring: { viewerId?: string } }>(`${prefix}/uploads`, async (request, reply) => {
    browsers.assertEnabled(request.params.id);
    const viewerId = request.query.viewerId;
    if (typeof viewerId !== "string" || !viewerId) invalid();
    const incoming = browsers.beginUpload(request.params.id, viewerId);
    const controller = incoming.controller;
    let staging: string | undefined;
    const stopInput = () => request.raw.destroy();
    controller.signal.addEventListener("abort", stopInput, { once: true });
    try {
      const location = await files.repair("agent", request.params.id);
      if (location.state !== "ready") throw new ConnectionError("Agent folder is unavailable.", 409);
      const folder = await managedDirectory(join(dirname(location.path), "browser", "uploads"), true);
      staging = await mkdtemp(join(folder, "upload-"));
      const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
      reply.raw.once("close", abort);
      try {
        let total = 0; const paths: string[] = [];
        for await (const part of request.parts({ limits: { files: 10, fields: 0, parts: 10, fileSize: browsers.maxTransferBytes } })) {
          if (part.type !== "file") invalid();
          const name = part.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload";
          const slot = await managedDirectory(join(staging!, String(paths.length)), true);
          const path = join(slot, name === "." || name === ".." ? "upload" : name);
          const limit = new Transform({ transform(chunk: Buffer, _encoding, next) { total += chunk.length; next(total > browsers.maxTransferBytes ? new ConnectionError("Browser upload exceeds the transfer limit.", 413) : null, chunk); } });
          await pipeline(part.file, limit, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
          if (part.file.truncated) throw new ConnectionError("Browser upload exceeds the transfer limit.", 413);
          paths.push(path);
        }
        return await browsers.upload(request.params.id, paths, undefined, controller.signal, viewerId);
      } finally { reply.raw.removeListener("close", abort); }
    } finally {
      try { if (staging) await rm(staging, { recursive: true, force: true }); }
      finally { controller.signal.removeEventListener("abort", stopInput); incoming.finish(); }
    }
  });
}
