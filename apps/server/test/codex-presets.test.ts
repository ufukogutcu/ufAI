import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { CodexRuntime } from "../src/codex-runtime.js";
import type { ModelPreset, ProviderModel, ProviderPresetOptions } from "../src/contracts.js";
import { openDatabase } from "../src/database.js";
import type { Triggers } from "../src/triggers.js";

const fixture = fileURLToPath(new URL("./fixtures/codex-preset-process.cjs", import.meta.url));
const catalogFixture = fileURLToPath(new URL("./fixtures/codex-catalog-process.cjs", import.meta.url));
const fast: ProviderPresetOptions = { provider: "codex", reasoningEffort: "ultra", serviceTier: "priority" };
const standard: ProviderPresetOptions = { provider: "codex", reasoningEffort: "medium", serviceTier: "default" };
const primary = {
  model: "first", displayName: "First",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced effort" },
    { reasoningEffort: "ultra", description: "Maximum reasoning" },
  ],
  serviceTiers: [{ id: "priority", name: "Fast", description: "Increased usage" }],
};
const secondary = {
  model: "second", displayName: "Second",
  supportedReasoningEfforts: [{ reasoningEffort: "minimal", description: "Lighter reasoning" }],
  serviceTiers: [],
};
const unknown = { model: "unknown", displayName: "Unknown" };

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ufai-codex-preset-"));
  const modelsPath = join(directory, "models.json");
  const turnsPath = join(directory, "turns.jsonl");
  const setModels = (models: unknown[]) => writeFile(modelsPath, JSON.stringify(models));
  await setModels([primary, secondary, unknown]);
  await writeFile(join(directory, "provider-catalog.json"), JSON.stringify({
    models: [primary, secondary, unknown].map(({ model }) => ({ slug: model, context_window: 160_000 })),
  }));
  const codex = new CodexRuntime(join(directory, "codex"),
    () => spawn(process.execPath, [fixture, modelsPath, turnsPath]),
    5000, 60_000,
    (_home, bundled) => spawn(process.execPath, [catalogFixture, directory, bundled ? "bundled" : "provider", "success"]),
  );
  const app = createApp({
    databasePath: join(directory, "app.sqlite"),
    filesRoot: join(directory, "files"),
    serveStatic: false,
    connections: { codex },
    execution: { autoStart: false },
    triggers: { autoStart: false },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, payload });
  const patch = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url, payload });
  const created = await post("/api/connections", { provider: "codex", name: "Subscription" });
  assert.equal(created.statusCode, 201, created.body);
  const connectionId = created.json().id as string;
  const connectionPath = `/api/connections/${connectionId}`;
  const refresh = async () => {
    const result = await post(`${connectionPath}/models/refresh`, {});
    assert.equal(result.statusCode, 200, result.body);
    return result.json<{ items: ProviderModel[] }>().items;
  };
  const models = await refresh();
  const finalized = await patch(connectionPath, { draft: false });
  assert.equal(finalized.statusCode, 200, finalized.body);
  const presets = "/api/model-presets";
  const createPreset = async (name: string, providerOptions: ProviderPresetOptions | null) => {
    const result = await post(presets, { name, connectionId, modelId: "first", providerOptions });
    assert.equal(result.statusCode, 201, result.body);
    return result.json<ModelPreset>();
  };
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const createAgent = async (name: string, presetId: string) => {
    const result = await post(`/api/workspaces/${workspace}/agents`, { name, presetId });
    assert.equal(result.statusCode, 201, result.body);
    return result.json().id as string;
  };
  const engine = app.getDecorator<Triggers>("triggers").execution;
  return { app, engine, post, patch, connectionId, connectionPath, models, refresh, presets, createPreset, createAgent, setModels, turnsPath };
}

test("preset duplication preserves saved configuration and keeps the original default", async (t) => {
  const { app, post, patch, connectionId, connectionPath, models, presets, createAgent } = await setup(t);
  const sourceResponse = await post(presets, {
    name: "Default Codex", isDefault: true, connectionId, modelId: "first",
    compaction: { mode: "percentage", value: 85 }, providerOptions: fast,
  });
  assert.equal(sourceResponse.statusCode, 201, sourceResponse.body);
  const source = sourceResponse.json<ModelPreset>();
  await createAgent("Existing agent", source.id);

  const response = await post(`${presets}/${source.id}/duplicate`, { name: "Codex copy" });
  assert.equal(response.statusCode, 201, response.body);
  const copy = response.json<ModelPreset>();
  assert.notEqual(copy.id, source.id);
  assert.deepEqual(copy, {
    ...source, name: "Codex copy", id: copy.id, isDefault: false,
    createdAt: copy.createdAt, updatedAt: copy.updatedAt,
  });
  assert.equal((await app.inject(`${presets}/default`)).json().preset.id, source.id);
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const agents = (await app.inject(`/api/workspaces/${workspace}/agents`)).json().items;
  assert.deepEqual(agents.map(({ presetId }: { presetId: string }) => presetId), [source.id]);
  assert.equal((await patch(`${presets}/${copy.id}`, { compaction: null })).statusCode, 200);
  assert.deepEqual((await app.inject(`${presets}/default`)).json().preset, source);
  assert.equal((await post(`${presets}/missing/duplicate`, { name: "Missing" })).statusCode, 404);
  assert.equal((await post(`${presets}/${source.id}/duplicate`, { name: "Other", isDefault: true })).statusCode, 400);

  const providerCopy = await post(`${connectionPath}/duplicate`, { name: "Catalog copy" });
  assert.equal(providerCopy.statusCode, 201, providerCopy.body);
  const catalog = (await app.inject(`/api/connections/${providerCopy.json().id}/models`)).json().items;
  assert.deepEqual(catalog, models.map(model => ({ ...model, connectionId: providerCopy.json().id })));
});

test("Codex model metadata controls which preset choices can be saved", async (t) => {
  const { app, post, patch, connectionId, connectionPath, models, refresh, presets, createPreset, createAgent, engine, setModels } =
    await setup(t);
  assert.deepEqual(models[0]?.presetCapabilities, {
    provider: "codex",
    reasoningEfforts: [{ id: "medium", description: "Balanced effort" }, { id: "ultra", description: "Maximum reasoning" }],
    serviceTiers: [{ id: "priority", name: "Fast", description: "Increased usage" }],
  });
  assert.equal(models.find(({ id }) => id === "unknown")?.presetCapabilities, undefined);
  const checkInvalid = async (overrides: Record<string, unknown>, field: string) => {
    const result = await post(presets, { name: "Invalid", connectionId, modelId: "first", providerOptions: fast, ...overrides });
    assert.equal(result.statusCode, 400, result.body);
    assert.ok(result.json().fields[field], result.body);
  };
  await checkInvalid({ modelId: "second" }, "providerOptions.reasoningEffort");
  await checkInvalid({ modelId: "unknown" }, "providerOptions.serviceTier");
  await checkInvalid({ modelId: null }, "providerOptions");
  await checkInvalid({ connectionId: null }, "providerOptions");
  await checkInvalid({ providerOptions: { ...fast, serviceTier: true } }, "providerOptions.serviceTier");
  const other = (await post("/api/connections", { provider: "ollama", name: "Local" })).json();
  const otherPath = `/api/connections/${other.id}`;
  assert.equal((await post(`${otherPath}/models`, { id: "first" })).statusCode, 201);
  assert.equal((await patch(otherPath, { draft: false })).statusCode, 200);
  await checkInvalid({ connectionId: other.id }, "providerOptions");

  const saved = await createPreset("Fast", fast);
  const url = `${presets}/${saved.id}`;
  const agent = await createAgent("Agent", saved.id);
  const renamed = await patch(url, { name: "Renamed" });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.deepEqual(renamed.json().providerOptions, fast);

  await setModels([{ model: "first", serviceTiers: primary.serviceTiers }, secondary]);
  assert.deepEqual((await refresh()).find(({ id }) => id === "first")?.presetCapabilities, models[0]?.presetCapabilities);
  await setModels([{ ...primary, serviceTiers: [] }, secondary]);
  await refresh();
  const list = await app.inject(presets);
  assert.deepEqual(list.json().items.find(({ id }: ModelPreset) => id === saved.id).providerOptions, fast);
  assert.equal((await patch(url, { providerOptions: fast })).statusCode, 400);
  assert.equal((await patch(url, { name: "Still editable" })).statusCode, 200);
  const receipt = engine.submit(agent, "new", "Check configuration", "invalid_codex_options");
  await engine.pump();
  assert.equal(engine.task(receipt.taskId!).status, "blocked");
  assert.match(engine.task(receipt.taskId!).error ?? "", /no longer offers/);
  assert.equal((await patch(url, { providerOptions: null })).json().providerOptions, null);

  await setModels([primary, secondary]);
  await refresh();
  assert.deepEqual((await patch(url, { providerOptions: standard })).json().providerOptions, standard);
  assert.equal((await patch(url, { modelId: "second" })).json().providerOptions, null);
  assert.equal((await patch(url, { modelId: "first", providerOptions: fast })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `${connectionPath}/models/first` })).statusCode, 204);
  assert.equal((await patch(url, { name: "Unlinked model" })).json().providerOptions, null);
  const minimal = { provider: "codex", reasoningEffort: "minimal" };
  assert.equal((await patch(url, { modelId: "second", providerOptions: minimal })).statusCode, 200);
  const selection = { modelSelection: [{ id: "second", enabled: false }] };
  const confirm = await patch(connectionPath, selection);
  assert.equal(confirm.statusCode, 409, confirm.body);
  assert.equal((await patch(connectionPath, {
    ...selection, confirmationToken: confirm.json().selectionImpact.confirmationToken,
  })).statusCode, 200);
  assert.equal((await patch(url, { name: "Deselected model" })).json().providerOptions, null);
  assert.equal((await patch(connectionPath, { modelSelection: [{ id: "second", enabled: true }] })).statusCode, 200);
  assert.equal((await patch(url, { modelId: "second", providerOptions: minimal })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: connectionPath })).statusCode, 204);
  assert.equal((await patch(url, { name: "Unlinked Provider" })).json().providerOptions, null);
});

test("Tasks and Chat use their own Codex turn options while maintenance inherits defaults", async (t) => {
  const { engine, createPreset, createAgent, patch, presets, turnsPath, connectionId } = await setup(t);
  const taskPreset = await createPreset("Fast Tasks", fast);
  const chatPreset = await createPreset("Standard Chat", standard);
  const taskAgent = await createAgent("Task Agent", taskPreset.id);
  const chatAgent = await createAgent("Chat Agent", chatPreset.id);
  const customAgent = await createAgent("Custom Agent", taskPreset.id);
  const invalid = await patch(`/api/agents/${customAgent}`, {
    customConfiguration: { connectionId, modelId: "second", providerOptions: fast },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.ok(invalid.json().fields["customConfiguration.providerOptions.reasoningEffort"]);
  const detached = await patch(`/api/agents/${customAgent}`, {
    customConfiguration: { connectionId, modelId: "first", providerOptions: fast },
  });
  assert.equal(detached.statusCode, 200, detached.body);
  assert.equal(detached.json().presetId, null);
  const task = engine.submit(taskAgent, "new", "Hello", "codex_preset_task");
  const chat = engine.submit(chatAgent, "chat", "Hello", "codex_preset_chat");
  const wait = async (ids: string[]) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      await engine.pump();
      const states = ids.map((id) => engine.task(id).status);
      assert.ok(states.every((status) => !["failed", "blocked", "awaiting_user"].includes(status)),
        JSON.stringify(ids.map((id) => engine.task(id))));
      if (states.every((status) => status === "completed")) return;
      await delay(10);
    }
    assert.fail("Timed out waiting for Codex turns.");
  };
  await wait([task.taskId!, chat.taskId!]);
  assert.equal((await patch(`${presets}/${taskPreset.id}`, { providerOptions: null })).statusCode, 200);
  const later = engine.submit(taskAgent, "new", "Run with defaults", "codex_preset_later");
  const custom = engine.submit(customAgent, "chat", "Use my settings", "codex_custom_chat");
  await wait([later.taskId!, custom.taskId!]);
  const calls = (await readFile(turnsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.filter(({ purpose }) => purpose === "task"), [
    { purpose: "task", effort: "ultra", serviceTierForTurn: "priority" },
    { purpose: "task" },
  ]);
  assert.deepEqual(calls.filter(({ purpose }) => purpose === "chat"), [
    { purpose: "chat", effort: "medium", serviceTierForTurn: "default" },
    { purpose: "chat", effort: "ultra", serviceTierForTurn: "priority" },
  ]);
  assert.deepEqual(calls.filter(({ purpose }) => purpose === "maintenance"), [
    { purpose: "maintenance" }, { purpose: "maintenance" }, { purpose: "maintenance" }, { purpose: "maintenance" },
  ]);
});

test("v42 migration preserves existing Codex presets and models with defaults", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-codex-preset-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "test.sqlite");
  const legacy = openDatabase(path);
  legacy.exec(`
    ALTER TABLE model_presets DROP COLUMN providerOptions;
    ALTER TABLE provider_models DROP COLUMN presetCapabilities;
    INSERT INTO connections(id, provider, name, draft, createdAt, updatedAt)
      VALUES ('c', 'codex', 'Provider', 0, 'created', 'updated');
    INSERT INTO provider_models(connectionId, id, name, discoveredContextWindow)
      VALUES ('c', 'm', 'Model', 50000);
    INSERT INTO model_presets(id, name, connectionId, modelId, compactionMode, compactionValue, isDefault, createdAt, updatedAt)
      VALUES ('p', 'Preset', 'c', 'm', 'tokens', 24000, 1, 'created', 'updated');
    PRAGMA user_version = 42;
  `);
  legacy.close();
  const app = createApp({ databasePath: path, serveStatic: false, execution: { autoStart: false } });
  try {
    const { preset } = (await app.inject("/api/model-presets/default")).json();
    assert.equal(preset.id, "p");
    assert.equal(preset.modelId, "m");
    assert.equal(preset.contextWindow, 50000);
    assert.deepEqual(preset.compaction, { mode: "tokens", value: 24000 });
    assert.equal(preset.updatedAt, "updated");
    assert.equal(preset.providerOptions, null);
    assert.equal((await app.inject("/api/connections/c/models/m")).json().presetCapabilities, undefined);
    const db = openDatabase(path);
    try {
      assert.equal(db.pragma("user_version", { simple: true }), 46);
    } finally { db.close(); }
  } finally { await app.close(); }
});
