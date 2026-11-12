import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ConnectionProvider,
  DiscoveredModel,
  PresetConfiguration,
  ProviderConnection,
  ModelTestResult,
} from "./contracts.js";
import { ConnectionSecrets } from "./connection-secrets.js";
import { CodexRuntime, type CodexAdapter } from "./codex-runtime.js";
import {
  connectionProviders,
  ConnectionError,
  discoverApiModels,
  providerEndpoints,
} from "./model-providers.js";
import { ProviderModels } from "./provider-models.js";
import { discoverOllama, testApiModel } from "./provider-inference.js";
import { InputError, objectBody, pagination } from "./validation.js";

type Row = Omit<ProviderConnection, "hasCredential" | "draft"> & {
  draft: number;
  credential: string | null;
};
export interface ConnectionOptions {
  fetcher?: typeof fetch;
  codex?: CodexAdapter;
  discoveryTimeoutMs?: number;
  testTimeoutMs?: number;
}
function guard(request: FastifyRequest) {
  const host = request.headers.host;
  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    process.env.HOST ?? "127.0.0.1",
  ]);
  try {
    if (!host || !allowedHosts.has(new URL(`http://${host}`).hostname))
      throw new Error();
    if (request.headers["sec-fetch-site"] === "cross-site") throw new Error();
    const origin = request.headers.origin;
    if (origin && new URL(origin).origin !== `${request.protocol}://${host}`)
      throw new Error();
  } catch {
    throw new ConnectionError(
      "Connection operations require the local ufAI origin.",
      403,
    );
  }
}
export function registerConnections(
  app: FastifyInstance,
  database: Database.Database,
  options: ConnectionOptions = {},
) {
  const memory = database.name === ":memory:" || !database.name;
  const directory = memory
    ? join(tmpdir(), `ufai-connections-${randomUUID()}`)
    : `${database.name}.connections`;
  const secrets = new ConnectionSecrets(memory ? null : directory);
  const codex = options.codex ?? new CodexRuntime(join(directory, "codex"));
  const models = new ProviderModels(database);
  const tests = new Map<string, AbortController>();
  const testCompletions = new Map<string, Promise<void>>();
  const deleting = new Set<string>();
  const inFlight = new Map<string, Promise<DiscoveredModel[]>>();
  const get = database.prepare("SELECT * FROM connections WHERE id = ?");
  const list = database.prepare(
    "SELECT * FROM connections ORDER BY createdAt, id LIMIT ? OFFSET ?",
  );
  const count = database.prepare("SELECT count(*) AS total FROM connections");
  const publicRow = (row: Row): ProviderConnection => ({
    id: row.id,
    provider: row.provider,
    name: row.name,
    endpoint: row.endpoint,
    draft: !!row.draft,
    hasCredential:
      row.provider === "codex" ? codex.hasCredential(row.id) : !!row.credential,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  function required(id: string): Row {
    if (deleting.has(id))
      throw new ConnectionError(
        "This connection is being deleted. Please retry shortly.",
        409,
      );
    const row = get.get(id) as Row | undefined;
    if (!row) throw new ConnectionError("Connection not found.", 404);
    return row;
  }
  function editable(id: string) {
    if (inFlight.has(id) || tests.has(id))
      throw new ConnectionError(
        "Model discovery is still running. Please retry shortly.",
        409,
      );
  }
  function validate(body: unknown, existing?: Row): Row {
    const patch = objectBody(body);
    const fields: Record<string, string> = {};
    for (const key of Object.keys(patch))
      if (
        ![
          "provider",
          "name",
          "endpoint",
          "apiKey",
          "draft",
        ].includes(key)
      )
        fields[key] = "Unknown field.";
    const input = { ...existing, ...patch };
    if (
      typeof input.provider !== "string" ||
      !connectionProviders.has(input.provider)
    )
      fields.provider = "Choose a supported provider.";
    if (existing && input.provider !== existing.provider)
      fields.provider =
        "A connection's provider cannot change. Add another connection instead.";
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 120
    )
      fields.name = "Enter a name between 1 and 120 characters.";
    let endpoint: string | null = null;
    if (input.provider === "openai-compatible" || input.provider === "ollama") {
      if (input.provider === "ollama" && !input.endpoint)
        input.endpoint = "http://localhost:11434";
      try {
        if (typeof input.endpoint !== "string" || input.endpoint.length > 2000)
          throw new Error();
        const url = new URL(input.endpoint);
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            ))
        )
          throw new Error();
        endpoint = url.toString().replace(/\/+$/, "");
      } catch {
        fields.endpoint =
          "Enter an HTTPS API base URL without credentials, query, or fragment (loopback HTTP is also allowed).";
      }
      if (
        existing?.credential &&
        endpoint !== existing.endpoint &&
        !patch.apiKey
      )
        fields.apiKey = "Re-enter the API key when changing its endpoint.";
    } else if (patch.endpoint != null)
      fields.endpoint =
        "Only custom compatible connections accept an endpoint.";
    if (
      patch.apiKey !== undefined &&
      (typeof patch.apiKey !== "string" ||
        !patch.apiKey.trim() ||
        patch.apiKey.length > 8192 ||
        /[\r\n]/.test(patch.apiKey))
    )
      fields.apiKey = "Enter a valid API key.";
    if (input.provider === "codex" && patch.apiKey !== undefined)
      fields.apiKey = "Use Sign in with ChatGPT for Codex.";
    if (
      !existing?.credential &&
      !patch.apiKey &&
      input.provider !== "codex" &&
      input.provider !== "openai-compatible" &&
      input.provider !== "ollama"
    )
      fields.apiKey = "Enter an API key.";
    if (patch.draft !== undefined && typeof patch.draft !== "boolean")
      fields.draft = "Choose true or false.";
    if (patch.draft === false && !existing)
      fields.models = "Add at least one model before saving the Provider.";
    if (existing && !existing.draft && patch.draft === true)
      fields.draft = "Saved Providers cannot become setup drafts.";
    if (Object.keys(fields).length) throw new InputError(fields);
    const id = existing?.id ?? randomUUID();
    return {
      id,
      provider: input.provider as ConnectionProvider,
      draft:
        patch.draft === undefined
          ? (existing?.draft ?? 1)
          : patch.draft
            ? 1
            : 0,
      name: (input.name as string).trim(),
      endpoint,
      credential:
        typeof patch.apiKey === "string"
          ? secrets.encrypt(patch.apiKey.trim(), id)
          : (existing?.credential ?? null),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  const upsert =
    database.prepare(`INSERT INTO connections (id, provider, name, endpoint, credential, draft, createdAt, updatedAt)
    VALUES (@id, @provider, @name, @endpoint, @credential, @draft, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET name=@name, endpoint=@endpoint, credential=@credential, draft=@draft, updatedAt=@updatedAt`);
  function save(row: Row, selection?: unknown, confirmationToken?: unknown): ProviderConnection {
    return database.transaction(() => {
      if (selection !== undefined) models.applySelection(row.id, selection, confirmationToken, !row.draft);
      if (!row.draft && !models.count(row.id, true))
        throw new InputError({ models: "Select at least one model before saving the Provider." });
      const previous = get.get(row.id) as Row | undefined;
      if (
        previous &&
        (previous.endpoint !== row.endpoint ||
          previous.credential !== row.credential)
      )
        models.invalidate(row.id);
      upsert.run(row);
      return publicRow(required(row.id));
    })();
  }
  app.addHook("onRequest", async (request) => {
    if (request.url.split("?")[0]?.startsWith("/api/connections"))
      guard(request);
  });
  app.get("/api/connections", async (request) => {
    const { limit, offset } = pagination(request.query);
    return {
      items: (list.all(limit, offset) as Row[]).map(publicRow),
      total: (count.get() as { total: number }).total,
    };
  });
  app.post("/api/connections", async (request, reply) => {
    if ((count.get() as { total: number }).total >= 100)
      throw new ConnectionError(
        "Keep at most 100 saved connections. Remove an unused connection first.",
        409,
      );
    return reply.code(201).send(save(validate(request.body)));
  });
  app.patch<{ Params: { id: string } }>(
    "/api/connections/:id",
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const row = required(request.params.id);
      editable(row.id);
      const { modelSelection, confirmationToken, ...connection } = objectBody(request.body);
      if (confirmationToken !== undefined && modelSelection === undefined)
        throw new InputError({ models: "Selection confirmation requires model changes." });
      return save(validate(connection, row), modelSelection, confirmationToken);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/connections/:id",
    async (request, reply) => {
      const row = required(request.params.id);
      if (!row.draft) editable(row.id);
      deleting.add(row.id);
      try {
        tests.get(row.id)?.abort();
        await Promise.allSettled([
          inFlight.get(row.id),
          testCompletions.get(row.id),
        ]);
        if (row.provider === "codex") await codex.remove(row.id);
        database.transaction(() => {
          database
            .prepare(
              "UPDATE model_presets SET connectionId = NULL, modelId = NULL, provider = NULL, integrationKind = NULL, customProviderName = NULL, contextWindow = NULL, maxOutputTokens = NULL WHERE connectionId = ?",
            )
            .run(row.id);
          database.prepare("DELETE FROM connections WHERE id = ?").run(row.id);
        })();
      } finally {
        deleting.delete(row.id);
      }
      return reply.code(204).send();
    },
  );
  function key(row: Row): string | null {
    try {
      return row.credential ? secrets.decrypt(row.credential, row.id) : null;
    } catch {
      throw new ConnectionError(
        "Cannot unlock this Provider's key. Replace the API key and retry.",
        503,
      );
    }
  }
  function endpoint(row: Row): string {
    return row.provider === "openai-compatible" || row.provider === "ollama"
      ? row.endpoint!
      : row.provider === "codex"
        ? ""
        : providerEndpoints[row.provider];
  }
  app.get<{ Params: { id: string } }>(
    "/api/connections/:id/models",
    async (request) => {
      required(request.params.id);
      const { limit, offset } = pagination(request.query);
      const query = (request.query as { q?: unknown }).q;
      const enabled = (request.query as { enabled?: unknown }).enabled;
      if (enabled !== undefined && enabled !== "true")
        throw new InputError({ enabled: "Use true to list selected models only." });
      if (
        query !== undefined &&
        (typeof query !== "string" || query.length > 300)
      )
        throw new InputError({ q: "Enter at most 300 search characters." });
      return models.list(
        request.params.id,
        limit,
        offset,
        typeof query === "string" ? query : "",
        enabled === "true",
      );
    },
  );
  app.get<{ Params: { id: string } }>("/api/connections/:id/model-selection", async request => {
    required(request.params.id);
    const query = (request.query as { q?: unknown }).q;
    if (query !== undefined && (typeof query !== "string" || query.length > 300))
      throw new InputError({ q: "Enter at most 300 search characters." });
    return models.selection(request.params.id, typeof query === "string" ? query : "");
  });
  app.post<{ Params: { id: string } }>(
    "/api/connections/:id/models/refresh",
    async (request) => {
      const row = required(request.params.id);
      if (tests.has(row.id))
        throw new ConnectionError(
          "A model test is running. Retry shortly.",
          409,
        );
      let running = inFlight.get(row.id);
      if (!running) {
        if (inFlight.size >= 4)
          throw new ConnectionError(
            "Model discovery is busy. Retry shortly.",
            429,
          );
        running = (async () => {
          const discovered =
            row.provider === "codex"
              ? await codex.models(row.id)
              : row.provider === "ollama"
                ? await discoverOllama(
                    endpoint(row),
                    key(row),
                    options.fetcher,
                    options.discoveryTimeoutMs,
                  )
                : await discoverApiModels(
                    row.provider,
                    endpoint(row),
                    key(row),
                    options.fetcher,
                    options.discoveryTimeoutMs,
                  );
          models.merge(row.id, discovered);
          return discovered;
        })();
        inFlight.set(row.id, running);
        void running.finally(() => inFlight.delete(row.id)).catch(() => {});
      }
      await running;
      return models.list(row.id, 100, 0);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/connections/:id/models",
    async (request, reply) => {
      required(request.params.id);
      editable(request.params.id);
      return reply.code(201).send(models.save(request.params.id, request.body));
    },
  );
  app.get<{ Params: { id: string; modelId: string } }>(
    "/api/connections/:id/models/:modelId",
    async (request) => {
      required(request.params.id);
      const model = models.get(request.params.id, request.params.modelId);
      if (!model) throw new ConnectionError("Model not found.", 404);
      return model;
    },
  );
  app.patch<{ Params: { id: string; modelId: string } }>(
    "/api/connections/:id/models/:modelId",
    async (request) => {
      required(request.params.id);
      editable(request.params.id);
      return models.save(
        request.params.id,
        request.body,
        request.params.modelId,
      );
    },
  );
  app.delete<{ Params: { id: string; modelId: string } }>(
    "/api/connections/:id/models/:modelId",
    async (request, reply) => {
      const row = required(request.params.id);
      editable(row.id);
      models.remove(row.id, request.params.modelId, !!row.draft);
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/connections/:id/test",
    async (request, reply) => {
      required(request.params.id);
      tests.get(request.params.id)?.abort();
      await testCompletions.get(request.params.id);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string; modelId: string } }>(
    "/api/connections/:id/models/:modelId/test",
    async (request, reply) => {
      const row = required(request.params.id);
      if (tests.has(row.id) || tests.size >= 4)
        throw new ConnectionError(
          "Model testing is busy. Retry after the current test finishes.",
          429,
        );
      if (inFlight.has(row.id))
        throw new ConnectionError(
          "Model discovery is running. Retry shortly.",
          409,
        );
      const model = models.get(row.id, request.params.modelId);
      if (!model) throw new ConnectionError("Model not found.", 404);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.testTimeoutMs ?? 120_000,
      );
      tests.set(row.id, controller);
      let settle!: () => void;
      testCompletions.set(
        row.id,
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
      const disconnected = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.on("close", disconnected);
      const started = Date.now();
      const result: ModelTestResult = {
        success: false,
        testedAt: new Date().toISOString(),
        durationMs: 0,
        reply: "",
        error: null,
      };
      try {
        const text =
          row.provider === "codex"
            ? await codex.test(row.id, model.id, controller.signal)
            : await testApiModel(
                row.provider,
                endpoint(row),
                key(row),
                model.id,
                model.maxOutputTokens,
                controller.signal,
                options.fetcher,
              );
        if (controller.signal.aborted)
          throw new ConnectionError(
            "The model test was cancelled or timed out.",
            504,
          );
        if (!text.trim())
          throw new ConnectionError("The model returned no assistant text.");
        result.success = true;
        result.reply = text.slice(0, 300);
      } catch (error) {
        result.error =
          error instanceof ConnectionError
            ? error.message
            : "The model test failed. Check the connection and retry.";
      } finally {
        clearTimeout(timeout);
        tests.delete(row.id);
        reply.raw.removeListener("close", disconnected);
      }
      result.durationMs = Date.now() - started;
      try {
        models.tested(row.id, model.id, result);
      } finally {
        testCompletions.delete(row.id);
        settle();
      }
      return result;
    },
  );
  const runtimeRow = (id: string) => {
    const row = required(id);
    if (row.provider !== "codex")
      throw new InputError({
        provider: "Only Codex connections use subscription sign-in.",
      });
    return row;
  };
  app.get<{ Params: { id: string } }>(
    "/api/connections/:id/login",
    async (request) => {
      runtimeRow(request.params.id);
      return codex.status(request.params.id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/connections/:id/login",
    async (request) => {
      runtimeRow(request.params.id);
      const body = objectBody(request.body);
      if (
        Object.keys(body).some((key) => key !== "deviceCode") ||
        (body.deviceCode !== undefined && typeof body.deviceCode !== "boolean")
      )
        throw new InputError({ deviceCode: "Choose true or false." });
      editable(request.params.id);
      models.invalidate(request.params.id);
      return codex.login(request.params.id, body.deviceCode === true);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/connections/:id/login",
    async (request, reply) => {
      runtimeRow(request.params.id);
      await codex.cancel(request.params.id);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/connections/:id/logout",
    async (request, reply) => {
      runtimeRow(request.params.id);
      editable(request.params.id);
      await codex.logout(request.params.id);
      models.invalidate(request.params.id);
      return reply.code(204).send();
    },
  );
  app.addHook("onClose", async () => {
    for (const controller of tests.values()) controller.abort();
    await Promise.allSettled([
      ...inFlight.values(),
      ...testCompletions.values(),
    ]);
    await codex.close();
    if (memory) await rm(directory, { recursive: true, force: true });
  });
  return function resolvePreset(
    input: PresetConfiguration,
  ): PresetConfiguration {
    if (!input.connectionId)
      return {
        ...input,
        connectionId: null,
        modelId: null,
        provider: null,
        integrationKind: null,
        customProviderName: null,
        contextWindow: null,
        maxOutputTokens: null,
      };
    const connection = get.get(input.connectionId) as Row | undefined;
    if (!connection || connection.draft)
      throw new InputError({
        connectionId: "Choose a saved Provider, or leave empty.",
      });
    const model = input.modelId
      ? models.get(connection.id, input.modelId)
      : undefined;
    if (input.modelId && (!model || !model.enabled))
      throw new InputError({
        modelId: "Choose a selected model saved in this Provider.",
      });
    return {
      ...input,
      provider: connection.provider,
      integrationKind: connection.provider === "codex" ? "runtime" : "provider",
      customProviderName: null,
      contextWindow: model?.contextWindow ?? null,
      maxOutputTokens: model?.maxOutputTokens ?? null,
    };
  };
}
