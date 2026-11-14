import type Database from "better-sqlite3";

export function migrateCheckIns(db: Database.Database) {
  db.exec(`
    ALTER TABLE agent_tasks ADD COLUMN pendingReason TEXT;
    ALTER TABLE agent_tasks ADD COLUMN resumeEnvelope TEXT;
    CREATE TABLE task_checkins (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      requestId TEXT REFERENCES agent_requests(id) ON DELETE CASCADE,
      reason TEXT NOT NULL, dueAt TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('scheduled','fired','cancelled')),
      deliveredTurnId TEXT REFERENCES agent_turns(id) ON DELETE SET NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX checkins_due ON task_checkins(state,dueAt,id);
    CREATE INDEX checkins_task ON task_checkins(taskId,state,dueAt,id);
    CREATE INDEX checkins_request ON task_checkins(requestId,state);
  `);
}

export function migrateCheckInRoutes(db: Database.Database) {
  // Preserve route snapshots from early check-in schemas that already contain them.
  for (const table of ["agent_requests", "task_checkins"]) {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[];
    if (!columns.some((column) => column.name === "returnEnvelope"))
      db.exec(
        `ALTER TABLE ${table} ADD COLUMN returnEnvelope TEXT${table === "task_checkins" ? " NOT NULL DEFAULT '{}'" : ""}`,
      );
  }
}
