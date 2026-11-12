import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import { registerSettings } from "./settings.js";
import { registerThemes } from "./themes.js";
import { openDatabase } from "./database.js";
import { registerConnections, type ConnectionOptions } from "./connections.js";
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
    maxOutputTokens: null,
    compactionMode: compaction?.mode ?? null,
    compactionValue: compaction?.value ?? null,
  };
}

export function createApp(
  options: {
    databasePath?: string;
    logger?: boolean;
    serveStatic?: boolean;
    connections?: ConnectionOptions;
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024,
  });
  const database = openDatabase(options.databasePath);
  app.setErrorHandler((error, request, reply) => {
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
  const validatePresetConnection = registerConnections(
    app,
    database,
    options.connections,
  );

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
  const workspaceDelete = database.prepare(
    "DELETE FROM workspaces WHERE id = ?",
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
      const removed = database.transaction(() => {
        const workspace = workspaceGet.get(request.params.id) as
          | Workspace
          | undefined;
        if (!workspace) return false;
        const next = database
          .prepare(
            `SELECT id FROM workspaces WHERE (createdAt, id) > (?, ?)
          ORDER BY createdAt, id LIMIT 1`,
          )
          .get(workspace.createdAt, workspace.id) as { id: string } | undefined;
        const previous =
          next ??
          (database
            .prepare(
              `SELECT id FROM workspaces WHERE (createdAt, id) < (?, ?)
          ORDER BY createdAt DESC, id DESC LIMIT 1`,
            )
            .get(workspace.createdAt, workspace.id) as
            | { id: string }
            | undefined);
        database
          .prepare(
            "UPDATE app_settings SET activeWorkspaceId = ? WHERE activeWorkspaceId = ?",
          )
          .run(previous?.id ?? null, workspace.id);
        workspaceDelete.run(workspace.id);
        return true;
      })();
      if (!removed)
        return reply.code(404).send({ error: "Workspace not found." });
      return reply.code(204).send();
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
    contextWindow, maxOutputTokens, connectionId, compactionMode, compactionValue, createdAt, updatedAt
  ) VALUES (
    @id, @name, @integrationKind, @provider, @customProviderName, @modelId,
    @contextWindow, @maxOutputTokens, @connectionId, @compactionMode, @compactionValue, @createdAt, @updatedAt
  )`);
  const presetUpdate = database.prepare(`UPDATE model_presets SET name = @name,
    integrationKind = @integrationKind, provider = @provider, customProviderName = @customProviderName,
    modelId = @modelId, contextWindow = @contextWindow, maxOutputTokens = @maxOutputTokens,
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
