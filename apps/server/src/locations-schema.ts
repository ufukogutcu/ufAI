import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export function migrateLocations(db: Database.Database) {
  db.exec(`
    CREATE TABLE managed_storage (id INTEGER PRIMARY KEY CHECK(id=1), installationId TEXT NOT NULL);
    CREATE TABLE clusters (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0,
      width REAL NOT NULL DEFAULT 600 CHECK(width>=320), height REAL NOT NULL DEFAULT 360 CHECK(height>=200),
      colorSlot INTEGER NOT NULL CHECK(colorSlot BETWEEN 0 AND 15), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX clusters_workspace ON clusters(workspaceId,createdAt,id);
    ALTER TABLE agents ADD COLUMN clusterId TEXT REFERENCES clusters(id) ON DELETE SET NULL;
    CREATE INDEX agents_cluster ON agents(clusterId);
    CREATE TRIGGER agents_cluster_insert BEFORE INSERT ON agents WHEN NEW.clusterId IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM clusters WHERE id=NEW.clusterId AND workspaceId=NEW.workspaceId)
        THEN RAISE(ABORT,'Cluster must belong to the agent workspace') END;
    END;
    CREATE TRIGGER agents_cluster_update BEFORE UPDATE OF clusterId,workspaceId ON agents WHEN NEW.clusterId IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM clusters WHERE id=NEW.clusterId AND workspaceId=NEW.workspaceId)
        THEN RAISE(ABORT,'Cluster must belong to the agent workspace') END;
    END;
    CREATE TRIGGER clusters_workspace_immutable BEFORE UPDATE OF workspaceId ON clusters BEGIN
      SELECT RAISE(ABORT,'Cluster workspace cannot change');
    END;
    CREATE TABLE managed_locations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('workspace','cluster','agent','task')),
      ownerId TEXT NOT NULL, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      relativePath TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','error')),
      error TEXT, UNIQUE(kind,ownerId)
    );
    CREATE INDEX managed_locations_pending ON managed_locations(state,id);
    CREATE TABLE deletion_operations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('workspace','cluster','agent')),
      ownerId TEXT NOT NULL, workspaceId TEXT NOT NULL, relativePath TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX deletion_owner ON deletion_operations(kind,ownerId);
    CREATE INDEX deletion_workspace ON deletion_operations(workspaceId,state);
  `);
  db.prepare("INSERT INTO managed_storage VALUES (1,?)").run(randomUUID());
  // Use the same insert triggers for existing installations and new records.
  for (const [table, kind, workspace, path] of [
    ["workspaces", "workspace", "NEW.id", "'workspaces/'||NEW.id||'/shared'"],
    [
      "clusters",
      "cluster",
      "NEW.workspaceId",
      "'workspaces/'||NEW.workspaceId||'/clusters/'||NEW.id||'/shared'",
    ],
    [
      "agents",
      "agent",
      "NEW.workspaceId",
      "'workspaces/'||NEW.workspaceId||'/agents/'||NEW.id||'/files'",
    ],
    [
      "agent_tasks",
      "task",
      "(SELECT workspaceId FROM agents WHERE id=NEW.agentId)",
      "'workspaces/'||(SELECT workspaceId FROM agents WHERE id=NEW.agentId)||'/agents/'||NEW.agentId||'/tasks/'||NEW.id",
    ],
  ]) {
    db.exec(`CREATE TRIGGER ${table}_location_insert AFTER INSERT ON ${table} BEGIN
      INSERT INTO managed_locations(id,kind,ownerId,workspaceId,relativePath)
      VALUES ('${kind}:'||NEW.id,'${kind}',NEW.id,${workspace},${path}); END;
      CREATE TRIGGER ${table}_location_delete AFTER DELETE ON ${table} BEGIN
      DELETE FROM managed_locations WHERE kind='${kind}' AND ownerId=OLD.id; END;`);
    db.exec(`INSERT INTO managed_locations(id,kind,ownerId,workspaceId,relativePath)
      SELECT '${kind}:'||id,'${kind}',id,${workspace!.replaceAll("NEW.", "")},${path!.replaceAll("NEW.", "")}
      FROM ${table}`);
  }
}
