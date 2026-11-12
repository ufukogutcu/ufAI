import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import {
  discoverOllama,
  testApiModel,
  TEST_PROMPT,
} from "../src/provider-inference.js";
import type { ConnectionProvider, ProviderModel } from "../src/contracts.js";
import type { ConnectionOptions } from "../src/connections.js";

function setup(options: ConnectionOptions = {}) {
  return createApp({
    databasePath: ":memory:",
    serveStatic: false,
    connections: options,
  });
}
async function draft(app: ReturnType<typeof createApp>, provider = "openai") {
  const response = await app.inject({
    method: "POST",
    url: "/api/connections",
    payload: {
      provider,
      name: `My ${provider}`,
      ...(provider === "codex" || provider === "ollama"
        ? {}
        : { apiKey: "PRIVATE-TEST-KEY" }),
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().draft, true);
  return response.json().id as string;
}
async function addModel(
  app: ReturnType<typeof createApp>,
  id: string,
  modelId = "manual",
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/connections/${id}/models`,
    payload: { id: modelId },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<ProviderModel>();
}
test("Provider finalization requires a model but never discovery or a successful test", async (t) => {
  const app = setup({
    fetcher: async () =>
      Response.json({ secret: "PRIVATE-TEST-KEY" }, { status: 401 }),
  });
  t.after(() => app.close());
  const id = await draft(app);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/connections/${id}`,
        payload: { draft: false },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/model-presets",
        payload: { name: "Draft selection", connectionId: id },
      })
    ).statusCode,
    400,
  );
  const discovery = await app.inject({
    method: "POST",
    url: `/api/connections/${id}/models/refresh`,
  });
  assert.equal(discovery.statusCode, 401);
  assert.equal(discovery.body.includes("PRIVATE-TEST-KEY"), false);
  await addModel(app, id);
  const failed = await app.inject({
    method: "POST",
    url: `/api/connections/${id}/models/manual/test`,
  });
  assert.equal(failed.json().success, false);
  assert.equal(failed.body.includes("PRIVATE-TEST-KEY"), false);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/connections/${id}`,
        payload: { draft: false },
      })
    ).statusCode,
    200,
  );
  const preset = await app.inject({
    method: "POST",
    url: "/api/model-presets",
    payload: { name: "Working draft", connectionId: id, modelId: "manual" },
  });
  assert.equal(preset.statusCode, 201);
  assert.equal(preset.json().modelId, "manual");
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/connections/${id}/models/manual`,
      })
    ).statusCode,
    409,
  );
});
test("catalog refresh preserves manual entries, missing models, overrides, and lists without network", async (t) => {
  let calls = 0;
  const app = setup({
    fetcher: async () => {
      calls++;
      return calls === 1
        ? Response.json({
            data: [{ id: "new", context_window: 1000, max_output_tokens: 100 }],
          })
        : calls === 2
          ? Response.json({ data: [{ id: "other", context_window: 500 }] })
          : Response.json({}, { status: 503 });
    },
  });
  t.after(() => app.close());
  const id = await draft(app);
  await addModel(app, id, "owner/model:v1");
  let response = await app.inject({
    method: "POST",
    url: `/api/connections/${id}/models/refresh`,
  });
  assert.equal(response.json().total, 2);
  await app.inject({
    method: "PATCH",
    url: `/api/connections/${id}/models/new`,
    payload: { contextWindowOverride: 2000 },
  });
  await app.inject({
    method: "POST",
    url: `/api/connections/${id}/models/refresh`,
  });
  const models = (await app.inject(`/api/connections/${id}/models`)).json<{
    items: ProviderModel[];
  }>().items;
  assert.equal(calls, 2);
  assert.equal(models.length, 3);
  const old = models.find((m) => m.id === "new")!;
  assert.equal(old.available, false);
  assert.equal(old.contextWindow, 2000);
  assert.equal(old.discoveredContextWindow, 1000);
  assert.equal(models.find((m) => m.id === "owner/model:v1")?.manual, true);
  assert.equal(
    (
      await app.inject(`/api/connections/${id}/models?limit=1&offset=1&q=new`)
    ).json().total,
    1,
  );
  assert.equal(
    (await app.inject(`/api/connections/${id}/models/owner%2Fmodel%3Av1`))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/connections/${id}/models/refresh`,
      })
    ).statusCode,
    502,
  );
  assert.equal(
    (await app.inject(`/api/connections/${id}/models`)).json().total,
    3,
  );
  const automatic = await app.inject({
    method: "PATCH",
    url: `/api/connections/${id}/models/new`,
    payload: { contextWindowOverride: null },
  });
  assert.equal(automatic.json().contextWindow, 1000);
});
test("shared limits update linked presets, incomplete selections save, and deletion clears only dependent selections", async (t) => {
  const app = setup();
  t.after(() => app.close());
  const id = await draft(app);
  await addModel(app, id);
  await addModel(app, id, "second");
  await app.inject({
    method: "PATCH",
    url: `/api/connections/${id}`,
    payload: { draft: false },
  });
  const preset = (
    await app.inject({
      method: "POST",
      url: "/api/model-presets",
      payload: {
        name: "Agent",
        connectionId: id,
        modelId: "manual",
        compaction: { mode: "tokens", value: 4000 },
      },
    })
  ).json();
  assert.equal(preset.provider, "openai");
  const incomplete = await app.inject({
    method: "POST",
    url: "/api/model-presets",
    payload: { name: "Choose model later", connectionId: id },
  });
  assert.equal(incomplete.statusCode, 201);
  assert.equal(incomplete.json().modelId, null);
  await app.inject({
    method: "PATCH",
    url: `/api/connections/${id}/models/manual`,
    payload: { contextWindowOverride: 2000, maxOutputTokensOverride: 1000 },
  });
  let changed = (await app.inject("/api/model-presets"))
    .json()
    .items.find((p: { id: string }) => p.id === preset.id);
  assert.equal(changed.contextWindow, 2000);
  assert.deepEqual(changed.compaction, { mode: "tokens", value: 4000 });
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/model-presets/${preset.id}`,
        payload: { name: "Still allowed" },
      })
    ).statusCode,
    200,
  );
  await app.inject({
    method: "DELETE",
    url: `/api/connections/${id}/models/manual`,
  });
  changed = (await app.inject("/api/model-presets"))
    .json()
    .items.find((p: { id: string }) => p.id === preset.id);
  assert.equal(changed.modelId, null);
  assert.equal(changed.connectionId, id);
  await app.inject({ method: "DELETE", url: `/api/connections/${id}` });
  changed = (await app.inject("/api/model-presets"))
    .json()
    .items.find((p: { id: string }) => p.id === preset.id);
  assert.equal(changed.connectionId, null);
  assert.equal(changed.provider, null);
  assert.deepEqual(changed.compaction, preset.compaction);
});
test("model validation rejects invalid limits and duplicate IDs without changing the saved model", async (t) => {
  const app = setup();
  t.after(() => app.close());
  const id = await draft(app);
  const model = await addModel(app, id);
  for (const patch of [
    { contextWindowOverride: 0 },
    { contextWindowOverride: 1.5 },
    { contextWindowOverride: Number.MAX_SAFE_INTEGER + 1 },
    { contextWindowOverride: "100" },
    { contextWindowOverride: 10, maxOutputTokensOverride: 20 },
    { id: "changed" },
    { lastTest: "fake" },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/connections/${id}/models/manual`,
          payload: patch,
        })
      ).statusCode,
      400,
    );
  }
  assert.deepEqual(
    (await app.inject(`/api/connections/${id}/models/manual`)).json(),
    model,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/connections/${id}/models`,
        payload: { id: "manual" },
      })
    ).statusCode,
    400,
  );
});
test("all API test adapters send a small prompt, use correct auth, cap output, and recognize text", async () => {
  const providers: Exclude<ConnectionProvider, "codex">[] = [
    "openai",
    "xai",
    "anthropic",
    "google",
    "ollama",
    "openai-compatible",
    "openrouter",
    "deepseek",
    "mistral",
    "groq",
    "together",
  ];
  for (const provider of providers) {
    let called = false;
    const fetcher: typeof fetch = async (url, options) => {
      called = true;
      const headers = new Headers(options?.headers);
      const body = JSON.parse(String(options?.body));
      assert.equal(options?.redirect, "error");
      assert.ok(JSON.stringify(body).includes(TEST_PROMPT));
      assert.equal(
        headers.get(
          provider === "anthropic"
            ? "x-api-key"
            : provider === "google"
              ? "x-goog-api-key"
              : "authorization",
        ),
        provider === "google" || provider === "anthropic"
          ? "private"
          : "Bearer private",
      );
      if (provider === "anthropic") {
        assert.equal(body.max_tokens, 100);
        return Response.json({ content: [{ type: "text", text: "Yes" }] });
      }
      if (provider === "google") {
        assert.ok(String(url).endsWith("/models/test:generateContent"));
        assert.equal(body.generationConfig.maxOutputTokens, 100);
        return Response.json({
          candidates: [{ content: { parts: [{ text: "Yes" }] } }],
        });
      }
      if (provider === "ollama") {
        assert.equal(body.stream, false);
        assert.equal(body.options.num_predict, 100);
        return Response.json({ message: { content: "Yes" }, done: true });
      }
      if (provider === "openai" || provider === "xai") {
        assert.equal(body.max_output_tokens, 100);
        return Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Yes" }],
            },
          ],
        });
      }
      assert.equal(body.max_tokens, 100);
      return Response.json({
        choices: [{ message: { content: "Yes" }, finish_reason: "stop" }],
      });
    };
    assert.equal(
      await testApiModel(
        provider,
        "https://example.com",
        "private",
        "test",
        100,
        new AbortController().signal,
        fetcher,
      ),
      "Yes",
    );
    assert.equal(called, true);
  }
  for (const [status, pattern] of [
    [401, /rejected authentication/],
    [429, /rate limiting/],
    [500, /could not complete/],
  ] as const)
    await assert.rejects(
      testApiModel(
        "openai-compatible",
        "https://example.com",
        null,
        "test",
        null,
        new AbortController().signal,
        async () => Response.json({ secret: "PRIVATE" }, { status }),
      ),
      pattern,
    );
  await assert.rejects(
    testApiModel(
      "openai-compatible",
      "https://example.com",
      null,
      "test",
      null,
      new AbortController().signal,
      async () =>
        Response.json({
          choices: [{ message: { content: "" }, finish_reason: "stop" }],
        }),
    ),
    /no assistant text/,
  );
});
test("Ollama lists local models and fills reported context without requiring all detail requests to succeed", async () => {
  const models = await discoverOllama(
    "http://localhost:11434",
    null,
    async (url, options) => {
      if (String(url).endsWith("/api/tags"))
        return Response.json({
          models: [{ model: "local:latest" }, { name: "no-details" }],
        });
      if (String(options?.body).includes("no-details"))
        return Response.json({}, { status: 404 });
      return Response.json({
        model_info: { "llama.context_length": 32000 },
        parameters: "num_ctx 8192",
      });
    },
  );
  assert.equal(models[0]?.contextWindow, 8192);
  assert.equal(models[1]?.contextWindow, null);
});
test("tests are bounded globally and per connection; cancellation settles work before credential edits", async (t) => {
  const started: string[] = [];
  const app = setup({
    fetcher: async (_url, options) => {
      started.push("test");
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    },
  });
  t.after(() => app.close());
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = await draft(app);
    await addModel(app, id);
    ids.push(id);
  }
  const jobs = ids
    .slice(0, 4)
    .map((id) =>
      app
        .inject({
          method: "POST",
          url: `/api/connections/${id}/models/manual/test`,
        })
        .then((r) => r),
    );
  while (started.length < 4)
    await new Promise((resolve) => setImmediate(resolve));
  for (const id of [ids[0], ids[4]])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/connections/${id}/models/manual/test`,
        })
      ).statusCode,
      429,
    );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/connections/${ids[0]}`,
        payload: { apiKey: "new" },
      })
    ).statusCode,
    409,
  );
  await Promise.all(
    ids
      .slice(0, 4)
      .map((id) =>
        app.inject({ method: "DELETE", url: `/api/connections/${id}/test` }),
      ),
  );
  for (const response of await Promise.all(jobs))
    assert.equal(response.json().success, false);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/connections/${ids[0]}`,
        payload: { apiKey: "new" },
      })
    ).statusCode,
    200,
  );
});
test("timeouts and completed tests persist sanitized results; replacing credentials invalidates them", async (t) => {
  let hanging = false;
  const app = setup({
    testTimeoutMs: 10,
    fetcher: async (_url, options) =>
      hanging
        ? new Promise((_resolve, reject) =>
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("private")),
              { once: true },
            ),
          )
        : Response.json({
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
          }),
  });
  t.after(() => app.close());
  const id = await draft(app);
  await addModel(app, id);
  const url = `/api/connections/${id}/models/manual`;
  const result = await app.inject({ method: "POST", url: `${url}/test` });
  assert.equal(result.json().success, true);
  assert.equal(result.json().reply, "OK");
  assert.equal((await app.inject(url)).json().lastTest.success, true);
  await app.inject({
    method: "PATCH",
    url: `/api/connections/${id}`,
    payload: { apiKey: "replacement" },
  });
  assert.equal((await app.inject(url)).json().lastTest, null);
  hanging = true;
  const timeout = await app.inject({ method: "POST", url: `${url}/test` });
  assert.equal(timeout.json().success, false);
  assert.match(timeout.json().error, /cancelled or timed out/);
});
test("migration 6 preserves linked models, conflicting historical limits, and unrelated state across reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-provider-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  const db = openDatabase(path);
  db.exec(`DROP TABLE provider_models; ALTER TABLE connections DROP COLUMN draft;
    INSERT INTO connections VALUES ('saved', 'openai', 'Saved', NULL, NULL, 1, 'created', 'updated');
    INSERT INTO model_presets VALUES ('one', 'One', 'provider', 'openai', NULL, 'same', 1000, 100, 'saved', 'percentage', 80, 'created', 'updated');
    INSERT INTO model_presets VALUES ('two', 'Two', 'provider', 'openai', NULL, 'same', 2000, 200, 'saved', NULL, NULL, 'created', 'updated');
    INSERT INTO model_presets VALUES ('three', 'Three', 'provider', 'openai', NULL, 'unique', 3000, 300, 'saved', NULL, NULL, 'created', 'updated');
    INSERT INTO model_presets VALUES ('unlinked', 'Unlinked', 'provider', 'custom', 'My old service', 'old', 4000, 400, NULL, 'tokens', 2000, 'created', 'updated');
    PRAGMA user_version = 5;`);
  const settings = db.prepare("SELECT * FROM app_settings").get();
  db.close();
  let app = createApp({ databasePath: path, serveStatic: false });
  let models = (await app.inject("/api/connections/saved/models")).json<{
    items: ProviderModel[];
  }>().items;
  assert.equal(models.find((m) => m.id === "same")?.contextWindow, null);
  assert.equal(models.find((m) => m.id === "same")?.legacyLimits.length, 2);
  assert.equal(models.find((m) => m.id === "unique")?.contextWindow, 3000);
  const presets = (await app.inject("/api/model-presets")).json().items;
  assert.equal(
    presets.find((p: { id: string }) => p.id === "one").connectionId,
    "saved",
  );
  const unlinked = presets.find((p: { id: string }) => p.id === "unlinked");
  assert.equal(unlinked.provider, null);
  assert.equal(unlinked.modelId, null);
  assert.equal(unlinked.contextWindow, null);
  assert.equal(unlinked.createdAt, "created");
  assert.deepEqual(unlinked.compaction, { mode: "tokens", value: 2000 });
  await app.close();
  app = createApp({ databasePath: path, serveStatic: false });
  t.after(() => app.close());
  models = (await app.inject("/api/connections/saved/models")).json().items;
  assert.equal(models.length, 2);
  const inspection = openDatabase(path);
  assert.deepEqual(
    inspection.prepare("SELECT * FROM app_settings").get(),
    settings,
  );
  inspection.close();
});

test("discarding setup waits for discovery before deleting its catalog and credentials", async (t) => {
  let complete!: (response: Response) => void;
  let signalStart!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  const app = setup({
    fetcher: async () => {
      signalStart();
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  t.after(() => app.close());
  const id = await draft(app);
  const refreshing = app
    .inject({ method: "POST", url: `/api/connections/${id}/models/refresh` })
    .then((r) => r);
  await started;
  const discarding = app
    .inject({ method: "DELETE", url: `/api/connections/${id}` })
    .then((r) => r);
  await new Promise((resolve) => setImmediate(resolve));
  complete(Response.json({ data: [{ id: "late-model" }] }));
  await refreshing;
  assert.equal((await discarding).statusCode, 204);
  assert.equal(
    (await app.inject(`/api/connections/${id}/models`)).statusCode,
    404,
  );
  assert.equal((await app.inject("/api/connections")).json().total, 0);
});
test("server shutdown cancels and settles model tests before closing storage", async () => {
  let signalStart!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  const app = setup({
    testTimeoutMs: 1000,
    fetcher: async (_url, options) => {
      signalStart();
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    },
  });
  const id = await draft(app);
  await addModel(app, id);
  const testing = app
    .inject({
      method: "POST",
      url: `/api/connections/${id}/models/manual/test`,
    })
    .then((r) => r);
  await started;
  await app.close();
  assert.equal((await testing).json().success, false);
});
