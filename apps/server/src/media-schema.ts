import type Database from "better-sqlite3";
export function migrateMedia(db: Database.Database) {
  db.exec(`
    ALTER TABLE artifact_versions ADD COLUMN origin TEXT NOT NULL DEFAULT 'published';
    ALTER TABLE artifact_versions ADD COLUMN ingestId TEXT;
    ALTER TABLE artifact_references ADD COLUMN mode TEXT NOT NULL DEFAULT 'file';
    ALTER TABLE agent_submissions ADD COLUMN attachmentFingerprint TEXT NOT NULL DEFAULT '[]';
    CREATE TABLE submission_ingests (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agentId TEXT REFERENCES agents(id) ON DELETE SET NULL, requestId TEXT NOT NULL,
      state TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE media_open_references (
      turnId TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      callId TEXT NOT NULL, versionId TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
      PRIMARY KEY(turnId,callId)
    );
    CREATE TABLE model_media_capabilities (
      connectionId TEXT NOT NULL, modelId TEXT NOT NULL,
      image INTEGER, pdf INTEGER, imageOverride INTEGER, pdfOverride INTEGER,
      PRIMARY KEY(connectionId,modelId),
      FOREIGN KEY(connectionId,modelId) REFERENCES provider_models(connectionId,id) ON DELETE CASCADE
    );
    CREATE TABLE provider_media_files (
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      versionId TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
      revision TEXT NOT NULL, fileId TEXT NOT NULL, expiresAt INTEGER NOT NULL,
      PRIMARY KEY(connectionId,versionId)
    );
    CREATE INDEX artifact_versions_ingest ON artifact_versions(ingestId);
  `);
}
