import type { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { guard } from "./connections.js";
import { pagination } from "./validation.js";
import { ConnectionError } from "./model-providers.js";
import { Vault, vaultObject } from "./vault.js";

export function registerVault(app: FastifyInstance, vault: Vault, events: EventEmitter) {
  app.register(async scoped => {
    let streams = 0;
    scoped.addHook("onRequest", async (req, reply) => {
      guard(req);
      reply.header("Cache-Control", "no-store");
    });
    scoped.get("/api/vault/events", async (req, reply) => {
      if (streams >= 32) throw new ConnectionError("Too many Vault viewers. Close an unused tab and retry.", 429);
      streams++;
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const send = () => { timer = undefined; if (!reply.raw.destroyed && reply.raw.writableLength < 65536) reply.raw.write("event: change\ndata: {}\n\n"); };
      const changed = () => { timer ??= setTimeout(send, 350); };
      const heartbeat = setInterval(() => { if (!reply.raw.destroyed && reply.raw.writableLength < 65536) reply.raw.write(": keepalive\n\n"); }, 20000);
      heartbeat.unref();
      let closed = false;
      const cleanup = () => { if (closed) return; closed = true; streams--; clearTimeout(timer); clearInterval(heartbeat); events.off("change", changed); events.off("close", stop); reply.raw.off("close", cleanup); };
      const stop = () => { cleanup(); reply.raw.end(); };
      reply.raw.on("close", cleanup);
      events.on("change", changed); events.on("close", stop);
      send();
    });
    scoped.get<{ Querystring: { query?: string; limit?: string; offset?: string } }>("/api/vault/secrets", req => {
      const p = pagination(req.query);
      return vault.list((req.query.query ?? "").slice(0, 160), p.offset, p.limit);
    });
    scoped.post("/api/vault/secrets", (req, reply) => reply.code(201).send(vault.save(req.body)));
    scoped.get<{ Params: { id: string } }>("/api/vault/secrets/:id", req => vault.detail(req.params.id));
    scoped.patch<{ Params: { id: string } }>("/api/vault/secrets/:id", req => vault.save(req.body, req.params.id));
    scoped.delete<{ Params: { id: string } }>("/api/vault/secrets/:id", (req, reply) => {
      vault.delete(req.params.id, vaultObject(req.body, ["expectedRevision"]).expectedRevision);
      return reply.code(204).send();
    });
    scoped.post<{ Params: { id: string } }>("/api/vault/secrets/:id/reveal", req => ({ value: vault.value(req.params.id) }));
    scoped.get<{ Querystring: { taskId?: string; limit?: string; offset?: string } }>("/api/user-input-requests", req => {
      const p = pagination(req.query);
      return vault.requests(req.query.taskId, p.offset, p.limit);
    });
    scoped.get<{ Params: { id: string } }>("/api/user-input-requests/:id", req => vault.requestDetail(req.params.id));
    scoped.post<{ Params: { id: string } }>("/api/user-input-requests/:id/resolve", req => vault.resolve(req.params.id, req.body));
    scoped.post<{ Params: { id: string } }>("/api/user-input-requests/:id/cancel", req => {
      const r = vault.cancel(req.params.id); vault.messaging?.inputsChanged(r.taskId); return r;
    });
  });
}
