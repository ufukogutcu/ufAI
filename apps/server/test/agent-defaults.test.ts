import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { removePresetDefault } from "./legacy-schema.js";
import type { Agent, ModelPreset } from "../src/contracts.js";

test("optional preset default is unique, validated, transactional, and independent of pagination", async (t) => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false, execution: { autoStart: false } });
  t.after(() => app.close());
  const post = async (payload: object) => app.inject({ method: "POST", url: "/api/model-presets", payload });
  const patch = async (id: string, payload: object) => app.inject({ method: "PATCH", url: `/api/model-presets/${id}`, payload });
  assert.deepEqual((await app.inject("/api/model-presets/default")).json(), { preset: null });
  const first = (await post({ name: "First", isDefault: true })).json<ModelPreset>();
  assert.equal(first.isDefault, true);
  for (const value of [null, 0, 1, "true", {}, []]) {
    const invalid = await post({ name: "Invalid", isDefault: value });
    assert.equal(invalid.statusCode, 400);
    assert.ok(invalid.json().fields.isDefault);
  }
  const second = (await post({ name: "Second" })).json<ModelPreset>();
  assert.equal(second.isDefault, false);
  assert.equal((await patch(first.id, { name: "Still default" })).json().isDefault, true);
  assert.equal((await patch(second.id, { isDefault: true, connectionId: "missing" })).statusCode, 400);
  assert.equal((await app.inject("/api/model-presets/default")).json().preset.id, first.id);
  const selected = (await patch(second.id, { isDefault: true })).json<ModelPreset>();
  const page = (await app.inject("/api/model-presets?limit=1")).json();
  assert.equal(page.items[0].id, first.id);
  assert.equal(page.items[0].isDefault, false);
  assert.deepEqual((await app.inject("/api/model-presets/default")).json().preset, selected);
  await patch(second.id, { isDefault: false });
  assert.deepEqual((await app.inject("/api/model-presets/default")).json(), { preset: null });
  await patch(first.id, { isDefault: true });
  await app.inject({ method: "DELETE", url: `/api/model-presets/${first.id}` });
  assert.deepEqual((await app.inject("/api/model-presets/default")).json(), { preset: null });
});

test("name-only creation uses the default only when presetId is omitted and configuration preserves instructions", async (t) => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false, execution: { autoStart: true } });
  t.after(() => app.close());
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const create = async (payload: object) => {
    const response = await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/agents`, payload });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<Agent>();
  };
  const first = await create({ name: "Name only" });
  assert.equal(first.instructions, "");
  assert.equal(first.presetId, null);
  const preset = (await app.inject({ method: "POST", url: "/api/model-presets", payload: { name: "Default", isDefault: true } })).json<ModelPreset>();
  const implicit = await create({ name: "Automatic" });
  assert.equal(implicit.presetId, preset.id);
  assert.equal((await create({ name: "Empty", presetId: null })).presetId, null);
  const other = (await app.inject({ method: "POST", url: "/api/model-presets", payload: { name: "Other" } })).json<ModelPreset>();
  assert.equal((await create({ name: "Explicit", presetId: other.id })).presetId, other.id);
  await app.inject({ method: "PATCH", url: `/api/agents/${first.id}`, payload: { instructions: "Keep this role" } });
  const updated = (await app.inject({ method: "PATCH", url: `/api/agents/${first.id}`, payload: { name: "Renamed", presetId: null } })).json<Agent>();
  assert.equal(updated.instructions, "Keep this role");
  assert.equal(updated.presetId, null);
  await app.inject({ method: "PATCH", url: `/api/model-presets/${other.id}`, payload: { isDefault: true } });
  assert.equal((await app.inject(`/api/agents/${implicit.id}`)).json().presetId, preset.id);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/agents/${first.id}`, payload: { name: "Again" } })).json().presetId, null);
  const blocked = (await app.inject({ method: "POST", url: `/api/agents/${first.id}/tasks`, payload: { content: "Work", requestId: "blocked_default_test" } }));
  assert.equal(blocked.statusCode, 202, blocked.body);
  const taskId = blocked.json().taskId;
  let detail: any;
  for (let i = 0; i < 100; i++) {
    detail = (await app.inject(`/api/tasks/${taskId}`)).json();
    if (detail.task.status === "blocked") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(detail.task.status, "blocked");
  assert.match(detail.task.error, /complete Agent Preset/);
});

test("v14 upgrade preserves presets, agents and settings, seeds no default and retains later choices across reopening", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-default-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "app.sqlite");
  let db = openDatabase(path);
  const workspace = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.exec("INSERT INTO model_presets(id,name,createdAt,updatedAt) VALUES ('p','Saved','created','updated')");
  db.prepare("INSERT INTO agents(id,workspaceId,name,instructions,presetId,createdAt,updatedAt) VALUES ('a',?,'Agent','Saved instructions','p','created','updated')").run(workspace);
  db.exec("UPDATE app_settings SET activeThemeId='dark-mode'");
  const agent = db.prepare("SELECT * FROM agents").get();
  const settings = db.prepare("SELECT * FROM app_settings").get();
  removePresetDefault(db);
  const preset = db.prepare("SELECT * FROM model_presets").get() as object;
  db.pragma("user_version = 14");
  db.close();
  db = openDatabase(path);
  try {
    assert.equal(db.pragma("user_version", { simple: true }), 15);
    assert.deepEqual(db.prepare("SELECT * FROM model_presets").get(), { ...preset, isDefault: 0 });
    assert.deepEqual(db.prepare("SELECT * FROM agents").get(), agent);
    assert.deepEqual(db.prepare("SELECT * FROM app_settings").get(), settings);
    db.exec("UPDATE model_presets SET isDefault=1 WHERE id='p'");
    assert.throws(() => db.exec("INSERT INTO model_presets(id,name,isDefault,createdAt,updatedAt) VALUES ('other','Other',1,'now','now')"), /UNIQUE/);
    assert.throws(() => db.exec("UPDATE model_presets SET isDefault=2"), /CHECK/);
  } finally { db.close(); }
  db = openDatabase(path);
  try { assert.equal((db.prepare("SELECT id FROM model_presets WHERE isDefault=1").get() as { id: string }).id, "p"); }
  finally { db.close(); }
});
