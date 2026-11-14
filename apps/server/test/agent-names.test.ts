import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { agentFirstNames, agentNameKey, generateAgentName } from "../src/agent-names.js";
import type { Agent } from "../src/contracts.js";

const conflict = "Another agent in this workspace already uses this name. Choose a different name.";

test("name keys preserve accents and internal spaces; suggestions exhaust unused first names before suffixes", () => {
  assert.equal(agentNameKey("  JOSE\u0301  "), agentNameKey("José"));
  assert.notEqual(agentNameKey("Jose"), agentNameKey("José"));
  assert.notEqual(agentNameKey("Alex  Smith"), agentNameKey("Alex Smith"));
  assert.equal(new Set(agentFirstNames.map(agentNameKey)).size, agentFirstNames.length);
  const used = new Set<string>();
  for (let index = 0; index < agentFirstNames.length; index++) {
    const suggestion = generateAgentName(used, () => 0);
    assert.ok(agentFirstNames.includes(suggestion as typeof agentFirstNames[number]));
    assert.ok(!used.has(agentNameKey(suggestion)));
    used.add(agentNameKey(suggestion));
  }
  assert.equal(generateAgentName(used, () => 0), "Alex 2");
  used.add(agentNameKey(" ALEX 2 "));
  assert.equal(generateAgentName(used, () => 0), "Alex 3");
});

test("agent creation and configuration enforce workspace name uniqueness atomically", async t => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false, execution: { autoStart: false } });
  t.after(() => app.close());
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const other = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Other" } })).json().id;
  const create = (name: string, workspaceId = workspace) => app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/agents`, payload: { name } });
  const first = (await create("  Alex  ")).json<Agent>();
  assert.equal(first.name, "Alex");
  for (const name of ["Alex", "alex", " ALEX "]) {
    const response = await create(name);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().fields.name, conflict);
  }
  assert.equal((await create("alex", other)).statusCode, 201);
  assert.equal((await create("José")).statusCode, 201);
  assert.equal((await create("JOSE\u0301")).statusCode, 400);
  assert.equal((await create("Jose")).statusCode, 201);
  const second = (await create("Maya")).json<Agent>();
  const rejected = await app.inject({ method: "PATCH", url: `/api/agents/${second.id}`,
    payload: { name: "aLeX", instructions: "Must not save", x: 42, expectedRevision: second.revision } });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().fields.name, conflict);
  assert.deepEqual((await app.inject(`/api/agents/${second.id}`)).json(), second);
  const own = await app.inject({ method: "PATCH", url: `/api/agents/${first.id}`, payload: { name: " ALEX ", instructions: "Keep role" } });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().name, "ALEX");
  const concurrent = await Promise.all([create("Sam"), create(" SAM ")]);
  assert.deepEqual(concurrent.map(response => response.statusCode).sort(), [201, 400]);
  assert.equal((await app.inject(`/api/workspaces/${workspace}/agents`)).json().total, 5);
  for (const name of ["", " ", "a".repeat(121)]) assert.equal((await create(name)).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/agents`, payload: {} })).statusCode, 400);
});

test("existing duplicates survive reopening; configuration requires manual resolution without blocking other updates", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-agent-names-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "app.sqlite");
  let db = openDatabase(path);
  const workspace = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  const insert = db.prepare("INSERT INTO agents(id,workspaceId,name,instructions,createdAt,updatedAt) VALUES (?,?,?,'Saved role','then','then')");
  insert.run("first", workspace, "Alex");
  insert.run("second", workspace, " alex ");
  const before = db.prepare("SELECT * FROM agents ORDER BY id").all();
  db.close();
  db = openDatabase(path);
  assert.deepEqual(db.prepare("SELECT * FROM agents ORDER BY id").all(), before);
  db.close();
  const app = createApp({ databasePath: path, serveStatic: false, execution: { autoStart: false } });
  t.after(() => app.close());
  const patch = (id: string, payload: object) => app.inject({ method: "PATCH", url: `/api/agents/${id}`, payload });
  for (const payload of [{ name: "Alex" }, { instructions: "Change role" }, { presetId: null }]) {
    const response = await patch("first", payload);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().fields.name, conflict);
  }
  assert.equal((await app.inject("/api/agents/first")).json().instructions, "Saved role");
  assert.equal((await patch("first", { x: 20, y: 30 })).statusCode, 200);
  assert.equal((await patch("first", { appearance: { kind: "bot", color: "sky", accessories: [] } })).statusCode, 200);
  const cluster = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/clusters`, payload: { name: "Team", x: 0, y: 0 } })).json();
  assert.equal((await patch("first", { clusterId: cluster.id, x: 20, y: 30 })).statusCode, 200);
  const task = await app.inject({ method: "POST", url: "/api/agents/first/tasks", payload: { content: "Still usable", requestId: "legacy_names_task" } });
  assert.equal(task.statusCode, 202, task.body);
  assert.equal((await patch("second", { name: "Maya" })).statusCode, 200);
  assert.equal((await patch("first", { instructions: "Updated role" })).statusCode, 200);
});

test("suggestions check the full workspace, stay read-only, obey access checks, and are revalidated on create", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-name-suggestions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "app.sqlite");
  const db = openDatabase(path);
  const workspace = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare("INSERT INTO workspaces(id,name,createdAt,updatedAt) VALUES ('other','Other','then','then')").run();
  const insert = db.prepare("INSERT INTO agents(id,workspaceId,name,createdAt,updatedAt) VALUES (?,?,?,'then','then')");
  for (let index = 0; index < 110; index++) insert.run(`filler-${index}`, workspace, `Custom ${index}`);
  const last = agentFirstNames.at(-1)!;
  for (const name of agentFirstNames.slice(0, -1)) insert.run(`name-${name}`, workspace, ` ${name.toUpperCase()} `);
  insert.run("other-agent", "other", last);
  const before = db.prepare("SELECT * FROM agents ORDER BY id").all();
  db.close();
  const app = createApp({ databasePath: path, serveStatic: false, execution: { autoStart: false } });
  t.after(() => app.close());
  const url = `/api/workspaces/${workspace}/agents/name-suggestion`;
  assert.equal((await app.inject(`/api/workspaces/${workspace}/agents`)).json().items.length, 100);
  for (let index = 0; index < 3; index++) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), { name: last });
  }
  const savedDb = openDatabase(path);
  assert.deepEqual(savedDb.prepare("SELECT * FROM agents ORDER BY id").all(), before);
  savedDb.close();
  assert.equal((await app.inject("/api/workspaces/missing/agents/name-suggestion")).statusCode, 404);
  assert.equal((await app.inject({ url, headers: { origin: "https://example.com" } })).statusCode, 403);
  const create = () => app.inject({ method: "POST", url: `/api/workspaces/${workspace}/agents`, payload: { name: last } });
  assert.equal((await create()).statusCode, 201);
  assert.equal((await create()).statusCode, 400);
  assert.match((await app.inject(url)).json().name, / \d+$/);
});
