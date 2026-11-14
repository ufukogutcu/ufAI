import type Database from "better-sqlite3";

/** Runs inside the versioned startup migration transaction. */
export function migrateMutualLinks(db: Database.Database) {
  db.exec(`
    CREATE TEMP TABLE mutual_link_map AS
      SELECT id, first_value(id) OVER (
        PARTITION BY min(sourceAgentId,targetAgentId), max(sourceAgentId,targetAgentId)
        ORDER BY createdAt,id
      ) survivor FROM communication_links;
    CREATE UNIQUE INDEX mutual_link_map_id ON mutual_link_map(id);
    UPDATE communication_links SET state='revoking' WHERE id IN (
      SELECT m.survivor FROM mutual_link_map m JOIN communication_links l ON l.id=m.id
      WHERE l.state='revoking' OR EXISTS (
        SELECT 1 FROM messaging_operations o WHERE o.linkId=l.id AND o.state!='completed'
      )
    );
    UPDATE agent_requests SET linkId=(SELECT survivor FROM mutual_link_map WHERE id=linkId)
      WHERE linkId IN (SELECT id FROM mutual_link_map WHERE id!=survivor);
    UPDATE messaging_operations SET linkId=(SELECT survivor FROM mutual_link_map WHERE id=linkId)
      WHERE linkId IN (SELECT id FROM mutual_link_map WHERE id!=survivor);
    DELETE FROM communication_links WHERE id IN (SELECT id FROM mutual_link_map WHERE id!=survivor);
    DROP TABLE mutual_link_map;
    CREATE UNIQUE INDEX IF NOT EXISTS communication_pair ON communication_links(
      min(sourceAgentId,targetAgentId), max(sourceAgentId,targetAgentId)
    );
    CREATE INDEX IF NOT EXISTS communication_target ON communication_links(targetAgentId,state);
  `);

  // A previously accepted removal now fences the whole pair. Preserve every
  // operation ID/retry key, and give each unfinished operation the complete work
  // set so a failed sibling cannot leave the newly merged direction running.
  const links = db.prepare(
    "SELECT DISTINCT linkId FROM messaging_operations WHERE state!='completed'",
  ).all() as { linkId: string }[];
  const affected = db.prepare(`
    WITH RECURSIVE affected(id) AS (
      SELECT id FROM agent_requests WHERE linkId=?
      UNION SELECT r.id FROM agent_requests r JOIN affected a ON r.parentRequestId=a.id
    ) SELECT r.id,r.targetTaskId FROM agent_requests r JOIN affected a ON a.id=r.id
      WHERE r.state IN ('open','revoking') OR EXISTS (
        SELECT 1 FROM owned_processes p WHERE p.taskId=r.targetTaskId AND p.state IN ('starting','running')
      )
  `);
  const operations = db.prepare(
    "SELECT id,requestIds,taskIds FROM messaging_operations WHERE linkId=? AND state!='completed'",
  );
  const update = db.prepare(
    "UPDATE messaging_operations SET requestIds=?,taskIds=? WHERE id=?",
  );
  const fence = db.prepare(
    "UPDATE agent_requests SET state='revoking' WHERE id=? AND state='open'",
  );
  const cancelCheckIns = db.prepare(
    "UPDATE task_checkins SET state='cancelled',updatedAt=? WHERE requestId=? AND (state='scheduled' OR (state='fired' AND deliveredTurnId IS NULL))",
  );
  const stamp = new Date().toISOString();
  for (const { linkId } of links) {
    const pending = operations.all(linkId) as { id: string; requestIds: string; taskIds: string }[];
    const requestIds = new Set<string>(pending.flatMap(o => JSON.parse(o.requestIds)));
    const taskIds = new Set<string>(pending.flatMap(o => JSON.parse(o.taskIds)));
    for (const row of affected.all(linkId) as { id: string; targetTaskId: string | null }[]) {
      requestIds.add(row.id);
      if (row.targetTaskId) taskIds.add(row.targetTaskId);
    }
    for (const id of requestIds) {
      fence.run(id);
      cancelCheckIns.run(stamp, id);
    }
    const requests = JSON.stringify([...requestIds].sort());
    const tasks = JSON.stringify([...taskIds].sort());
    for (const op of pending) update.run(requests, tasks, op.id);
  }
}
