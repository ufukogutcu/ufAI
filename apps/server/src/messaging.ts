import { MessageTransits } from "./message-transits.js";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { AgentExecution } from "./agent-execution.js";
import type { ConnectionService } from "./connection-service.js";
import type { ToolOwner } from "./process-service.js";
import { ConnectionError } from "./model-providers.js";
import { guard } from "./connections.js";
import { pagination, objectBody } from "./validation.js";
import type { TaskCheckIn } from "./contracts.js";

const now = () => new Date().toISOString();
const fail = (message: string, code = 409): never => {
  throw new ConnectionError(message, code);
};
export interface MessageEnvelope {
  source?: "user" | "agent" | "system";
  senderId?: string;
  requestId?: string;
  messageId?: string;
  replyKind?: "result" | "answer" | "none" | "inbox";
  inboxId?: string;
  rootWorkflowId?: string;
  parentRequestId?: string;
  causationId?: string;
  continuation?: boolean;
  incomingMessages?: {
    messageId: string;
    requestId: string | null;
    kind: string;
  }[];
}
export class MessagingService {
  readonly transits: MessageTransits;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private operations = new Map<string, Promise<void>>();
  private checkinCursor = "";
  constructor(
    readonly db: Database.Database,
    readonly execution: AgentExecution,
    private connections: ConnectionService,
  ) {
    this.transits = new MessageTransits(db,
      workspaceId => execution.workspaceEvent(workspaceId, "message-transit"),
      messageId => { this.deliver(messageId); execution.wake(); });
  }
  start() {
    this.db
      .prepare(
        "UPDATE messaging_operations SET state='pending' WHERE state='running'",
      )
      .run();
    this.transits.reconcile();
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  private owner(id: string): any {
    const a = this.execution.requiredAgent(id);
    this.execution.assertWorkspaceAvailable(a.workspaceId);
    return a;
  }
  private task(id: string): any {
    return this.execution.task(id);
  }
  readRequest(id: string): any {
    return this.request(id);
  }
  private request(id: string): any {
    const row = this.db
      .prepare(
        "SELECT r.*,(SELECT status FROM agent_tasks WHERE id=r.targetTaskId) executionState,(SELECT error FROM agent_tasks WHERE id=r.targetTaskId) executionError FROM agent_requests r WHERE r.id=?",
      )
      .get(id);
    if (!row) fail("Request not found.", 404);
    return row;
  }
  private participant(owner: ToolOwner, id: string): any {
    const r = this.request(id);
    if (
      r.workspaceId !== owner.workspaceId ||
      ![r.sourceTaskId, r.targetTaskId].includes(owner.taskId)
    )
      fail("Request is outside this task.", 403);
    return r;
  }
  assertAgentDeletionAvailable(id: string) {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM messaging_operations o JOIN communication_links l ON l.id=o.linkId WHERE o.state!='completed' AND (l.sourceAgentId=? OR l.targetAgentId=?) LIMIT 1",
        )
        .get(id, id)
    )
      fail(
        "Finish or retry this agent's communication-link removal before deleting it.",
      );
  }
  assertOwner(owner: ToolOwner) {
    const row = this.db
      .prepare(
        "SELECT envelope FROM agent_turns WHERE id=? AND taskId=? AND agentId=?",
      )
      .get(owner.turnId, owner.taskId, owner.agentId) as
      | { envelope: string }
      | undefined;
    if (
      !row ||
      this.task(owner.taskId).agentId !== owner.agentId ||
      this.owner(owner.agentId).workspaceId !== owner.workspaceId
    )
      fail("This tool does not belong to the executing task.", 403);
    this.assertTask(
      owner.taskId,
      row ? (JSON.parse(row.envelope).source ?? "user") : "agent",
    );
  }
  assertTask(id: string, source: string = "agent") {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM messaging_operations o,json_each(o.taskIds) t WHERE t.value=? AND o.state!='completed' LIMIT 1",
        )
        .get(id)
    )
      fail("Communication revocation is settling this task.", 403);
    if (source === "user") return;
    if (
      this.db
        .prepare(
          "SELECT 1 FROM agent_requests WHERE targetTaskId=? AND state IN ('revoking','revoked','expired')",
        )
        .get(id)
    )
      fail("This request no longer permits execution.", 403);
  }
  assertVersion(owner: Pick<ToolOwner, "workspaceId" | "taskId">, id: string) {
    const v = this.db
      .prepare("SELECT * FROM artifact_versions WHERE id=?")
      .get(id) as any;
    if (!v || v.workspaceId !== owner.workspaceId)
      fail("Artifact is outside this workspace.", 403);
    if (v.state !== "ready" || v.ingestId)
      fail("Artifact bytes are unavailable.");
    if (
      v.origin === "published" ||
      v.producerTaskId === owner.taskId ||
      this.db
        .prepare("SELECT 1 FROM artifact_grants WHERE taskId=? AND versionId=?")
        .get(owner.taskId, id) ||
      this.db
        .prepare(
          "SELECT 1 FROM artifact_references r JOIN agent_messages m ON m.id=r.messageId JOIN agent_tasks t ON t.conversationId=m.conversationId WHERE t.id=? AND r.versionId=?",
        )
        .get(owner.taskId, id)
    )
      return v;
    fail("This private file has not been shared with this task.", 403);
  }
  private attachments(owner: ToolOwner, ids: unknown = []): string[] {
    if (
      !Array.isArray(ids) ||
      ids.length > 10 ||
      ids.some((x) => typeof x !== "string" || x.length > 100)
    )
      fail("Supply at most ten artifact version IDs.", 400);
    (ids as string[]).forEach((id) => this.assertVersion(owner, id));
    return ids as string[];
  }
  private text(value: unknown, allowEmpty = false): string {
    if (
      typeof value !== "string" ||
      value.length > 12000 ||
      value.includes("\0") ||
      (!allowEmpty && !value.trim())
    )
      fail("Use 1–12,000 characters.", 400);
    return (value as string).trim();
  }
  private once<T>(
    key: string,
    workspaceId: string,
    fingerprint: unknown,
    action: () => T,
  ): T {
    const encoded = JSON.stringify(fingerprint);
    const old = this.db
      .prepare("SELECT * FROM messaging_idempotency WHERE id=?")
      .get(key) as any;
    if (old) {
      if (old.workspaceId !== workspaceId || old.fingerprint !== encoded)
        fail("Message ID was reused for different input.");
      return JSON.parse(old.result);
    }
    return this.db.transaction(() => {
      const result = action();
      this.db
        .prepare("INSERT INTO messaging_idempotency VALUES (?,?,?,?)")
        .run(key, workspaceId, encoded, JSON.stringify(result));
      return result;
    })();
  }
  private changed(workspaceId: string) {
    this.execution.workspaceEvent(workspaceId, "communication");
    this.execution.wake();
  }
  checkIns(taskId: string, limit = 20, offset = 0) {
    this.task(taskId);
    return {
      items: this.db
        .prepare(
          "SELECT id,taskId,requestId,reason,dueAt,state,deliveredTurnId,createdAt,updatedAt FROM task_checkins WHERE taskId=? ORDER BY (state='scheduled' OR (state='fired' AND deliveredTurnId IS NULL)) DESC,dueAt,id LIMIT ? OFFSET ?",
        )
        .all(taskId, limit, offset) as TaskCheckIn[],
      total: (
        this.db
          .prepare("SELECT count(*) n FROM task_checkins WHERE taskId=?")
          .get(taskId) as { n: number }
      ).n,
    };
  }
  private hasReplyDependency(taskId: string) {
    return !!this.db
      .prepare(
        `SELECT 1 FROM agent_requests WHERE sourceTaskId=? AND state='open' AND kind='request'
      UNION ALL SELECT 1 FROM communication_messages m JOIN agent_requests r ON r.id=m.requestId WHERE senderTaskId=? AND m.kind='question' AND answered=0 AND r.state='open'
      UNION ALL SELECT 1 FROM communication_messages m JOIN communication_deliveries d ON d.messageId=m.id
        WHERE m.recipientTaskId=? AND d.state='pending' LIMIT 1`,
      )
      .get(taskId, taskId, taskId);
  }
  private pendingReason(taskId: string) {
    if (this.hasReplyDependency(taskId)) return "message";
    return this.db
      .prepare(
        "SELECT 1 FROM task_checkins WHERE taskId=? AND (state='scheduled' OR (state='fired' AND deliveredTurnId IS NULL)) LIMIT 1",
      )
      .get(taskId)
      ? "check_in"
      : null;
  }
  private refreshPending(taskId: string) {
    const reason = this.pendingReason(taskId);
    this.db
      .prepare(
        "UPDATE agent_tasks SET pendingReason=?,status=CASE WHEN status='waiting' AND pendingReason IS NOT NULL AND ? IS NULL THEN 'awaiting_user' ELSE status END WHERE id=?",
      )
      .run(reason, reason, taskId);
  }
  scheduleCheckIn(owner: ToolOwner, args: any, key: string) {
    this.assertOwner(owner);
    return this.once(key, owner.workspaceId, args, () => {
      const due = Date.now() + args.afterMs;
      if (
        !Number.isSafeInteger(args.afterMs) ||
        args.afterMs <= 0 ||
        !Number.isSafeInteger(due) ||
        due > 253402300799999
      )
        fail(
          "Use a positive whole-millisecond delay within the supported date range.",
          400,
        );
      const reason = this.text(args.reason);
      let replied = false;
      if (args.requestId) {
        const request = this.participant(owner, args.requestId);
        replied =
          request.state !== "open" ||
          !!this.db
            .prepare(
              `SELECT 1 FROM communication_messages m
          WHERE requestId=? AND recipientTaskId=? AND kind!='progress' AND sequence>
            (SELECT coalesce(max(sequence),0) FROM communication_messages WHERE requestId=? AND senderTaskId=? AND kind!='progress') LIMIT 1`,
            )
            .get(request.id, owner.taskId, request.id, owner.taskId);
      }
      const id = randomUUID(),
        stamp = now();
      const envelope = (
        this.db
          .prepare("SELECT envelope FROM agent_turns WHERE id=?")
          .get(owner.turnId) as { envelope: string }
      ).envelope;
      this.db
        .prepare(
          "INSERT INTO task_checkins(id,taskId,requestId,reason,dueAt,state,createdAt,updatedAt,returnEnvelope) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          owner.taskId,
          args.requestId ?? null,
          reason,
          new Date(due).toISOString(),
          replied ? "cancelled" : "scheduled",
          stamp,
          stamp,
          envelope,
        );
      this.refreshPending(owner.taskId);
      this.changed(owner.workspaceId);
      return {
        checkinId: id,
        dueAt: new Date(due).toISOString(),
        state: replied ? "cancelled" : "scheduled",
        ...(replied ? { reason: "A response already arrived." } : {}),
      };
    });
  }
  cancelCheckIn(taskId: string, id: string) {
    const task = this.task(taskId);
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT id FROM task_checkins WHERE id=? AND taskId=?")
        .get(id, taskId);
      if (!row) fail("Check-in not found for this task.", 404);
      this.db
        .prepare(
          "UPDATE task_checkins SET state='cancelled',updatedAt=? WHERE id=? AND (state='scheduled' OR (state='fired' AND deliveredTurnId IS NULL))",
        )
        .run(now(), id);
      this.refreshPending(taskId);
      this.changed(this.owner(task.agentId).workspaceId);
      const state = (
        this.db
          .prepare("SELECT state FROM task_checkins WHERE id=?")
          .get(id) as TaskCheckIn
      ).state;
      return { checkinId: id, state, cancelled: state === "cancelled" };
    })();
  }
  cancelTaskCheckIns(taskId: string) {
    this.db
      .prepare(
        "UPDATE task_checkins SET state='cancelled',updatedAt=? WHERE taskId=? AND (state='scheduled' OR (state='fired' AND deliveredTurnId IS NULL))",
      )
      .run(now(), taskId);
    this.db
      .prepare(
        "UPDATE agent_tasks SET pendingReason=NULL,resumeEnvelope=NULL WHERE id=?",
      )
      .run(taskId);
  }
  yieldTask(owner: ToolOwner, summary: unknown) {
    this.assertOwner(owner);
    return this.db.transaction(() => {
      const reason = this.pendingReason(owner.taskId);
      if (!reason)
        fail(
          "Schedule a check-in or send a request before yielding. If a response has arrived, handle it first.",
        );
      const text = this.text(summary);
      const turn = this.db
        .prepare(
          "SELECT envelope FROM agent_turns WHERE id=? AND taskId=? AND status='running'",
        )
        .get(owner.turnId, owner.taskId) as { envelope: string } | undefined;
      if (!turn) fail("Only a running turn can yield.");
      this.db
        .prepare(
          "UPDATE agent_tasks SET summary=?,pendingReason=?,resumeEnvelope=? WHERE id=?",
        )
        .run(text, reason, turn!.envelope, owner.taskId);
      this.db
        .prepare("UPDATE agent_turns SET phase='yielding' WHERE id=?")
        .run(owner.turnId);
      return { taskYield: true, summary: text };
    })();
  }
  link(id: string): any {
    const l = this.db
      .prepare("SELECT * FROM communication_links WHERE id=?")
      .get(id) as any;
    if (!l) fail("Communication link not found.", 404);
    return l;
  }
  createLink(workspaceId: string, source: string, target: string) {
    if (
      typeof source !== "string" ||
      typeof target !== "string" ||
      source.length > 100 ||
      target.length > 100
    )
      fail("Choose two existing agents.", 400);
    const a = this.owner(source),
      b = this.owner(target);
    if (
      a.workspaceId !== workspaceId ||
      b.workspaceId !== workspaceId ||
      source === target
    )
      fail("Choose two different agents in this workspace.", 400);
    const old = this.db
      .prepare(
        "SELECT * FROM communication_links WHERE min(sourceAgentId,targetAgentId)=min(?,?) AND max(sourceAgentId,targetAgentId)=max(?,?)",
      )
      .get(source, target, source, target) as any;
    if (old) {
      if (old.state !== "active") fail("This link is being revoked.");
      return old;
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO communication_links(id,workspaceId,sourceAgentId,targetAgentId,createdAt) VALUES (?,?,?,?,?)",
      )
      .run(id, workspaceId, source, target, now());
    this.changed(workspaceId);
    return this.link(id);
  }
  find(owner: ToolOwner, args: any) {
    const limit = args.limit ?? 25,
      offset = args.offset ?? 0;
    const rows = this.db
      .prepare(
        "SELECT a.id FROM communication_links l JOIN agents a ON a.id=CASE WHEN l.sourceAgentId=? THEN l.targetAgentId ELSE l.sourceAgentId END WHERE (l.sourceAgentId=? OR l.targetAgentId=?) AND l.state='active' AND a.workspaceId=? AND (?='' OR a.name LIKE ? ESCAPE '\\') ORDER BY a.name,a.id LIMIT ? OFFSET ?",
      )
      .all(
        owner.agentId,
        owner.agentId,
        owner.agentId,
        owner.workspaceId,
        args.query ?? "",
        `%${(args.query ?? "").replace(/[\\%_]/g, "\\$&")}%`,
        limit,
        offset,
      ) as any[];
    return {
      items: rows.map(({ id }) => {
        const a = this.execution.requiredAgent(id, true);
        let capabilities: unknown = { image: "unknown", pdf: "unknown" };
        let modelId: string | null = null;
        try {
          const s = this.connections.snapshot(a);
          capabilities = s.mediaCapabilities;
          modelId = s.modelId;
        } catch {
          /* Discovery remains usable without a configured model. */
        }
        const c = a.clusterId
          ? (this.db
              .prepare("SELECT name FROM clusters WHERE id=?")
              .get(a.clusterId) as any)
          : null;
        return {
          id,
          name: a.name,
          description: a.instructions.slice(0, 500),
          clusterId: a.clusterId,
          clusterName: c?.name ?? null,
          state: a.state,
          modelId,
          mediaCapabilities: capabilities,
        };
      }),
      offset,
      limit,
    };
  }
  send(owner: ToolOwner, args: any, key: string) {
    this.assertOwner(owner);
    return this.once(key, owner.workspaceId, args, () => {
      const source = this.owner(owner.agentId),
        target = this.owner(args.agentId);
      if (target.workspaceId !== owner.workspaceId)
        fail("Cross-workspace messaging is unavailable.", 403);
      const link = this.db
        .prepare(
          "SELECT * FROM communication_links WHERE min(sourceAgentId,targetAgentId)=min(?,?) AND max(sourceAgentId,targetAgentId)=max(?,?) AND state='active'",
        )
        .get(owner.agentId, target.id, owner.agentId, target.id) as any;
      if (!link)
        fail("No active communication link permits this request.", 403);
      const task = this.task(owner.taskId),
        root = task.rootWorkflowId ?? task.id;
      const parent = task.parentRequestId
        ? this.request(task.parentRequestId)
        : null;
      const depth = (parent?.depth ?? 0) + 1;
      let ancestor = parent;
      while (ancestor) {
        if (
          [ancestor.sourceAgentId, ancestor.targetAgentId].includes(target.id)
        )
          fail("Delegation back to an ancestor agent is not allowed.");
        ancestor = ancestor.parentRequestId
          ? this.request(ancestor.parentRequestId)
          : null;
      }
      if (target.id === owner.agentId) fail("Self delegation is not allowed.");
      const ids = this.attachments(owner, args.versionIds),
        text = this.text(args.content, ids.length > 0);
      const id = randomUUID(),
        kind = args.kind ?? "request";
      if (!["request", "notification"].includes(kind))
        fail("Invalid request kind.", 400);
      const accepted = this.execution.submit(
        target.id,
        "new",
        text,
        `message_${id}`,
        ids.map((versionId) => ({
          versionId,
          name: (this.assertVersion(owner, versionId) as any).name,
          mode: "file" as const,
        })),
        JSON.stringify(ids),
        {
          source: "agent",
          senderId: owner.agentId,
          requestId: id,
          replyKind: kind === "request" ? "result" : "none",
          rootWorkflowId: root,
          parentRequestId: id,
          causationId: key,
        },
      );
      this.db
        .prepare(
          "INSERT INTO agent_requests(id,workspaceId,linkId,sourceAgentId,targetAgentId,sourceName,targetName,sourceTaskId,targetTaskId,rootWorkflowId,parentRequestId,depth,kind,createdAt,updatedAt,returnEnvelope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          owner.workspaceId,
          link.id,
          source.id,
          target.id,
          source.name,
          target.name,
          task.id,
          accepted.taskId,
          root,
          parent?.id ?? null,
          depth,
          kind,
          now(),
          now(),
          (
            this.db
              .prepare("SELECT envelope FROM agent_turns WHERE id=?")
              .get(owner.turnId) as { envelope: string }
          ).envelope,
        );
      const recorded = this.record(
        owner,
        this.request(id),
        kind,
        text,
        ids,
        accepted.taskId,
        undefined,
        true,
        accepted,
      );
      return { ...recorded, requestId: id, taskId: accepted.taskId, state: "accepted" };
    });
  }
  private record(
    owner: ToolOwner,
    request: any,
    kind: string,
    content: string,
    ids: string[],
    recipient: string | null,
    replyToId?: string,
    delivered = false,
    accepted?: any,
  ): any {
    const id = randomUUID();
    const name =
      (
        this.db
          .prepare("SELECT name FROM agents WHERE id=?")
          .get(owner.agentId) as any
      )?.name ??
      (owner.agentId === request.sourceAgentId
        ? request.sourceName
        : request.targetName);
    this.db
      .prepare(
        "INSERT INTO communication_messages(id,workspaceId,requestId,senderAgentId,senderName,senderTaskId,recipientTaskId,kind,content,attachments,replyToId,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        request.workspaceId,
        request.id,
        owner.agentId,
        name,
        owner.taskId,
        recipient,
        kind,
        content,
        JSON.stringify(ids),
        replyToId ?? null,
        now(),
      );
    for (const version of ids)
      if (recipient)
        this.db
          .prepare("INSERT OR IGNORE INTO artifact_grants VALUES (?,?,?)")
          .run(recipient, version, request.id);
    this.db
      .prepare(
        "INSERT INTO communication_deliveries(messageId,state,inputMessageId,turnId,createdAt) VALUES (?,?,?,?,?)",
      )
      .run(
        id,
        delivered ? "delivered" : kind === "progress" ? "recorded" : "pending",
        (accepted?.turnId
          ? (
              this.db
                .prepare("SELECT inputMessageId FROM agent_turns WHERE id=?")
                .get(accepted.turnId) as any
            )?.inputMessageId
          : null) ?? null,
        accepted?.turnId ?? null,
        now(),
      );
    const transit = recipient && owner.turnId
      ? this.transits.create(id, request, owner.agentId, recipient)
      : undefined;
    if (kind !== "progress" && !delivered) {
      this.db
        .prepare(
          "UPDATE task_checkins SET state='cancelled',updatedAt=? WHERE taskId=? AND requestId=? AND (state='scheduled' OR (state='fired' AND deliveredTurnId IS NULL))",
        )
        .run(now(), recipient, request.id);
      if (!transit) this.deliver(id);
    }
    this.changed(request.workspaceId);
    return { messageId: id, requestId: request.id, ...(transit ? { startedAt: transit.startedAt, arrivesAt: transit.arrivesAt } : {}) };
  }
  message(owner: ToolOwner, args: any, key: string) {
    return this.once(key, owner.workspaceId, args, () => {
      const r = this.participant(owner, args.requestId);
      if (r.state !== "open") fail("This conversation is closed.");
      const link = this.db
        .prepare("SELECT state FROM communication_links WHERE id=?")
        .get(r.linkId) as any;
      if (link?.state !== "active")
        fail("Communication permission was revoked.", 403);
      const kind = args.kind;
      if (!["question", "progress", "answer"].includes(kind))
        fail("Choose question, progress, or answer.", 400);
      const ids = this.attachments(owner, args.versionIds),
        text = this.text(args.content, ids.length > 0);
      const recipient =
        owner.taskId === r.sourceTaskId ? r.targetTaskId : r.sourceTaskId;
      if (!recipient) fail("The recipient task no longer exists.", 404);
      if (kind === "answer") {
        const q = this.db
          .prepare(
            "SELECT * FROM communication_messages WHERE id=? AND requestId=? AND kind='question' AND answered=0",
          )
          .get(args.replyToId ?? "", r.id) as any;
        if (!q || q.recipientTaskId !== owner.taskId)
          fail("Choose an unanswered question addressed to this task.");
        this.db
          .prepare("UPDATE communication_messages SET answered=1 WHERE id=?")
          .run(q.id);
      }
      return this.record(owner, r, kind, text, ids, recipient, args.replyToId);
    });
  }
  status(owner: ToolOwner, id: string, offset = 0, limit = 25) {
    const r = this.participant(owner, id);
    limit = Math.min(limit, 10);
    const messages = this.db
      .prepare(
        "SELECT * FROM communication_messages WHERE requestId=? ORDER BY sequence LIMIT ? OFFSET ?",
      )
      .all(id, limit, offset);
    return {
      request: r,
      messages: messages.map((m: any) => ({
        ...m,
        content: m.content.slice(0, 2000),
        contentTruncated: m.content.length > 2000,
        attachments: JSON.parse(m.attachments),
      })),
      total: (
        this.db
          .prepare(
            "SELECT count(*) n FROM communication_messages WHERE requestId=?",
          )
          .get(id) as any
      ).n,
    };
  }
  private resultRoute(envelope: string) {
    const route = JSON.parse(envelope) as MessageEnvelope;
    return JSON.stringify([
      route.replyKind ?? "none",
      route.requestId ?? null,
      route.inboxId ?? null,
    ]);
  }
  private pendingInputs(
    taskId: string,
    byteBudget = 60000,
    activeEnvelope?: string,
    contentBudget = Infinity,
  ) {
    const original =
      (
        this.db
          .prepare(
            "SELECT envelope FROM agent_turns WHERE taskId=? ORDER BY rowid LIMIT 1",
          )
          .get(taskId) as { envelope: string } | undefined
      )?.envelope ?? "{}";
    const messages = this.db
      .prepare(
        `SELECT m.*,NULL AS checkinId,
        CASE WHEN r.sourceTaskId=m.recipientTaskId THEN r.returnEnvelope END AS returnEnvelope
      FROM communication_messages m JOIN agent_requests r ON r.id=m.requestId
      JOIN communication_deliveries d ON d.messageId=m.id WHERE m.recipientTaskId=? AND d.state='pending'
      AND NOT EXISTS(SELECT 1 FROM message_transits mt WHERE mt.messageId=m.id AND mt.state!='arrived')
      ORDER BY m.sequence LIMIT 32`,
      )
      .all(taskId) as any[];
    const checkins = this.db
      .prepare(
        `SELECT id AS checkinId,id,'check_in' AS kind,reason AS content,'system' AS senderName,
      NULL AS senderAgentId,requestId,'[]' AS attachments,dueAt AS createdAt,returnEnvelope FROM task_checkins
      WHERE taskId=? AND state='fired' AND deliveredTurnId IS NULL ORDER BY dueAt,id LIMIT 32`,
      )
      .all(taskId) as any[];
    const batch: any[] = [];
    let bytes = 0,
      files = 0,
      characters = 0;
    let route = activeEnvelope ? this.resultRoute(activeEnvelope) : null;
    for (const item of [...messages, ...checkins].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )) {
      item.returnEnvelope =
        !item.returnEnvelope || item.returnEnvelope === "{}"
          ? original
          : item.returnEnvelope;
      const destination = this.resultRoute(item.returnEnvelope);
      route ??= destination;
      if (destination !== route) continue;
      const size = Buffer.byteLength(JSON.stringify(item)) + 1024;
      const count = (JSON.parse(item.attachments) as string[]).length;
      const contentLength =
        this.inputContent(item).length + (batch.length ? 2 : 0);
      if (batch.length && characters + contentLength > contentBudget) break;
      if (bytes + size > byteBudget || files + count > 10 || batch.length >= 10)
        break;
      batch.push(item);
      bytes += size;
      files += count;
      characters += contentLength;
    }
    return batch;
  }
  private inputContent(item: any) {
    return `[${item.kind} from ${item.senderName}; request ${item.requestId ?? "none"}; message ${item.id}]\n${item.content}`;
  }
  private acknowledgeInputs(
    batch: any[],
    turnId: string,
    inputMessageId: string,
  ) {
    for (const item of batch) {
      if (item.checkinId)
        this.db
          .prepare(
            "UPDATE task_checkins SET deliveredTurnId=?,updatedAt=? WHERE id=? AND state='fired'",
          )
          .run(turnId, now(), item.checkinId);
      else
        this.db
          .prepare(
            "UPDATE communication_deliveries SET state='delivered',turnId=?,inputMessageId=? WHERE messageId=? AND state='pending'",
          )
          .run(turnId, inputMessageId, item.id);
    }
  }
  // Called only after a completed host tool exchange, never while an action is in flight.
  consumeInputs(owner: ToolOwner, byteBudget = 60000) {
    return this.db.transaction(() => {
      this.assertOwner(owner);
      const turn = this.db
        .prepare(
          "SELECT conversationId,envelope FROM agent_turns WHERE id=? AND status='running'",
        )
        .get(owner.turnId) as
        | { conversationId: string; envelope: string }
        | undefined;
      if (!turn) return [];
      const batch = this.pendingInputs(owner.taskId, byteBudget, turn.envelope);
      for (const item of batch) {
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO agent_messages(id,conversationId,turnId,role,content,state,createdAt,authorType,authorId)
          VALUES (?,?,?,'user',?,'complete',?,?,?)`,
          )
          .run(
            id,
            turn.conversationId,
            owner.turnId,
            this.inputContent(item),
            now(),
            item.checkinId ? "system" : "agent",
            item.senderAgentId,
          );
        (JSON.parse(item.attachments) as string[]).forEach(
          (versionId, ordinal) =>
            this.db
              .prepare(
                "INSERT INTO artifact_references(versionId,messageId,ordinal,mode) VALUES (?,?,?,'file')",
              )
              .run(versionId, id, ordinal),
        );
        this.acknowledgeInputs([item], owner.turnId, id);
      }
      if (batch.length) this.changed(owner.workspaceId);
      return batch.map((item) => ({
        messageId: item.id,
        requestId: item.requestId,
        kind: item.kind,
        authorType: item.checkinId ? "system" : "agent",
        authorId: item.senderAgentId,
        authorName: item.senderName,
        content: item.content,
        versionIds: JSON.parse(item.attachments),
        replyToId: item.replyToId ?? null,
      }));
    })();
  }
  private deliver(id: string) {
    const message = this.db
      .prepare("SELECT m.recipientTaskId,d.state FROM communication_messages m JOIN communication_deliveries d ON d.messageId=m.id WHERE m.id=?")
      .get(id) as any;
    if (message?.state !== "pending") return;
    if (message?.recipientTaskId) this.deliverTask(message.recipientTaskId);
    else
      this.db
        .prepare(
          "UPDATE communication_deliveries SET state='orphaned' WHERE messageId=? AND state='pending'",
        )
        .run(id);
  }
  private deliverTask(taskId: string) {
    const task = this.db
      .prepare("SELECT * FROM agent_tasks WHERE id=?")
      .get(taskId) as any;
    if (!task || task.status === "cancelled") {
      this.db
        .prepare(
          "UPDATE communication_deliveries SET state='recorded' WHERE messageId IN (SELECT id FROM communication_messages WHERE recipientTaskId=?) AND state='pending'",
        )
        .run(taskId);
      if (task) this.cancelTaskCheckIns(taskId);
      return;
    }
    if (
      ["failed", "blocked"].includes(task.status) ||
      this.db
        .prepare(
          `SELECT 1 FROM agent_turns WHERE taskId=? AND
      (status IN ('running','waiting') OR (status='queued' AND json_extract(envelope,'$.continuation')=1)) LIMIT 1`,
        )
        .get(taskId)
    )
      return;
    const batch = this.pendingInputs(taskId, 60000, undefined, 12000);
    if (!batch.length) return;
    const first = batch[0];
    const base = JSON.parse(first.returnEnvelope) as MessageEnvelope;
    // A continuation always keeps the task's own result route. Questions carry their own IDs
    // and are answered explicitly with agent_message, independently of the task's final result.
    const envelope: MessageEnvelope = {
      ...base,
      source: first.checkinId ? "system" : "agent",
      senderId: first.senderAgentId ?? undefined,
      causationId: first.id,
      continuation: true,
      incomingMessages: batch.map((item) => ({
        messageId: item.id,
        requestId: item.requestId ?? null,
        kind: item.kind,
      })),
    };
    const versions = [
      ...new Set(
        batch.flatMap((item) => JSON.parse(item.attachments) as string[]),
      ),
    ];
    let content = batch.map((item) => this.inputContent(item)).join("\n\n");
    // A full-size single message uses routing metadata for attribution so the
    // existing submission limit cannot clip its body or acknowledge unseen peers.
    if (batch.length === 1 && content.length > 12000) content = first.content;
    if (content.length > 12000)
      content =
        content.slice(0, 11600) +
        "\n[Excerpt; full messages remain in communication history.]";
    try {
      const accepted = this.execution.submit(
        task.agentId,
        task.id,
        content,
        `delivery_${first.id}`,
        versions.map((versionId) => ({
          versionId,
          name: (
            this.db
              .prepare("SELECT name FROM artifact_versions WHERE id=?")
              .get(versionId) as any
          ).name,
          mode: "file" as const,
        })),
        JSON.stringify(versions),
        envelope,
      );
      const input = this.db
        .prepare("SELECT inputMessageId FROM agent_turns WHERE id=?")
        .get(accepted.turnId) as { inputMessageId: string };
      this.acknowledgeInputs(batch, accepted.turnId, input.inputMessageId);
    } catch (e) {
      if (
        !(
          e instanceof ConnectionError &&
          [403, 409, 429, 503].includes(e.statusCode)
        )
      )
        throw e;
    }
  }
  outputs(owner: ToolOwner, ids: unknown) {
    const versions = this.attachments(owner, ids);
    this.db
      .prepare(
        "INSERT INTO task_output_selections VALUES (?,?) ON CONFLICT(turnId) DO UPDATE SET versions=excluded.versions",
      )
      .run(owner.turnId, JSON.stringify(versions));
    return { versionIds: versions };
  }
  finalVersions(owner: ToolOwner): string[] {
    const selection = this.db
      .prepare("SELECT versions FROM task_output_selections WHERE turnId=?")
      .get(owner.turnId) as any;
    const ids = selection
      ? JSON.parse(selection.versions)
      : (
          this.db
            .prepare(
              "SELECT content FROM execution_items WHERE turnId=? AND kind='artifact' ORDER BY sequence",
            )
            .all(owner.turnId) as any[]
        ).map((r) => JSON.parse(r.content).versionId);
    return this.attachments(owner, ids);
  }
  final(
    owner: ToolOwner,
    envelope: MessageEnvelope,
    content: string,
    ids: string[],
  ) {
    const key = `final_${owner.turnId}`;
    const deliveredContent =
      content.length > 12000
        ? content.slice(0, 11600) +
          `\n[Excerpt: full answer retained in source task ${owner.taskId}.]`
        : content;
    if (envelope.replyKind === "inbox") {
      this.notify(owner, { content: deliveredContent, versionIds: ids }, key);
      return;
    }
    if (!envelope.requestId) return;
    if (envelope.replyKind === "none") {
      this.db
        .prepare(
          "UPDATE agent_requests SET state='completed',updatedAt=? WHERE id=? AND kind='notification' AND state='open'",
        )
        .run(now(), envelope.requestId);
      return;
    }
    if (!envelope.replyKind) return;
    const r = this.request(envelope.requestId);
    if (r.state !== "open") return;
    this.once(key, owner.workspaceId, { content, ids }, () => {
      if (envelope.replyKind === "answer") {
        const q = this.db
          .prepare(
            "SELECT * FROM communication_messages WHERE id=? AND answered=0",
          )
          .get(envelope.messageId ?? "") as any;
        if (!q) return { ignored: true };
        this.db
          .prepare("UPDATE communication_messages SET answered=1 WHERE id=?")
          .run(q.id);
        return this.record(
          owner,
          r,
          "answer",
          deliveredContent,
          ids,
          q.senderTaskId,
          q.id,
        );
      }
      if (owner.taskId !== r.targetTaskId) return { ignored: true };
      this.db
        .prepare(
          "UPDATE agent_requests SET state='completed',updatedAt=? WHERE id=?",
        )
        .run(now(), r.id);
      return this.record(
        owner,
        r,
        "result",
        deliveredContent,
        ids,
        r.sourceTaskId,
      );
    });
  }
  notify(owner: ToolOwner, args: any, key: string) {
    return this.once(key, owner.workspaceId, args, () => {
      const ids = this.attachments(owner, args.versionIds),
        text = this.text(args.content, ids.length > 0),
        agent = this.owner(owner.agentId),
        id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO workspace_inbox(id,workspaceId,agentId,agentName,taskId,content,attachments,createdAt) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          owner.workspaceId,
          owner.agentId,
          agent.name,
          owner.taskId,
          text,
          JSON.stringify(ids),
          now(),
        );
      this.changed(owner.workspaceId);
      return { inboxId: id };
    });
  }
  inboxReply(id: string, body: any) {
    const item = this.db
      .prepare("SELECT * FROM workspace_inbox WHERE id=?")
      .get(id) as any;
    if (!item) fail("Inbox message not found.", 404);
    if (!item.taskId || !item.agentId)
      fail("The originating task is no longer available.");
    const text = this.text(body.content);
    if (
      typeof body.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)
    )
      fail("Supply a unique request ID.", 400);
    return this.execution.submit(
      item.agentId,
      item.taskId,
      text,
      body.requestId,
      [],
      "[]",
      { source: "user", replyKind: "inbox", inboxId: id, causationId: id },
    );
  }
  waitState(owner: ToolOwner, ids: string[], mode: string): any {
    const rows = ids.map((id) => this.participant(owner, id));

    const questions = this.db
      .prepare(
        "SELECT m.* FROM communication_messages m JOIN communication_deliveries d ON d.messageId=m.id WHERE m.recipientTaskId=? AND m.kind='question' AND m.answered=0 AND NOT EXISTS(SELECT 1 FROM message_transits mt WHERE mt.messageId=m.id AND mt.state!='arrived') ORDER BY sequence LIMIT 10",
      )
      .all(owner.taskId);
    for (const r of rows)
      if (
        r.targetTaskId === owner.taskId &&
        r.state === "open" &&
        !this.db
          .prepare(
            "SELECT 1 FROM communication_messages WHERE requestId=? AND senderTaskId=? AND kind='question'",
          )
          .get(r.id, owner.taskId)
      )
        fail(
          "A helper may wait on its incoming request only after asking a clarification question.",
        );
    const complete = (r: any) =>
      (!["open", "revoking"].includes(r.state) && !this.db.prepare(
        "SELECT 1 FROM message_transits WHERE requestId=? AND recipientTaskId=? AND state='in_flight' LIMIT 1"
      ).get(r.id, owner.taskId)) ||
      (r.targetTaskId === owner.taskId &&
        !!this.db
          .prepare(
            "SELECT 1 FROM communication_messages m JOIN communication_deliveries d ON d.messageId=m.id WHERE m.recipientTaskId=? AND m.requestId=? AND m.kind='answer' AND NOT EXISTS(SELECT 1 FROM message_transits mt WHERE mt.messageId=m.id AND mt.state!='arrived')",
          )
          .get(owner.taskId, r.id));
    const done = mode === "all" ? rows.every(complete) : rows.some(complete);
    return {
      ready: done || questions.length > 0,
      requests: rows,
      questions: (questions as any[]).map((q) => ({
        ...q,
        content: q.content.slice(0, 1000),
        contentTruncated: q.content.length > 1000,
      })),
    };
  }
  waitResult(owner: ToolOwner, ids: string[], mode: string) {
    const state = this.waitState(owner, ids, mode);
    const messages = this.db
      .prepare(
        `SELECT m.* FROM communication_messages m JOIN communication_deliveries d ON d.messageId=m.id WHERE m.recipientTaskId=? AND m.requestId IN (${ids.map(() => "?").join(",")}) AND m.kind!='progress' AND NOT EXISTS(SELECT 1 FROM message_transits mt WHERE mt.messageId=m.id AND mt.state!='arrived') ORDER BY sequence DESC LIMIT 10`,
      )
      .all(owner.taskId, ...ids)
      .reverse() as any[];
    for (const m of messages)
      this.db
        .prepare(
          "UPDATE communication_deliveries SET state='delivered' WHERE messageId=?",
        )
        .run(m.id);
    return {
      ...state,
      messages: messages.map((m) => ({
        ...m,
        content: m.content.slice(0, 2000),
        contentTruncated: m.content.length > 2000,
        attachments: JSON.parse(m.attachments),
      })),
    };
  }
  private terminal(id: string, state: string, error: string) {
    const r = this.request(id);
    if (!["open", "revoking"].includes(r.state)) return;
    this.db
      .prepare(
        "UPDATE agent_requests SET state=?,error=?,updatedAt=? WHERE id=?",
      )
      .run(state, error, now(), id);
    if (r.sourceTaskId)
      this.record(
        {
          workspaceId: r.workspaceId,
          agentId: r.targetAgentId,
          taskId: r.targetTaskId,
          turnId: "",
        },
        r,
        "failure",
        error,
        [],
        r.sourceTaskId,
      );
    this.changed(r.workspaceId);
  }
  taskCancelled(id: string) {
    this.transits.cancel("recipientTaskId", id);
    this.cancelTaskCheckIns(id);
    for (const r of this.db
      .prepare(
        "SELECT id FROM agent_requests WHERE targetTaskId=? AND state='open'",
      )
      .all(id) as any[])
      this.terminal(r.id, "cancelled", "The helper task was cancelled.");
    this.db
      .prepare(
        "UPDATE messaging_waits SET state='cancelled' WHERE taskId=? AND state='waiting'",
      )
      .run(id);
  }
  async deletingAgents(ids: string[]) {
    for (const id of ids) this.transits.cancel("recipientAgentId", id);
    for (const agent of ids)
      for (const r of this.db
        .prepare(
          "SELECT id,targetTaskId FROM agent_requests WHERE targetAgentId=? AND state='open'",
        )
        .all(agent) as any[])
        this.terminal(
          r.id,
          "recipient_deleted",
          "The recipient agent was deleted.",
        );
  }
  impact(id: string) {
    const l = this.link(id);
    const rows = this.db
      .prepare(
        `WITH RECURSIVE affected(id,targetTaskId) AS (
      SELECT id,targetTaskId FROM agent_requests WHERE linkId=? AND rootWorkflowId IN (
        SELECT rootWorkflowId FROM agent_requests WHERE state='open'
        UNION SELECT r.rootWorkflowId FROM owned_processes p JOIN agent_requests r ON r.targetTaskId=p.taskId WHERE p.state IN ('starting','running')
      )
      UNION SELECT r.id,r.targetTaskId FROM agent_requests r JOIN affected a ON r.parentRequestId=a.id
    ) SELECT r.* FROM agent_requests r JOIN affected a ON a.id=r.id WHERE r.state='open' OR EXISTS(SELECT 1 FROM owned_processes p WHERE p.taskId=r.targetTaskId AND p.state IN ('starting','running')) ORDER BY r.id`,
      )
      .all(id) as any[];
    const tasks = rows.map((r) => r.targetTaskId).filter(Boolean);
    const processes = tasks.flatMap((t) =>
      this.db
        .prepare(
          "SELECT id,taskId,command,state FROM owned_processes WHERE taskId=? AND state IN ('starting','running') ORDER BY id",
        )
        .all(t),
    );
    const taskStates = tasks.map((id) =>
      this.db.prepare("SELECT id,status FROM agent_tasks WHERE id=?").get(id),
    );
    const turns = tasks.flatMap((id) =>
      this.db
        .prepare(
          "SELECT id,status,generation FROM agent_turns WHERE taskId=? AND status IN ('queued','running','waiting','blocked','failed','interrupted') ORDER BY id",
        )
        .all(id),
    );
    const snapshot = {
      link: l,
      requests: rows,
      tasks,
      taskStates,
      turns,
      processes,
    };
    return {
      ...snapshot,
      revision: createHash("sha256")
        .update(JSON.stringify(snapshot))
        .digest("hex"),
      retains: ["messages", "working files", "published artifacts"],
    };
  }
  revoke(id: string, body: any) {
    if (body.confirmInterruption !== true)
      fail("Confirm interruption after reviewing the impact.", 400);
    const retryKey = `revocation_${id}_${body.revision}`;
    const accepted = this.db
      .prepare("SELECT result FROM messaging_idempotency WHERE id=?")
      .get(retryKey) as any;
    if (accepted) return this.operation(JSON.parse(accepted.result).id);
    const impact = this.impact(id);
    this.owner(impact.link.sourceAgentId);
    this.owner(impact.link.targetAgentId);
    if (impact.revision !== body.revision)
      fail("Affected work changed. Review a fresh impact preview.");
    const prior = this.db
      .prepare(
        "SELECT * FROM messaging_operations WHERE linkId=? AND state!='completed'",
      )
      .get(id) as any;
    if (prior) return prior;
    if (
      (
        this.db
          .prepare(
            "SELECT count(*) n FROM messaging_operations WHERE state!='completed'",
          )
          .get() as any
      ).n >= 100
    )
      fail(
        "Too many unfinished revocations. Finish or retry existing operations.",
        429,
      );
    const op = randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE communication_links SET state='revoking' WHERE id=?")
        .run(id);
      for (const r of impact.requests) {
        this.db
          .prepare(
            "UPDATE agent_requests SET state='revoking' WHERE id=? AND state='open'",
          )
          .run(r.id);
        this.db
          .prepare(
            "UPDATE task_checkins SET state='cancelled',updatedAt=? WHERE requestId=? AND (state='scheduled' OR (state='fired' AND deliveredTurnId IS NULL))",
          )
          .run(now(), r.id);
      }
      this.db
        .prepare(
          "INSERT INTO messaging_operations(id,workspaceId,linkId,requestIds,taskIds,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          op,
          impact.link.workspaceId,
          id,
          JSON.stringify(impact.requests.map((r) => r.id)),
          JSON.stringify(impact.tasks),
          now(),
          now(),
        );
      this.db
        .prepare("INSERT INTO messaging_idempotency VALUES (?,?,?,?)")
        .run(
          retryKey,
          impact.link.workspaceId,
          JSON.stringify({ revision: body.revision }),
          JSON.stringify({ id: op }),
        );
    })();
    this.transits.cancel("linkId", id);
    this.changed(impact.link.workspaceId);
    this.tick();
    return this.operation(op);
  }
  operation(id: string): any {
    const r = this.db
      .prepare("SELECT * FROM messaging_operations WHERE id=?")
      .get(id);
    if (!r) fail("Operation not found.", 404);
    return r;
  }
  retryOperation(id: string) {
    const op = this.operation(id);
    if (op.state === "failed")
      this.db
        .prepare(
          "UPDATE messaging_operations SET state='pending',error=NULL WHERE id=?",
        )
        .run(id);
    this.tick();
    return this.operation(id);
  }
  private tick() {
    if (this.stopped) return;
    this.transits.reconcile();
    this.db.transaction(() => {
      const due = this.db
        .prepare(
          "SELECT id,taskId FROM task_checkins WHERE state='scheduled' AND dueAt<=? ORDER BY dueAt,id LIMIT 32",
        )
        .all(now()) as { id: string; taskId: string }[];
      for (const row of due) {
        this.db
          .prepare(
            "UPDATE task_checkins SET state='fired',updatedAt=? WHERE id=? AND state='scheduled'",
          )
          .run(now(), row.id);
        const owner = this.db
          .prepare(
            "SELECT a.workspaceId FROM agent_tasks t JOIN agents a ON a.id=t.agentId WHERE t.id=?",
          )
          .get(row.taskId) as { workspaceId: string };
        this.changed(owner.workspaceId);
      }
      const tasks = this.db
        .prepare(
          "SELECT DISTINCT taskId FROM task_checkins WHERE state='fired' AND deliveredTurnId IS NULL ORDER BY (taskId<=?),taskId LIMIT 32",
        )
        .all(this.checkinCursor) as { taskId: string }[];
      if (tasks.length) this.checkinCursor = tasks.at(-1)!.taskId;
      for (const row of tasks) this.deliverTask(row.taskId);
    })();
    for (const d of this.db
      .prepare(
        "SELECT d.messageId FROM communication_deliveries d JOIN communication_messages m ON m.id=d.messageId LEFT JOIN agent_tasks t ON t.id=m.recipientTaskId WHERE d.state='pending' AND NOT EXISTS(SELECT 1 FROM message_transits mt WHERE mt.messageId=m.id AND mt.state!='arrived') AND (t.id IS NULL OR (t.status NOT IN ('failed','blocked','running') AND NOT EXISTS(SELECT 1 FROM messaging_waits w WHERE w.taskId=t.id AND w.state='waiting'))) ORDER BY d.createdAt,d.messageId LIMIT 32",
      )
      .all() as any[])
      this.db.transaction(() => this.deliver(d.messageId))();
    for (const op of this.db
      .prepare(
        "SELECT id FROM messaging_operations WHERE state='pending' ORDER BY createdAt LIMIT 2",
      )
      .all() as any[]) {
      if (this.operations.has(op.id) || this.operations.size >= 2) continue;
      const work = this.runOperation(op.id).finally(() =>
        this.operations.delete(op.id),
      );
      this.operations.set(op.id, work);
    }
  }
  private async runOperation(id: string) {
    const op = this.operation(id);
    this.db
      .prepare(
        "UPDATE messaging_operations SET state='running',updatedAt=? WHERE id=?",
      )
      .run(now(), id);
    try {
      for (const taskId of JSON.parse(op.taskIds))
        if (this.db.prepare("SELECT 1 FROM agent_tasks WHERE id=?").get(taskId))
          await this.execution.cancelTask(taskId);
      this.db.transaction(() => {
        for (const requestId of JSON.parse(op.requestIds))
          this.terminal(
            requestId,
            "revoked",
            "Communication permission was revoked.",
          );
        this.db
          .prepare(
            "UPDATE messaging_operations SET state='completed',updatedAt=? WHERE id=?",
          )
          .run(now(), id);
        // Legacy reverse links can merge with multiple unfinished removals.
        // Keep the pair fenced until every operation has settled successfully.
        this.db
          .prepare("DELETE FROM communication_links WHERE id=? AND NOT EXISTS(SELECT 1 FROM messaging_operations WHERE linkId=? AND state!='completed')")
          .run(op.linkId, op.linkId);
      })();
    } catch {
      this.db
        .prepare(
          "UPDATE messaging_operations SET state='failed',error='Could not settle affected work. Retry revocation.',updatedAt=? WHERE id=?",
        )
        .run(now(), id);
    }
    this.changed(op.workspaceId);
  }
  async close() {
    this.transits.close();
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.operations.values()]);
  }
}

export function registerMessaging(
  app: FastifyInstance,
  service: MessagingService,
  incoming?: import("./submission-media.js").SubmissionMedia,
) {
  const db = service.db;
  const page = (
    table: string,
    where: string,
    args: unknown[],
    query: unknown,
    order = "createdAt DESC,id",
  ) => {
    const { limit, offset } = pagination(query);
    return {
      items: db
        .prepare(
          `SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset),
      total: (
        db
          .prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`)
          .get(...args) as any
      ).n,
    };
  };
  const checked =
    (handler: (req: any, reply: any) => any) =>
    async (req: any, reply: any) => {
      guard(req);
      return handler(req, reply);
    };
  const workspace = (id: string) => {
    service.execution.assertWorkspaceAvailable(id);
    if (!db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(id))
      fail("Workspace not found.", 404);
  };
  app.get(
    "/api/workspaces/:id/message-transits",
    checked((req) => {
      workspace(req.params.id);
      const { limit } = pagination(req.query);
      const after = req.query.after === undefined ? 0 : Number(req.query.after);
      if (!Number.isSafeInteger(after) || after < 0) fail("Invalid transmission cursor.", 400);
      const serverNow = now();
      const items = db.prepare(`SELECT mt.*,m.sequence FROM message_transits mt
        JOIN communication_messages m ON m.id=mt.messageId
        WHERE mt.workspaceId=? AND mt.state='in_flight' AND mt.arrivesAt>? AND m.sequence>?
        ORDER BY m.sequence LIMIT ?`).all(req.params.id, serverNow, after, limit) as any[];
      return { items, serverNow, nextCursor: items.length === limit ? items.at(-1).sequence : null };
    }),
  );
  app.get(
    "/api/tasks/:id/check-ins",
    checked((req) => {
      const { limit, offset } = pagination(req.query);
      return service.checkIns(req.params.id, limit, offset);
    }),
  );
  app.delete(
    "/api/tasks/:id/check-ins/:checkinId",
    checked((req, reply) => {
      const result = service.cancelCheckIn(req.params.id, req.params.checkinId);
      if (!result.cancelled)
        fail(
          "This check-in has already been delivered. Stop the task to cancel queued or active work.",
          409,
        );
      return reply.code(204).send();
    }),
  );
  app.get(
    "/api/workspaces/:id/communication-links",
    checked((req) => {
      workspace(req.params.id);
      return page(
        "communication_links",
        "workspaceId=?",
        [req.params.id],
        req.query,
      );
    }),
  );
  app.post(
    "/api/workspaces/:id/communication-links",
    checked((req, reply) => {
      workspace(req.params.id);
      const b = objectBody(req.body);
      return reply
        .code(201)
        .send(
          service.createLink(
            req.params.id,
            b.sourceAgentId as string,
            b.targetAgentId as string,
          ),
        );
    }),
  );
  app.get(
    "/api/communication-links/:id",
    checked((req) => ({
      ...service.link(req.params.id),
      operation:
        db
          .prepare(
            "SELECT * FROM messaging_operations WHERE linkId=? AND state!='completed' ORDER BY createdAt DESC LIMIT 1",
          )
          .get(req.params.id) ?? null,
    })),
  );
  app.post(
    "/api/communication-links/:id/revocation-preview",
    checked((req) => service.impact(req.params.id)),
  );
  app.delete(
    "/api/communication-links/:id",
    checked((req, reply) =>
      reply.code(202).send(service.revoke(req.params.id, objectBody(req.body))),
    ),
  );
  app.get(
    "/api/messaging-operations/:id",
    checked((req) => service.operation(req.params.id)),
  );
  app.post(
    "/api/messaging-operations/:id/retry",
    checked((req, reply) =>
      reply.code(202).send(service.retryOperation(req.params.id)),
    ),
  );
  app.get(
    "/api/workspaces/:id/requests",
    checked((req) => {
      workspace(req.params.id);
      return page(
        "agent_requests",
        "workspaceId=?",
        [req.params.id],
        req.query,
      );
    }),
  );
  app.get(
    "/api/tasks/:id/communications",
    checked((req) => {
      service.execution.task(req.params.id);
      const p = page(
        "agent_requests",
        "sourceTaskId=? OR targetTaskId=?",
        [req.params.id, req.params.id],
        req.query,
      );
      return {
        ...p,
        items: p.items.map((r: any) => service.readRequest(r.id)),
      };
    }),
  );
  app.get(
    "/api/agent-requests/:id",
    checked((req) => {
      return service.readRequest(req.params.id);
    }),
  );
  app.get(
    "/api/agent-requests/:id/messages",
    checked((req) => {
      if (
        !db
          .prepare("SELECT 1 FROM agent_requests WHERE id=?")
          .get(req.params.id)
      )
        fail("Request not found.", 404);
      const p = page(
        "communication_messages",
        "requestId=?",
        [req.params.id],
        req.query,
        "sequence",
      );
      return {
        ...p,
        items: p.items.map((m: any) => ({
          ...m,
          attachments: JSON.parse(m.attachments),
        })),
      };
    }),
  );
  app.get(
    "/api/workspaces/:id/inbox",
    checked((req) => {
      workspace(req.params.id);
      const p = page(
        "workspace_inbox",
        "workspaceId=?",
        [req.params.id],
        req.query,
        "sequence DESC",
      );
      return {
        ...p,
        items: p.items.map((m: any) => ({
          ...m,
          attachments: JSON.parse(m.attachments),
        })),
        unread: (
          db
            .prepare(
              "SELECT count(*) n FROM workspace_inbox WHERE workspaceId=? AND readAt IS NULL",
            )
            .get(req.params.id) as any
        ).n,
      };
    }),
  );
  app.patch(
    "/api/inbox/:id",
    checked((req) => {
      const b = objectBody(req.body);
      if (b.read !== true && b.read !== false)
        fail("Supply read: true or false.", 400);
      const item = db
        .prepare("SELECT * FROM workspace_inbox WHERE id=?")
        .get(req.params.id) as any;
      if (!item) fail("Inbox message not found.", 404);
      db.prepare("UPDATE workspace_inbox SET readAt=? WHERE id=?").run(
        b.read ? now() : null,
        item.id,
      );
      service.execution.workspaceEvent(item.workspaceId, "inbox");
      return { ...item, readAt: b.read ? now() : null };
    }),
  );
  app.post(
    "/api/inbox/:id/reply",
    checked(async (req, reply) => {
      if (req.isMultipart() && incoming) {
        const item = db
          .prepare("SELECT * FROM workspace_inbox WHERE id=?")
          .get(req.params.id) as any;
        if (!item?.agentId || !item?.taskId)
          fail("The originating task is no longer available.", 404);
        return reply.code(202).send(
          await incoming.receive(req, item.agentId, item.taskId, {
            source: "user",
            replyKind: "inbox",
            inboxId: item.id,
            causationId: item.id,
          }),
        );
      }
      return reply
        .code(202)
        .send(service.inboxReply(req.params.id, objectBody(req.body)));
    }),
  );
}
