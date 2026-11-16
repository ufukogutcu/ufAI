import type Database from "better-sqlite3";
export function migrateMcp(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL CHECK(transport IN ('stdio','http')),
      config TEXT NOT NULL, secrets TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_mcp_servers (
      agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      serverId TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), PRIMARY KEY(agentId,serverId)
    );
    CREATE INDEX IF NOT EXISTS agent_mcp_servers_server ON agent_mcp_servers(serverId,enabled);
  `);
}
