import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { deleteOwner } from "./deletion-helper.js";
import type { Page, Workspace } from "../src/contracts.js";

test("migration ranks legacy workspaces by creation order and preserves preferences and viewports", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-workspace-order-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "test.sqlite");
  const old = openDatabase(path);
  old.exec("DELETE FROM workspaces; DROP INDEX workspaces_order; ALTER TABLE workspaces DROP COLUMN sortOrder;");
  const insert = old.prepare("INSERT INTO workspaces(id,name,description,createdAt,updatedAt) VALUES (?,?,'description',?,?)");
  for (const [id, stamp] of [["z", "2026-01-01"], ["b", "2026-01-02"], ["a", "2026-01-02"]]) insert.run(id, id, stamp, stamp);
  old.exec("UPDATE app_settings SET activeThemeId='dark-mode', activeWorkspaceId='b'; INSERT INTO workspace_viewports VALUES ('b',12,24,1.5); PRAGMA user_version=38");
  const before = old.prepare("SELECT * FROM workspaces ORDER BY createdAt,id").all();
  old.close();
  const upgraded = openDatabase(path);
  assert.deepEqual(upgraded.prepare("SELECT * FROM workspaces ORDER BY sortOrder,id").all(), before.map((row, sortOrder) => ({ ...row as object, sortOrder })));
  assert.equal((upgraded.prepare("SELECT activeWorkspaceId FROM app_settings").get() as any).activeWorkspaceId, "b");
  assert.equal((upgraded.prepare("SELECT zoom FROM workspace_viewports WHERE workspaceId='b'").get() as any).zoom, 1.5);
  upgraded.close();
});

test("relative workspace moves persist, paginate, append copies, and select the saved neighbor on deletion", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-workspace-moves-"));
  const options = { databasePath: join(directory, "test.sqlite"), filesRoot: join(directory, "files"), serveStatic: false,
    execution: { autoStart: false }, triggers: { autoStart: false } };
  let app = createApp(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const list = async () => (await app.inject("/api/workspaces")).json<Page<Workspace>>().items;
  const original = (await list())[0]!;
  const b = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "B" } })).json<Workspace>();
  const c = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "C" } })).json<Workspace>();
  const move = async (id: string, relativeToId: string, placement: string) => {
    const response = await app.inject({ method: "PATCH", url: `/api/workspaces/${id}/order`, payload: { relativeToId, placement } });
    assert.equal(response.statusCode, 204, response.body);
  };
  const settings = (await app.inject("/api/settings")).json();
  await move(c.id, original.id, "before");
  assert.deepEqual((await list()).map(w => w.id), [c.id, original.id, b.id]);
  assert.equal((await list()).find(w => w.id === c.id)!.updatedAt, c.updatedAt);
  assert.deepEqual((await app.inject("/api/settings")).json().settings, settings.settings);
  assert.equal((await app.inject("/api/workspaces?offset=1&limit=1")).json().items[0].id, original.id);
  await move(original.id, b.id, "after");
  assert.deepEqual((await list()).map(w => w.id), [c.id, b.id, original.id]);
  await move(c.id, original.id, "before");
  assert.deepEqual((await list()).map(w => w.id), [b.id, c.id, original.id]);
  await move(original.id, b.id, "after");
  assert.deepEqual((await list()).map(w => w.id), [b.id, original.id, c.id]);
  await move(c.id, b.id, "before");
  assert.deepEqual((await list()).map(w => w.id), [c.id, b.id, original.id]);
  await app.close(); app = createApp(options);
  assert.deepEqual((await list()).map(w => w.id), [c.id, b.id, original.id]);
  await app.inject({ method: "PATCH", url: "/api/settings", payload: { activeWorkspaceId: b.id } });
  assert.equal((await deleteOwner(app, `/api/workspaces/${b.id}`)).statusCode, 202);
  assert.equal((await app.inject("/api/settings")).json().settings.activeWorkspaceId, original.id);
  // A gap left by deletion must not break later relative moves.
  await move(original.id, c.id, "before");
  const d = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "D" } })).json<Workspace>();
  assert.deepEqual((await list()).map(w => w.id), [original.id, c.id, d.id]);
  const duplication = await app.inject({ method: "POST", url: `/api/workspaces/${original.id}/duplicate`, payload: {
    requestId: "order-copy", name: "Copy", description: "", includeConnections: false, includeSkills: false,
    includeMcp: false, includeMemories: false, includeWorkspaceFiles: false, includeAgentFiles: false, includeTriggers: false,
  } });
  assert.equal(duplication.statusCode, 202, duplication.body);
  for (let attempt = 0; attempt < 200; attempt++) {
    const operation = (await app.inject(`/api/workspace-duplications/${duplication.json().id}`)).json();
    assert.notEqual(operation.state, "failed", operation.error);
    if (operation.state === "completed") break;
    await delay(10);
  }
  const copied = await list();
  assert.equal(copied.length, 4);
  assert.equal(copied.at(-1)!.name, "Copy");
  assert.equal(new Set(copied.map(w => w.sortOrder)).size, copied.length);
});

test("invalid and unavailable relative moves leave workspace order unchanged", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-workspace-order-invalid-"));
  const databasePath = join(directory, "test.sqlite");
  const app = createApp({ databasePath, filesRoot: join(directory, "files"), serveStatic: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const initial = (await app.inject("/api/workspaces")).json().items[0];
  const second = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Second" } })).json();
  const before = (await app.inject("/api/workspaces")).json();
  for (const [id, payload, status] of [
    [initial.id, { relativeToId: initial.id, placement: "before" }, 400],
    [initial.id, { relativeToId: second.id, placement: "up" }, 400],
    [initial.id, { relativeToId: second.id, placement: "before", sortOrder: 0 }, 400],
    [initial.id, { relativeToId: "missing", placement: "after" }, 404],
    ["missing", { relativeToId: second.id, placement: "after" }, 404],
  ] as const) {
    const response = await app.inject({ method: "PATCH", url: `/api/workspaces/${id}/order`, payload });
    assert.equal(response.statusCode, status, response.body);
    assert.deepEqual((await app.inject("/api/workspaces")).json(), before);
  }
  assert.equal((await app.inject({ method: "PATCH", url: `/api/workspaces/${initial.id}`, payload: { sortOrder: 50 } })).statusCode, 400);
  const db = openDatabase(databasePath);
  try {
    db.prepare("INSERT INTO deletion_operations(id,kind,ownerId,workspaceId,relativePath,state,createdAt,updatedAt) VALUES ('fenced','workspace',?,?,'unused','failed','now','now')").run(initial.id, initial.id);
    for (const [source, relativeToId] of [[initial.id, second.id], [second.id, initial.id]]) {
      const response = await app.inject({ method: "PATCH", url: `/api/workspaces/${source}/order`, payload: { relativeToId, placement: "after" } });
      assert.equal(response.statusCode, 409, response.body);
      assert.deepEqual((await app.inject("/api/workspaces")).json(), before);
    }
  } finally { db.close(); }
});
