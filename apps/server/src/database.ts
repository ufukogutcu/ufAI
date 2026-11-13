import { migrateCharacters } from "./agent-appearance.js";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { migrateLocations } from "./locations-schema.js";
import { migrateExecution } from "./execution-schema.js";
import { migrateMessaging } from "./messaging-schema.js";
import { migrateMedia } from "./media-schema.js";
import { migrateTools } from "./tools-schema.js";

const defaultPath = fileURLToPath(
  new URL("../../../data/ufai.sqlite", import.meta.url),
);

export function openDatabase(path = process.env.DATABASE_PATH ?? defaultPath) {
  const databasePath = path === ":memory:" ? path : resolve(path);
  if (databasePath !== ":memory:")
    mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    const version = database.pragma("user_version", { simple: true }) as number;
    if (version > 19)
      throw new Error("This database requires a newer version of ufAI.");
    if (version < 1)
      database.transaction(() => {
        database.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE INDEX workspaces_created ON workspaces(createdAt, id);
        CREATE TABLE model_presets (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          integrationKind TEXT NOT NULL, provider TEXT NOT NULL,
          customProviderName TEXT, modelId TEXT NOT NULL,
          contextWindow INTEGER, maxOutputTokens INTEGER,
          notes TEXT NOT NULL, compactionMode TEXT NOT NULL,
          compactionValue INTEGER NOT NULL,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE INDEX model_presets_created ON model_presets(createdAt, id);
      `);
        const now = new Date().toISOString();
        database
          .prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?)")
          .run(randomUUID(), "Default workspace", now, now);
        database.pragma("user_version = 1");
      })();
    if (version < 2)
      database.transaction(() => {
        database.exec(`
          CREATE TABLE themes (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL,
            colors TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
          );
          CREATE INDEX themes_created ON themes(createdAt, id);
        `);
        database.pragma("user_version = 2");
      })();
    if (version < 3)
      database.transaction(() => {
        database.exec(`
          CREATE TABLE app_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            activeThemeId TEXT NOT NULL,
            activeWorkspaceId TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
            sidebarExpanded INTEGER NOT NULL CHECK (sidebarExpanded IN (0, 1))
          );
          INSERT INTO app_settings VALUES (
            1, 'light-mode',
            (SELECT id FROM workspaces ORDER BY createdAt, id LIMIT 1), 0
          );
          CREATE TABLE workspace_viewports (
            workspaceId TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            x REAL NOT NULL, y REAL NOT NULL,
            zoom REAL NOT NULL CHECK (zoom BETWEEN 0.25 AND 2)
          );
        `);
        database.pragma("user_version = 3");
      })();
    if (version < 4)
      database.transaction(() => {
        database.exec(
          "ALTER TABLE workspaces ADD COLUMN description TEXT NOT NULL DEFAULT ''",
        );
        database.pragma("user_version = 4");
      })();
    if (version < 5)
      database.transaction(() => {
        database.exec(`
          CREATE TABLE connections (
            id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL,
            endpoint TEXT, credential TEXT,
            isDefault INTEGER NOT NULL CHECK (isDefault IN (0, 1)),
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
          );
          CREATE UNIQUE INDEX connections_default ON connections(provider) WHERE isDefault = 1;
          CREATE INDEX connections_provider ON connections(provider, createdAt, id);
          ALTER TABLE model_presets DROP COLUMN notes;
          ALTER TABLE model_presets ADD COLUMN connectionId TEXT REFERENCES connections(id) ON DELETE SET NULL;
          CREATE INDEX model_presets_connection ON model_presets(connectionId);
        `);
        database.pragma("user_version = 5");
      })();
    if (version < 6)
      database.transaction(() => {
        database.exec(`
          ALTER TABLE connections ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE provider_models (
            connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            id TEXT NOT NULL, name TEXT NOT NULL,
            discoveredContextWindow INTEGER, discoveredMaxOutputTokens INTEGER,
            contextWindowOverride INTEGER, maxOutputTokensOverride INTEGER,
            manual INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1,
            lastTest TEXT, legacyLimits TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (connectionId, id)
          );
          INSERT INTO provider_models (connectionId, id, name, manual, available,
            contextWindowOverride, maxOutputTokensOverride, legacyLimits)
          SELECT connectionId, modelId, modelId, 1, 0,
            CASE WHEN count(DISTINCT coalesce(contextWindow, -1)) = 1 THEN max(contextWindow) END,
            CASE WHEN count(DISTINCT coalesce(maxOutputTokens, -1)) = 1 THEN max(maxOutputTokens) END,
            CASE WHEN count(DISTINCT coalesce(contextWindow, -1)) > 1
                   OR count(DISTINCT coalesce(maxOutputTokens, -1)) > 1
              THEN json_group_array(json_object('contextWindow', contextWindow, 'maxOutputTokens', maxOutputTokens))
              ELSE '[]' END
          FROM model_presets WHERE connectionId IS NOT NULL GROUP BY connectionId, modelId;
          UPDATE connections SET draft = 1 WHERE NOT EXISTS
            (SELECT 1 FROM provider_models WHERE connectionId = connections.id);
          ALTER TABLE model_presets RENAME TO old_model_presets;
          CREATE TABLE model_presets (
            id TEXT PRIMARY KEY, name TEXT NOT NULL,
            integrationKind TEXT, provider TEXT, customProviderName TEXT, modelId TEXT,
            contextWindow INTEGER, maxOutputTokens INTEGER,
            connectionId TEXT REFERENCES connections(id) ON DELETE SET NULL,
            compactionMode TEXT, compactionValue INTEGER,
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
          );
          INSERT INTO model_presets SELECT id, name,
            CASE WHEN connectionId IS NOT NULL THEN integrationKind END,
            CASE WHEN connectionId IS NOT NULL THEN provider END, NULL,
            CASE WHEN connectionId IS NOT NULL THEN modelId END,
            NULL, NULL, connectionId, compactionMode, compactionValue, createdAt, updatedAt
            FROM old_model_presets;
          DROP TABLE old_model_presets;
          CREATE INDEX model_presets_created ON model_presets(createdAt, id);
          CREATE INDEX model_presets_connection ON model_presets(connectionId);
        `);
        database.pragma("user_version = 6");
      })();
    if (version < 7)
      database.transaction(() => {
        database.exec(`
          DROP INDEX connections_default;
          ALTER TABLE connections DROP COLUMN isDefault;
        `);
        database.pragma("user_version = 7");
      })();
    if (version < 8)
      database.transaction(() => {
        database.exec(
          "ALTER TABLE provider_models ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))",
        );
        database.pragma("user_version = 8");
      })();
    if (version < 9)
      database.transaction(() => {
        database.exec(`
          ALTER TABLE provider_models DROP COLUMN discoveredMaxOutputTokens;
          ALTER TABLE provider_models DROP COLUMN maxOutputTokensOverride;
          ALTER TABLE model_presets DROP COLUMN maxOutputTokens;
          UPDATE provider_models SET legacyLimits = (
            SELECT CASE WHEN count(*) > 1
              THEN json_group_array(json_object('contextWindow', context))
              ELSE '[]' END
            FROM (
              SELECT DISTINCT json_extract(value, '$.contextWindow') AS context
              FROM json_each(provider_models.legacyLimits)
              ORDER BY context
            )
          ) WHERE legacyLimits != '[]';
        `);
        database.pragma("user_version = 9");
      })();
    if (version < 10)
      database.transaction(() => {
        migrateExecution(database);
        database.pragma("user_version = 10");
      })();
    if (version < 11)
      database.transaction(() => {
        migrateLocations(database);
        database.pragma("user_version = 11");
      })();
    if (version < 12)
      database.transaction(() => {
        migrateTools(database);
        database.pragma("user_version = 12");
      })();
    if (version < 13)
      database.transaction(() => {
        migrateMedia(database);
        database.pragma("user_version = 13");
      })();
    if (version < 14)
      database.transaction(() => {
        migrateMessaging(database);
        database.pragma("user_version = 14");
      })();
    if (version < 15)
      database.transaction(() => {
        database.exec(`
          ALTER TABLE model_presets ADD COLUMN isDefault INTEGER NOT NULL DEFAULT 0 CHECK (isDefault IN (0, 1));
          CREATE UNIQUE INDEX model_presets_default ON model_presets(isDefault) WHERE isDefault = 1;
        `);
        database.pragma("user_version = 15");
      })();
    if (version < 16)
      database.transaction(() => {
        migrateCharacters(database);
        database.pragma("user_version = 16");
      })();
    if (version < 17)
      database.transaction(() => {
        // Preserve centers when narrowing the character node from 208px to 144px.
        database.exec("UPDATE agents SET x = min(1000000, max(-1000000, x + 32))");
        database.pragma("user_version = 17");
      })();
    if (version < 18)
      database.transaction(() => {
        database.exec(`
          ALTER TABLE agent_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','chat'));
          CREATE UNIQUE INDEX agent_tasks_chat ON agent_tasks(agentId) WHERE kind='chat';
          UPDATE agent_turns SET status='cancelled', generation=generation+1, error=NULL
            WHERE taskId IS NULL AND status NOT IN ('completed','cancelled','superseded');
          UPDATE agent_messages SET state='incomplete' WHERE state='streaming'
            AND conversationId IN (SELECT id FROM conversations WHERE kind='status');
        `);
        database.pragma("user_version = 18");
      })();
    if (version < 19)
      database.transaction(() => {
        database.exec(`
          DROP INDEX requests_deadline;
          ALTER TABLE agent_requests DROP COLUMN deadline;
          ALTER TABLE messaging_waits DROP COLUMN deadline;
          ALTER TABLE owned_processes DROP COLUMN deadline;
          CREATE TABLE provider_output_metadata (
            connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            modelId TEXT NOT NULL, revision TEXT NOT NULL,
            maxOutputTokens INTEGER NOT NULL CHECK(maxOutputTokens>0),
            PRIMARY KEY(connectionId,modelId),
            FOREIGN KEY(connectionId,modelId) REFERENCES provider_models(connectionId,id) ON DELETE CASCADE
          );
        `);
        database.pragma("user_version = 19");
      })();
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
}
