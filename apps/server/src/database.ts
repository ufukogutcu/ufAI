import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

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
    if (version > 4)
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
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
}
