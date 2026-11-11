import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import { registerThemes } from "./themes.js";
import { openDatabase } from "./database.js";
import type { ModelPreset, Workspace, PresetInput } from "./contracts.js";
import {
  InputError,
  pagination,
  presetInput,
  workspaceName,
} from "./validation.js";

type PresetRow = Omit<ModelPreset, "compaction"> & {
  compactionMode: ModelPreset["compaction"]["mode"];
  compactionValue: number;
};
function fromRow(row: PresetRow): ModelPreset {
  const { compactionMode, compactionValue, ...rest } = row;
  return {
    ...rest,
    compaction: { mode: compactionMode, value: compactionValue },
  };
}
function toRow(input: PresetInput) {
  const { compaction, ...rest } = input;
  return {
    ...rest,
    compactionMode: compaction.mode,
    compactionValue: compaction.value,
  };
}

export function createApp(
  options: {
    databasePath?: string;
    logger?: boolean;
    serveStatic?: boolean;
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024,
  });
  const database = openDatabase(options.databasePath);
  app.addHook("onClose", async () => {
    database.close();
  });
  app.setErrorHandler((error, request, reply) => {
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
    "INSERT INTO workspaces VALUES (@id, @name, @createdAt, @updatedAt)",
  );
  const workspaceUpdate = database.prepare(
    "UPDATE workspaces SET name = ?, updatedAt = ? WHERE id = ?",
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
    const name = workspaceName(request.body);
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
    };
    workspaceInsert.run(workspace);
    return reply.code(201).send(workspace);
  });
  app.patch<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (request, reply) => {
      if (!workspaceGet.get(request.params.id))
        return reply.code(404).send({ error: "Workspace not found." });
      const name = workspaceName(request.body);
      workspaceUpdate.run(name, new Date().toISOString(), request.params.id);
      return workspaceGet.get(request.params.id);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (request, reply) => {
      if (!workspaceDelete.run(request.params.id).changes)
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
  const presetInsert = database.prepare(`INSERT INTO model_presets VALUES (
    @id, @name, @integrationKind, @provider, @customProviderName, @modelId,
    @contextWindow, @maxOutputTokens, @notes, @compactionMode, @compactionValue, @createdAt, @updatedAt
  )`);
  const presetUpdate = database.prepare(`UPDATE model_presets SET name = @name,
    integrationKind = @integrationKind, provider = @provider, customProviderName = @customProviderName,
    modelId = @modelId, contextWindow = @contextWindow, maxOutputTokens = @maxOutputTokens,
    notes = @notes, compactionMode = @compactionMode, compactionValue = @compactionValue,
    updatedAt = @updatedAt WHERE id = @id`);
  const presetDelete = database.prepare(
    "DELETE FROM model_presets WHERE id = ?",
  );
  app.get("/api/model-presets", async (request) => {
    const { limit, offset } = pagination(request.query);
    return {
      items: (presetList.all(limit, offset) as PresetRow[]).map(fromRow),
      total: (presetCount.get() as { total: number }).total,
    };
  });
  app.post("/api/model-presets", async (request, reply) => {
    const input = presetInput(request.body);
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
        return reply.code(404).send({ error: "Model preset not found." });
      const input = presetInput(request.body, fromRow(row));
      presetUpdate.run({
        ...toRow(input),
        id: row.id,
        updatedAt: new Date().toISOString(),
      });
      return fromRow(presetGet.get(row.id) as PresetRow);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/model-presets/:id",
    async (request, reply) => {
      if (!presetDelete.run(request.params.id).changes)
        return reply.code(404).send({ error: "Model preset not found." });
      return reply.code(204).send();
    },
  );

  registerThemes(app, database);

  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (options.serveStatic !== false && existsSync(webRoot))
    app.register(fastifyStatic, { root: webRoot });
  return app;
}
