import type Database from "better-sqlite3";

const lineage = `(SELECT json_extract(envelope,'$.trigger.lineage') FROM agent_turns WHERE taskId=NEW.id ORDER BY rowid DESC LIMIT 1)`;
const turn = `(SELECT id||':'||attempt FROM agent_turns WHERE taskId=NEW.id ORDER BY rowid DESC LIMIT 1)`;
const taskLifecycle = `    CREATE TRIGGER trigger_task_event AFTER UPDATE OF status ON agent_tasks
    WHEN NEW.kind='task' AND NEW.status IN ('completed','failed') AND NEW.status!=OLD.status
    BEGIN
      UPDATE trigger_clock SET value=value+1 WHERE id=1;
      INSERT OR IGNORE INTO trigger_events(sequence,id,workspaceId,sourceKey,eventId,eventType,occurredAt,receivedAt,data,fingerprint,lineage)
      SELECT (SELECT value FROM trigger_clock), 'task:'||NEW.id||':'||coalesce(${turn},'none')||':'||NEW.status,
        a.workspaceId, 'builtin', 'task:'||NEW.id||':'||coalesce(${turn},'none')||':'||NEW.status,
        'ufai.task.'||NEW.status, NEW.updatedAt, NEW.updatedAt,
        json_object('taskId',NEW.id,'agentId',NEW.agentId,'title',NEW.title,'status',NEW.status,'turnId',(SELECT id FROM agent_turns WHERE taskId=NEW.id ORDER BY rowid DESC LIMIT 1),'summary',substr(NEW.summary,1,2000),'error',substr(NEW.error,1,2000)),
        NEW.id||':'||coalesce(${turn},'none')||':'||NEW.status,coalesce(${lineage},'[]')
      FROM agents a WHERE a.id=NEW.agentId;
    END;
`;

export function migrateTriggers(db: Database.Database) {
  db.exec(`
    CREATE INDEX trigger_turn_start ON agent_turns(taskId) WHERE snapshot IS NOT NULL;
    CREATE TABLE trigger_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
    INSERT INTO trigger_clock VALUES(1,0);
    CREATE TABLE agent_triggers (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, input TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, dispatchError TEXT, retryAt TEXT,
      failureEpisode INTEGER NOT NULL DEFAULT 0, dispatchFailures INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX triggers_agent ON agent_triggers(agentId,deleted,id);
    CREATE INDEX triggers_workspace ON agent_triggers(workspaceId,deleted,id);
    CREATE TABLE trigger_revisions (
      sequence INTEGER PRIMARY KEY, triggerId TEXT NOT NULL REFERENCES agent_triggers(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, input TEXT NOT NULL, untilSequence INTEGER,
      startedAt TEXT NOT NULL, endedAt TEXT, nextAt TEXT, UNIQUE(triggerId,revision)
    );
    CREATE INDEX trigger_revisions_due ON trigger_revisions(nextAt,sequence);
    CREATE INDEX trigger_revisions_match ON trigger_revisions(sequence,untilSequence);
    CREATE TABLE trigger_event_sources (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, tokenHash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX event_sources_workspace ON trigger_event_sources(workspaceId,id);
    CREATE TABLE trigger_events (
      sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      sourceId TEXT, sourceKey TEXT NOT NULL, eventId TEXT NOT NULL, eventType TEXT NOT NULL,
      occurredAt TEXT NOT NULL, receivedAt TEXT NOT NULL, data TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]', fingerprint TEXT NOT NULL, uploadFingerprint TEXT,
      lineage TEXT NOT NULL DEFAULT '[]', cursor INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0,
      UNIQUE(workspaceId,sourceKey,eventId)
    );
    CREATE INDEX trigger_events_pending ON trigger_events(processed,sequence);
    CREATE INDEX trigger_events_source ON trigger_events(workspaceId,sourceId,sequence);
    CREATE TABLE trigger_occurrences (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      triggerId TEXT NOT NULL REFERENCES agent_triggers(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, occurrenceKey TEXT NOT NULL, kind TEXT NOT NULL,
      scheduledAt TEXT NOT NULL, createdAt TEXT NOT NULL, dispatchedAt TEXT,
      state TEXT NOT NULL DEFAULT 'queued', taskId TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      turnId TEXT, eventId TEXT, error TEXT, envelope TEXT,
      UNIQUE(triggerId,occurrenceKey)
    );
    CREATE INDEX trigger_occurrences_queue ON trigger_occurrences(triggerId,state,scheduledAt,sequence);
    CREATE INDEX trigger_occurrences_task ON trigger_occurrences(taskId);
    CREATE TABLE trigger_dependencies (
      triggerId TEXT NOT NULL REFERENCES agent_triggers(id) ON DELETE CASCADE,
      skillId TEXT NOT NULL, fingerprint TEXT NOT NULL, snapshot TEXT NOT NULL,
      PRIMARY KEY(triggerId,skillId)
    );
    CREATE TABLE trigger_cancellations (
      triggerId TEXT PRIMARY KEY REFERENCES agent_triggers(id) ON DELETE CASCADE, throughSequence INTEGER NOT NULL
    );
    CREATE TABLE skill_automation_setups (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skillId TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', taskId TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      snapshot TEXT NOT NULL, previousSnapshot TEXT, templates TEXT NOT NULL DEFAULT '[]',
      error TEXT, createdAt TEXT NOT NULL, UNIQUE(agentId,skillId,fingerprint,kind)
    );
    ALTER TABLE skill_automation_setups ADD COLUMN consentAfterRow INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX skill_automation_pending ON skill_automation_setups(state,createdAt,id);
    CREATE TABLE trigger_ingests (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE trigger_notices (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);
  // Persist lifecycle events in the same transaction as the state transition.
  db.exec(`
    CREATE TRIGGER trigger_occurrence_task_state AFTER UPDATE OF status ON agent_tasks
    WHEN NEW.status!=OLD.status BEGIN
      UPDATE trigger_occurrences SET state=CASE WHEN NEW.status IN ('completed','failed','cancelled') THEN NEW.status ELSE 'submitted' END,
        error=NEW.error WHERE taskId=NEW.id;
    END;
    ${taskLifecycle}
    CREATE TRIGGER trigger_artifact_event AFTER UPDATE OF state ON artifact_versions
    WHEN NEW.state='ready' AND OLD.state!='ready' AND NEW.origin='published' AND NEW.ingestId IS NULL
    BEGIN
      UPDATE trigger_clock SET value=value+1 WHERE id=1;
      INSERT OR IGNORE INTO trigger_events(sequence,id,workspaceId,sourceKey,eventId,eventType,occurredAt,receivedAt,data,attachments,fingerprint,lineage)
      VALUES((SELECT value FROM trigger_clock),'artifact:'||NEW.id,NEW.workspaceId,'builtin','artifact:'||NEW.id,
        'ufai.artifact.published',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        json_object('versionId',NEW.id,'taskId',NEW.producerTaskId,'agentId',NEW.producerAgentId,'name',NEW.name,'mediaType',NEW.mediaType),
        json_array(json_object('versionId',NEW.id,'mode','file')),NEW.id,
        coalesce((SELECT json_extract(envelope,'$.trigger.lineage') FROM agent_turns WHERE taskId=NEW.producerTaskId ORDER BY rowid DESC LIMIT 1),'[]'));
    END;
  `);
}

export function migrateTriggerReviews(db: Database.Database) {
  // Early development builds also used version 30. Normalize their additive
  // fields before rebuilding reviews so existing local installations can boot.
  const addColumn = (table: string, name: string, declaration: string) => {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[];
    if (columns.some((column) => column.name === name)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
    return true;
  };
  addColumn("agent_triggers", "dispatchFailures", "INTEGER NOT NULL DEFAULT 0");
  addColumn("trigger_events", "uploadFingerprint", "TEXT");
  if (
    addColumn(
      "skill_automation_setups",
      "consentAfterRow",
      "INTEGER NOT NULL DEFAULT 0",
    )
  )
    db.exec(
      "UPDATE skill_automation_setups SET consentAfterRow=(SELECT coalesce(max(rowid),0) FROM agent_messages) WHERE kind='setup' AND state!='approved'",
    );
  db.exec(`CREATE INDEX IF NOT EXISTS trigger_turn_start ON agent_turns(taskId) WHERE snapshot IS NOT NULL;
    CREATE TABLE IF NOT EXISTS trigger_cancellations (
      triggerId TEXT PRIMARY KEY REFERENCES agent_triggers(id) ON DELETE CASCADE,
      throughSequence INTEGER NOT NULL
    );
    DROP TRIGGER trigger_task_event;
    ${taskLifecycle}`);

  db.exec(`
    ALTER TABLE agent_triggers ADD COLUMN dependencyError TEXT;
    UPDATE agent_turns SET envelope=json_set(envelope,'$.trigger',json((SELECT json_extract(o.envelope,'$.trigger')
      FROM trigger_occurrences o WHERE o.taskId=agent_turns.taskId LIMIT 1)))
      WHERE json_type(envelope,'$.trigger') IS NULL AND EXISTS(SELECT 1 FROM trigger_occurrences o
        WHERE o.taskId=agent_turns.taskId AND json_type(o.envelope,'$.trigger')='object');
    ALTER TABLE trigger_revisions ADD COLUMN collectedThrough TEXT;
    UPDATE trigger_revisions SET collectedThrough=(SELECT max(scheduledAt) FROM trigger_occurrences o
      WHERE o.triggerId=trigger_revisions.triggerId AND o.revision=trigger_revisions.revision AND o.kind='schedule');
    CREATE INDEX trigger_revisions_highwater ON trigger_revisions(triggerId,collectedThrough DESC);
    CREATE TABLE skill_automation_setups_new (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skillId TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', taskId TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      snapshot TEXT NOT NULL, previousSnapshot TEXT, templates TEXT NOT NULL DEFAULT '[]',
      error TEXT, createdAt TEXT NOT NULL, consentAfterRow INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO skill_automation_setups_new SELECT * FROM skill_automation_setups;
    DROP TABLE skill_automation_setups;
    ALTER TABLE skill_automation_setups_new RENAME TO skill_automation_setups;
    CREATE UNIQUE INDEX skill_automation_install ON skill_automation_setups(agentId,skillId,fingerprint,kind) WHERE kind='setup';
    CREATE INDEX skill_automation_reviews ON skill_automation_setups(agentId,skillId,fingerprint,kind,state);
    CREATE INDEX skill_automation_pending ON skill_automation_setups(state,createdAt,id);
    DROP TRIGGER trigger_artifact_event;
    CREATE TRIGGER trigger_artifact_event AFTER UPDATE OF state ON artifact_versions
    WHEN NEW.state='ready' AND OLD.state!='ready' AND NEW.origin='published' AND NEW.ingestId IS NULL
    BEGIN
      UPDATE trigger_clock SET value=value+1 WHERE id=1;
      INSERT OR IGNORE INTO trigger_events(sequence,id,workspaceId,sourceKey,eventId,eventType,occurredAt,receivedAt,data,attachments,fingerprint,lineage)
      VALUES((SELECT value FROM trigger_clock),'artifact:'||NEW.id,NEW.workspaceId,'builtin','artifact:'||NEW.id,
        'ufai.artifact.published',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        json_object('versionId',NEW.id,'taskId',NEW.producerTaskId,'agentId',NEW.producerAgentId,'name',NEW.name,'mediaType',NEW.mediaType),
        json_array(json_object('versionId',NEW.id,'mode','file')),NEW.id,
        coalesce((SELECT json_extract(envelope,'$.trigger.lineage') FROM agent_turns
          WHERE id=json_extract(NEW.provenance,'$.turnId') AND taskId=NEW.producerTaskId),'[]'));
    END;
  `);
}
