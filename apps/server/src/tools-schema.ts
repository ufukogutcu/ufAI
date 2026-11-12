import type Database from "better-sqlite3";

export function migrateTools(db: Database.Database) {
  db.exec(`
    CREATE TABLE execution_items (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE INDEX execution_items_task ON execution_items(taskId, sequence);
    CREATE TABLE tool_invocations (
      id TEXT PRIMARY KEY, turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      callId TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL,
      state TEXT NOT NULL, result TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      UNIQUE(turnId, callId)
    );
    CREATE TABLE owned_processes (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      command TEXT NOT NULL, cwd TEXT NOT NULL, pty INTEGER NOT NULL, launchId TEXT NOT NULL,
      state TEXT NOT NULL, exitCode INTEGER, signal TEXT, error TEXT,
      outputStart INTEGER NOT NULL DEFAULT 0, outputEnd INTEGER NOT NULL DEFAULT 0,
      deadline TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX owned_processes_task ON owned_processes(taskId,createdAt,id);
    CREATE INDEX owned_processes_state ON owned_processes(state,agentId);
    CREATE TABLE process_waits (
      turnId TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE,
      processId TEXT NOT NULL REFERENCES owned_processes(id) ON DELETE CASCADE,
      state TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE INDEX artifacts_workspace ON artifacts(workspaceId,createdAt,id);
    CREATE TABLE artifact_versions (
      id TEXT PRIMARY KEY, artifactId TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      producerAgentId TEXT REFERENCES agents(id) ON DELETE SET NULL,
      producerTaskId TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      provenance TEXT NOT NULL, sourceVersionId TEXT REFERENCES artifact_versions(id) ON DELETE SET NULL,
      name TEXT NOT NULL, mediaType TEXT NOT NULL, size INTEGER NOT NULL,
      sha256 TEXT, state TEXT NOT NULL, error TEXT, createdAt TEXT NOT NULL
    );
    CREATE INDEX artifact_versions_workspace ON artifact_versions(workspaceId,createdAt,id);
    CREATE INDEX artifact_versions_task ON artifact_versions(producerTaskId,createdAt,id);
    CREATE TABLE artifact_references (
      versionId TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
      messageId TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, PRIMARY KEY(messageId,ordinal)
    );
  `);
}
