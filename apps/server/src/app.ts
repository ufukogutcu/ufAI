import { registerInboxNotifications } from "./inbox-notifications.js";
import { WorkspaceDuplications, registerWorkspaceDuplications } from "./workspace-duplications.js";
import { Vault } from "./vault.js";
import { registerVault } from "./vault-routes.js";
import { McpService, type McpOptions } from "./mcp-service.js";
import { Triggers, type TriggerOptions } from "./triggers.js";
import { SkillAutomations } from "./trigger-skills.js";
import { TriggerUploads } from "./trigger-uploads.js";
import { registerTriggers } from "./trigger-routes.js";
import { registerMcp, mcpRedirectUrl } from "./mcp-routes.js";
import websocket from "@fastify/websocket";
import { BrowserService, type BrowserOptions } from "./browser-service.js";
import { registerBrowser } from "./browser-routes.js";
import { Skills } from "./skills.js";
import { registerSkills } from "./skill-routes.js";
import { MessagingService, registerMessaging } from "./messaging.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyError } from "fastify";
import multipart from "@fastify/multipart";
import { MediaService, effectiveMedia } from "./media-service.js";
import { SubmissionMedia, type UploadOptions } from "./submission-media.js";
import fastifyStatic from "@fastify/static";
import { ConnectionService } from "./connection-service.js";
import { AgentExecution, type ExecutionOptions } from "./agent-execution.js";
import { registerIssueInvalidations } from "./agent-issues.js";
import { ProcessService, type ProcessOptions } from "./process-service.js";
import { ArtifactService, type ArtifactOptions } from "./artifact-service.js";
import { AgentTools } from "./agent-tools.js";
import { registerTools } from "./tool-routes.js";
import { registerTimeline } from "./task-timeline.js";
import { ManagedFiles } from "./managed-files.js";
import { registerLocations } from "./locations.js";
import { AgentFiles, registerAgentFiles, type AgentFilesOptions } from "./agent-files.js";
import { registerAgents } from "./agents.js";
import { registerSettings } from "./settings.js";
import { registerThemes } from "./themes.js";
import { openDatabase } from "./database.js";
import {
  guard as guardMedia,
  registerConnections,
  type ConnectionOptions,
} from "./connections.js";
import { SelectionConfirmationError } from "./provider-models.js";
import { ConnectionError } from "./model-providers.js";
import { McpAuthError } from "./mcp-auth-errors.js";
import type {
  Compaction,
  ModelPreset,
  Workspace,
  PresetConfiguration,
} from "./contracts.js";
import {
  InputError,
  objectBody,
  pagination,
  presetInput,
  workspaceInput,
} from "./validation.js";

type PresetRow = Omit<ModelPreset, "compaction" | "isDefault"> & {
  isDefault: number;
  compactionMode: Compaction["mode"] | null;
  compactionValue: number | null;
};
function fromRow(row: PresetRow): ModelPreset {
  const { compactionMode, compactionValue, ...rest } = row;
  return {
    ...rest,
    isDefault: !!row.isDefault,
    compaction:
      compactionMode && compactionValue !== null
        ? { mode: compactionMode, value: compactionValue }
        : null,
  };
}
function toRow(input: PresetConfiguration) {
  const { compaction, ...rest } = input;
  return {
    ...rest,
    isDefault: Number(input.isDefault),
    contextWindow: null,
    compactionMode: compaction?.mode ?? null,
    compactionValue: compaction?.value ?? null,
  };
}

export function createApp(
  options: {
    databasePath?: string;
    filesRoot?: string;
    logger?: boolean;
    serveStatic?: boolean;
    connections?: ConnectionOptions;
    execution?: ExecutionOptions;
    processes?: ProcessOptions;
    artifacts?: ArtifactOptions;
    uploads?: UploadOptions;
    agentFiles?: AgentFilesOptions;
    browser?: BrowserOptions;
    mcp?: McpOptions;
    triggers?: TriggerOptions;
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024,
  });
  app.register(multipart);
  const database = openDatabase(options.databasePath);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SelectionConfirmationError)
      return reply
        .code(409)
        .send({ error: error.message, selectionImpact: error.impact });
    if (error instanceof McpAuthError)
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    if (error instanceof ConnectionError)
      return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof InputError)
      return reply
        .code(400)
        .send({ error: error.message, fields: error.fields });
    const httpError = error as Partial<FastifyError> | null;
    if (
      typeof httpError?.statusCode === "number" &&
      httpError.statusCode >= 400 &&
      httpError.statusCode < 500
    )
      return reply
        .code(httpError.statusCode)
        .send({ error: httpError.message ?? "Invalid request." });
    request.log.error(error);
    return reply
      .code(500)
      .send({ error: "The request could not be saved. Please try again." });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "Not found." }),
  );
  app.get("/api/health", async () => ({ status: "ok" }));
  // Registered first: Fastify closes hooks in reverse order, after connection work finishes.
  app.addHook("onClose", async () => {
    database.close();
  });
  const connections = new ConnectionService(
    database,
    options.connections?.fetcher,
    options.connections?.codex,
  );
  const validatePresetConnection = registerConnections(
    app,
    database,
    options.connections,
    connections,
  );
  const files = new ManagedFiles(database, options.filesRoot);
  const agentFiles = new AgentFiles(files, options.agentFiles);
  files.browser = agentFiles;
  let execution!: AgentExecution;
  const changed = (id: string) => execution?.workspaceEvent(id, "activity");
  const processes = new ProcessService(
    database,
    files,
    changed,
    options.processes,
  );
  const artifacts = new ArtifactService(
    database,
    files,
    changed,
    options.artifacts,
  );
  const mcp = new McpService(database, files, connections.secrets, changed, artifacts, options.mcp);
  mcp.redirectUrl = () => mcpRedirectUrl(app);
  registerMcp(app, mcp);
  files.mcp = mcp;
  const skills = new Skills(database, files, changed, options.agentFiles);
  registerSkills(app, skills);
  const browsers = new BrowserService(database, files, skills, changed, options.browser);
  files.agentBrowser = browsers;
  skills.onEnabledChanged = (id, skillId, enabled) => browsers.enabledChanged(id, skillId, enabled);
  app.register(async instance => {
    await instance.register(websocket, { options: { maxPayload: 65536 } });
    registerBrowser(instance, browsers, files);
  });
  const tools = new AgentTools(
    database,
    files,
    processes,
    artifacts,
    changed,
  );
  tools.mcp = mcp;
  tools.mcpRedirectUrl = () => mcpRedirectUrl(app);
  tools.skills = skills;
  tools.browser = browsers;
  execution = new AgentExecution(
    database,
    connections,
    options.execution,
    files,
    tools,
  );
  const messaging = new MessagingService(database,execution,connections);
  registerIssueInvalidations(app, database, id => execution.workspaceEvent(id, "issues"));
  execution.messaging=messaging; tools.messaging=messaging;
  const vault = new Vault(database, connections.secrets, changed);
  vault.messaging = messaging; vault.browser = browsers; tools.vault = vault;
  registerVault(app, vault, execution.events);
  registerInboxNotifications(app, database, execution.events);
  app.addHook("onClose", async () => vault.close());
  const media = new MediaService(artifacts);
  tools.media = media;
  tools.mediaCapabilities = (owner) => {
    const row = database
      .prepare("SELECT snapshot FROM agent_turns WHERE id=?")
      .get(owner.turnId) as { snapshot: string | null } | undefined;
    const s = row?.snapshot
      ? JSON.parse(row.snapshot)
      : connections.snapshot(execution.requiredAgent(owner.agentId));
    return (
      s.mediaCapabilities ??
      effectiveMedia(
        s.provider,
        connections.models.get(s.connectionId, s.modelId),
      )
    );
  };
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/media-capabilities",
    async (req) => {
      guardMedia(req);
      const s = connections.snapshot(execution.requiredAgent(req.params.id));
      return {
        capabilities: effectiveMedia(
          s.provider,
          connections.models.get(s.connectionId, s.modelId),
        ),
        maxFiles: incoming.maxFiles,
        maxBytes: incoming.maxBytes,
      };
    },
  );
  mcp.mediaCapabilities = tools.mediaCapabilities;
  const incoming = new SubmissionMedia(
    database,
    media,
    execution,
    connections,
    options.uploads,
  );
  execution.incoming = incoming;
  const triggers = new Triggers(database, execution, connections, skills, artifacts, files,
    { ...options.triggers, onError: error => app.log.error(error) });
  const automations = new SkillAutomations(triggers);
  triggers.automation = automations;
  skills.onInstalled = (agentId, skillId) => automations.installed(agentId, skillId);
  tools.triggers = triggers;
  const triggerUploads = new TriggerUploads(triggers, incoming);
  registerTriggers(app, triggers, triggerUploads);
  app.decorate("triggers", triggers);
  files.triggerUploads = triggerUploads;
  const duplications = new WorkspaceDuplications(database, files, triggers);
  registerWorkspaceDuplications(app, duplications);
  registerMessaging(app,messaging,incoming);
  files.bind(execution);
  registerAgents(app, database, execution, files, incoming);
  registerLocations(app, database, files);
  registerAgentFiles(app, agentFiles);
  registerTools(app, database, execution, processes, artifacts);
  registerTimeline(app, database, execution);
  app.addHook("preClose", async () => {
    await duplications.close();
    await triggers.close();
    await triggerUploads.close();
    await browsers.close();
    await agentFiles.close();
    await incoming.close();
    await artifacts.quiesce();
  });
  app.addHook("onReady", async () => {
    await files.start();
    await duplications.start();
    await skills.start();
    await artifacts.start();
    await triggerUploads.start();
    messaging.start();
    tools.ready = true;
    execution.wake();
    triggers.start();
  });
  app.addHook("onListen", async () => {
    triggers.recordAppStart();
  });
  app.addHook("onClose", async () => files.close());
  app.addHook("onClose", async () => artifacts.close());
  app.addHook("onClose", async () => processes.close());
  app.addHook("onClose", async () => messaging.close());
  app.addHook("onClose", async () => skills.close());
  app.addHook("onClose", async () => mcp.close());
  app.addHook("onClose", async () => execution.close());

  const workspaceList = database.prepare(
    "SELECT * FROM workspaces ORDER BY sortOrder, id LIMIT ? OFFSET ?",
  );
  const workspaceCount = database.prepare(
    "SELECT count(*) AS total FROM workspaces",
  );
  const workspaceGet = database.prepare(
    "SELECT * FROM workspaces WHERE id = ?",
  );
  const workspaceInsert = database.prepare(
    `INSERT INTO workspaces (id, name, description, createdAt, updatedAt, sortOrder)
     VALUES (@id, @name, @description, @createdAt, @updatedAt, @sortOrder)`,
  );
  const workspaceUpdate = database.prepare(
    "UPDATE workspaces SET name = @name, description = @description, updatedAt = @updatedAt WHERE id = @id",
  );
  app.get("/api/workspaces", async (request) => {
    const { limit, offset } = pagination(request.query);
    return {
      items: workspaceList.all(limit, offset),
      total: (workspaceCount.get() as { total: number }).total,
    };
  });
  app.post("/api/workspaces", async (request, reply) => {
    const input = workspaceInput(request.body);
    const now = new Date().toISOString();
    const workspace = database.transaction(() => {
      const { sortOrder } = database.prepare("SELECT COALESCE(MAX(sortOrder), -1) + 1 AS sortOrder FROM workspaces").get() as { sortOrder: number };
      const workspace: Workspace = { id: randomUUID(), ...input, createdAt: now, updatedAt: now, sortOrder };
      workspaceInsert.run(workspace);
      database
        .prepare("UPDATE app_settings SET activeWorkspaceId = ? WHERE id = 1")
        .run(workspace.id);
      return workspace;
    })();
    files.kick();
    return reply.code(201).send(workspace);
  });
  app.patch<{ Params: { id: string } }>("/api/workspaces/:id/order", async (request, reply) => {
    const input = objectBody(request.body);
    const fields: Record<string, string> = {};
    for (const key of Object.keys(input))
      if (!["relativeToId", "placement"].includes(key)) fields[key] = "Unknown field.";
    if (typeof input.relativeToId !== "string" || !input.relativeToId || input.relativeToId === request.params.id)
      fields.relativeToId = "Choose a different existing workspace.";
    if (input.placement !== "before" && input.placement !== "after") fields.placement = "Choose before or after.";
    if (Object.keys(fields).length) throw new InputError(fields);
    const moved = database.transaction(() => {
      const workspace = workspaceGet.get(request.params.id) as Workspace | undefined;
      const relative = workspaceGet.get(input.relativeToId as string) as Workspace | undefined;
      if (!workspace || !relative) return false;
      files.assertAvailable(workspace.id);
      files.assertAvailable(relative.id);
      const from = workspace.sortOrder;
      const to = relative.sortOrder + (input.placement === "after" ? 1 : 0) - (from < relative.sortOrder ? 1 : 0);
      if (from < to) database.prepare("UPDATE workspaces SET sortOrder = sortOrder - 1 WHERE sortOrder > ? AND sortOrder <= ?").run(from, to);
      else if (from > to) database.prepare("UPDATE workspaces SET sortOrder = sortOrder + 1 WHERE sortOrder >= ? AND sortOrder < ?").run(to, from);
      if (from !== to) database.prepare("UPDATE workspaces SET sortOrder = ? WHERE id = ?").run(to, workspace.id);
      return true;
    })();
    return moved ? reply.code(204).send() : reply.code(404).send({ error: "Workspace not found." });
  });
  app.patch<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (request, reply) => {
      const existing = workspaceGet.get(request.params.id) as
        Workspace | undefined;
      if (!existing)
        return reply.code(404).send({ error: "Workspace not found." });
      files.assertAvailable(existing.id);
      const input = workspaceInput(request.body, existing);
      if (
        input.name === existing.name &&
        input.description === existing.description
      )
        return existing;
      workspaceUpdate.run({
        ...input,
        updatedAt: new Date().toISOString(),
        id: existing.id,
      });
      return workspaceGet.get(request.params.id);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (request, reply) => {
      if (!workspaceGet.get(request.params.id))
        return reply.code(404).send({ error: "Workspace not found." });
      const body = request.body as
        { confirmFilesDeletion?: unknown } | undefined;
      return reply
        .code(202)
        .send(
          files.requestDeletion(
            "workspace",
            request.params.id,
            body?.confirmFilesDeletion,
          ),
        );
    },
  );

  const presetList = database.prepare(
    "SELECT * FROM model_presets ORDER BY createdAt, id LIMIT ? OFFSET ?",
  );
  const presetCount = database.prepare(
    "SELECT count(*) AS total FROM model_presets",
  );
  const presetGet = database.prepare(
    "SELECT * FROM model_presets WHERE id = ?",
  );
  const presetInsert = database.prepare(`INSERT INTO model_presets (
    id, name, integrationKind, provider, customProviderName, modelId,
    contextWindow, connectionId, compactionMode, compactionValue, isDefault, createdAt, updatedAt
  ) VALUES (
    @id, @name, @integrationKind, @provider, @customProviderName, @modelId,
    @contextWindow, @connectionId, @compactionMode, @compactionValue, @isDefault, @createdAt, @updatedAt
  )`);
  const presetUpdate = database.prepare(`UPDATE model_presets SET name = @name,
    integrationKind = @integrationKind, provider = @provider, customProviderName = @customProviderName,
    modelId = @modelId, contextWindow = @contextWindow,
    connectionId = @connectionId, compactionMode = @compactionMode, compactionValue = @compactionValue,
    isDefault = @isDefault, updatedAt = @updatedAt WHERE id = @id`);
  const presetDelete = database.prepare(
    "DELETE FROM model_presets WHERE id = ?",
  );
  const clearDefault = database.prepare(
    "UPDATE model_presets SET isDefault=0, updatedAt=? WHERE isDefault=1 AND id!=?",
  );
  app.get("/api/model-presets/default", async () => {
    const row = database
      .prepare("SELECT * FROM model_presets WHERE isDefault=1")
      .get() as PresetRow | undefined;
    return { preset: row ? validatePresetConnection(fromRow(row)) : null };
  });
  app.get("/api/model-presets", async (request) => {
    const { limit, offset } = pagination(request.query);
    return {
      items: (presetList.all(limit, offset) as PresetRow[]).map((row) =>
        validatePresetConnection(fromRow(row)),
      ),
      total: (presetCount.get() as { total: number }).total,
    };
  });
  app.post("/api/model-presets", async (request, reply) => {
    const input = validatePresetConnection(presetInput(request.body));
    const now = new Date().toISOString();
    const preset: ModelPreset = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    database.transaction(() => {
      if (input.isDefault) clearDefault.run(now, preset.id);
      presetInsert.run({
        ...toRow(input),
        id: preset.id,
        createdAt: now,
        updatedAt: now,
      });
    })();
    return reply.code(201).send(preset);
  });
  app.patch<{ Params: { id: string } }>(
    "/api/model-presets/:id",
    async (request, reply) => {
      const row = presetGet.get(request.params.id) as PresetRow | undefined;
      if (!row)
        return reply.code(404).send({ error: "Agent preset not found." });
      const input = validatePresetConnection(
        presetInput(request.body, fromRow(row)),
      );
      database.transaction(() => {
        const now = new Date().toISOString();
        if (input.isDefault) clearDefault.run(now, row.id);
        presetUpdate.run({ ...toRow(input), id: row.id, updatedAt: now });
      })();
      return validatePresetConnection(
        fromRow(presetGet.get(row.id) as PresetRow),
      );
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/model-presets/:id",
    async (request, reply) => {
      if (!presetDelete.run(request.params.id).changes)
        return reply.code(404).send({ error: "Agent preset not found." });
      return reply.code(204).send();
    },
  );

  registerThemes(app, database);
  registerSettings(app, database);

  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (options.serveStatic !== false && existsSync(webRoot))
    app.register(fastifyStatic, { root: webRoot });
  return app;
}
