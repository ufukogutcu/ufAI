import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.js";
import type { Agent, AgentModelConfiguration, ModelPreset, SelectionImpact } from "../src/contracts.js";
import type { Triggers } from "../src/triggers.js";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ufai-agent-configuration-"));
  const options = {
    databasePath: join(directory, "app.sqlite"), filesRoot: join(directory, "files"),
    serveStatic: false, execution: { autoStart: false }, triggers: { autoStart: false },
  };
  let app = createApp(options);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const write = (method: "POST" | "PATCH", url: string, payload: object) => app.inject({ method, url, payload });
  const post = (url: string, payload: object) => write("POST", url, payload);
  const patch = (url: string, payload: object) => write("PATCH", url, payload);
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const provider = (await post("/api/connections", { provider: "ollama", name: "Local" })).json();
  const providerUrl = `/api/connections/${provider.id}`;
  for (const id of ["first", "second"]) {
    const model = await post(`${providerUrl}/models`, { id, contextWindowOverride: 32_000 });
    assert.equal(model.statusCode, 201, model.body);
  }
  assert.equal((await patch(providerUrl, { draft: false })).statusCode, 200);
  const config: AgentModelConfiguration = {
    connectionId: provider.id, modelId: "first", compaction: { mode: "percentage", value: 75 }, providerOptions: null,
  };
  const create = async (name: string) => {
    const result = await post(`/api/workspaces/${workspace}/agents`, { name });
    assert.equal(result.statusCode, 201, result.body);
    return result.json<Agent>();
  };
  const read = async (id: string) => (await app.inject(`/api/agents/${id}`)).json<Agent>();
  return { get app() { return app; }, get services() { return app.getDecorator<Triggers>("triggers"); },
    patch, post, read, create, config, providerUrl, workspace,
    async restart() { await app.close(); app = createApp(options); await app.ready(); },
  };
}

test("detaching an agent saves its own model configuration through restart, preset deletion and relinking", async t => {
  const s = await setup(t);
  const preset = (await s.post("/api/model-presets", { name: "Default", isDefault: true, ...s.config })).json<ModelPreset>();
  const other = (await s.post("/api/model-presets", { name: "Other" })).json<ModelPreset>();
  const original = await s.create("Customize me");
  const linked = await s.create("Follow the preset");
  assert.equal(original.presetId, preset.id);
  assert.equal(original.customConfiguration, null);
  const url = `/api/agents/${original.id}`, presetUrl = `/api/model-presets/${preset.id}`;
  const before = s.services.connections.snapshot(original);
  const configuration = { ...s.config, compaction: { mode: "tokens", value: 16_000 } };
  const both = await s.patch(url, { presetId: preset.id, customConfiguration: configuration });
  assert.equal(both.statusCode, 400);
  const invalid = await s.patch(url, { customConfiguration: { ...configuration, modelId: "unknown" } });
  assert.equal(invalid.statusCode, 400);
  assert.ok(invalid.json().fields["customConfiguration.modelId"]);
  assert.equal((await s.read(original.id)).revision, original.revision);
  const response = await s.patch(url, { expectedRevision: original.revision, customConfiguration: configuration });
  assert.equal(response.statusCode, 200, response.body);
  const detached = response.json<Agent>();
  assert.equal(detached.presetId, null);
  assert.deepEqual(detached.customConfiguration, configuration);
  assert.equal(detached.revision, original.revision + 1);
  assert.equal(detached.issueCounts.warning, 0);
  assert.equal((await s.patch(url, { name: "Stale", expectedRevision: original.revision })).statusCode, 409);
  assert.deepEqual((await s.patch(url, { instructions: "Keep the configuration" })).json<Agent>().customConfiguration, configuration);
  assert.equal((await s.patch(presetUrl, { modelId: "second" })).statusCode, 200);
  assert.equal((await s.app.inject(presetUrl)).json<ModelPreset>().modelId, "second");
  assert.equal(s.services.connections.snapshot(await s.read(linked.id)).modelId, "second");
  assert.equal(before.modelId, "first");
  assert.equal((await s.app.inject({ method: "DELETE", url: presetUrl })).statusCode, 204);
  assert.equal((await s.app.inject(presetUrl)).statusCode, 404);
  assert.equal((await s.read(linked.id)).presetId, null);
  await s.restart();
  const saved = await s.read(original.id);
  assert.deepEqual(saved.customConfiguration, configuration);
  const snapshot = s.services.connections.snapshot(saved);
  assert.equal(snapshot.presetId, null);
  assert.equal(snapshot.modelId, "first");
  assert.deepEqual(snapshot.compaction, configuration.compaction);
  const relinked = (await s.patch(url, { presetId: other.id })).json<Agent>();
  assert.equal(relinked.presetId, other.id);
  assert.equal(relinked.customConfiguration, null);
  const cleared = (await s.patch(url, { presetId: null, customConfiguration: null })).json<Agent>();
  assert.equal(cleared.presetId, null);
  assert.equal(cleared.customConfiguration, null);
});

test("Provider model deselection confirms and repairs custom settings, and Provider removal preserves compaction", async t => {
  const s = await setup(t);
  const agent = await s.create("Custom");
  const agentUrl = `/api/agents/${agent.id}`;
  const detached = (await s.patch(agentUrl, { customConfiguration: s.config })).json<Agent>();
  const selection = { modelSelection: [{ id: "first", enabled: false }] };
  const confirmation = await s.patch(s.providerUrl, selection);
  assert.equal(confirmation.statusCode, 409, confirmation.body);
  const impact = confirmation.json<{ selectionImpact: SelectionImpact }>().selectionImpact;
  assert.equal(impact.total, 0);
  assert.equal(impact.agentTotal, 1);
  assert.deepEqual(impact.agents, [{ id: agent.id, name: "Custom", workspaceName: "Default workspace" }]);
  assert.equal((await s.read(agent.id)).customConfiguration?.modelId, "first");
  const changed = await s.patch(s.providerUrl, { ...selection, confirmationToken: impact.confirmationToken });
  assert.equal(changed.statusCode, 200, changed.body);
  const current = await s.read(agent.id);
  assert.equal(current.revision, detached.revision + 1);
  assert.deepEqual(current.customConfiguration, { ...s.config, modelId: null });
  const issues = (await s.app.inject(`${agentUrl}/issues?severity=warning`)).json().items;
  assert.equal(issues[0].id, "missing-model");
  assert.match(issues[0].message, /Details/);
  assert.ok(s.services.db.prepare("SELECT 1 FROM execution_events WHERE workspaceId=? AND kind='issues'").get(s.workspace));
  assert.equal((await s.app.inject({ method: "DELETE", url: s.providerUrl })).statusCode, 204);
  const removed = await s.read(agent.id);
  assert.deepEqual(removed.customConfiguration, { ...s.config, modelId: null, connectionId: null });
  assert.equal(removed.revision, current.revision + 1);
});

test("a version 44 database keeps existing preset links when it gains custom agent settings", async t => {
  const s = await setup(t);
  const preset = (await s.post("/api/model-presets", { name: "Default", isDefault: true, ...s.config })).json<ModelPreset>();
  const agent = await s.create("Existing");
  s.services.db.exec("DROP TABLE agent_model_configurations; PRAGMA user_version=44");
  await s.restart();
  assert.equal(s.services.db.pragma("user_version", { simple: true }), 47);
  const upgraded = await s.read(agent.id);
  assert.equal(upgraded.presetId, preset.id);
  assert.equal(upgraded.revision, agent.revision);
  assert.equal(upgraded.customConfiguration, null);
  const saved = await s.patch(`/api/agents/${agent.id}`, { expectedRevision: agent.revision, customConfiguration: s.config });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json<Agent>().customConfiguration, s.config);
});
