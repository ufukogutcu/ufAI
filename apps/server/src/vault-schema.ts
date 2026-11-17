import type Database from "better-sqlite3";

export function migrateVault(db: Database.Database) {
  db.exec(`
    CREATE TABLE vault_secrets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      ciphertext TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX vault_secret_order ON vault_secrets(createdAt,id);
    CREATE TABLE user_input_requests (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind='secret'),
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      callId TEXT NOT NULL, name TEXT NOT NULL, purpose TEXT NOT NULL,
      secretId TEXT REFERENCES vault_secrets(id) ON DELETE SET NULL,
      expectedRevision INTEGER, state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','fulfilled','declined','cancelled')),
      returnEnvelope TEXT NOT NULL,
      deliveredTurnId TEXT REFERENCES agent_turns(id) ON DELETE SET NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      UNIQUE(turnId,callId)
    );
    CREATE INDEX user_input_task ON user_input_requests(taskId,state,createdAt,id);
    CREATE INDEX user_input_delivery ON user_input_requests(state,deliveredTurnId,taskId);
    ALTER TABLE workspace_inbox ADD COLUMN userInputRequestId TEXT REFERENCES user_input_requests(id) ON DELETE SET NULL;
  `);
}
