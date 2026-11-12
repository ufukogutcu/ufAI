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

export function removeExecutionTables(database: Database.Database) {
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
