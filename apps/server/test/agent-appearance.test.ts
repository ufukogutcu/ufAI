import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allAppearances, appearanceCandidates, appearanceKey, generateAppearance, validateAppearance, type AppearanceCount } from "../src/agent-appearance.js";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import type { Agent } from "../src/contracts.js";
import { removeChat, removeCharacters } from "./legacy-schema.js";

test("384 canonical choices preserve accessory-count probabilities and penalize similar identities", () => {
  const candidates = appearanceCandidates([]);
  assert.equal(candidates.length, 384);
  assert.equal(new Set(allAppearances.map(appearanceKey)).size, 384);
  const total = candidates.reduce((sum, item) => sum + item.weight, 0);
  for (const [count, expected] of [0.1, 0.4, 0.35, 0.12, 0.03].entries()) {
    const sum = candidates.filter(item => item.appearance.accessories.length === count).reduce((sum, item) => sum + item.weight, 0);
    assert.ok(Math.abs(sum / total - expected) < 1e-12);
  }
  assert.deepEqual(validateAppearance({ kind: "droplet", color: "sage", accessories: ["badge", "glasses"] }), { kind: "droplet", color: "sage", accessories: ["glasses", "badge"] });
  const used = [{ appearance: { kind: "droplet", color: "sage", accessories: ["glasses"] } as const, count: 1 }];
  const weighted = appearanceCandidates(used as unknown as AppearanceCount[]);
  assert.equal(weighted.length, 383);
  const weight = (kind: string, color: string) => weighted.find(item => item.appearance.kind === kind && item.appearance.color === color && item.appearance.accessories.join() === "cap")!.weight;
  assert.ok(weight("droplet", "sage") < weight("droplet", "sky"));
  assert.ok(weight("droplet", "sky") < weight("bot", "sky"));
  const repeatedSet = weighted.find(item => item.appearance.kind === "bot" && item.appearance.color === "sky" && item.appearance.accessories.join() === "glasses")!;
  assert.ok(repeatedSet.weight < weight("bot", "sky"));
});

test("allocation reaches the last unused choice and exhaustion reuses only the least-used combinations", () => {
  const used: AppearanceCount[] = [];
  let seed = 42;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let index = 0; index < 384; index++) {
    const appearance = generateAppearance(used, random);
    assert.ok(!used.some(item => appearanceKey(item.appearance) === appearanceKey(appearance)));
    used.push({ appearance, count: 1 });
  }
  assert.equal(appearanceCandidates(used.slice(0, -1)).length, 1);
  used[0]!.count = 2;
  assert.equal(appearanceCandidates(used).length, 383);
  assert.notEqual(appearanceKey(generateAppearance(used, () => 0)), appearanceKey(used[0]!.appearance));
});

test("agent appearance API isolates workspaces, permits manual duplicates and preserves unrelated fields", async t => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false, execution: { autoStart: false } });
  t.after(() => app.close());
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const other = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Other" } })).json().id;
  const create = async (workspaceId: string, payload: object) => app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/agents`, payload });
  const manual = { kind: "droplet", color: "sage", accessories: ["glasses"] };
  const first = (await create(workspace, { name: "First", instructions: "Keep role", ...{ appearance: manual } })).json<Agent>();
  assert.equal(first.runningTaskCount, 0);
  assert.equal((await app.inject(`/api/agents/${first.id}`)).json().runningTaskCount, 0);
  assert.equal((await app.inject(`/api/workspaces/${workspace}/agents`)).json().items[0].runningTaskCount, 0);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/agents/${first.id}`, payload: { runningTaskCount: 9 } })).statusCode, 400);
  assert.deepEqual(first.appearance, manual);
  assert.deepEqual((await create(workspace, { name: "Duplicate", appearance: manual })).json().appearance, manual);
  assert.deepEqual((await create(other, { name: "Cross workspace", appearance: manual })).json().appearance, manual);
  const firstChoice = { kind: "pebble", color: "sage", accessories: [] };
  await create(other, { name: "Other workspace only", appearance: firstChoice });
  const random = t.mock.method(Math, "random", () => 0);
  const isolated = (await create(workspace, { name: "Workspace-specific automatic choice" })).json<Agent>();
  random.mock.restore();
  assert.deepEqual(isolated.appearance, firstChoice);
  for (let index = 0; index < 20; index++) {
    const response = await create(workspace, { name: `Auto ${index}` });
    assert.equal(response.statusCode, 201, response.body);
    assert.notDeepEqual(response.json().appearance, manual);
  }
  const suggestion = (await app.inject(`/api/workspaces/${workspace}/agents/appearance-suggestion`)).json().appearance;
  const saved = (await create(workspace, { name: "Suggested", appearance: suggestion })).json<Agent>();
  assert.deepEqual(saved.appearance, suggestion);
  const updated = (await app.inject({ method: "PATCH", url: `/api/agents/${first.id}`, payload: { appearance: { ...manual, accessories: ["badge", "cap"] } } })).json<Agent>();
  assert.equal(updated.revision, first.revision);
  assert.equal(updated.instructions, "Keep role");
  assert.equal(updated.presetId, first.presetId);
  assert.deepEqual(updated.appearance.accessories, ["cap", "badge"]);
  const renamed = (await app.inject({ method: "PATCH", url: `/api/agents/${first.id}`, payload: { name: "New name" } })).json<Agent>();
  assert.deepEqual(renamed.appearance, updated.appearance);
  for (const appearance of [null, {}, { ...manual, kind: "other" }, { ...manual, color: "other" }, { ...manual, accessories: ["bad"] }, { ...manual, accessories: ["cap", "cap"] }, { ...manual, extra: true }]) {
    const response = await create(workspace, { name: "Invalid", appearance });
    assert.equal(response.statusCode, 400, response.body);
    assert.ok(response.json().fields.appearance);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/agents/${first.id}`, payload: { appearance } })).statusCode, 400);
  }
  assert.equal((await app.inject("/api/workspaces/missing/agents/appearance-suggestion")).statusCode, 404);
  const cluster = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/clusters`, payload: { name: "Boundary", x: 0, y: 0, width: 320, height: 200 } })).json();
  const boundary = await create(workspace, { name: "At content edge", x: -72, y: -48, clusterId: cluster.id });
  assert.equal(boundary.statusCode, 201, boundary.body);
  assert.equal((await create(workspace, { name: "Beyond right edge", x: 249, y: 0, clusterId: cluster.id })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/agents/${boundary.json().id}`, payload: { y: 105 } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/clusters/${cluster.id}`, payload: { x: 100, y: 100 } })).statusCode, 200);
  const moved = (await app.inject(`/api/agents/${boundary.json().id}`)).json<Agent>();
  assert.deepEqual([moved.x, moved.y, moved.clusterId], [28, 52, cluster.id]);
  const initial = (await app.inject("/api/settings")).json();
  assert.equal(initial.settings.characterAnimationsPaused, false);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { characterAnimationsPaused: true } })).json().settings.characterAnimationsPaused, true);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { characterAnimationsPaused: "true" } })).statusCode, 400);
});

test("migration backfills durable distinct appearances while preserving centers, memberships and work", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ufai-characters-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "upgrade.sqlite");
  let db = openDatabase(path);
  const workspace = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
  removeCharacters(db);
  db.pragma("user_version = 15");
  db.prepare("INSERT INTO clusters(id,workspaceId,name,x,y,width,height,colorSlot,createdAt,updatedAt) VALUES ('group',?,'Group',0,0,600,360,0,'then','then')").run(workspace);
  const insert = db.prepare("INSERT INTO agents(id,workspaceId,name,instructions,clusterId,x,y,revision,createdAt,updatedAt) VALUES (?,?,'Agent','Keep instructions','group',100,100,7,'then','then')");
  for (let index = 0; index < 4; index++) insert.run(`agent-${index}`, workspace);
  db.exec(`INSERT INTO conversations(id,agentId,kind,createdAt) VALUES ('conversation','agent-0','task','then');
    INSERT INTO agent_tasks(id,agentId,conversationId,title,status,createdAt,updatedAt) VALUES ('task','agent-0','conversation','Keep task','queued','then','then');
    INSERT INTO agent_turns(id,taskId,conversationId,agentId,inputMessageId,attempt,status,snapshot,createdAt,updatedAt) VALUES ('turn','task','conversation','agent-0','message',1,'queued','{"keep":true}','then','then');`);
  db.close(); db = openDatabase(path);
  const agents = db.prepare("SELECT * FROM agents ORDER BY id").all() as any[];
  assert.equal(db.pragma("user_version", { simple: true }), 19);
  assert.equal(new Set(agents.map(agent => appearanceKey(JSON.parse(agent.appearance)))).size, 4);
  for (const agent of agents) {
    assert.equal(agent.x + 144 / 2, 100 + 224 / 2);
    assert.equal(agent.y + 192 / 2, 100 + 104 / 2);
    assert.equal(agent.clusterId, "group"); assert.equal(agent.revision, 7);
    assert.equal(agent.instructions, "Keep instructions"); assert.equal(agent.updatedAt, "then");
  }
  assert.equal((db.prepare("SELECT snapshot FROM agent_turns WHERE id='turn'").get() as any).snapshot, '{"keep":true}');
  assert.equal((db.prepare("SELECT status FROM agent_tasks WHERE id='task'").get() as any).status, "queued");
  const stored = agents.map(agent => agent.appearance);
  db.close(); db = openDatabase(path);
  assert.deepEqual((db.prepare("SELECT appearance FROM agents ORDER BY id").all() as any[]).map(agent => agent.appearance), stored);
  db.close();
});

test("compact geometry upgrades version 16 once, preserving metadata and clamping coordinate limits", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ufai-compact-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "upgrade.sqlite");
  let db = openDatabase(path);
  const workspace = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
  db.prepare("INSERT INTO clusters(id,workspaceId,name,x,y,width,height,colorSlot,createdAt,updatedAt) VALUES ('group',?,'Group',0,0,320,200,0,'then','then')").run(workspace);
  const insert = db.prepare("INSERT INTO agents(id,workspaceId,name,clusterId,x,y,revision,createdAt,updatedAt) VALUES (?,?,'Agent',?,?,0,7,'then','then')");
  for (const [id, x, clusterId] of [["left-edge", -104, "group"], ["right-edge", 216, "group"], ["upper-limit", 1e6, null], ["lower-limit", -1e6, null]] as const)
    insert.run(id, workspace, clusterId, x);
  const before = db.prepare("SELECT * FROM agents ORDER BY id").all() as any[];
  removeChat(db);
  db.pragma("user_version = 16");
  db.close(); db = openDatabase(path);
  const after = db.prepare("SELECT * FROM agents ORDER BY id").all() as any[];
  assert.equal(db.pragma("user_version", { simple: true }), 19);
  for (let i = 0; i < before.length; i++) {
    const expectedX = Math.min(1e6, before[i].x + 32);
    assert.deepEqual(after[i], { ...before[i], x: expectedX });
    if (before[i].id !== "upper-limit") assert.equal(after[i].x + 72, before[i].x + 104);
  }
  db.close(); db = openDatabase(path);
  assert.deepEqual(db.prepare("SELECT * FROM agents ORDER BY id").all(), after);
  db.close();
});
