import type Database from "better-sqlite3";

export function migrateExecution(db: Database.Database) {
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
      presetId TEXT REFERENCES model_presets(id) ON DELETE SET NULL,
      x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX agents_workspace ON agents(workspaceId, createdAt, id);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('task','status')), participants TEXT NOT NULL DEFAULT '["user"]',
      createdAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX conversations_status ON conversations(agentId) WHERE kind = 'status';
    CREATE TABLE agent_tasks (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      conversationId TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', error TEXT,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX agent_tasks_agent ON agent_tasks(agentId, updatedAt, id);
    CREATE TABLE agent_turns (
      id TEXT PRIMARY KEY, taskId TEXT REFERENCES agent_tasks(id) ON DELETE CASCADE,
      conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      inputMessageId TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'queued', snapshot TEXT, error TEXT, usage TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX agent_turns_ready ON agent_turns(status, createdAt, id);
    CREATE INDEX agent_turns_agent ON agent_turns(agentId, status);
    CREATE TABLE agent_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      turnId TEXT REFERENCES agent_turns(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
      state TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE INDEX agent_messages_conversation ON agent_messages(conversationId, sequence);
    CREATE TABLE agent_submissions (
      requestId TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      target TEXT NOT NULL, content TEXT NOT NULL, taskId TEXT, turnId TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT 'user', replyDestination TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE agent_context_summaries (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, throughSequence INTEGER NOT NULL, content TEXT NOT NULL,
      createdAt TEXT NOT NULL, UNIQUE(taskId, version)
    );
    CREATE TABLE agent_memories (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      key TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
      sources TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(agentId, key)
    );
    CREATE TABLE execution_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agentId TEXT, kind TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE INDEX execution_events_workspace ON execution_events(workspaceId, sequence);
    CREATE VIRTUAL TABLE agent_history USING fts5(agentId UNINDEXED, taskId UNINDEXED, text, messageId UNINDEXED);
    CREATE TRIGGER agent_tasks_delete AFTER DELETE ON agent_tasks BEGIN
      DELETE FROM agent_history WHERE taskId = old.id;
    END;
  `);
}
