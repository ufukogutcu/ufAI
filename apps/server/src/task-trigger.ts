import type Database from "better-sqlite3";
import type { AgentTask } from "./contracts.js";

export function withTaskTrigger(
  db: Database.Database,
  task: AgentTask,
): AgentTask {
  const o = db
    .prepare(
      `SELECT o.triggerId id,o.id occurrenceId,json_extract(r.input,'$.name') name,
    o.scheduledAt,o.dispatchedAt FROM trigger_occurrences o JOIN trigger_revisions r
    ON r.triggerId=o.triggerId AND r.revision=o.revision WHERE o.taskId=? LIMIT 1`,
    )
    .get(task.id);
  return o
    ? { ...task, trigger: o as NonNullable<AgentTask["trigger"]> }
    : task;
}
