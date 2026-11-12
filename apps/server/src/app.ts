import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import { ConnectionService } from "./connection-service.js";
import { AgentExecution, type ExecutionOptions } from "./agent-execution.js";
import { ProcessService, type ProcessOptions } from "./process-service.js";
import { ArtifactService, type ArtifactOptions } from "./artifact-service.js";
import { AgentTools } from "./agent-tools.js";
import { registerTools } from "./tool-routes.js";
import { ManagedFiles } from "./managed-files.js";
import { registerLocations } from "./locations.js";
import { registerAgents } from "./agents.js";
import { registerSettings } from "./settings.js";
import { registerThemes } from "./themes.js";
import { openDatabase } from "./database.js";
import { registerConnections, type ConnectionOptions } from "./connections.js";
import { SelectionConfirmationError } from "./provider-models.js";
import { ConnectionError } from "./model-providers.js";
import type {
  Compaction,
  ModelPreset,
  Workspace,
  PresetConfiguration,
} from "./contracts.js";
import {
  InputError,
  pagination,
  presetInput,
  workspaceInput,
} from "./validation.js";

type PresetRow = Omit<ModelPreset, "compaction"> & {
  compactionMode: Compaction["mode"] | null;
  compactionValue: number | null;
};
function fromRow(row: PresetRow): ModelPreset {
  const { compactionMode, compactionValue, ...rest } = row;
  return {
    ...rest,
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
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024,
  });
  const database = openDatabase(options.databasePath);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SelectionConfirmationError)
      return reply
        .code(409)
        .send({ error: error.message, selectionImpact: error.impact });
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
  const tools = new AgentTools(
    database,
    files,
    processes,
    artifacts,
    changed,
    options.execution?.maxToolCalls,
  );
  execution = new AgentExecution(
    database,
    connections,
    options.execution,
    files,
    tools,
  );
  files.bind(execution);
  registerAgents(app, database, execution, files);
  registerLocations(app, database, execution, files);
  registerTools(app, database, execution, processes, artifacts);
  app.addHook("preClose", async () => artifacts.quiesce());
  app.addHook("onReady", async () => {
    await files.start();
    await artifacts.start();
    tools.ready = true;
    execution.wake();
  });
  app.addHook("onClose", async () => files.close());
  app.addHook("onClose", async () => artifacts.close());
  app.addHook("onClose", async () => processes.close());
  app.addHook("onClose", async () => execution.close());

  const workspaceList = database.prepare(
    "SELECT * FROM workspaces ORDER BY createdAt, id LIMIT ? OFFSET ?",
  );
  const workspaceCount = database.prepare(
    "SELECT count(*) AS total FROM workspaces",
  );
  const workspaceGet = database.prepare(
    "SELECT * FROM workspaces WHERE id = ?",
  );
  const workspaceInsert = database.prepare(
    `INSERT INTO workspaces (id, name, description, createdAt, updatedAt)
     VALUES (@id, @name, @description, @createdAt, @updatedAt)`,
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
    const workspace: Workspace = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    database.transaction(() => {
      workspaceInsert.run(workspace);
      database
        .prepare("UPDATE app_settings SET activeWorkspaceId = ? WHERE id = 1")
        .run(workspace.id);
    })();
    files.kick();
    return reply.code(201).send(workspace);
  });
  app.patch<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (request, reply) => {
      const existing = workspaceGet.get(request.params.id) as
        | Workspace
        | undefined;
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
        | { confirmFilesDeletion?: unknown }
        | undefined;
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
    contextWindow, connectionId, compactionMode, compactionValue, createdAt, updatedAt
  ) VALUES (
    @id, @name, @integrationKind, @provider, @customProviderName, @modelId,
    @contextWindow, @connectionId, @compactionMode, @compactionValue, @createdAt, @updatedAt
  )`);
  const presetUpdate = database.prepare(`UPDATE model_presets SET name = @name,
    integrationKind = @integrationKind, provider = @provider, customProviderName = @customProviderName,
    modelId = @modelId, contextWindow = @contextWindow,
    connectionId = @connectionId, compactionMode = @compactionMode, compactionValue = @compactionValue,
    updatedAt = @updatedAt WHERE id = @id`);
  const presetDelete = database.prepare(
    "DELETE FROM model_presets WHERE id = ?",
  );
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
    presetInsert.run({
      ...toRow(input),
      id: preset.id,
      createdAt: now,
      updatedAt: now,
    });
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
      presetUpdate.run({
        ...toRow(input),
        id: row.id,
        updatedAt: new Date().toISOString(),
      });
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
