import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgentIssue, ProviderPresetOptions } from "./contracts.js";
import {
  codexPresetOptionErrors,
  unavailableCodexPresetOptions,
} from "./codex-preset-options.js";

type Configuration = {
  preset: string | null;
  custom: string | null;
  connection: string | null;
  draft: number | null;
  provider: string | null;
  hasCredential: number;
  modelId: string | null;
  model: string | null;
  enabled: number | null;
  contextWindow: number | null;
  providerOptions: string | null;
  presetCapabilities: string | null;
};

/** Read-only diagnostics. Never probes a provider or starts a runtime. */
export class AgentIssues {
  private configuration;
  private errorCount;
  private errors;
  constructor(db: Database.Database) {
    this.configuration = db.prepare(`SELECT p.id AS preset, cfg.agentId AS custom,
      c.id AS connection, c.draft, c.provider, (c.credential IS NOT NULL) AS hasCredential,
      coalesce(p.modelId,cfg.modelId) AS modelId, m.id AS model, m.enabled,
      coalesce(p.providerOptions,cfg.providerOptions) AS providerOptions, m.presetCapabilities,
      coalesce(m.contextWindowOverride,m.discoveredContextWindow) AS contextWindow
      FROM agents a LEFT JOIN model_presets p ON p.id=a.presetId
      LEFT JOIN agent_model_configurations cfg ON cfg.agentId=a.id AND a.presetId IS NULL
      LEFT JOIN connections c ON c.id=coalesce(p.connectionId,cfg.connectionId)
      LEFT JOIN provider_models m ON m.connectionId=c.id AND m.id=coalesce(p.modelId,cfg.modelId)
      WHERE a.id=?`);
    this.errorCount = db.prepare(`SELECT count(*) AS total FROM agent_tasks
      WHERE agentId=? AND status IN ('blocked','failed')`);
    this.errors = db.prepare(`SELECT id, title, error, status FROM agent_tasks
      WHERE agentId=? AND status IN ('blocked','failed')
      ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?`);
  }
  warnings(agentId: string): AgentIssue[] {
    const c = this.configuration.get(agentId) as Configuration | undefined;
    if (!c) return [];
    const items: AgentIssue[] = [];
    const add = (id: string, message: string) => items.push({
      id, severity: "warning", message, taskId: null, taskTitle: null,
    });
    if (!c.preset && !c.custom) {
      add("missing-preset", "Choose an Agent Preset or configure a Provider and model in Details.");
      return items;
    }
    if (!c.connection || c.draft) {
      add("missing-provider", c.custom
        ? "Choose a saved Provider in this agent’s Details."
        : "The Agent Preset needs a complete Provider. Choose or finish its Provider in Agent Presets and Providers.");
      return items;
    }
    if (c.provider && !["codex", "ollama", "openai-compatible"].includes(c.provider) && !c.hasCredential)
      add("missing-credentials", "Provider credentials are missing. Add the required API key in Providers.");
    if (!c.modelId) {
      add("missing-model", c.custom
        ? "Choose a saved model in this agent’s Details."
        : "No model selected in the Agent Preset. Choose a model in Agent Presets.");
    } else if (!c.model || !c.enabled) {
      add("unavailable-model", c.custom
        ? "The selected model is missing or disabled. Enable it in Providers or choose another model in Details."
        : "The selected model is missing or disabled. Enable it in Providers or choose another model in Agent Presets.");
    } else if (c.contextWindow == null) {
      add("unknown-context", "The model’s context window is unknown. Set it in Providers.");
    } else if (c.contextWindow < 1024) {
      add("insufficient-context", "Execution requires a context window of at least 1,024 tokens. Update the model in Providers.");
    }
    if (c.provider === "codex" && c.model && c.enabled && c.providerOptions) {
      const options = JSON.parse(c.providerOptions) as ProviderPresetOptions;
      const capabilities = c.presetCapabilities ? JSON.parse(c.presetCapabilities) : undefined;
      if (Object.keys(codexPresetOptionErrors(options, capabilities)).length)
        add("unavailable-codex-preset-options", c.custom
          ? "This Codex model no longer offers the selected thinking level or speed. Update the model settings in Details."
          : unavailableCodexPresetOptions);
    }
    return items;
  }
  counts(agentId: string) {
    return {
      warning: this.warnings(agentId).length,
      error: (this.errorCount.get(agentId) as { total: number }).total,
    };
  }
  list(agentId: string, severity: AgentIssue["severity"], limit: number, offset: number) {
    if (severity === "warning") {
      const items = this.warnings(agentId);
      return { items: items.slice(offset, offset + limit), total: items.length };
    }
    const rows = this.errors.all(agentId, limit, offset) as {
      id: string; title: string; error: string | null; status: string;
    }[];
    return {
      items: rows.map((row): AgentIssue => ({
        id: `task:${row.id}`, severity: "error", taskId: row.id, taskTitle: row.title,
        message: row.error || `This work is ${row.status}. Open it in Chat or Tasks to retry or cancel.`,
      })),
      total: (this.errorCount.get(agentId) as { total: number }).total,
    };
  }
}

/** Capture dependencies before deletion/model-selection repair can unlink them. */
export function registerIssueInvalidations(
  app: FastifyInstance, db: Database.Database, changed: (workspaceId: string) => void,
) {
  const affected = new WeakMap<FastifyRequest, { workspaceId: string }[]>();
  const byPreset = db.prepare("SELECT DISTINCT workspaceId FROM agents WHERE presetId=?");
  const byConnection = db.prepare(`SELECT DISTINCT a.workspaceId FROM agents a
    JOIN model_presets p ON p.id=a.presetId WHERE p.connectionId=@id
    UNION SELECT a.workspaceId FROM agent_model_configurations cfg
    JOIN agents a ON a.id=cfg.agentId WHERE cfg.connectionId=@id`);
  app.addHook("preHandler", async request => {
    if (!["POST", "PATCH", "DELETE"].includes(request.method)) return;
    const path = request.url.split("?")[0]!;
    const preset = /^\/api\/model-presets\/([^/]+)$/.exec(path);
    const connection = /^\/api\/connections\/([^/]+)(?:\/models(?:\/.*)?)?$/.exec(path);
    const match = preset ?? connection;
    if (!match || (request.method === "POST" && path.endsWith("/test"))) return;
    const id = decodeURIComponent(match[1]!);
    affected.set(request, (preset ? byPreset.all(id) : byConnection.all({ id })) as { workspaceId: string }[]);
  });
  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 300)
      for (const { workspaceId } of affected.get(request) ?? []) changed(workspaceId);
  });
}
