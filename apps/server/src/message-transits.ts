import type Database from "better-sqlite3";
import type { MessageTransit } from "./contracts.js";
import { ConnectionError } from "./model-providers.js";

export function migrateMessageTransits(db: Database.Database) {
  db.exec(`CREATE TABLE message_transits (
    messageId TEXT PRIMARY KEY REFERENCES communication_messages(id) ON DELETE CASCADE,
    workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    requestId TEXT NOT NULL REFERENCES agent_requests(id) ON DELETE CASCADE,
    linkId TEXT NOT NULL, senderAgentId TEXT NOT NULL, recipientAgentId TEXT NOT NULL,
    recipientTaskId TEXT, startedAt TEXT NOT NULL, arrivesAt TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('in_flight','arrived','cancelled'))
  );
  CREATE INDEX message_transits_due ON message_transits(state,arrivesAt,messageId);
  CREATE INDEX message_transits_workspace ON message_transits(workspaceId,state,startedAt,messageId);
  CREATE INDEX message_transits_request ON message_transits(requestId,senderAgentId,state,arrivesAt);
  CREATE INDEX communication_deliveries_turn ON communication_deliveries(turnId) WHERE turnId IS NOT NULL;`);
}

export function messageTravelDuration(distance: number) {
  return Math.round(Math.min(2400, Math.max(600, distance / 500 * 1000)));
}

type Waiter = { finish: (error?: Error) => void };

/** Durable deadlines own delivery; browsers only draw the shared timeline. */
export class MessageTransits {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private waiters = new Map<string, Set<Waiter>>();
  constructor(
    private db: Database.Database,
    private changed: (workspaceId: string) => void,
    private arrived: (messageId: string) => void,
  ) {}

  create(messageId: string, request: { id: string; workspaceId: string; linkId: string }, senderAgentId: string, recipientTaskId: string): MessageTransit | undefined {
    const peers = this.db.prepare(`SELECT a.x,a.y,b.x AS targetX,b.y AS targetY,b.id AS recipientAgentId
      FROM agents a JOIN agent_tasks t ON t.id=? JOIN agents b ON b.id=t.agentId
      JOIN communication_links l ON l.id=? AND l.state='active' WHERE a.id=?`).get(recipientTaskId, request.linkId, senderAgentId) as
      { x: number; y: number; targetX: number; targetY: number; recipientAgentId: string } | undefined;
    if (!peers) return;
    const startedAt = new Date().toISOString();
    const previous = this.db.prepare("SELECT max(arrivesAt) AS deadline FROM message_transits WHERE requestId=? AND senderAgentId=? AND state='in_flight'").get(request.id, senderAgentId) as { deadline: string | null };
    const arrivesAt = new Date(Math.max(Date.parse(startedAt) + messageTravelDuration(Math.hypot(peers.targetX - peers.x, peers.targetY - peers.y)), Date.parse(previous.deadline ?? startedAt))).toISOString();
    const transit: MessageTransit = { messageId, workspaceId: request.workspaceId, requestId: request.id, linkId: request.linkId, senderAgentId, recipientAgentId: peers.recipientAgentId, startedAt, arrivesAt, state: "in_flight" };
    this.db.prepare(`INSERT INTO message_transits(messageId,workspaceId,requestId,linkId,senderAgentId,recipientAgentId,recipientTaskId,startedAt,arrivesAt,state)
      VALUES (?,?,?,?,?,?,?,?,?,'in_flight')`).run(messageId, request.workspaceId, request.id, request.linkId, senderAgentId, peers.recipientAgentId, recipientTaskId, startedAt, arrivesAt);
    this.changed(request.workspaceId);
    this.schedule();
    return transit;
  }

  private cancelled(messageId: string) {
    this.db.prepare("UPDATE communication_deliveries SET state='recorded' WHERE messageId=? AND state='pending'").run(messageId);
    this.settle(messageId, new ConnectionError("Message delivery was cancelled."));
  }

  private settle(messageId: string, error?: Error) {
    for (const waiter of this.waiters.get(messageId) ?? []) waiter.finish(error);
  }

  wait(messageId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const row = this.db.prepare("SELECT state FROM message_transits WHERE messageId=?").get(messageId) as { state: string } | undefined;
    if (!row || row.state === "arrived") return Promise.resolve();
    if (this.stopped || row.state === "cancelled") return Promise.reject(new ConnectionError("Message delivery was cancelled."));
    return new Promise((resolve, reject) => {
      const abort = () => waiter.finish(signal.reason instanceof Error ? signal.reason : new Error("Message wait cancelled."));
      const waiter: Waiter = { finish: (error) => {
        signal.removeEventListener("abort", abort);
        const set = this.waiters.get(messageId);
        set?.delete(waiter);
        if (!set?.size) this.waiters.delete(messageId);
        if (!this.waiters.size) this.timer?.unref();
        if (error) reject(error); else resolve();
      } };
      const set = this.waiters.get(messageId) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(messageId, set);
      signal.addEventListener("abort", abort, { once: true });
      this.timer?.ref();
    });
  }

  cancel(field: "linkId" | "recipientAgentId" | "recipientTaskId", id: string) {
    const rows = this.db.transaction(() => {
      const rows = this.db.prepare(`UPDATE message_transits SET state='cancelled' WHERE ${field}=? AND state='in_flight' RETURNING messageId,workspaceId`).all(id) as { messageId: string; workspaceId: string }[];
      for (const row of rows) this.cancelled(row.messageId);
      return rows;
    })();
    for (const workspaceId of new Set(rows.map(row => row.workspaceId))) this.changed(workspaceId);
    this.schedule();
  }

  reconcile() {
    if (this.stopped) return;
    // Startup and periodic repair also cover deletion/revocation committed before a crash.
    const cancelled = this.db.transaction(() => {
      const rows = this.db.prepare(`UPDATE message_transits SET state='cancelled' WHERE messageId IN (
      SELECT mt.messageId FROM message_transits mt
      LEFT JOIN communication_links l ON l.id=mt.linkId
      LEFT JOIN agent_tasks t ON t.id=mt.recipientTaskId
      WHERE mt.state='in_flight' AND (l.id IS NULL OR l.state!='active' OR t.id IS NULL OR t.status='cancelled')
      LIMIT 128) RETURNING messageId,workspaceId`).all() as { messageId: string; workspaceId: string }[];
      for (const row of rows) this.cancelled(row.messageId);
      return rows;
    })();
    for (const workspaceId of new Set(cancelled.map(row => row.workspaceId))) this.changed(workspaceId);
    const rows = this.db.prepare(`SELECT mt.messageId,mt.workspaceId FROM message_transits mt
      JOIN communication_messages m ON m.id=mt.messageId
      JOIN communication_links l ON l.id=mt.linkId AND l.state='active'
      JOIN agent_tasks t ON t.id=mt.recipientTaskId AND t.status!='cancelled'
      WHERE mt.state='in_flight' AND mt.arrivesAt<=? ORDER BY mt.arrivesAt,m.sequence LIMIT 128`
    ).all(new Date().toISOString()) as { messageId: string; workspaceId: string }[];
    this.db.transaction(() => {
      // Release the whole due batch before batching recipient inputs, preserving
      // their original message sequence when several envelopes arrive together.
      const update = this.db.prepare("UPDATE message_transits SET state='arrived' WHERE messageId=? AND state='in_flight'");
      for (const row of rows) update.run(row.messageId);
      for (const row of rows) this.arrived(row.messageId);
    })();
    for (const row of rows) this.settle(row.messageId);
    for (const workspaceId of new Set(rows.map(row => row.workspaceId))) this.changed(workspaceId);
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const next = this.db.prepare("SELECT arrivesAt FROM message_transits WHERE state='in_flight' ORDER BY arrivesAt,messageId LIMIT 1").get() as { arrivesAt: string } | undefined;
    if (next) {
      this.timer = setTimeout(() => this.reconcile(), Math.max(0, Date.parse(next.arrivesAt) - Date.now()));
      if (!this.waiters.size) this.timer.unref();
    }
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const id of this.waiters.keys()) this.settle(id, new ConnectionError("ufAI is shutting down.", 503));
  }
}
