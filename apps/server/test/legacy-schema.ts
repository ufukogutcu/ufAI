import type Database from "better-sqlite3";

// Reconstruct columns removed in v9 when an upgrade fixture starts from today's schema.
export function restoreOutputColumns(database: Database.Database) {
  removeExecutionTables(database);
  database.exec(`
    ALTER TABLE model_presets ADD COLUMN maxOutputTokens INTEGER;
    ALTER TABLE provider_models ADD COLUMN discoveredMaxOutputTokens INTEGER;
    ALTER TABLE provider_models ADD COLUMN maxOutputTokensOverride INTEGER;
  `);
}

export function removeToolTables(database: Database.Database) {
  if (
    (
      database.pragma("table_info(agent_submissions)") as { name: string }[]
    ).some((c) => c.name === "attachmentFingerprint")
  )
    database.exec(
      "ALTER TABLE agent_submissions DROP COLUMN attachmentFingerprint",
    );
  database.exec(
    `DROP TABLE IF EXISTS provider_media_files; DROP TABLE IF EXISTS model_media_capabilities; DROP TABLE IF EXISTS media_open_references; DROP TABLE IF EXISTS submission_ingests; DROP TABLE IF EXISTS artifact_references; DROP TABLE IF EXISTS artifact_versions; DROP TABLE IF EXISTS artifacts; DROP TABLE IF EXISTS process_waits; DROP TABLE IF EXISTS owned_processes; DROP TABLE IF EXISTS tool_invocations; DROP TABLE IF EXISTS execution_items;`,
  );
}
export function removeLocationTables(database: Database.Database) {
  removeToolTables(database);
  for (const table of ["workspaces", "clusters", "agents", "agent_tasks"])
    database.exec(
      `DROP TRIGGER IF EXISTS ${table}_location_insert; DROP TRIGGER IF EXISTS ${table}_location_delete;`,
    );
  database.exec(`DROP TRIGGER agents_cluster_insert; DROP TRIGGER agents_cluster_update;
    DROP INDEX agents_cluster; ALTER TABLE agents DROP COLUMN clusterId;
    DROP TABLE clusters; DROP TABLE managed_locations; DROP TABLE managed_storage; DROP TABLE deletion_operations;`);
}
export function removeExecutionTables(database: Database.Database) {
  removeLocationTables(database);
  database.exec(`
    DROP TABLE agent_history;
    DROP TABLE agent_submissions;
    DROP TABLE agent_context_summaries;
    DROP TABLE agent_memories;
    DROP TABLE agent_messages;
    DROP TABLE agent_turns;
    DROP TABLE agent_tasks;
    DROP TABLE conversations;
    DROP TABLE execution_events;
    DROP TABLE agents;
  `);
}
