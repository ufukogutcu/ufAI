import type Database from "better-sqlite3";

/** Forward-only retirement: filesystem work runs after storage ownership verification. */
export function retireClusters(db: Database.Database) {
  db.exec(`CREATE TABLE managed_path_cleanup (relativePath TEXT PRIMARY KEY);`);
  db.exec(`
    INSERT OR IGNORE INTO managed_path_cleanup
      SELECT CASE WHEN relativePath LIKE '%/shared' THEN substr(relativePath,1,length(relativePath)-7) ELSE relativePath END
      FROM managed_locations WHERE kind='cluster';
    INSERT OR IGNORE INTO managed_path_cleanup
      SELECT 'workspaces/'||workspaceId||'/clusters/'||id FROM clusters;
    INSERT OR IGNORE INTO managed_path_cleanup
      SELECT relativePath FROM deletion_operations WHERE kind='cluster' AND state!='completed';
  `);

  // Owner triggers reference managed_locations, so recreate them around its rebuild.
  const triggers = db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
    AND name IN ('workspaces_location_insert','workspaces_location_delete',
      'agents_location_insert','agents_location_delete','agent_tasks_location_insert','agent_tasks_location_delete')`)
    .all() as { name: string; sql: string }[];
  for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
  db.exec(`
    DROP TRIGGER agents_cluster_insert;
    DROP TRIGGER agents_cluster_update;
    DROP INDEX agents_cluster;
    ALTER TABLE agents DROP COLUMN clusterId;
    DROP TABLE clusters;

    CREATE TABLE managed_locations_next (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('workspace','agent','task')),
      ownerId TEXT NOT NULL, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      relativePath TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','error')),
      error TEXT, UNIQUE(kind,ownerId)
    );
    INSERT INTO managed_locations_next SELECT * FROM managed_locations WHERE kind!='cluster';
    DROP TABLE managed_locations;
    ALTER TABLE managed_locations_next RENAME TO managed_locations;
    CREATE INDEX managed_locations_pending ON managed_locations(state,id);

    CREATE TABLE deletion_operations_next (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('workspace','agent')),
      ownerId TEXT NOT NULL, workspaceId TEXT NOT NULL, relativePath TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    INSERT INTO deletion_operations_next SELECT * FROM deletion_operations WHERE kind!='cluster';
    DROP TABLE deletion_operations;
    ALTER TABLE deletion_operations_next RENAME TO deletion_operations;
    CREATE UNIQUE INDEX deletion_owner ON deletion_operations(kind,ownerId);
    CREATE INDEX deletion_workspace ON deletion_operations(workspaceId,state);
  `);
  for (const { sql } of triggers) db.exec(sql);

  const themes = db.prepare("SELECT id,colors FROM themes").all() as { id: string; colors: string }[];
  const update = db.prepare("UPDATE themes SET colors=? WHERE id=?");
  for (const theme of themes) {
    const colors = JSON.parse(theme.colors) as Record<string, string>;
    let changed = false;
    for (const key of Object.keys(colors)) {
      if (/^cluster-(color-(?:[1-9]|1[0-6])|surface|border|drop-surface)$/.test(key)) {
        delete colors[key];
        changed = true;
      }
    }
    if (changed) update.run(JSON.stringify(colors), theme.id);
  }
}
