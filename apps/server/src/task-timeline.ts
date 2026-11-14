import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { AgentExecution } from "./agent-execution.js";
import type {
  AgentMessage,
  AgentRequest,
  CommunicationMessage,
  ExecutionItem,
  OwnedProcess,
  TaskCheckIn,
  TimelineEntry,
  TimelinePage,
  TimelineStatus,
  ArtifactVersion,
} from "./contracts.js";
import { InputError, pagination } from "./validation.js";

function record(value: string | null | undefined): Record<string, any> {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

// Only metadata is sorted here. Full text/results are read for the bounded page.
// Final/live message anchors must not use the assistant row's creation time: it
// is allocated before the first tool runs. Text segment IDs survive promotion
// from the mutable assistant row into immutable commentary.
const candidates = `WITH ordered_execution AS (
  SELECT id,taskId,turnId,sequence,kind,createdAt,
    CASE WHEN kind='artifact' THEN content ELSE '' END content,
    max(createdAt) OVER (PARTITION BY turnId ORDER BY sequence) displayAt,
    coalesce(sum(kind='commentary') OVER (PARTITION BY turnId ORDER BY sequence ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) segment
  FROM execution_items WHERE taskId=@task
), candidates AS (
  SELECT 'message' source,m.id sourceId,
    CASE WHEN m.role='assistant' AND m.turnId IS NOT NULL THEN m.turnId||':text:'||
      (SELECT count(*) FROM execution_items e WHERE e.taskId=@task AND e.turnId=m.turnId AND e.kind='commentary')
      ELSE 'message:'||m.id END id,
    coalesce(CASE WHEN m.role='assistant' THEN
      (SELECT max(createdAt) FROM execution_items WHERE taskId=@task AND turnId=m.turnId) END,m.createdAt)||
      CASE WHEN m.role='assistant' THEN ':2:' ELSE ':0:' END||printf('%020d',m.sequence)||':'||m.id ord
  FROM agent_messages m WHERE m.conversationId=@conversation
    AND NOT EXISTS (SELECT 1 FROM communication_deliveries d WHERE d.inputMessageId=m.id) AND
    (m.role!='assistant' OR m.content!='' OR EXISTS(SELECT 1 FROM artifact_references WHERE messageId=m.id))
  UNION ALL
  SELECT 'execution',e.id,
    CASE WHEN e.kind='commentary' THEN e.turnId||':text:'||
      e.segment
      ELSE 'execution:'||e.id END,
    e.displayAt||':1:'||printf('%020d',e.sequence)||':'||e.id
  FROM ordered_execution e WHERE e.taskId=@task AND e.kind IN ('commentary','tool_call','artifact')
    AND (e.kind!='artifact' OR NOT EXISTS (
      SELECT 1 FROM tool_invocations i WHERE i.turnId=e.turnId
        AND json_valid(i.result) AND json_valid(e.content) AND json_extract(i.result,'$.version.id')=json_extract(e.content,'$.versionId'))
      AND NOT EXISTS (SELECT 1 FROM artifact_references r JOIN agent_messages m ON m.id=r.messageId
        WHERE m.conversationId=@conversation AND json_valid(e.content) AND r.versionId=json_extract(e.content,'$.versionId')))
  UNION ALL
  SELECT 'communication',c.id,'communication:'||c.id,coalesce((SELECT mt.arrivesAt FROM message_transits mt WHERE mt.messageId=c.id),c.createdAt)||':1:'||printf('%020d',c.sequence)||':'||c.id
  FROM communication_messages c WHERE (c.senderTaskId=@task OR c.recipientTaskId=@task)
    AND NOT EXISTS (SELECT 1 FROM tool_invocations i JOIN agent_turns t ON t.id=i.turnId
      WHERE t.taskId=@task AND json_valid(i.result) AND json_extract(i.result,'$.messageId')=c.id)
    AND NOT EXISTS (SELECT 1 FROM tool_invocations i JOIN agent_turns t ON t.id=i.turnId
      WHERE t.taskId=@task AND c.senderTaskId=@task AND i.name IN ('agent_send','agent_message')
        AND json_valid(i.arguments) AND json_extract(i.arguments,'$.content')=c.content
        AND i.createdAt<=c.createdAt)
    AND NOT EXISTS (SELECT 1 FROM messaging_idempotency k WHERE k.id LIKE 'final_%'
      AND json_valid(k.result) AND json_extract(k.result,'$.messageId')=c.id AND c.senderTaskId=@task)
    AND NOT EXISTS (SELECT 1 FROM message_transits mt WHERE mt.messageId=c.id AND c.recipientTaskId=@task AND mt.state!='arrived')
  UNION ALL
  SELECT 'checkin',c.id,'checkin:'||c.id,c.createdAt||':1:00000000000000000000:'||c.id
  FROM task_checkins c WHERE c.taskId=@task AND NOT EXISTS (
    SELECT 1 FROM tool_invocations i JOIN agent_turns t ON t.id=i.turnId WHERE t.taskId=@task
      AND json_valid(i.result) AND json_extract(i.result,'$.checkinId')=c.id)
)`;

type Candidate = { source: string; sourceId: string; id: string; ord: string };
export function taskTimeline(
  db: Database.Database,
  execution: AgentExecution,
  taskId: string,
  limit = 50,
  before = "",
  watch: string[] = [],
): TimelinePage {
  const task = execution.task(taskId);
  const workspaceId = execution.requiredAgent(task.agentId).workspaceId;
  const bindings = { task: taskId, conversation: task.conversationId };
  function requestInfo(id: unknown): AgentRequest | undefined {
    if (typeof id !== "string") return;
    return db
      .prepare(
        `SELECT r.*,t.status executionState,t.error executionError FROM agent_requests r
      LEFT JOIN agent_tasks t ON t.id=r.targetTaskId WHERE r.id=? AND (r.sourceTaskId=? OR r.targetTaskId=?)`,
      )
      .get(id, taskId, taskId) as AgentRequest | undefined;
  }
  function message(raw: AgentMessage): AgentMessage {
    const author = raw.authorId
      ? (db.prepare("SELECT name FROM agents WHERE id=?").get(raw.authorId) as
          { name: string } | undefined)
      : undefined;
    const deliveries = db
      .prepare(
        `SELECT c.* FROM communication_messages c JOIN communication_deliveries d ON d.messageId=c.id
      WHERE d.inputMessageId=? ORDER BY c.sequence LIMIT 10`,
      )
      .all(raw.id) as (Omit<CommunicationMessage, "attachments"> & {
      attachments: string;
    })[];
    const parts = db
      .prepare(
        `SELECT r.versionId,r.mode,v.name FROM artifact_references r
      JOIN artifact_versions v ON v.id=r.versionId WHERE messageId=? ORDER BY ordinal LIMIT 100`,
      )
      .all(raw.id) as {
      versionId: string;
      mode: "file" | "inspect";
      name: string;
    }[];
    return {
      ...raw,
      authorName:
        author?.name ??
        deliveries[0]?.senderName ??
        (raw.authorType === "system" ? "System" : "Deleted agent"),
      // Delivered envelopes contain routing syntax; the timeline shows the actual
      // collaborator message while leaving persisted model input untouched.
      content: deliveries.length
        ? deliveries.map((c) => c.content).join("\n\n")
        : raw.content,
      parts: parts.map((p) => ({ type: "artifact", ...p })),
    };
  }
  function hydrate(row: Candidate): TimelineEntry {
    const base: TimelineEntry = {
      id: row.id,
      order: row.ord,
      turnId: null,
      createdAt: row.ord.slice(0, 24),
      kind: "action",
    };
    if (row.source === "message") {
      const m = db
        .prepare("SELECT * FROM agent_messages WHERE id=?")
        .get(row.sourceId) as AgentMessage;
      return {
        ...base,
        kind: "message",
        turnId: m.turnId,
        message: message(m),
      };
    }
    if (row.source === "checkin") {
      const checkin = db
        .prepare("SELECT * FROM task_checkins WHERE id=?")
        .get(row.sourceId) as TaskCheckIn;
      return { ...base, kind: "checkin", checkin };
    }
    if (row.source === "communication") {
      const c = db
        .prepare("SELECT * FROM communication_messages WHERE id=?")
        .get(row.sourceId) as Omit<CommunicationMessage, "attachments"> & {
        attachments: string;
      };
      return {
        ...base,
        kind: "communication",
        communication: { ...c, attachments: JSON.parse(c.attachments) },
        request: requestInfo(c.requestId),
      };
    }
    const e = db
      .prepare("SELECT * FROM execution_items WHERE id=?")
      .get(row.sourceId) as ExecutionItem;
    base.turnId = e.turnId;
    if (e.kind === "commentary")
      return {
        ...base,
        kind: "message",
        message: {
          id: row.id,
          conversationId: task.conversationId,
          turnId: e.turnId,
          sequence: e.sequence,
          role: "assistant",
          authorType: "agent",
          content: e.content,
          state: "complete",
          createdAt: e.createdAt,
        },
      };
    const content = record(e.content);
    const callId = typeof content.id === "string" ? content.id : "";
    if (e.kind === "artifact")
      return {
        ...base,
        kind: "file",
        file: db
          .prepare(
            "SELECT * FROM artifact_versions WHERE id=? AND workspaceId=? AND ingestId IS NULL",
          )
          .get(content.versionId ?? "", workspaceId) as
          ArtifactVersion | undefined,
      };
    const invocation = db
      .prepare(
        "SELECT state,result FROM tool_invocations WHERE turnId=? AND callId=?",
      )
      .get(e.turnId, callId) as
      { state: string; result: string | null } | undefined;
    const savedResult =
      invocation?.result ??
      (
        db
          .prepare(
            `SELECT content FROM execution_items WHERE taskId=? AND turnId=? AND kind='tool_result'
      AND json_valid(content) AND json_extract(content,'$.callId')=? ORDER BY sequence DESC LIMIT 1`,
          )
          .get(taskId, e.turnId, callId) as { content: string } | undefined
      )?.content;
    const result = record(savedResult);
    const turn = db
      .prepare("SELECT status FROM agent_turns WHERE id=?")
      .get(e.turnId) as { status: string };
    let status: TimelineStatus = savedResult
      ? result.ok === false
        ? "failed"
        : "completed"
      : "running";
    if (
      turn.status === "cancelled" &&
      (invocation?.state === "interrupted" || !savedResult)
    )
      status = "cancelled";
    else if (invocation?.state === "interrupted") status = "interrupted";
    else if (!savedResult) {
      if (turn.status === "cancelled") status = "cancelled";
      else if (["failed", "blocked"].includes(turn.status)) status = "failed";
      else if (["completed", "superseded", "interrupted"].includes(turn.status))
        status = "interrupted";
      else if (turn.status === "waiting" || turn.status === "queued")
        status = "waiting";
    }
    const args =
      content.arguments &&
      typeof content.arguments === "object" &&
      !Array.isArray(content.arguments)
        ? content.arguments
        : {};
    // Never expose raw invocation arguments: process_input is intentionally redacted.
    const processId =
      typeof args.processId === "string" ? args.processId : result.process?.id;
    const process = (
      processId
        ? db
            .prepare("SELECT * FROM owned_processes WHERE id=? AND taskId=?")
            .get(processId, taskId)
        : content.name === "process_start" &&
            !savedResult &&
            ["running", "waiting"].includes(status)
          ? db
              .prepare(
                "SELECT * FROM owned_processes WHERE turnId=? AND command=? AND createdAt>=? ORDER BY createdAt,id LIMIT 1",
              )
              .get(e.turnId, args.command ?? "", e.createdAt)
          : undefined
    ) as OwnedProcess | undefined;
    const request = requestInfo(result.requestId ?? args.requestId);
    const contextName =
      typeof args.agentId === "string"
        ? (
            db
              .prepare("SELECT name FROM agents WHERE id=? AND workspaceId=?")
              .get(args.agentId, workspaceId) as { name: string } | undefined
          )?.name
        : request
          ? request.sourceTaskId === taskId
            ? request.targetName
            : request.sourceName
          : typeof args.versionId === "string"
            ? (
                db
                  .prepare(
                    "SELECT name FROM artifact_versions WHERE id=? AND workspaceId=? AND ingestId IS NULL",
                  )
                  .get(args.versionId, workspaceId) as
                  { name: string } | undefined
              )?.name
            : typeof args.taskId === "string"
              ? (
                  db
                    .prepare(
                      "SELECT title FROM agent_tasks WHERE id=? AND agentId=?",
                    )
                    .get(args.taskId, task.agentId) as
                    { title: string } | undefined
                )?.title
              : undefined;
    const checkinId = result.checkinId ?? args.checkinId;
    const checkin =
      typeof checkinId === "string"
        ? (db
            .prepare("SELECT * FROM task_checkins WHERE id=? AND taskId=?")
            .get(checkinId, taskId) as TaskCheckIn | undefined)
        : undefined;
    return {
      ...base,
      name: typeof content.name === "string" ? content.name : "unknown",
      arguments: args,
      result,
      status,
      error:
        typeof result.error === "string"
          ? result.error
          : status === "interrupted"
            ? "Execution was interrupted; the outcome may be uncertain."
            : status === "failed"
              ? "Execution failed before a result was recorded."
              : undefined,
      process,
      request,
      contextName,
      checkin,
    };
  }
  return db.transaction(() => {
    const rows = db
      .prepare(
        `${candidates} SELECT * FROM candidates WHERE (@before='' OR ord<@before) ORDER BY ord DESC LIMIT @limit`,
      )
      .all({ ...bindings, before, limit: limit + 1 }) as Candidate[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit).reverse();
    const updates = watch.length
      ? (
          db
            .prepare(
              `${candidates} SELECT * FROM candidates WHERE id IN (SELECT value FROM json_each(@watch)) LIMIT 100`,
            )
            .all({ ...bindings, watch: JSON.stringify(watch) }) as Candidate[]
        ).map(hydrate)
      : [];
    return {
      items: selected.map(hydrate),
      before: hasMore ? selected[0]!.ord : null,
      updates,
      removed: watch.filter((id) => !updates.some((i) => i.id === id)),
    };
  })();
}

export function registerTimeline(
  app: FastifyInstance,
  db: Database.Database,
  execution: AgentExecution,
) {
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; before?: string; watch?: string };
  }>("/api/tasks/:id/timeline", async (req) => {
    const { limit } = pagination(req.query);
    const before = req.query.before ?? "";
    if (
      typeof before !== "string" ||
      before.length > 500 ||
      (before && !/^\d{4}-\d\d-\d\dT/.test(before))
    )
      throw new InputError({
        before: "Use a timeline cursor returned by this task.",
      });
    if (req.query.watch !== undefined && typeof req.query.watch !== "string")
      throw new InputError({
        watch: "Use comma-separated timeline entry IDs.",
      });
    const watch = req.query.watch?.split(",").filter(Boolean) ?? [];
    if (watch.length > 100 || watch.some((id) => id.length > 250))
      throw new InputError({ watch: "Watch at most 100 timeline entries." });
    return taskTimeline(db, execution, req.params.id, limit, before, watch);
  });
}
