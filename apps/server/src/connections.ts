import { randomUUID } from "node:crypto";
import { repairCustomConfigurations } from "./agent-model-configuration.js";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AgentModelConfiguration,
  ConnectionProvider,
  DiscoveredModel,
  PresetConfiguration,
  ProviderConnection,
  ModelTestResult,
} from "./contracts.js";
import { ConnectionService } from "./connection-service.js";
import { type CodexAdapter } from "./codex-runtime.js";
import { codexPresetOptionErrors } from "./codex-preset-options.js";
import {
  connectionProviders,
  ConnectionError,
  discoverApiModels,
  providerEndpoints,
} from "./model-providers.js";
import { discoverExperiential, maxMakerLength } from "./experiential-catalog.js";
import { discoverOllama, testApiModel } from "./provider-inference.js";
import { duplicateName, InputError, objectBody, pagination } from "./validation.js";

type Row = Omit<ProviderConnection, "hasCredential" | "draft"> & {
  draft: number;
  credential: string | null;
  codexSessionId: string | null;
};
export interface ConnectionOptions {
  fetcher?: typeof fetch;
  codex?: CodexAdapter;
  discoveryTimeoutMs?: number;
  testTimeoutMs?: number;
}
export function guard(request: FastifyRequest) {
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
  service = new ConnectionService(database, options.fetcher, options.codex),
) {
  const { secrets, codex, models } = service;
  const tests = new Map<string, AbortController>();
  const testCompletions = new Map<string, Promise<void>>();
  const deleting = new Set<string>();
  const inFlight = new Map<string, Promise<DiscoveredModel[]>>();
  const usageWork = new Map<string, Set<Promise<unknown>>>();
  const resetting = new Set<string>();
  const get = database.prepare("SELECT * FROM connections WHERE id = ?");
  const list = database.prepare(
    "SELECT * FROM connections ORDER BY createdAt, id LIMIT ? OFFSET ?",
  );
  const count = database.prepare("SELECT count(*) AS total FROM connections");
  const sessionCount = database.prepare<[string], { total: number }>(`
    SELECT count(*) AS total FROM connections
    WHERE provider = 'codex' AND coalesce(codexSessionId, id) = ?
  `);
  const updateSession = database.prepare("UPDATE connections SET codexSessionId = ? WHERE id = ?");
  const sessionId = (row: Row) => row.codexSessionId ?? row.id;
  const sharedSession = (row: Row) => sessionCount.get(sessionId(row))!.total > 1;
  const publicRow = (row: Row): ProviderConnection => ({
    id: row.id,
    provider: row.provider,
    name: row.name,
    endpoint: row.endpoint,
    draft: !!row.draft,
    hasCredential:
      row.provider === "codex" ? codex.hasCredential(sessionId(row)) : !!row.credential,
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
    if (service.busy(id) || inFlight.has(id) || tests.has(id) || usageWork.has(service.codexSession(id)))
      throw new ConnectionError(
        "This Provider is busy. Retry when its current work finishes.",
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
      codexSessionId: existing?.codexSessionId ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  const upsert =
    database.prepare(`INSERT INTO connections (id, provider, name, endpoint, credential, draft, codexSessionId, createdAt, updatedAt)
    VALUES (@id, @provider, @name, @endpoint, @credential, @draft, @codexSessionId, @createdAt, @updatedAt)
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
  function requireCapacity() {
    if ((count.get() as { total: number }).total >= 100)
      throw new ConnectionError(
        "Keep at most 100 saved connections. Remove an unused connection first.",
        409,
      );
  }
  app.post("/api/connections", async (request, reply) => {
    requireCapacity();
    return reply.code(201).send(save(validate(request.body)));
  });
  const duplicate = database.transaction((sourceId: string, name: string) => {
    const source = required(sourceId);
    if (source.draft)
      throw new ConnectionError("Save this Provider before duplicating it.", 409);
    requireCapacity();
    let codexSessionId: string | null = null;
    if (source.provider === "codex") {
      editable(source.id);
      const session = sessionId(source);
      if (codex.isSigningIn(session))
        throw new ConnectionError("Finish or cancel Codex sign-in before duplicating this Provider.", 409);
      // Both Providers use one runtime to keep rotating credentials in sync.
      if (codex.hasCredential(session)) codexSessionId = session;
    }
    const id = randomUUID();
    const apiKey = key(source);
    const now = new Date().toISOString();
    const copy: Row = {
      ...source, name, id, codexSessionId,
      credential: apiKey ? secrets.encrypt(apiKey, id) : null,
      createdAt: now, updatedAt: now,
    };
    upsert.run(copy);
    models.copyCatalog(sourceId, id);
    return publicRow(copy);
  });
  app.post<{ Params: { id: string } }>("/api/connections/:id/duplicate", async (request, reply) => {
    return reply.code(201).send(duplicate.immediate(request.params.id, duplicateName(request.body)));
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
      const release = row.draft ? undefined : service.claim(row.id, "exclusive");
      deleting.add(row.id);
      try {
        tests.get(row.id)?.abort();
        await Promise.allSettled([
          inFlight.get(row.id),
          testCompletions.get(row.id),
          ...(usageWork.get(sessionId(row)) ?? []),
        ]);
        if (row.provider === "codex" && !sharedSession(row))
          await codex.remove(sessionId(row));
        database.transaction(() => {
          repairCustomConfigurations(database, row.id, "provider-removed");
          database
            .prepare(
              "UPDATE model_presets SET connectionId = NULL, modelId = NULL, provider = NULL, integrationKind = NULL, customProviderName = NULL, contextWindow = NULL, providerOptions = NULL WHERE connectionId = ?",
            )
            .run(row.id);
          database.prepare("DELETE FROM connections WHERE id = ?").run(row.id);
        })();
      } finally {
        deleting.delete(row.id);
        release?.();
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
  function modelCatalogFilters(row: Row, input: unknown) {
    const { q: query, maker } = input as { q?: unknown; maker?: unknown };
    if (query !== undefined && (typeof query !== "string" || query.length > 300))
      throw new InputError({ q: "Enter at most 300 search characters." });
    const grouped = row.provider === "experiential";
    if (maker !== undefined && (!grouped || typeof maker !== "string" || maker.length > maxMakerLength))
      throw new InputError({ maker: "Choose a company from this model catalog." });
    return { query, maker, grouped };
  }
  app.get<{ Params: { id: string } }>(
    "/api/connections/:id/models",
    async (request) => {
      const row = required(request.params.id);
      const { limit, offset } = pagination(request.query);
      const enabled = (request.query as { enabled?: unknown }).enabled;
      if (enabled !== undefined && enabled !== "true")
        throw new InputError({ enabled: "Use true to list selected models only." });
      return models.list(row.id, limit, offset, {
        ...modelCatalogFilters(row, request.query), enabledOnly: enabled === "true",
      });
    },
  );
  app.get<{ Params: { id: string } }>("/api/connections/:id/model-selection", async request => {
    const row = required(request.params.id);
    return models.selection(row.id, modelCatalogFilters(row, request.query));
  });
  app.post<{ Params: { id: string } }>(
    "/api/connections/:id/models/refresh",
    async (request) => {
      const row = required(request.params.id);
      if (tests.has(row.id) || usageWork.has(row.id))
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
        const release = service.claim(row.id, "exclusive");
        running = (async () => {
          try {
            const { fetcher, discoveryTimeoutMs } = options;
            let discovered: DiscoveredModel[];
            switch (row.provider) {
              case "codex":
                discovered = await codex.models(sessionId(row));
                break;
              case "ollama":
                discovered = await discoverOllama(endpoint(row), key(row), fetcher, discoveryTimeoutMs);
                break;
              case "experiential":
                discovered = await discoverExperiential(key(row), fetcher, discoveryTimeoutMs);
                break;
              default:
                discovered = await discoverApiModels(row.provider, endpoint(row), key(row), fetcher, discoveryTimeoutMs);
            }
            models.merge(row.id, discovered);
            return discovered;
          } finally { release(); }
        })();
        inFlight.set(row.id, running);
        void running.finally(() => inFlight.delete(row.id)).catch(() => {});
      }
      await running;
      return models.list(row.id, 100, 0, { grouped: row.provider === "experiential" });
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
      if (inFlight.has(row.id) || usageWork.has(row.id))
        throw new ConnectionError(
          "Model discovery is running. Retry shortly.",
          409,
        );
      const model = models.get(row.id, request.params.modelId);
      if (!model) throw new ConnectionError("Model not found.", 404);
      const release = service.claim(row.id, "exclusive");
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
            ? await codex.test(sessionId(row), model.id, controller.signal)
            : await testApiModel(
                row.provider,
                endpoint(row),
                key(row),
                model.id,
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
        release();
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
  function trackUsage<T>(session: string, promise: Promise<T>): Promise<T> {
    const pending = usageWork.get(session) ?? new Set<Promise<unknown>>();
    pending.add(promise);
    usageWork.set(session, pending);
    void promise.finally(() => {
      pending.delete(promise);
      if (!pending.size && usageWork.get(session) === pending) usageWork.delete(session);
    }).catch(() => {});
    return promise;
  }
  function usageRow(id: string) {
    const row = runtimeRow(id);
    if (row.draft) throw new InputError({ provider: "Save this Provider before viewing usage." });
    return row;
  }
  app.get<{ Params: { id: string }; Querystring: { details?: string; refresh?: string } }>(
    "/api/connections/:id/usage",
    async (request, reply) => {
      const row = usageRow(request.params.id);
      const session = sessionId(row);
      const { details, refresh } = request.query;
      if ([details, refresh].some((value) => value !== undefined && value !== "true" && value !== "false"))
        throw new InputError({ usage: "Use true or false for details and refresh." });
      if (service.exclusive(row.id) || resetting.has(session))
        throw new ConnectionError("This Provider is busy. Retry usage shortly.", 409);
      reply.header("Cache-Control", "no-store");
      return trackUsage(session, codex.usage(session, details === "true", refresh === "true"));
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/connections/:id/usage/resets/consume",
    async (request, reply) => {
      const row = usageRow(request.params.id);
      const session = sessionId(row);
      editable(row.id);
      const body = objectBody(request.body);
      const valid = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max;
      if (Object.keys(body).some((key) => key !== "idempotencyKey" && key !== "creditId") ||
          !valid(body.idempotencyKey, 200) || (body.creditId !== undefined && !valid(body.creditId, 500)))
        throw new InputError({ reset: "Supply an idempotency key and an optional reset ID." });
      reply.header("Cache-Control", "no-store");
      resetting.add(session);
      try {
        const outcome = await trackUsage(session, codex.consumeReset(session, {
          idempotencyKey: body.idempotencyKey as string,
          ...(body.creditId !== undefined ? { creditId: body.creditId as string } : {}),
        }));
        return { outcome };
      } finally { resetting.delete(session); }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/connections/:id/login",
    async (request) => {
      return codex.status(sessionId(runtimeRow(request.params.id)));
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/connections/:id/login",
    async (request) => {
      const row = runtimeRow(request.params.id);
      const body = objectBody(request.body);
      if (
        Object.keys(body).some((key) => key !== "deviceCode") ||
        (body.deviceCode !== undefined && typeof body.deviceCode !== "boolean")
      )
        throw new InputError({ deviceCode: "Choose true or false." });
      return changeAuthentication(row, (session, detached) => {
        if (!detached) models.invalidate(row.id);
        return codex.login(session, body.deviceCode === true);
      });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/connections/:id/login",
    async (request, reply) => {
      const row = runtimeRow(request.params.id);
      if (!sharedSession(row)) await codex.cancel(sessionId(row));
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/connections/:id/logout",
    async (request, reply) => {
      const row = runtimeRow(request.params.id);
      await changeAuthentication(row, async (session, detached) => {
        if (detached) return;
        await codex.logout(session);
        models.invalidate(row.id);
      });
      return reply.code(204).send();
    },
  );
  async function changeAuthentication<T>(row: Row, change: (session: string, detached: boolean) => Promise<T>) {
    editable(row.id);
    const detached = sharedSession(row);
    const session = detached ? randomUUID() : sessionId(row);
    if (detached) {
      database.transaction(() => {
        updateSession.run(session, row.id);
        models.invalidate(row.id);
      })();
    }
    const release = service.claim(row.id, "exclusive");
    try {
      return await change(session, detached);
    } finally {
      release();
    }
  }
  app.addHook("onClose", async () => {
    for (const controller of tests.values()) controller.abort();
    await Promise.allSettled([
      ...inFlight.values(),
      ...testCompletions.values(),
      ...[...usageWork.values()].flatMap(pending => [...pending]),
    ]);
    await service.close();
  });
  return function resolvePreset<T extends AgentModelConfiguration>(
    input: T,
    validateOptions = false,
  ): T & Pick<PresetConfiguration, "provider" | "integrationKind" | "customProviderName" | "contextWindow"> {
    const options = validateOptions ? input.providerOptions : null;
    const requiresCodexModel = "Choose a Codex model before setting Codex options.";
    if (!input.connectionId) {
      if (options) throw new InputError({ providerOptions: requiresCodexModel });
      return {
        ...input,
        connectionId: null,
        modelId: null,
        provider: null,
        integrationKind: null,
        customProviderName: null,
        contextWindow: null,
      };
    }
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
    if (options) {
      if (connection.provider !== options.provider || !model)
        throw new InputError({ providerOptions: requiresCodexModel });
      const fields = codexPresetOptionErrors(options, model.presetCapabilities);
      if (Object.keys(fields).length) throw new InputError(fields);
    }
    return {
      ...input,
      provider: connection.provider,
      integrationKind: connection.provider === "codex" ? "runtime" : "provider",
      customProviderName: null,
      contextWindow: model?.contextWindow ?? null,
    };
  };
}
