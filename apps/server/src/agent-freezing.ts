import type Database from "better-sqlite3";
import type { AgentExecution } from "./agent-execution.js";
import { ConnectionError } from "./model-providers.js";
import type { AgentExecutionControl, FreezePolicy } from "./contracts.js";

export function migrateFreezing(db: Database.Database) {
  if (!(db.pragma("table_info(trigger_occurrences)") as {name:string}[]).some(c=>c.name === "resumeBatch")) db.exec("ALTER TABLE trigger_occurrences ADD COLUMN resumeBatch TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_freezes (
      agentId TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      requestedAt TEXT, frozenAt TEXT, cutoff TEXT, eventCutoff INTEGER,
      policy TEXT, batch TEXT, replaying INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS agent_freeze_requests (
      requestId TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      action TEXT NOT NULL, input TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_resume_blockers (
      agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      PRIMARY KEY(agentId,taskId)
    );
    CREATE TABLE IF NOT EXISTS execution_checkpoints (
      turnId TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1, safe INTEGER NOT NULL DEFAULT 0,
      context TEXT, taskContext TEXT, messageId TEXT, answer TEXT, phase TEXT, maintenanceBaseline TEXT
    );
    CREATE TABLE IF NOT EXISTS execution_rounds (
      turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, response TEXT NOT NULL,
      PRIMARY KEY(turnId,ordinal)
    );
    CREATE TABLE IF NOT EXISTS execution_results (
      turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      callId TEXT NOT NULL, call TEXT NOT NULL, result TEXT,
      PRIMARY KEY(turnId,callId)
    );
    CREATE TABLE IF NOT EXISTS execution_deliveries (
      turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      round INTEGER NOT NULL, position INTEGER NOT NULL, callId TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(turnId,round,position)
    );
    CREATE TABLE IF NOT EXISTS execution_generations (
      turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      key TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(turnId,key)
    );

    CREATE INDEX IF NOT EXISTS trigger_resume_batch ON trigger_occurrences(resumeBatch,state,scheduledAt,sequence);
  `);
}

/** Version 36 used millisecond timestamps for manual-run cutoffs. */
export function migrateFreezeCutoffs(db: Database.Database) {
  if (!(db.pragma("table_info(agent_freezes)") as {name:string}[]).some(c => c.name === "occurrenceCutoff"))
    db.exec("ALTER TABLE agent_freezes ADD COLUMN occurrenceCutoff INTEGER NOT NULL DEFAULT 0");
  // An old in-progress choice has no authoritative manual-run sequence boundary.
  // Ask for a fresh choice instead of applying it to potentially newer requests.
  db.prepare(`UPDATE agent_freezes AS f SET state='frozen',revision=revision+1
    WHERE f.state='resuming' AND EXISTS(SELECT 1 FROM trigger_occurrences o JOIN agent_triggers g ON g.id=o.triggerId
      WHERE g.agentId=f.agentId AND o.kind='manual' AND o.state IN ('queued','submitted')
      AND (o.resumeBatch IS NULL OR o.resumeBatch!=f.batch))`).run();
  db.prepare("UPDATE agent_freezes SET occurrenceCutoff=coalesce((SELECT max(sequence) FROM trigger_occurrences),0) WHERE state='resuming'").run();
}

function controlInput(input: {requestId:string;expectedRevision:number;policy?:FreezePolicy}) {
  return JSON.stringify({requestId:input.requestId,expectedRevision:input.expectedRevision,...(input.policy === undefined ? {} : {policy:input.policy})});
}

/** Durable control state is independent of task lifecycle and agent configuration. */
export class AgentFreezing {
  constructor(readonly db: Database.Database, private execution: AgentExecution) {}
  state(id: string): AgentExecutionControl["state"] {
    return (this.db.prepare("SELECT state FROM agent_freezes WHERE agentId=?").get(id) as any)?.state ?? "active";
  }
  blocked(id: string) { return this.state(id) !== "active"; }
  control(id: string): AgentExecutionControl {
    const row = this.db.prepare("SELECT * FROM agent_freezes WHERE agentId=?").get(id) as any;
    const queued = this.db.prepare(`SELECT count(*) n FROM trigger_occurrences o JOIN agent_triggers g ON g.id=o.triggerId
      WHERE g.agentId=? AND (o.state='queued' OR (o.state='submitted' AND NOT EXISTS
      (SELECT 1 FROM agent_turns t WHERE t.taskId=o.taskId AND t.snapshot IS NOT NULL)))`).get(id) as any;
    const backlog = this.db.prepare(`SELECT 1 FROM trigger_revisions r JOIN agent_triggers g ON g.id=r.triggerId
      WHERE g.agentId=? AND g.deleted=0 AND r.nextAt<=? AND (r.endedAt IS NULL OR r.nextAt<=r.endedAt)
      UNION ALL SELECT 1 FROM trigger_events e JOIN trigger_revisions r ON r.sequence<=e.sequence
      AND (r.untilSequence IS NULL OR r.untilSequence>e.sequence) JOIN agent_triggers g ON g.id=r.triggerId
      WHERE g.agentId=? AND g.deleted=0 AND e.processed=0 AND e.cursor<r.sequence
      AND json_extract(r.input,'$.when.kind')='event' LIMIT 1`).get(id, new Date().toISOString(), id);
    return { state: row?.state ?? "active", revision: row?.revision ?? 1,
      requestedAt: row?.requestedAt ?? null, frozenAt: row?.frozenAt ?? null,
      queuedTriggerCount: queued.n, backlogPending: !!backlog };
  }
  request(id: string, action: "freeze" | "resume", input: { requestId: string; expectedRevision: number; policy?: FreezePolicy }) {
    this.execution.requiredAgent(id);
    const encoded = controlInput(input);
    this.db.transaction(() => {
      const old = this.db.prepare("SELECT * FROM agent_freeze_requests WHERE requestId=?").get(input.requestId) as any;
      if (old) {
        if (old.agentId !== id || old.action !== action || controlInput(JSON.parse(old.input)) !== encoded)
          throw new ConnectionError("This control request ID was already used.", 409);
        return;
      }
      const control = this.control(id);
      if (control.revision !== input.expectedRevision)
        throw new ConnectionError("Agent freeze state changed. Refresh and try again.", 409);
      if (action === "resume" && control.state !== "frozen")
        throw new ConnectionError("Wait until the agent is frozen before resuming.", 409);
      if (action === "freeze" && control.state === "resuming")
        throw new ConnectionError("Resume preparation is still running.", 409);
      this.db.prepare("INSERT INTO agent_freeze_requests VALUES(?,?,?,?)").run(input.requestId,id,action,encoded);
      if (action === "freeze" && control.state !== "active") return;
      const stamp = new Date().toISOString();
      this.db.prepare("INSERT OR IGNORE INTO agent_freezes(agentId,state) VALUES(?,'active')").run(id);
      if (action === "freeze") {
        this.db.prepare("UPDATE agent_freezes SET state='freezing',revision=revision+1,requestedAt=?,frozenAt=NULL WHERE agentId=?").run(stamp,id);
        this.db.prepare(`INSERT OR IGNORE INTO agent_resume_blockers SELECT ?,t.id FROM agent_tasks t
          WHERE t.agentId=? AND t.kind='task' AND t.status NOT IN ('completed','failed','cancelled')
          AND EXISTS(SELECT 1 FROM agent_turns r WHERE r.taskId=t.id AND r.status IN ('running','waiting') AND r.snapshot IS NOT NULL)`).run(id,id);
      } else {
        this.db.prepare(`UPDATE agent_freezes SET state='resuming',revision=revision+1,cutoff=?,eventCutoff=(SELECT value FROM trigger_clock),occurrenceCutoff=coalesce((SELECT max(sequence) FROM trigger_occurrences),0),policy=?,batch=? WHERE agentId=?`)
          .run(stamp,input.policy,input.requestId,id);
      }
    })();
    this.execution.freezeChanged(id);
    return this.execution.requiredAgent(id);
  }
  private occurrenceAdmissionSql(occurrence: string) {
    return `NOT EXISTS(SELECT 1 FROM agent_freezes freeze_control WHERE freeze_control.agentId=${occurrence}.agentId AND freeze_control.replaying=1 AND (
      EXISTS(SELECT 1 FROM agent_resume_blockers b JOIN agent_tasks task ON task.id=b.taskId
        WHERE b.agentId=freeze_control.agentId AND task.status NOT IN ('completed','failed','cancelled'))
      OR EXISTS(SELECT 1 FROM trigger_occurrences other_occurrence JOIN agent_triggers other_trigger ON other_trigger.id=other_occurrence.triggerId JOIN agent_tasks task ON task.id=other_occurrence.taskId
        WHERE other_trigger.agentId=freeze_control.agentId AND task.status NOT IN ('completed','failed','cancelled') AND other_occurrence.id!=${occurrence}.id
        AND EXISTS(SELECT 1 FROM agent_turns started WHERE started.taskId=task.id AND started.snapshot IS NOT NULL))
      OR ${occurrence}.id!=coalesce((SELECT next.id FROM trigger_occurrences next JOIN agent_triggers definition ON definition.id=next.triggerId
        WHERE definition.agentId=freeze_control.agentId AND next.resumeBatch=freeze_control.batch AND next.state IN ('queued','submitted') AND definition.deleted=0
        AND json_extract(definition.input,'$.enabled')=1 AND json_extract(definition.input,'$.paused')=0
        AND definition.dependencyError IS NULL AND definition.dispatchError IS NULL
        ORDER BY next.scheduledAt,next.sequence LIMIT 1),${occurrence}.id)
    ))`;
  }
  /** Apply before lane ranking, so a held trigger cannot hide user/helper work. */
  taskAdmissionSql(taskId: string) {
    return `NOT EXISTS(SELECT 1 FROM (SELECT o.*,g.agentId FROM trigger_occurrences o JOIN agent_triggers g ON g.id=o.triggerId) freeze_occurrence
      WHERE freeze_occurrence.taskId=${taskId}
      AND NOT EXISTS(SELECT 1 FROM agent_turns started WHERE started.taskId=${taskId} AND started.snapshot IS NOT NULL)
      AND NOT (${this.occurrenceAdmissionSql("freeze_occurrence")}))`;
  }
  /** Started work and user/helper inputs bypass the catch-up admission fence. */
  canRunTask(agentId: string, taskId: string) {
    return !!this.db.prepare(`SELECT 1 FROM agent_tasks task WHERE task.id=? AND task.agentId=? AND ${this.taskAdmissionSql("task.id")}`).get(taskId,agentId);
  }
  canDispatch(agentId: string, occurrenceId: string) {
    if (this.blocked(agentId)) return false;
    const admitted = this.db.prepare(`SELECT 1 FROM (SELECT o.*,g.agentId FROM trigger_occurrences o JOIN agent_triggers g ON g.id=o.triggerId) candidate
      WHERE candidate.id=? AND candidate.agentId=? AND ${this.occurrenceAdmissionSql("candidate")}`).get(occurrenceId,agentId);
    if (!admitted) return false;
    this.db.prepare(`UPDATE agent_freezes SET replaying=0 WHERE agentId=? AND replaying=1
      AND NOT EXISTS(SELECT 1 FROM trigger_occurrences WHERE resumeBatch=agent_freezes.batch AND state IN ('queued','submitted'))`).run(agentId);
    return true;
  }
}
