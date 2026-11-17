import type Database from "better-sqlite3";

/** Rebuild without changing the Inbox's foreign key or invoking ON DELETE actions. */
export function migrateUserInputs(db: Database.Database) {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE user_input_requests_new (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('secret','text','single_choice','multi_select','form')),
        workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
        callId TEXT NOT NULL, name TEXT NOT NULL, purpose TEXT NOT NULL,
        secretId TEXT REFERENCES vault_secrets(id) ON DELETE SET NULL,
        expectedRevision INTEGER, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','fulfilled','declined','cancelled')),
        returnEnvelope TEXT NOT NULL, deliveredTurnId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        definition TEXT NOT NULL DEFAULT '{}', answer TEXT, UNIQUE(turnId,callId));
        INSERT INTO user_input_requests_new(id,kind,workspaceId,agentId,taskId,turnId,callId,name,purpose,secretId,expectedRevision,state,returnEnvelope,deliveredTurnId,createdAt,updatedAt)
          SELECT id,kind,workspaceId,agentId,taskId,turnId,callId,name,purpose,secretId,expectedRevision,state,returnEnvelope,deliveredTurnId,createdAt,updatedAt FROM user_input_requests;
        DROP TABLE user_input_requests;
        ALTER TABLE user_input_requests_new RENAME TO user_input_requests;
        CREATE INDEX user_input_task ON user_input_requests(taskId,state,createdAt,id);
        CREATE INDEX user_input_delivery ON user_input_requests(state,deliveredTurnId,taskId);
        CREATE INDEX user_input_agent_pending ON user_input_requests(agentId,createdAt,id) WHERE state='pending';`);
      if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("User input migration found invalid references.");
      db.pragma("user_version = 34");
    })();
  } finally { db.pragma("foreign_keys = ON"); }
}
