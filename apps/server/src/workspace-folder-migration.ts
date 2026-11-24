import type Database from "better-sqlite3";

export const retiredFileEvent = "ufai.artifact.published";
const retirementMessage = "This file event was retired. Choose another event type to enable this trigger.";

export function migrateWorkspaceFolder(db: Database.Database) {
  db.exec(`
    DROP TRIGGER IF EXISTS trigger_artifact_event;
    CREATE TABLE IF NOT EXISTS workspace_file_imports (
      versionId TEXT PRIMARY KEY REFERENCES artifact_versions(id) ON DELETE CASCADE,
      destination TEXT, stagingName TEXT, finished INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS workspace_file_imports_pending ON workspace_file_imports(versionId) WHERE finished=0;
    INSERT OR IGNORE INTO workspace_file_imports(versionId)
      SELECT id FROM artifact_versions WHERE origin='published' AND state='ready' AND ingestId IS NULL;
    UPDATE artifact_versions SET origin='legacy_output' WHERE origin='published';
    -- Keep access to exact legacy bytes already inspected or selected while they were workspace-visible.
    INSERT OR IGNORE INTO artifact_grants(taskId,versionId)
      SELECT t.taskId,v.id FROM media_open_references m JOIN agent_turns t ON t.id=m.turnId
      JOIN artifact_versions v ON v.id=m.versionId JOIN agents a ON a.id=t.agentId
      WHERE v.origin='legacy_output' AND a.workspaceId=v.workspaceId AND t.taskId IS NOT NULL;
    INSERT OR IGNORE INTO artifact_grants(taskId,versionId)
      SELECT t.taskId,v.id FROM task_output_selections s JOIN agent_turns t ON t.id=s.turnId
      JOIN json_each(s.versions) selected JOIN artifact_versions v ON v.id=selected.value
      JOIN agents a ON a.id=t.agentId
      WHERE v.origin='legacy_output' AND a.workspaceId=v.workspaceId AND t.taskId IS NOT NULL;

  `);
  db.prepare("UPDATE trigger_events SET processed=1 WHERE eventType=? AND processed=0").run(retiredFileEvent);
  db.prepare(`UPDATE trigger_occurrences SET state='cancelled',error=?
    WHERE state='queued' AND (
      EXISTS(SELECT 1 FROM trigger_events e WHERE e.id=trigger_occurrences.eventId AND e.eventType=?)
      OR EXISTS(SELECT 1 FROM trigger_revisions r WHERE r.triggerId=trigger_occurrences.triggerId
        AND r.revision=trigger_occurrences.revision AND json_extract(r.input,'$.when.eventType')=?)
      OR EXISTS(SELECT 1 FROM agent_triggers t WHERE t.id=trigger_occurrences.triggerId
        AND json_extract(t.input,'$.when.eventType')=?)
    )`).run(retirementMessage, retiredFileEvent, retiredFileEvent, retiredFileEvent);

  const retired = db.prepare(`SELECT id,revision, json_set(input,'$.enabled',json('false')) AS input
    FROM agent_triggers WHERE deleted=0 AND json_extract(input,'$.when.eventType')=? ORDER BY id`);
  const nextSequence = db.prepare("UPDATE trigger_clock SET value=value+1 WHERE id=1 RETURNING value");
  const close = db.prepare("UPDATE trigger_revisions SET untilSequence=?,endedAt=? WHERE triggerId=? AND untilSequence IS NULL");
  const clearSchedule = db.prepare("UPDATE trigger_revisions SET nextAt=NULL WHERE triggerId=? AND nextAt IS NOT NULL");
  const insert = db.prepare("INSERT INTO trigger_revisions(sequence,triggerId,revision,input,startedAt) VALUES(?,?,?,?,?)");
  const update = db.prepare("UPDATE agent_triggers SET input=?,revision=?,updatedAt=?,dispatchError=?,retryAt=NULL WHERE id=?");
  const now = new Date().toISOString();
  for (const { id, revision, input } of retired.all(retiredFileEvent) as { id: string; revision: number; input: string }[]) {
    const { value } = nextSequence.get() as { value: number };
    close.run(value, now, id);
    clearSchedule.run(id);
    insert.run(value, id, revision + 1, input, now);
    update.run(input, revision + 1, now, retirementMessage, id);
  }
}
