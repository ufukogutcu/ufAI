import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { ConnectionSecrets } from "../src/connection-secrets.js";
import type { CodexAdapter } from "../src/codex-runtime.js";
import { discoverApiModels } from "../src/model-providers.js";

const basic = {
  name: "Test",
  provider: "openai",
  integrationKind: "provider",
  modelId: "manual",
};
const key = "test-private-api-key";
function providerApp(fetcher?: typeof fetch) {
  return createApp({
    databasePath: ":memory:",
    serveStatic: false,
    connections: { fetcher },
  });
}
async function add(
  app: ReturnType<typeof createApp>,
  input: Record<string, unknown> = {},
) {
  const result = await app.inject({
    method: "POST",
    url: "/api/connections",
    payload: { provider: "openai", name: "Primary", apiKey: key, ...input },
  });
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.body.includes(key), false);
  assert.equal("credential" in result.json(), false);
  return result.json();
}

test("connections preserve defaults and preset bindings; deletion unlinks without substituting accounts", async (t) => {
  const app = providerApp();
  t.after(() => app.close());
  const first = await add(app);
  const second = await add(app, { name: "Second" });
  assert.equal(first.isDefault, true);
  assert.equal(second.isDefault, false);
  const preset = (
    await app.inject({
      method: "POST",
      url: "/api/model-presets",
      payload: { ...basic, connectionId: first.id },
    })
  ).json();
  assert.equal(preset.connectionId, first.id);
  const changed = await app.inject({
    method: "PATCH",
    url: `/api/connections/${second.id}`,
    payload: { isDefault: true, name: "Other" },
  });
  assert.equal(changed.statusCode, 200);
  let items = (await app.inject("/api/connections")).json().items;
  assert.equal(items.filter((c: any) => c.isDefault).length, 1);
  assert.equal(items.find((c: any) => c.id === second.id).isDefault, true);
  assert.equal(
    (await app.inject("/api/model-presets")).json().items[0].connectionId,
    first.id,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/connections/${first.id}`,
      })
    ).statusCode,
    204,
  );
  const kept = (await app.inject("/api/model-presets")).json().items[0];
  assert.deepEqual(kept, { ...preset, connectionId: null });
  await app.inject({
    method: "PATCH",
    url: `/api/connections/${second.id}`,
    payload: { isDefault: false },
  });
  items = (await app.inject("/api/connections")).json().items;
  assert.equal(items[0].isDefault, true);
  const third = await add(app, { name: "Third" });
  await app.inject({ method: "DELETE", url: `/api/connections/${second.id}` });
  assert.equal(
    (await app.inject("/api/connections"))
      .json()
      .items.find((c: any) => c.id === third.id).isDefault,
    true,
  );
});

test("invalid connection input, mismatched bindings, and cross-origin requests are rejected", async (t) => {
  const app = providerApp();
  t.after(() => app.close());
  const connection = await add(app);
  for (const payload of [
    { provider: "ollama", name: "Local", apiKey: key },
    { provider: "codex", name: "Codex", apiKey: key },
    { provider: "openai", name: "No key" },
    { provider: "openai", name: "Key", apiKey: "a\nb" },
    {
      provider: "openai",
      name: "Key",
      apiKey: key,
      endpoint: "https://attacker.example",
    },
    {
      provider: "openai-compatible",
      name: "Bad URL",
      endpoint: "https://user:pass@example.com",
    },
    {
      provider: "openai-compatible",
      name: "Bad URL",
      endpoint: "http://example.com/v1",
    },
    {
      provider: "openai-compatible",
      name: "Bad URL",
      endpoint: "https://example.com?key=secret",
    },
    { provider: "openai", name: "Key", apiKey: key, isDefault: 1 },
  ])
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/connections", payload }))
        .statusCode,
      400,
      JSON.stringify(payload),
    );
  for (const payload of [
    { ...basic, provider: "google", connectionId: connection.id },
    { ...basic, connectionId: "missing" },
    { ...basic, connectionId: 2 },
  ]) {
    const result = await app.inject({
      method: "POST",
      url: "/api/model-presets",
      payload,
    });
    assert.equal(result.statusCode, 400);
    assert.ok(result.json().fields.connectionId);
  }
  for (const headers of [
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
    { host: "evil.example", origin: "http://evil.example" },
  ])
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/connections", headers }))
        .statusCode,
      403,
    );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: { host: "localhost:5173", origin: "http://localhost:5173" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/connections/${connection.id}`,
        payload: { provider: "google" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/connections/${connection.id}`,
        payload: { credential: "plaintext" },
      })
    ).statusCode,
    400,
  );
});

test("API credentials are encrypted, connection-bound, replaceable, and durable across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-credentials-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "test.sqlite");
  const seen: string[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    seen.push(new Headers(options?.headers).get("authorization")!);
    return Response.json({ data: [{ id: "chat" }] });
  };
  let app = createApp({
    databasePath,
    serveStatic: false,
    connections: { fetcher },
  });
  t.after(() => app.close());
  const connection = await add(app);
  const storage = new Database(databasePath);
  const ciphertext = (
    storage.prepare("SELECT credential FROM connections").get() as {
      credential: string;
    }
  ).credential;
  assert.equal(ciphertext.includes(key), false);
  const secrets = new ConnectionSecrets(`${databasePath}.connections`);
  assert.equal(secrets.decrypt(ciphertext, connection.id), key);
  assert.throws(() => secrets.decrypt(ciphertext, "another-connection"));
  if (process.platform !== "win32")
    assert.equal(
      (await stat(`${databasePath}.connections/connections.key`)).mode & 0o777,
      0o600,
    );
  await app.close();
  app = createApp({
    databasePath,
    serveStatic: false,
    connections: { fetcher },
  });
  assert.equal(
    (await app.inject(`/api/connections/${connection.id}/models`)).statusCode,
    200,
  );
  assert.deepEqual(seen, [`Bearer ${key}`]);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/connections/${connection.id}`,
        payload: { apiKey: "replacement" },
      })
    ).statusCode,
    200,
  );
  await app.inject(`/api/connections/${connection.id}/models`);
  assert.equal(seen[1], "Bearer replacement");
  assert.equal(
    (await readFile(databasePath)).includes(Buffer.from(key)),
    false,
  );
  storage.close();
});

test("all API adapters use the correct authentication and normalize model metadata", async (t) => {
  const requests: { url: URL; headers: Headers; redirect?: RequestRedirect }[] =
    [];
  const app = providerApp(async (url, options) => {
    const target = new URL(String(url));
    requests.push({
      url: target,
      headers: new Headers(options?.headers),
      redirect: options?.redirect,
    });
    if (target.hostname.includes("googleapis"))
      return Response.json({
        models: [
          {
            name: "models/gemini-test",
            displayName: "Gemini Test",
            inputTokenLimit: 1000,
            outputTokenLimit: 100,
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/embed",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      });
    if (target.hostname === "api.x.ai")
      return Response.json({
        models: [{ id: "grok-test", output_modalities: ["text"] }],
      });
    if (target.hostname === "api.together.xyz")
      return Response.json([
        {
          id: "test",
          display_name: "Test",
          type: "chat",
          context_length: 1000,
        },
      ]);
    return Response.json({
      data: [
        {
          id: "test",
          display_name: "Test",
          context_window: 1000,
          max_output_tokens: 100,
        },
        { id: "image", output_modalities: ["image"] },
      ],
    });
  });
  t.after(() => app.close());
  for (const provider of [
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "xai",
    "deepseek",
    "mistral",
    "groq",
    "together",
    "openai-compatible",
  ]) {
    const connection = await add(app, {
      provider,
      ...(provider === "openai-compatible"
        ? { endpoint: "https://custom.example/v1/" }
        : {}),
    });
    const result = await app.inject(`/api/connections/${connection.id}/models`);
    assert.equal(result.statusCode, 200, `${provider}: ${result.body}`);
    assert.equal(result.json().items.length, 1);
    assert.equal(result.body.includes(key), false);
    const { headers, redirect } = requests.at(-1)!;
    assert.equal(redirect, "error");
    if (provider === "anthropic") {
      assert.equal(headers.get("x-api-key"), key);
      assert.equal(headers.get("anthropic-version"), "2023-06-01");
    } else if (provider === "google")
      assert.equal(headers.get("x-goog-api-key"), key);
    else assert.equal(headers.get("authorization"), `Bearer ${key}`);
  }
  const custom = await add(app, {
    provider: "openai-compatible",
    endpoint: "https://old.example/v1",
  });
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/connections/${custom.id}`,
        payload: { endpoint: "https://new.example/v1" },
      })
    ).statusCode,
    400,
  );
});

test("provider pagination, malformed responses, auth errors, size limits, and timeout are bounded", async () => {
  const cursors: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    const cursor = new URL(String(url)).searchParams.get("pageToken");
    cursors.push(cursor ?? "");
    return Response.json({
      models: [{ name: `models/${cursor ?? "first"}` }],
      ...(cursor ? {} : { nextPageToken: "second" }),
    });
  };
  const models = await discoverApiModels(
    "google",
    "https://example.com/v1beta",
    key,
    fetcher,
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["first", "second"],
  );
  assert.deepEqual(cursors, ["", "second"]);
  await assert.rejects(
    discoverApiModels("openai", "https://example.com", key, async () =>
      Response.json({ error: "private secret" }, { status: 401 }),
    ),
    /rejected this API key/,
  );
  await assert.rejects(
    discoverApiModels("openai", "https://example.com", key, async () =>
      Response.json({ wrong: [] }),
    ),
    /invalid model list/,
  );
  await assert.rejects(
    discoverApiModels(
      "openai",
      "https://example.com",
      key,
      async () => new Response("not json"),
    ),
    /Cannot read models/,
  );
  await assert.rejects(
    discoverApiModels(
      "openai",
      "https://example.com",
      key,
      async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
    ),
    /too large/,
  );
  await assert.rejects(
    discoverApiModels("google", "https://example.com", key, async () =>
      Response.json({ models: [], nextPageToken: "repeated" }),
    ),
    /pagination/,
  );
  const hanging: typeof fetch = async (_url, options) =>
    new Promise((_resolve, reject) =>
      options?.signal?.addEventListener("abort", () =>
        reject(new Error("abort")),
      ),
    );
  await assert.rejects(
    discoverApiModels("openai", "https://example.com", key, hanging, 10),
    /timed out/,
  );
});

test("identical discovery calls coalesce and edits cannot change credentials during discovery", async (t) => {
  let finish!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const app = providerApp(async () => {
    calls++;
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  t.after(() => app.close());
  const connection = await add(app);
  const first = app.inject(`/api/connections/${connection.id}/models`);
  const second = app.inject(`/api/connections/${connection.id}/models`);
  await ready;
  const blocked = await app.inject({
    method: "PATCH",
    url: `/api/connections/${connection.id}`,
    payload: { apiKey: "another" },
  });
  assert.equal(blocked.statusCode, 409);
  finish(Response.json({ data: [{ id: "available" }] }));
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0]!.json(), results[1]!.json());
});

test("Codex routes handle sign-in, device fallback, cancellation, logout and sanitized model results", async (t) => {
  const actions: string[] = [];
  const codex: CodexAdapter = {
    status: async () => ({ status: "disconnected" }),
    hasCredential: () => false,
    login: async (id, device) => {
      actions.push(`login:${id}:${device}`);
      return {
        status: "pending",
        authUrl: "https://auth.openai.com/codex/device",
        userCode: "TEST-CODE",
      };
    },
    cancel: async (id) => {
      actions.push(`cancel:${id}`);
    },
    logout: async (id) => {
      actions.push(`logout:${id}`);
    },
    models: async () => [
      {
        id: "codex-model",
        name: "Codex model",
        contextWindow: null,
        maxOutputTokens: null,
      },
    ],
    remove: async (id) => {
      actions.push(`remove:${id}`);
    },
    close: async () => {
      actions.push("close");
    },
  };
  const app = createApp({
    databasePath: ":memory:",
    serveStatic: false,
    connections: { codex },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/connections",
    payload: { provider: "codex", name: "ChatGPT" },
  });
  assert.equal(response.statusCode, 201);
  const { id } = response.json();
  assert.equal(
    (await app.inject(`/api/connections/${id}/login`)).json().status,
    "disconnected",
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/connections/${id}/login`,
        payload: { deviceCode: true },
      })
    ).json().userCode,
    "TEST-CODE",
  );
  await app.inject({ method: "DELETE", url: `/api/connections/${id}/login` });
  assert.equal(
    (await app.inject(`/api/connections/${id}/models`)).json().items[0].id,
    "codex-model",
  );
  await app.inject({
    method: "POST",
    url: `/api/connections/${id}/logout`,
    payload: {},
  });
  await app.inject({ method: "DELETE", url: `/api/connections/${id}` });
  await app.close();
  assert.deepEqual(actions, [
    `login:${id}:true`,
    `cancel:${id}`,
    `logout:${id}`,
    `remove:${id}`,
    "close",
  ]);
});

test("migration 5 removes notes and preserves legacy records, settings and timestamps", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-v4-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "test.sqlite");
  const old = openDatabase(databasePath);
  old.exec(`DROP INDEX model_presets_connection; ALTER TABLE model_presets DROP COLUMN connectionId; DROP TABLE connections;
    ALTER TABLE model_presets ADD COLUMN notes TEXT NOT NULL DEFAULT '';
    INSERT INTO model_presets (id, name, integrationKind, provider, customProviderName, modelId, contextWindow, maxOutputTokens, compactionMode, compactionValue, createdAt, updatedAt, notes)
    VALUES ('kept', 'Old local', 'provider', 'ollama', NULL, 'local-model', 1000, 100, 'percentage', 80, 'created', 'updated', 'obsolete');
    PRAGMA user_version = 4;`);
  const settings = old.prepare("SELECT * FROM app_settings").get();
  old.close();
  const app = createApp({ databasePath, serveStatic: false });
  t.after(() => app.close());
  const preset = (await app.inject("/api/model-presets")).json().items[0];
  assert.equal(preset.id, "kept");
  assert.equal(preset.provider, "ollama");
  assert.equal(preset.createdAt, "created");
  assert.equal(preset.updatedAt, "updated");
  assert.equal(preset.connectionId, null);
  assert.equal("notes" in preset, false);
  const inspection = new Database(databasePath);
  assert.deepEqual(
    inspection.prepare("SELECT * FROM app_settings").get(),
    settings,
  );
  assert.equal(
    (
      inspection.prepare("PRAGMA table_info(model_presets)").all() as {
        name: string;
      }[]
    ).some((column) => column.name === "notes"),
    false,
  );
  inspection.close();
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/model-presets/kept",
        payload: { name: "Edited legacy" },
      })
    ).statusCode,
    200,
  );
  const rejected = await app.inject({
    method: "PATCH",
    url: "/api/model-presets/kept",
    payload: { notes: "removed" },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().fields.notes, "Unknown field.");
});
