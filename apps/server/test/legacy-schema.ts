import assert from "node:assert/strict";
import { validateAppearance } from "../src/agent-appearance.js";
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

export function removeCharacters(database: Database.Database) {
  if ((database.pragma("table_info(agents)") as { name: string }[]).some(column => column.name === "appearance"))
    database.exec("ALTER TABLE agents DROP COLUMN appearance");
  if ((database.pragma("table_info(app_settings)") as { name: string }[]).some(column => column.name === "characterAnimationsPaused"))
    database.exec("ALTER TABLE app_settings DROP COLUMN characterAnimationsPaused");
}

export function removePresetDefault(database: Database.Database) {
  removeCharacters(database);
  if ((database.pragma("table_info(model_presets)") as { name: string }[]).some((column) => column.name === "isDefault")) {
    database.exec("DROP INDEX model_presets_default; ALTER TABLE model_presets DROP COLUMN isDefault");
  }
}

export function removeMessagingTables(database: Database.Database) {
  removePresetDefault(database);
  database.exec(`DROP TRIGGER IF EXISTS communication_workspace;
    DROP TABLE IF EXISTS agent_schedule_state; DROP TABLE IF EXISTS messaging_idempotency;
    DROP TABLE IF EXISTS messaging_operations; DROP TABLE IF EXISTS workspace_inbox;
    DROP TABLE IF EXISTS task_output_selections; DROP TABLE IF EXISTS messaging_waits;
    DROP TABLE IF EXISTS artifact_grants; DROP TABLE IF EXISTS communication_deliveries;
    DROP TABLE IF EXISTS communication_messages; DROP TABLE IF EXISTS agent_requests; DROP TABLE IF EXISTS communication_links;`);
  for (const [table,columns] of [["agent_messages",["authorType","authorId"]],["agent_turns",["envelope"]],["agent_tasks",["source","rootWorkflowId","parentRequestId"]]] as const) {
    const existing=(database.pragma(`table_info(${table})`) as {name:string}[]).map(c=>c.name);
    for(const column of columns) if(existing.includes(column)) database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}
export function removeToolTables(database: Database.Database) {
  removeMessagingTables(database);
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

// Migrations 16 and 17 add appearance and preserve centers through both node-size changes.
export function assertCharacterUpgrade(actual: any, previous: any) {
  if (Object.hasOwn(actual, "appearance")) assert.deepEqual(validateAppearance(JSON.parse(actual.appearance)), JSON.parse(actual.appearance));
  const { appearance: _actual, ...after } = actual;
  const { appearance: _previous, ...before } = previous;
  assert.deepEqual(after, { ...before, x: before.x + 40, y: before.y - 44 });
}
