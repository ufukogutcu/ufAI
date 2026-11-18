import type Database from "better-sqlite3";
import type { AgentExecution } from "./agent-execution.js";
import type { FreezePolicy, WorkspaceExecutionControl } from "./contracts.js";
import { ConnectionError } from "./model-providers.js";

export function migrateWorkspaceFreezing(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_freezes (
    workspaceId TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    requestedAt TEXT, frozenAt TEXT, cutoff TEXT, eventCutoff INTEGER,
    occurrenceCutoff INTEGER, policy TEXT, batch TEXT
  );
  CREATE TABLE IF NOT EXISTS workspace_freeze_agents (
    agentId TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    releaseOnResume INTEGER NOT NULL, prepared INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS workspace_freeze_members ON workspace_freeze_agents(workspaceId,releaseOnResume,prepared);
  CREATE TABLE IF NOT EXISTS workspace_freeze_requests (
    requestId TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    action TEXT NOT NULL, input TEXT NOT NULL
  );`);
}

type ControlInput = { requestId: string; expectedRevision: number; policy?: FreezePolicy };
type WorkspaceFreeze = {
  workspaceId: string; state: WorkspaceExecutionControl["state"]; revision: number;
  requestedAt: string | null; frozenAt: string | null;
};

/** Workspace holds are independent of individual freezes and keep admission closed
 * until every member's existing trigger preparation has completed. */
export class WorkspaceFreezing {
  private cursor = "";
  constructor(private db: Database.Database, private execution: AgentExecution) {}

  private required(id: string) {
    this.execution.assertWorkspaceAvailable(id);
    if (!this.db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(id))
      throw new ConnectionError("Workspace not found.", 404);
  }

  control(id: string): WorkspaceExecutionControl {
    this.required(id);
    const row = this.db.prepare("SELECT * FROM workspace_freezes WHERE workspaceId=?").get(id) as WorkspaceFreeze | undefined;
    const counts = this.db.prepare(`SELECT count(*) agentCount,
      coalesce(sum(m.releaseOnResume),0) resumeAgentCount,
      coalesce(sum(f.state IN ('frozen','resuming') OR (f.state='active' AND m.prepared=1)),0) frozenAgentCount
      FROM agents a LEFT JOIN agent_freezes f ON f.agentId=a.id
      LEFT JOIN workspace_freeze_agents m ON m.agentId=a.id WHERE a.workspaceId=?`).get(id) as {
        agentCount: number; resumeAgentCount: number; frozenAgentCount: number;
      };
    // The queue choice only affects members released by this workspace operation.
    const queued = this.db.prepare(`SELECT count(*) n FROM trigger_occurrences o JOIN agent_triggers g ON g.id=o.triggerId
      JOIN workspace_freeze_agents m ON m.agentId=g.agentId
      WHERE m.workspaceId=? AND m.releaseOnResume=1 AND (o.state='queued' OR (o.state='submitted' AND NOT EXISTS
      (SELECT 1 FROM agent_turns t WHERE t.taskId=o.taskId AND t.snapshot IS NOT NULL)))`).get(id) as { n: number };
    const backlog = this.db.prepare(`SELECT 1 FROM trigger_revisions r JOIN agent_triggers g ON g.id=r.triggerId
      JOIN workspace_freeze_agents m ON m.agentId=g.agentId
      WHERE m.workspaceId=? AND m.releaseOnResume=1 AND g.deleted=0 AND r.nextAt<=?
      AND (r.endedAt IS NULL OR r.nextAt<=r.endedAt)
      UNION ALL SELECT 1 FROM trigger_events e JOIN trigger_revisions r ON r.sequence<=e.sequence
      AND (r.untilSequence IS NULL OR r.untilSequence>e.sequence) JOIN agent_triggers g ON g.id=r.triggerId
      JOIN workspace_freeze_agents m ON m.agentId=g.agentId
      WHERE m.workspaceId=? AND m.releaseOnResume=1 AND g.deleted=0 AND e.processed=0 AND e.cursor<r.sequence
      AND json_extract(r.input,'$.when.kind')='event' LIMIT 1`).get(id, new Date().toISOString(), id);
    return { state: row?.state ?? "active", revision: row?.revision ?? 1,
      requestedAt: row?.requestedAt ?? null, frozenAt: row?.frozenAt ?? null,
      ...counts, queuedTriggerCount: queued.n, backlogPending: !!backlog };
  }

  request(id: string, action: "pause" | "resume", input: ControlInput) {
    this.required(id);
    const encoded = JSON.stringify({ requestId: input.requestId, expectedRevision: input.expectedRevision,
      ...(input.policy === undefined ? {} : { policy: input.policy }) });
    const agents: string[] = [];
    this.db.transaction(() => {
      const old = this.db.prepare("SELECT * FROM workspace_freeze_requests WHERE requestId=?").get(input.requestId) as {
        workspaceId: string; action: string; input: string;
      } | undefined;
      if (old) {
        if (old.workspaceId !== id || old.action !== action || old.input !== encoded)
          throw new ConnectionError("This workspace control request ID was already used.", 409);
        return;
      }
      const control = this.control(id);
      if (control.revision !== input.expectedRevision)
        throw new ConnectionError("Workspace pause state changed. Refresh and try again.", 409);
      if (action === "resume" && control.state !== "frozen")
        throw new ConnectionError("Wait until the workspace is paused before resuming.", 409);
      if (control.state === "resuming") throw new ConnectionError("Resume preparation is still running. Try again when it finishes.", 409);
      if (action === "pause" && this.db.prepare(`SELECT 1 FROM agent_freezes f JOIN agents a ON a.id=f.agentId
        WHERE a.workspaceId=? AND f.state='resuming' LIMIT 1`).get(id))
        throw new ConnectionError("An agent is preparing to resume. Try pausing again when it finishes.", 409);
      this.db.prepare("INSERT INTO workspace_freeze_requests VALUES(?,?,?,?)").run(input.requestId,id,action,encoded);
      if (action === "pause" && control.state !== "active") return;
      const stamp = new Date().toISOString();
      this.db.prepare("INSERT OR IGNORE INTO workspace_freezes(workspaceId,state) VALUES(?,'active')").run(id);
      if (action === "pause") {
        // Commit the admission gate and all member ownership in the same transaction.
        this.db.prepare("UPDATE workspace_freezes SET state='freezing',revision=revision+1,requestedAt=?,frozenAt=NULL WHERE workspaceId=?").run(stamp,id);
        this.db.prepare(`INSERT INTO workspace_freeze_agents(agentId,workspaceId,releaseOnResume)
          SELECT a.id,a.workspaceId,coalesce(f.state,'active')='active' FROM agents a
          LEFT JOIN agent_freezes f ON f.agentId=a.id WHERE a.workspaceId=?`).run(id);
        for (const a of this.db.prepare("SELECT agentId,releaseOnResume FROM workspace_freeze_agents WHERE workspaceId=?").all(id) as {agentId:string;releaseOnResume:number}[]) {
          agents.push(a.agentId);
          if (a.releaseOnResume) this.execution.freezing.beginFreeze(a.agentId,stamp);
          else this.db.prepare("UPDATE agent_freezes SET revision=revision+1 WHERE agentId=?").run(a.agentId);
        }
      } else {
        this.db.prepare(`UPDATE workspace_freezes SET state='resuming',revision=revision+1,cutoff=?,
          eventCutoff=(SELECT value FROM trigger_clock),occurrenceCutoff=coalesce((SELECT max(sequence) FROM trigger_occurrences),0),policy=?,batch=? WHERE workspaceId=?`)
          .run(stamp,input.policy,input.requestId,id);
        this.db.prepare(`UPDATE agent_freezes SET revision=revision+1 WHERE agentId IN
          (SELECT agentId FROM workspace_freeze_agents WHERE workspaceId=? AND releaseOnResume=0)`).run(id);
        this.db.prepare(`UPDATE agent_freezes SET state='resuming',revision=revision+1,cutoff=?,
          eventCutoff=(SELECT eventCutoff FROM workspace_freezes WHERE workspaceId=?),
          occurrenceCutoff=(SELECT occurrenceCutoff FROM workspace_freezes WHERE workspaceId=?),policy=?,batch=?
          WHERE agentId IN (SELECT agentId FROM workspace_freeze_agents WHERE workspaceId=? AND releaseOnResume=1)`)
          .run(stamp,id,id,input.policy,input.requestId,id);
      }
    }).immediate();
    for (const agentId of agents) this.execution.freezeChanged(agentId);
    this.settle(id);
    this.execution.workspaceEvent(id);
    return this.control(id);
  }

  /** Called inside agent creation's transaction, before any work can be admitted. */
  inherit(agentId: string, workspaceId: string) {
    const row = this.db.prepare("SELECT state,requestedAt FROM workspace_freezes WHERE workspaceId=? AND state!='active'").get(workspaceId) as {state:string;requestedAt:string} | undefined;
    if (!row) return;
    this.db.prepare("INSERT INTO workspace_freeze_agents(agentId,workspaceId,releaseOnResume,prepared) VALUES(?,?,1,?)").run(agentId,workspaceId,row.state === "resuming" ? 1 : 0);
    this.db.prepare("INSERT INTO agent_freezes(agentId,state,revision,requestedAt,frozenAt) VALUES(?,'frozen',2,?,?)").run(agentId,row.requestedAt,new Date().toISOString());
  }

  settle(id: string) {
    let changed = false;
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT state FROM workspace_freezes WHERE workspaceId=?").get(id) as {state:string} | undefined;
      if (row?.state === "freezing" && !this.db.prepare(`SELECT 1 FROM agent_freezes f JOIN agents a ON a.id=f.agentId
        WHERE a.workspaceId=? AND f.state='freezing' LIMIT 1`).get(id)) {
        this.db.prepare("UPDATE workspace_freezes SET state='frozen',revision=revision+1,frozenAt=? WHERE workspaceId=?").run(new Date().toISOString(),id);
        changed = true;
      } else if (row?.state === "resuming" && !this.db.prepare("SELECT 1 FROM workspace_freeze_agents WHERE workspaceId=? AND releaseOnResume=1 AND prepared=0 LIMIT 1").get(id)) {
        this.db.prepare(`UPDATE agent_freezes SET state=CASE WHEN agentId IN
          (SELECT agentId FROM workspace_freeze_agents WHERE workspaceId=? AND releaseOnResume=1) THEN 'active' ELSE state END,
          revision=revision+1 WHERE agentId IN (SELECT agentId FROM workspace_freeze_agents WHERE workspaceId=?)`).run(id,id);
        this.db.prepare("UPDATE workspace_freezes SET state='active',revision=revision+1 WHERE workspaceId=?").run(id);
        this.db.prepare("DELETE FROM workspace_freeze_agents WHERE workspaceId=?").run(id);
        changed = true;
      }
    })();
    if (changed) { this.execution.workspaceEvent(id); this.execution.wake(); }
  }

  settlePending() {
    const rows = this.db.prepare(`SELECT workspaceId FROM workspace_freezes WHERE state IN ('freezing','resuming')
      ORDER BY (workspaceId<=?),workspaceId LIMIT 32`).all(this.cursor) as {workspaceId:string}[];
    for (const row of rows) this.settle(row.workspaceId);
    if (rows.length) this.cursor = rows.at(-1)!.workspaceId;
  }
}
