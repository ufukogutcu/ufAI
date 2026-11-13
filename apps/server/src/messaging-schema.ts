import type Database from "better-sqlite3";

export function migrateMessaging(db: Database.Database) {
  db.exec(`
    ALTER TABLE agent_messages ADD COLUMN authorType TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE agent_messages ADD COLUMN authorId TEXT;
    UPDATE agent_messages SET authorType='agent',authorId=(SELECT agentId FROM conversations WHERE conversations.id=agent_messages.conversationId) WHERE role='assistant';
    ALTER TABLE agent_turns ADD COLUMN envelope TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE agent_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE agent_tasks ADD COLUMN rootWorkflowId TEXT;
    ALTER TABLE agent_tasks ADD COLUMN parentRequestId TEXT;
    UPDATE agent_tasks SET rootWorkflowId=id;
    CREATE TABLE communication_links (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      sourceAgentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      targetAgentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'active',createdAt TEXT NOT NULL,
      UNIQUE(sourceAgentId,targetAgentId), CHECK(sourceAgentId!=targetAgentId)
    );
    CREATE TRIGGER communication_workspace BEFORE INSERT ON communication_links BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agents a JOIN agents b ON b.id=NEW.targetAgentId WHERE a.id=NEW.sourceAgentId AND a.workspaceId=NEW.workspaceId AND b.workspaceId=NEW.workspaceId) THEN RAISE(ABORT,'Cross-workspace communication') END;
    END;
    CREATE TABLE agent_requests (
      id TEXT PRIMARY KEY,workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      linkId TEXT NOT NULL,sourceAgentId TEXT,targetAgentId TEXT,sourceName TEXT NOT NULL,targetName TEXT NOT NULL,
      sourceTaskId TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      targetTaskId TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      rootWorkflowId TEXT NOT NULL,parentRequestId TEXT,depth INTEGER NOT NULL,
      kind TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',error TEXT,deadline TEXT NOT NULL,
      createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
    );
    CREATE INDEX requests_link ON agent_requests(linkId,rootWorkflowId);
    CREATE INDEX requests_root ON agent_requests(rootWorkflowId,state);
    CREATE INDEX requests_source ON agent_requests(sourceTaskId,state);
    CREATE INDEX requests_target ON agent_requests(targetTaskId,state);
    CREATE INDEX requests_deadline ON agent_requests(state,deadline);
    CREATE TABLE communication_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      requestId TEXT NOT NULL REFERENCES agent_requests(id) ON DELETE CASCADE,
      senderAgentId TEXT NOT NULL,senderName TEXT NOT NULL,
      senderTaskId TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      recipientTaskId TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,content TEXT NOT NULL,attachments TEXT NOT NULL,replyToId TEXT,
      answered INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL
    );
    CREATE INDEX communication_request ON communication_messages(requestId,sequence);
    CREATE INDEX communication_recipient ON communication_messages(recipientTaskId,sequence);
    CREATE TABLE communication_deliveries (
      messageId TEXT PRIMARY KEY REFERENCES communication_messages(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending',inputMessageId TEXT,turnId TEXT,createdAt TEXT NOT NULL
    );
    CREATE TABLE artifact_grants (
      taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      versionId TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
      requestId TEXT,PRIMARY KEY(taskId,versionId)
    );
    CREATE TABLE messaging_waits (
      turnId TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE,
      taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      requestIds TEXT NOT NULL,mode TEXT NOT NULL,deadline TEXT NOT NULL,state TEXT NOT NULL,
      checkpoint TEXT NOT NULL DEFAULT '{}',createdAt TEXT NOT NULL
    );
    CREATE TABLE task_output_selections (
      turnId TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE,versions TEXT NOT NULL
    );
    CREATE TABLE workspace_inbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agentId TEXT,agentName TEXT NOT NULL,taskId TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      content TEXT NOT NULL,attachments TEXT NOT NULL,readAt TEXT,createdAt TEXT NOT NULL
    );
    CREATE INDEX inbox_workspace ON workspace_inbox(workspaceId,sequence);
    CREATE TABLE messaging_operations (
      id TEXT PRIMARY KEY,workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      linkId TEXT NOT NULL,requestIds TEXT NOT NULL,taskIds TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
      error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
    );
    CREATE TABLE messaging_idempotency (
      id TEXT PRIMARY KEY,workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,result TEXT NOT NULL
    );
    CREATE TABLE agent_schedule_state (
      agentId TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,userStreak INTEGER NOT NULL DEFAULT 0
    );
  `);
}
