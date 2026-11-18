import type Database from "better-sqlite3";
import type { WorkspacePacing } from "./contracts.js";

export function migrateWorkspacePacing(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_pacing (
    workspaceId TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    extraDelayMs INTEGER NOT NULL CHECK (extraDelayMs BETWEEN 0 AND 3000 AND extraDelayMs % 500 = 0),
    revision INTEGER NOT NULL DEFAULT 1
  )`);
}

export function isWorkspaceDelay(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 3000 && value % 500 === 0;
}

export function readWorkspacePacing(db: Database.Database, workspaceId: string): WorkspacePacing {
  const pacing = db.prepare("SELECT extraDelayMs,revision FROM workspace_pacing WHERE workspaceId=?")
    .get(workspaceId) as WorkspacePacing | undefined;
  return pacing ?? { extraDelayMs: 0, revision: 0 };
}

export function saveWorkspacePacing(db: Database.Database, workspaceId: string, extraDelayMs: number) {
  return db.transaction(() => {
    const current = readWorkspacePacing(db, workspaceId);
    if (current.extraDelayMs === extraDelayMs) return current;
    return db.prepare(`INSERT INTO workspace_pacing(workspaceId,extraDelayMs) VALUES (?,?)
      ON CONFLICT(workspaceId) DO UPDATE SET extraDelayMs=excluded.extraDelayMs,revision=workspace_pacing.revision+1
      RETURNING extraDelayMs,revision`).get(workspaceId, extraDelayMs) as WorkspacePacing;
  }).immediate();
}
