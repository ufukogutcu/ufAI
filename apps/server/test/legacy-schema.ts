import type Database from "better-sqlite3";

// Reconstruct columns removed in v9 when an upgrade fixture starts from today's schema.
export function restoreOutputColumns(database: Database.Database) {
  database.exec(`
    ALTER TABLE model_presets ADD COLUMN maxOutputTokens INTEGER;
    ALTER TABLE provider_models ADD COLUMN discoveredMaxOutputTokens INTEGER;
    ALTER TABLE provider_models ADD COLUMN maxOutputTokensOverride INTEGER;
  `);
}
