import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type Database from "better-sqlite3";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { normalizeModel } from "../src/model-providers.js";
import { restoreOutputColumns } from "./legacy-schema.js";

test("discovery ignores output budgets without losing context or text capability filtering", () => {
  const metadata = {
    id: "model",
    name: "Model",
    context_window: 1000,
    max_output_tokens: 2000,
    max_completion_tokens: 3000,
    max_tokens: 4000,
    outputTokenLimit: 5000,
    top_provider: { max_completion_tokens: 6000 },
  };
  assert.deepEqual(normalizeModel(metadata, "openai"), {
    id: "model",
    name: "Model",
    contextWindow: 1000,
  });
  assert.equal(
    normalizeModel({ ...metadata, output_modalities: ["image"] }, "openai"),
    null,
  );
});

test("removed model fields are rejected on create and update without changing context", async (t) => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false });
  t.after(() => app.close());
  const connection = (
    await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "Local", provider: "ollama" },
    })
  ).json();
  const url = `/api/connections/${connection.id}/models`;
  const saved = (
    await app.inject({
      method: "POST",
      url,
      payload: { id: "model", contextWindowOverride: 1000 },
    })
  ).json();
  for (const field of [
    "maxOutputTokens",
    "discoveredMaxOutputTokens",
    "maxOutputTokensOverride",
  ]) {
    assert.equal(field in saved, false);
    for (const method of ["POST", "PATCH"] as const) {
      const response = await app.inject({
        method,
        url: method === "PATCH" ? `${url}/model` : url,
        payload: {
          id: method === "PATCH" ? "model" : "new",
          contextWindowOverride: 2000,
          [field]: null,
        },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().fields[field], "Unknown field.");
    }
  }
  assert.deepEqual((await app.inject(`${url}/model`)).json(), saved);
  assert.equal((await app.inject(url)).json().total, 1);
});

test("migration 9 removes output storage, preserves unrelated state, and keeps only context conflicts across reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-output-removal-"));
  const path = join(directory, "state.sqlite");
  let db = openDatabase(path);
  const tables = [
    "connections",
    "provider_models",
    "model_presets",
    "workspaces",
    "app_settings",
    "workspace_viewports",
    "themes",
  ];
  const snapshot = (database: Database.Database) =>
    tables.map((table) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  db.exec(`
    INSERT INTO connections (id, provider, name, credential, draft, createdAt, updatedAt)
      VALUES ('provider', 'ollama', 'Local', 'opaque-credential', 0, 'created', 'updated');
    INSERT INTO model_presets (id, name, modelId, connectionId, provider, integrationKind,
      compactionMode, compactionValue, createdAt, updatedAt)
      VALUES ('preset', 'Agent', 'conflict', 'provider', 'ollama', 'provider', 'percentage', 80, 'created', 'updated');
    UPDATE app_settings SET activeThemeId = 'dark-mode';
    INSERT INTO workspace_viewports SELECT id, 12, -24, 1.25 FROM workspaces;
  `);
  const candidates = [
    {
      id: "conflict",
      contexts: [null, 1000, 2000],
      historical: [2000, 1000, 1000, null],
    },
    { id: "output-only", contexts: [], historical: [1000, 1000] },
    { id: "unknown", contexts: [], historical: [null, null] },
    { id: "single", contexts: [], historical: [1000] },
    { id: "empty", contexts: [], historical: [] },
  ];
  for (const { id, contexts } of candidates) {
    db.prepare(
      `INSERT INTO provider_models (connectionId, id, name, discoveredContextWindow,
      contextWindowOverride, manual, available, enabled, lastTest, legacyLimits)
      VALUES ('provider', ?, ?, 4000, 3000, 1, 0, 0, ?, ?)`,
    ).run(
      id,
      id,
      JSON.stringify({
        success: true,
        testedAt: "tested",
        durationMs: 5,
        reply: "OK",
        error: null,
      }),
      JSON.stringify(contexts.map((contextWindow) => ({ contextWindow }))),
    );
  }
  db.exec("UPDATE provider_models SET enabled = 1 WHERE id = 'conflict'");
  const expected = snapshot(db);
  restoreOutputColumns(db);
  db.exec("UPDATE model_presets SET maxOutputTokens = 512");
  for (const { id, historical } of candidates) {
    db.prepare(
      `UPDATE provider_models SET discoveredMaxOutputTokens = 2048, maxOutputTokensOverride = 1024,
      legacyLimits = ? WHERE id = ?`,
    ).run(
      JSON.stringify(
        historical.map((contextWindow, index) => ({
          contextWindow,
          maxOutputTokens: index + 1,
        })),
      ),
      id,
    );
  }
  db.pragma("user_version = 8");
  db.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    db = openDatabase(path);
    try {
      assert.equal(db.pragma("user_version", { simple: true }), 23);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      assert.deepEqual(snapshot(db), expected);
      for (const table of ["provider_models", "model_presets"]) {
        const columns = db
          .prepare(`SELECT name FROM pragma_table_info(?)`)
          .all(table) as { name: string }[];
        assert.ok(columns.every((column) => !/output/i.test(column.name)));
      }
    } finally {
      db.close();
    }
  }
  const app = createApp({ databasePath: path, serveStatic: false });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const models = (await app.inject("/api/connections/provider/models")).json()
    .items;
  assert.deepEqual(
    models.find((model: { id: string }) => model.id === "conflict")
      .legacyLimits,
    [{ contextWindow: null }, { contextWindow: 1000 }, { contextWindow: 2000 }],
  );
  assert.ok(
    models.every(
      (model: object) => !JSON.stringify(model).includes("maxOutputTokens"),
    ),
  );
  const presets = await app.inject("/api/model-presets");
  assert.equal(presets.statusCode, 200, presets.body);
  assert.equal("maxOutputTokens" in presets.json().items[0], false);
});
