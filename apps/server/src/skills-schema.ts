import type Database from "better-sqlite3";
export function migrateSkills(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL,
      instructions TEXT NOT NULL, builtIn INTEGER NOT NULL DEFAULT 0 CHECK(builtIn IN(0,1)),
      revision INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL,
      folder TEXT NOT NULL, fingerprint TEXT NOT NULL, error TEXT,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_skills (
      agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skillId TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
      PRIMARY KEY(agentId,skillId)
    );
    CREATE TABLE IF NOT EXISTS skill_installations (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      source TEXT NOT NULL, candidates TEXT NOT NULL, expiresAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skill_installations_expiry ON skill_installations(expiresAt);
    CREATE TABLE IF NOT EXISTS task_skill_activations (
      taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      skillId TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL,
      instructions TEXT NOT NULL, folder TEXT NOT NULL,
      PRIMARY KEY(taskId,skillId)
    );
  `);
}
