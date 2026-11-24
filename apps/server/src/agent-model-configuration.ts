import type Database from "better-sqlite3";
import type { AgentModelConfiguration, Compaction, ProviderPresetOptions } from "./contracts.js";

export interface ModelConfigurationRow {
  connectionId: string | null;
  modelId: string | null;
  compactionMode: Compaction["mode"] | null;
  compactionValue: number | null;
  providerOptions: string | null;
}

export function modelConfigurationFromRow(row: ModelConfigurationRow): AgentModelConfiguration {
  return {
    connectionId: row.connectionId,
    modelId: row.modelId,
    compaction: row.compactionMode && row.compactionValue !== null
      ? { mode: row.compactionMode, value: row.compactionValue }
      : null,
    providerOptions: row.providerOptions ? JSON.parse(row.providerOptions) as ProviderPresetOptions : null,
  };
}

export function readCustomConfiguration(db: Database.Database, agentId: string): AgentModelConfiguration | null {
  const row = db.prepare("SELECT * FROM agent_model_configurations WHERE agentId=?")
    .get(agentId) as ModelConfigurationRow | undefined;
  return row ? modelConfigurationFromRow(row) : null;
}

export function writeCustomConfiguration(db: Database.Database, agentId: string, config: AgentModelConfiguration | null) {
  if (config === null) {
    db.prepare("DELETE FROM agent_model_configurations WHERE agentId=?").run(agentId);
    return;
  }
  db.prepare(`INSERT INTO agent_model_configurations
    (agentId, connectionId, modelId, compactionMode, compactionValue, providerOptions)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(agentId) DO UPDATE SET connectionId=excluded.connectionId, modelId=excluded.modelId,
    compactionMode=excluded.compactionMode, compactionValue=excluded.compactionValue,
    providerOptions=excluded.providerOptions`).run(
    agentId, config.connectionId, config.modelId, config.compaction?.mode ?? null,
    config.compaction?.value ?? null, config.providerOptions ? JSON.stringify(config.providerOptions) : null,
  );
}

export function repairCustomConfigurations(
  db: Database.Database, connectionId: string, change: "provider-removed" | "models-disabled" | { removedModel: string },
) {
  const binding = change === "provider-removed" ? "connectionId=?"
    : change === "models-disabled" ? `connectionId=? AND modelId IN (
        SELECT id FROM provider_models WHERE connectionId=? AND enabled=0
      )`
    : "connectionId=? AND modelId=?";
  const params = change === "provider-removed" ? [connectionId]
    : change === "models-disabled" ? [connectionId, connectionId]
    : [connectionId, change.removedModel];
  db.prepare(`UPDATE agents SET revision=revision+1, updatedAt=? WHERE id IN (
    SELECT agentId FROM agent_model_configurations WHERE ${binding}
  )`).run(new Date().toISOString(), ...params);
  db.prepare(`UPDATE agent_model_configurations SET
    ${change === "provider-removed" ? "connectionId=NULL," : ""}
    modelId=NULL, providerOptions=NULL WHERE ${binding}`).run(...params);
}
