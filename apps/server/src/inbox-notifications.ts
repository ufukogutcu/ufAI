import type { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { InboxEntry, InboxNotification, InboxNotifications } from "./contracts.js";
import { guard } from "./connections.js";
import { ConnectionError } from "./model-providers.js";
import { InputError } from "./validation.js";

export function inboxPreview(content: string, privateInput: boolean) {
  // Retained Inbox rows lose their request FK when its owning agent is deleted.
  if (privateInput || content.startsWith("Private input requested: ")) return "Private input requested. Open Inbox to respond.";
  return content.slice(0, 2000)
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, "")
    .replace(/<[^>]*>/g, " ").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_#~]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 180) || "New Inbox message.";
}

export function registerInboxNotifications(app: FastifyInstance, db: Database.Database, events: EventEmitter) {
  const latest = db.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='workspace_inbox'),0) AS cursor");
  const unread = db.prepare("SELECT count(*) AS total FROM workspace_inbox WHERE readAt IS NULL");
  const arrivals = db.prepare(`SELECT i.sequence,i.id,i.workspaceId,w.name AS workspaceName,i.agentName,
    substr(i.content,1,2000) AS content,i.userInputRequestId,r.kind AS inputKind,i.readAt FROM workspace_inbox i LEFT JOIN user_input_requests r ON r.id=i.userInputRequestId
    JOIN workspaces w ON w.id=i.workspaceId WHERE i.sequence>? AND i.sequence<=? ORDER BY i.sequence LIMIT 101`);
  const snapshot = db.transaction((after?: number): InboxNotifications => {
    const { cursor } = latest.get() as { cursor: number };
    if (after !== undefined && after > cursor) throw new InputError({ after: "The Inbox cursor is no longer valid. Refresh ufAI." });
    const rows = after === undefined ? [] : arrivals.all(after, cursor) as (InboxNotification & { content: string; userInputRequestId: string | null; inputKind: string | null })[];
    const hasMore = rows.length > 100;
    const items = rows.slice(0, 100).map(({ content, userInputRequestId, inputKind, ...row }) => ({ ...row, preview: inboxPreview(content, !!userInputRequestId && inputKind === "secret") }));
    return { cursor: hasMore ? items.at(-1)!.sequence : cursor, unreadTotal: (unread.get() as { total: number }).total, items, hasMore };
  });
  let streams = 0;
  app.register(async scoped => {
    scoped.addHook("onRequest", async (req, reply) => { guard(req); reply.header("Cache-Control", "no-store"); });
    scoped.get<{ Querystring: { after?: string } }>("/api/inbox/notifications", req => {
      const after = req.query.after;
      if (after !== undefined && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))))
        throw new InputError({ after: "Use a non-negative safe integer cursor." });
      return snapshot(after === undefined ? undefined : Number(after));
    });
    scoped.get<{ Params: { id: string } }>("/api/inbox/:id", req => {
      const row = db.prepare("SELECT * FROM workspace_inbox WHERE id=?").get(req.params.id) as (Omit<InboxEntry, "attachments"> & { attachments: string }) | undefined;
      if (!row) throw new ConnectionError("Inbox message not found.", 404);
      return { ...row, attachments: JSON.parse(row.attachments) };
    });
    scoped.get("/api/inbox/events", async (_req, reply) => {
      if (streams >= 32) throw new ConnectionError("Too many Inbox viewers. Close an unused tab and retry.", 429);
      streams++;
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (closed) return;
        closed = true; streams--; clearTimeout(timer); clearInterval(heartbeat);
        events.off("change", changed); events.off("close", stop); reply.raw.off("close", cleanup);
      };
      const stop = () => { cleanup(); reply.raw.end(); };
      const write = (data: string) => {
        if (closed) return;
        if (reply.raw.destroyed || reply.raw.writableLength > 65536 || !reply.raw.write(data)) stop();
      };
      const send = () => { timer = undefined; write("event: change\ndata: {}\n\n"); };
      const changed = () => { if (!closed) timer ??= setTimeout(send, 350); };
      const heartbeat = setInterval(() => write(": heartbeat\n\n"), 20000);
      heartbeat.unref();
      events.on("change", changed); events.on("close", stop); reply.raw.on("close", cleanup);
      send();
    });
  });
}
