import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ConnectionProvider,
  DiscoveredModel,
  PresetInput,
  ProviderConnection,
} from "./contracts.js";
import { ConnectionSecrets } from "./connection-secrets.js";
import { CodexRuntime, type CodexAdapter } from "./codex-runtime.js";
import {
  connectionProviders,
  ConnectionError,
  discoverApiModels,
  providerEndpoints,
} from "./model-providers.js";
import { InputError, objectBody, pagination } from "./validation.js";

type Row = Omit<ProviderConnection, "isDefault" | "hasCredential"> & {
  isDefault: number;
  credential: string | null;
};
export interface ConnectionOptions {
  fetcher?: typeof fetch;
  codex?: CodexAdapter;
  discoveryTimeoutMs?: number;
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
    isDefault: !!row.isDefault,
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
    if (inFlight.has(id))
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
        !["provider", "name", "endpoint", "apiKey", "isDefault"].includes(key)
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
    if (
      input.isDefault !== undefined &&
      typeof input.isDefault !== "boolean" &&
      !(existing && patch.isDefault === undefined)
    )
      fields.isDefault = "Choose true or false.";
    let endpoint: string | null = null;
    if (input.provider === "openai-compatible") {
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
      input.provider !== "openai-compatible"
    )
      fields.apiKey = "Enter an API key.";
    if (Object.keys(fields).length) throw new InputError(fields);
    const id = existing?.id ?? randomUUID();
    return {
      id,
      provider: input.provider as ConnectionProvider,
      name: (input.name as string).trim(),
      endpoint,
      credential:
        typeof patch.apiKey === "string"
          ? secrets.encrypt(patch.apiKey.trim(), id)
          : (existing?.credential ?? null),
      isDefault:
        patch.isDefault === undefined
          ? (existing?.isDefault ?? 0)
          : patch.isDefault
            ? 1
            : 0,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  const upsert =
    database.prepare(`INSERT INTO connections (id, provider, name, endpoint, credential, isDefault, createdAt, updatedAt)
    VALUES (@id, @provider, @name, @endpoint, @credential, @isDefault, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET name=@name, endpoint=@endpoint, credential=@credential, isDefault=@isDefault, updatedAt=@updatedAt`);
  function save(row: Row): ProviderConnection {
    return database.transaction(() => {
      const first = database
        .prepare(
          "SELECT id FROM connections WHERE provider = ? AND id != ? ORDER BY createdAt, id LIMIT 1",
        )
        .get(row.provider, row.id) as { id: string } | undefined;
      if (!first) row.isDefault = 1;
      if (row.isDefault)
        database
          .prepare("UPDATE connections SET isDefault = 0 WHERE provider = ?")
          .run(row.provider);
      upsert.run(row);
      // Every nonempty provider group always retains exactly one default.
      if (
        !row.isDefault &&
        !database
          .prepare(
            "SELECT id FROM connections WHERE provider = ? AND isDefault = 1",
          )
          .get(row.provider)
      )
        database
          .prepare("UPDATE connections SET isDefault = 1 WHERE id = ?")
          .run(first!.id);
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
    async (request) => {
      const row = required(request.params.id);
      editable(row.id);
      return save(validate(request.body, row));
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/connections/:id",
    async (request, reply) => {
      const row = required(request.params.id);
      editable(row.id);
      deleting.add(row.id);
      try {
        if (row.provider === "codex") await codex.remove(row.id);
        database.transaction(() => {
          database.prepare("DELETE FROM connections WHERE id = ?").run(row.id);
          if (row.isDefault)
            database
              .prepare(
                `UPDATE connections SET isDefault = 1 WHERE id =
          (SELECT id FROM connections WHERE provider = ? ORDER BY createdAt, id LIMIT 1)`,
              )
              .run(row.provider);
        })();
      } finally {
        deleting.delete(row.id);
      }
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/connections/:id/models",
    async (request) => {
      const row = required(request.params.id);
      let running = inFlight.get(row.id);
      if (!running) {
        if (inFlight.size >= 4)
          throw new ConnectionError(
            "Model discovery is busy. Please retry shortly.",
            429,
          );
        running = (async () => {
          if (row.provider === "codex") return codex.models(row.id);
          let apiKey: string | null = null;
          try {
            if (row.credential)
              apiKey = secrets.decrypt(row.credential, row.id);
          } catch {
            throw new ConnectionError(
              "Cannot unlock this connection's API key. Replace the key in Manage connection.",
              503,
            );
          }
          const endpoint =
            row.provider === "openai-compatible"
              ? row.endpoint!
              : providerEndpoints[row.provider];
          return discoverApiModels(
            row.provider,
            endpoint,
            apiKey,
            options.fetcher,
            options.discoveryTimeoutMs,
          );
        })();
        inFlight.set(row.id, running);
        void running
          .finally(() => {
            inFlight.delete(row.id);
          })
          .catch(() => {});
      }
      return { items: await running };
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
      return reply.code(204).send();
    },
  );
  app.addHook("onClose", async () => {
    await Promise.allSettled(inFlight.values());
    await codex.close();
    if (memory) await rm(directory, { recursive: true, force: true });
  });
  return function validatePresetConnection(input: PresetInput) {
    if (!input.connectionId) return;
    const connection = get.get(input.connectionId) as Row | undefined;
    if (
      !connection ||
      connection.provider !== input.provider ||
      (connection.provider === "codex") !==
        (input.integrationKind === "runtime")
    )
      throw new InputError({
        connectionId: "Choose a connection matching this provider.",
      });
  };
}
