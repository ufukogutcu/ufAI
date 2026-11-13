import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { AgentExecution } from "./agent-execution.js";
import type { ConnectionService } from "./connection-service.js";
import type { ToolOwner } from "./process-service.js";
import { ConnectionError } from "./model-providers.js";
import { guard } from "./connections.js";
import { pagination, objectBody } from "./validation.js";

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
}
export interface MessagingOptions {
  maxOpenChildren?: number;
  maxDepth?: number;
  maxRequests?: number;
  maxMessages?: number;
  defaultDeadlineMs?: number;
  maxDeadlineMs?: number;
}
export class MessagingService {
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private operations = new Map<string, Promise<void>>();
  constructor(
    readonly db: Database.Database,
    readonly execution: AgentExecution,
    private connections: ConnectionService,
    readonly options: MessagingOptions = {},
  ) {
    for (const value of Object.values(options))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid messaging limits.");
  }
  start() {
    this.db
      .prepare(
        "UPDATE messaging_operations SET state='pending' WHERE state='running'",
      )
      .run();
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
        "SELECT * FROM communication_links WHERE sourceAgentId=? AND targetAgentId=?",
      )
      .get(source, target) as any;
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
        "SELECT a.id FROM communication_links l JOIN agents a ON a.id=l.targetAgentId WHERE l.sourceAgentId=? AND l.state='active' AND a.workspaceId=? AND (?='' OR a.name LIKE ? ESCAPE '\\') ORDER BY a.name,a.id LIMIT ? OFFSET ?",
      )
      .all(
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
          "SELECT * FROM communication_links WHERE sourceAgentId=? AND targetAgentId=? AND state='active'",
        )
        .get(owner.agentId, target.id) as any;
      if (!link)
        fail("No active communication link permits this request.", 403);
      const task = this.task(owner.taskId),
        root = task.rootWorkflowId ?? task.id;
      const parent = task.parentRequestId
        ? this.request(task.parentRequestId)
        : null;
      const depth = (parent?.depth ?? 0) + 1;
      if (depth > (this.options.maxDepth ?? 8))
        fail("Delegation depth limit reached.", 429);
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
      const count = (sql: string, id: string) =>
        (this.db.prepare(sql).get(id) as any).n;
      if (
        count(
          "SELECT count(*) n FROM agent_requests WHERE rootWorkflowId=?",
          root,
        ) >= (this.options.maxRequests ?? 64) ||
        count(
          "SELECT count(*) n FROM agent_requests WHERE sourceTaskId=? AND state='open'",
          task.id,
        ) >= (this.options.maxOpenChildren ?? 16)
      )
        fail("Workflow request limit reached.", 429);
      const ids = this.attachments(owner, args.versionIds),
        text = this.text(args.content, ids.length > 0);
      const ttl = args.timeoutMs ?? this.options.defaultDeadlineMs ?? 3600000;
      if (
        !Number.isSafeInteger(ttl) ||
        ttl < 1 ||
        ttl > (this.options.maxDeadlineMs ?? 86400000)
      )
        fail("Invalid request deadline.", 400);
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
          "INSERT INTO agent_requests(id,workspaceId,linkId,sourceAgentId,targetAgentId,sourceName,targetName,sourceTaskId,targetTaskId,rootWorkflowId,parentRequestId,depth,kind,deadline,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
          new Date(Date.now() + ttl).toISOString(),
          now(),
          now(),
        );
      this.record(
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
      return { requestId: id, taskId: accepted.taskId, state: "accepted" };
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
    const count = (
      this.db
        .prepare(
          "SELECT count(*) n FROM communication_messages m JOIN agent_requests r ON r.id=m.requestId WHERE r.rootWorkflowId=?",
        )
        .get(request.rootWorkflowId) as any
    ).n;
    if (
      !["result", "failure"].includes(kind) &&
      count >= (this.options.maxMessages ?? 256)
    )
      fail("Workflow message limit reached.", 429);
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
    if (kind !== "progress" && !delivered) this.deliver(id);
    this.changed(request.workspaceId);
    return { messageId: id, requestId: request.id };
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
  private deliver(id: string) {
    const m = this.db
      .prepare("SELECT * FROM communication_messages WHERE id=?")
      .get(id) as any;
    const d = this.db
      .prepare("SELECT * FROM communication_deliveries WHERE messageId=?")
      .get(id) as any;
    if (!m || d?.state !== "pending") return;
    if (!m.recipientTaskId) {
      this.db
        .prepare(
          "UPDATE communication_deliveries SET state='orphaned' WHERE messageId=?",
        )
        .run(id);
      return;
    }
    const task = this.db
      .prepare("SELECT * FROM agent_tasks WHERE id=?")
      .get(m.recipientTaskId) as any;
    if (!task || task.status === "cancelled") {
      this.db
        .prepare(
          "UPDATE communication_deliveries SET state='recorded' WHERE messageId=?",
        )
        .run(id);
      return;
    }
    const r = this.request(m.requestId);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM agent_turns WHERE taskId=? AND status='running' LIMIT 1",
        )
        .get(task.id)
    )
      return;
    // A parked turn receives the event as a tool result, not a competing turn.
    if (
      this.db
        .prepare(
          "SELECT 1 FROM messaging_waits WHERE taskId=? AND state='waiting'",
        )
        .get(task.id)
    )
      return;
    if (["failed", "blocked"].includes(task.status)) return;
    // Coalesce other pending inputs at the same safe boundary; bounded by ten files / 12k text.
    const pending = this.db
      .prepare(
        "SELECT m.* FROM communication_messages m JOIN communication_deliveries d ON d.messageId=m.id WHERE m.recipientTaskId=? AND d.state='pending' AND m.kind!='progress' ORDER BY m.sequence LIMIT 10",
      )
      .all(task.id) as any[];
    const batch: any[] = [];
    const versions: string[] = [];
    let content = "";
    for (const item of pending) {
      // Questions have distinct return routes and cannot be combined with result updates.
      if (
        batch.length &&
        (item.kind === "question" || batch[0].kind === "question")
      )
        break;
      const part = `[${item.kind} from ${item.senderName}; request ${item.requestId}; message ${item.id}]\n${item.content}`;
      const ids = JSON.parse(item.attachments) as string[];
      if (
        content.length + part.length > 12000 ||
        versions.length + ids.length > 10
      )
        break;
      batch.push(item);
      versions.push(...ids);
      content += (content ? "\n\n" : "") + part;
    }
    if (!batch.length) {
      batch.push(m);
      content = m.content;
      versions.push(...JSON.parse(m.attachments));
    }
    try {
      const accepted = this.execution.submit(
        task.agentId,
        task.id,
        content,
        `delivery_${batch[0].id}`,
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
        {
          source: "agent",
          senderId: m.senderAgentId,
          requestId:
            batch[0].kind === "question"
              ? m.requestId
              : (task.parentRequestId ?? m.requestId),
          messageId: batch[0].id,
          replyKind:
            batch[0].kind === "question"
              ? "answer"
              : task.parentRequestId &&
                  this.request(task.parentRequestId).kind === "request"
                ? "result"
                : "none",
          rootWorkflowId: r.rootWorkflowId,
          causationId: batch[0].id,
        },
      );
      for (const item of batch)
        this.db
          .prepare(
            "UPDATE communication_deliveries SET state='delivered',turnId=?,inputMessageId=(SELECT inputMessageId FROM agent_turns WHERE id=?) WHERE messageId=?",
          )
          .run(accepted.turnId, accepted.turnId, item.id);
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
        "SELECT m.* FROM communication_messages m JOIN communication_deliveries d ON d.messageId=m.id WHERE m.recipientTaskId=? AND m.kind='question' AND m.answered=0 ORDER BY sequence LIMIT 10",
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
      !["open", "revoking"].includes(r.state) ||
      (r.targetTaskId === owner.taskId &&
        !!this.db
          .prepare(
            "SELECT 1 FROM communication_messages m JOIN communication_deliveries d ON d.messageId=m.id WHERE m.recipientTaskId=? AND m.requestId=? AND m.kind='answer'",
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
        `SELECT m.* FROM communication_messages m JOIN communication_deliveries d ON d.messageId=m.id WHERE m.recipientTaskId=? AND m.requestId IN (${ids.map(() => "?").join(",")}) AND m.kind!='progress' ORDER BY sequence DESC LIMIT 10`,
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
      for (const r of impact.requests)
        this.db
          .prepare(
            "UPDATE agent_requests SET state='revoking' WHERE id=? AND state='open'",
          )
          .run(r.id);
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
    for (const r of this.db
      .prepare(
        "SELECT id,targetTaskId FROM agent_requests WHERE state='open' AND deadline<=? LIMIT 32",
      )
      .all(now()) as any[]) {
      this.db.transaction(() =>
        this.terminal(r.id, "expired", "The agent request deadline expired."),
      )();
      if (r.targetTaskId)
        void this.execution.cancelTask(r.targetTaskId).catch(() => {});
    }
    for (const d of this.db
      .prepare(
        "SELECT d.messageId FROM communication_deliveries d JOIN communication_messages m ON m.id=d.messageId LEFT JOIN agent_tasks t ON t.id=m.recipientTaskId WHERE d.state='pending' AND (t.id IS NULL OR (t.status NOT IN ('failed','blocked','running') AND NOT EXISTS(SELECT 1 FROM messaging_waits w WHERE w.taskId=t.id AND w.state='waiting'))) ORDER BY d.createdAt,d.messageId LIMIT 32",
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
          .prepare("DELETE FROM communication_links WHERE id=?")
          .run(op.linkId);
        this.db
          .prepare(
            "UPDATE messaging_operations SET state='completed',updatedAt=? WHERE id=?",
          )
          .run(now(), id);
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
