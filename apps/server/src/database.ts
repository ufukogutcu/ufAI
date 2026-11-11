import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const defaultPath = fileURLToPath(new URL("../../../data/ufai.sqlite", import.meta.url));

export function openDatabase() {
  const databasePath = resolve(process.env.DATABASE_PATH ?? defaultPath);
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  return database;
}
