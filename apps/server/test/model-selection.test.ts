import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { ProviderModels } from "../src/provider-models.js";
import { openDatabase } from "../src/database.js";
import { restoreOutputColumns } from "./legacy-schema.js";
import type { ModelSelection, SelectionImpact } from "../src/contracts.js";

type App = ReturnType<typeof createApp>;
async function setup(app: App, count = 3) {
  const created = await app.inject({ method: "POST", url: "/api/connections", payload: { name: "Local", provider: "ollama" } });
  const id = created.json().id as string;
  for (let i = 0; i < count; i++) {
    const added = await app.inject({ method: "POST", url: `/api/connections/${id}/models`, payload: { id: `model-${i.toString().padStart(3, "0")}` } });
    assert.equal(added.statusCode, 201, added.body);
    assert.equal(added.json().enabled, true);
  }
  return id;
}
function save(app: App, id: string, modelSelection: unknown, extra = {}) {
  return app.inject({ method: "PATCH", url: `/api/connections/${id}`, payload: { draft: false, modelSelection, ...extra } });
}
async function selection(app: App, id: string) {
  return (await app.inject(`/api/connections/${id}/model-selection`)).json<{ items: ModelSelection[] }>().items;
}
async function preset(app: App, id: string, name = "Linked", modelId = "model-000") {
  const result = await app.inject({ method: "POST", url: "/api/model-presets", payload: { name, connectionId: id, modelId, compaction: { mode: "percentage", value: 80 } } });
  assert.equal(result.statusCode, 201, result.body);
  return result.json();
}

test("selection filtering precedes pagination and totals; last enabled model cannot be disabled or removed", async t => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false });
  t.after(() => app.close());
  const id = await setup(app, 65);
  const changes = (await selection(app, id)).map((model, i) => ({ ...model, enabled: i >= 60 }));
  assert.equal((await save(app, id, changes)).statusCode, 200);
  const page = (await app.inject(`/api/connections/${id}/models?enabled=true&limit=2&offset=1`)).json();
  assert.equal(page.total, 5);
  assert.deepEqual(page.items.map((model: { id: string }) => model.id), ["model-061", "model-062"]);
  const matching = (await app.inject(`/api/connections/${id}/model-selection?q=model-06`)).json();
  assert.equal(matching.items.length, 5);
  assert.equal((await app.inject(`/api/connections/${id}/model-selection?q=%25`)).json().items.length, 0);
  const none = changes.map(model => ({ ...model, enabled: false }));
  const failed = await save(app, id, none, { name: "Should roll back" });
  assert.equal(failed.statusCode, 400);
  assert.match(failed.json().fields.models, /Select at least one/);
  assert.equal((await app.inject("/api/connections")).json().items.find((item: { id: string }) => item.id === id).name, "Local");
  assert.equal((await selection(app, id)).filter(model => model.enabled).length, 5);
  assert.equal((await save(app, id, changes.map(model => ({ ...model, enabled: model.id === "model-064" })))).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/connections/${id}/models/model-064` })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/connections/${id}/models/model-000` })).statusCode, 204);
  assert.equal((await app.inject(`/api/connections/${id}/models?enabled=invalid`)).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/api/connections/${id}/models`, payload: { id: "selection" } })).statusCode, 201);
  assert.equal((await app.inject(`/api/connections/${id}/models/selection`)).json().id, "selection");
});

test("confirmation is atomic, cancel leaves saved records unchanged, impact changes require reconfirmation", async t => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false, connections: {
    fetcher: async () => Response.json({ message: { content: "OK" }, done: true }),
  } });
  t.after(() => app.close());
  const id = await setup(app);
  assert.equal((await save(app, id, [])).statusCode, 200);
  const first = await preset(app, id);
  const changes = [{ id: "model-000", enabled: false }];
  let response = await save(app, id, changes, { name: "Changed" });
  assert.equal(response.statusCode, 409, response.body);
  const initialImpact = response.json().selectionImpact as SelectionImpact;
  assert.equal(initialImpact.total, 1);
  assert.deepEqual(initialImpact.presets, [{ id: first.id, name: first.name }]);
  assert.equal((await selection(app, id))[0]?.enabled, true);
  assert.equal((await app.inject("/api/connections")).json().items.find((item: { id: string }) => item.id === id).name, "Local");
  assert.equal((await app.inject("/api/model-presets")).json().items.find((item: { id: string }) => item.id === first.id).modelId, "model-000");
  const second = await preset(app, id, "Second");
  response = await save(app, id, changes, { confirmationToken: initialImpact.confirmationToken, name: "Changed" });
  assert.equal(response.statusCode, 409);
  const impact = response.json().selectionImpact as SelectionImpact;
  assert.equal(impact.total, 2);
  assert.notEqual(impact.confirmationToken, initialImpact.confirmationToken);
  assert.equal((await save(app, id, changes, { confirmationToken: impact.confirmationToken, name: "Changed" })).statusCode, 200);
  for (const linked of [first, second]) {
    const cleared = (await app.inject("/api/model-presets")).json().items.find((item: { id: string }) => item.id === linked.id);
    assert.equal(cleared.modelId, null);
    assert.equal(cleared.contextWindow, null);
    assert.equal(cleared.connectionId, id);
    assert.deepEqual(cleared.compaction, first.compaction);
    assert.equal(cleared.name, linked.name);
    assert.equal(cleared.updatedAt, linked.updatedAt);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/model-presets", payload: { name: "Stale", connectionId: id, modelId: "model-000" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/model-presets/${first.id}`, payload: { modelId: "model-000" } })).statusCode, 400);
  // Metadata and fixed-prompt testing remain available for unchecked models.
  assert.equal((await app.inject({ method: "PATCH", url: `/api/connections/${id}/models/model-000`, payload: { name: "Still editable" } })).statusCode, 200);
  assert.equal((await app.inject(`/api/connections/${id}/models/model-000`)).json().enabled, false);
  const tested = await app.inject({ method: "POST", url: `/api/connections/${id}/models/model-000/test` });
  assert.equal(tested.statusCode, 200, tested.body);
  assert.equal(tested.json().success, true);
});

test("confirmation preview is bounded and changes bind the token", async t => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false });
  t.after(() => app.close());
  const id = await setup(app);
  await save(app, id, []);
  for (let i = 0; i < 23; i++) await preset(app, id, `Preset ${i}`);
  const changes = [{ id: "model-000", enabled: false }];
  const impact = (await save(app, id, changes)).json().selectionImpact as SelectionImpact;
  assert.equal(impact.total, 23);
  assert.equal(impact.presets.length, 20);
  assert.equal((await save(app, id, [...changes, { id: "model-001", enabled: false }], { confirmationToken: impact.confirmationToken })).statusCode, 409);
});

test("invalid selection input and zero-model finalization never write partial state", async t => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false });
  t.after(() => app.close());
  const id = await setup(app);
  for (const changes of [null, {}, [{ id: "missing", enabled: true }], [{ id: "model-000", enabled: 1 }], [{ id: "model-000", enabled: true, other: 1 }], [{ id: "model-000", enabled: true }, { id: "model-000", enabled: false }], Array.from({ length: 5001 }, () => ({ id: "model-000", enabled: false }))]) {
    const result = await save(app, id, changes, { name: "Invalid" });
    assert.equal(result.statusCode, 400, result.body);
    assert.equal((await app.inject("/api/connections")).json().items.find((item: { id: string }) => item.id === id).name, "Local");
  }
  assert.equal((await save(app, id, (await selection(app, id)).map(model => ({ ...model, enabled: false })))).statusCode, 400);
  assert.equal((await app.inject("/api/connections")).json().items.find((item: { id: string }) => item.id === id).draft, true);
  const empty = await setup(app, 0);
  assert.equal((await save(app, empty, [])).statusCode, 400);
});

test("migration 8 and restart preserve selections, catalog refresh retains flags, large saves use a bounded route limit", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-model-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  const db = openDatabase(path);
  restoreOutputColumns(db);
  db.exec(`INSERT INTO connections (id, provider, name, draft, createdAt, updatedAt) VALUES ('old', 'ollama', 'Old', 0, 'created', 'updated');
    INSERT INTO provider_models (connectionId, id, name) VALUES ('old', 'old-model', 'Old model');
    ALTER TABLE provider_models DROP COLUMN enabled;
    PRAGMA user_version = 7;`);
  db.close();
  const fetcher: typeof fetch = async () => Response.json({ models: [] });
  let app = createApp({ databasePath: path, serveStatic: false, connections: { fetcher } });
  assert.deepEqual(await selection(app, "old"), [{ id: "old-model", enabled: true }]);
  const id = await setup(app, 2);
  await save(app, id, [{ id: "model-000", enabled: false }]);
  await app.inject({ method: "POST", url: `/api/connections/${id}/models/refresh` });
  assert.equal((await selection(app, id))[0]?.enabled, false);
  await app.close();
  app = createApp({ databasePath: path, serveStatic: false });
  t.after(() => app.close());
  assert.equal((await selection(app, id))[0]?.enabled, false);
  // Seed the bounded maximum directly, avoiding thousands of HTTP setup calls.
  const storage = openDatabase(path);
  const insert = storage.prepare("INSERT INTO provider_models (connectionId, id, name) VALUES (?, ?, ?)");
  const changes: ModelSelection[] = [];
  storage.transaction(() => {
    for (let i = 0; i < 4998; i++) {
      const modelId = `${i}-` + "long-id".repeat(20);
      insert.run(id, modelId, modelId);
      changes.push({ id: modelId, enabled: false });
    }
  })();
  storage.close();
  changes.push({ id: "model-000", enabled: false }, { id: "model-001", enabled: true });
  assert.equal(changes.length, 5000);
  assert.ok(JSON.stringify(changes).length > 32 * 1024);
  assert.equal((await save(app, id, changes)).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "x".repeat(40000) } })).statusCode, 413);
});

test("discovered models retain deselection and newly discovered models default to enabled", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec("INSERT INTO connections (id, provider, name, draft, createdAt, updatedAt) VALUES ('p', 'ollama', 'P', 1, 'created', 'updated')");
    const models = new ProviderModels(db);
    models.merge("p", [{ id: "old", name: "Old", contextWindow: 1000 }]);
    db.transaction(() => models.applySelection("p", [{ id: "old", enabled: false }], undefined, false))();
    models.merge("p", [{ id: "old", name: "Renamed", contextWindow: 2000 }, { id: "new", name: "New", contextWindow: null }]);
    assert.equal(models.get("p", "old")?.enabled, false);
    assert.equal(models.get("p", "old")?.name, "Renamed");
    assert.equal(models.get("p", "new")?.enabled, true);
    models.merge("p", []);
    assert.equal(models.get("p", "old")?.enabled, false);
    assert.equal(models.get("p", "old")?.available, false);
  } finally { db.close(); }
});
