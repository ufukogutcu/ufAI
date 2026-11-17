import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { removeCommunicationAnchors } from "./legacy-schema.js";

test("anchor API creates, preserves duplicate anchors and updates either endpoint without reconnecting", async t => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false });
  t.after(() => app.close());
  const workspaceId = (await app.inject("/api/workspaces")).json().items[0].id;
  const createAgent = async (name: string, x: number, y: number) => (await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/agents`, payload: { name, x, y } })).json();
  const a = await createAgent("A", 0, 0), b = await createAgent("B", 0, 400), c = await createAgent("C", 400, 0);
  const create = async (sourceAgentId: string, targetAgentId: string, angles = {}) => app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/communication-links`, payload: { sourceAgentId, targetAgentId, ...angles } });
  const first = await create(a.id, b.id);
  assert.equal(first.statusCode, 201, first.body);
  const link = first.json();
  assert.equal(link.sourceAnchorAngle, 90); assert.equal(link.targetAnchorAngle, 270);
  const explicit = await create(a.id, c.id, { sourceAnchorAngle: 12.5, targetAnchorAngle: 240.25 });
  assert.equal(explicit.json().sourceAnchorAngle, 12.5); assert.equal(explicit.json().targetAnchorAngle, 240.25);
  const duplicate = await create(b.id, a.id, { sourceAnchorAngle: 15, targetAnchorAngle: 30 });
  assert.deepEqual(duplicate.json(), link);
  const patch = async (payload: unknown, id = link.id) => app.inject({ method: "PATCH", url: `/api/communication-links/${id}/anchors`, payload });
  const updated = await patch({ sourceAnchorAngle: 45.5 });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json(), { ...link, sourceAnchorAngle: 45.5 });
  const both = await patch({ sourceAnchorAngle: 0, targetAnchorAngle: 359.99 });
  assert.deepEqual(both.json(), { ...link, sourceAnchorAngle: 0, targetAnchorAngle: 359.99 });
  assert.deepEqual((await app.inject(`/api/communication-links/${link.id}`)).json(), { ...both.json(), operation: null });
  for (const payload of [{}, { sourceAnchorAngle: -1 }, { sourceAnchorAngle: 360 }, { sourceAnchorAngle: null }, { targetAnchorAngle: "90" }, { targetAnchorAngle: true }, { sourceAgentId: c.id }, { sourceAnchorAngle: 1, targetAgentId: c.id }])
    assert.equal((await patch(payload)).statusCode, 400, JSON.stringify(payload));
  assert.equal((await patch({ sourceAnchorAngle: 20 }, "missing")).statusCode, 404);
  assert.equal((await create(b.id, c.id, { sourceAnchorAngle: 360 })).statusCode, 400);
});

test("v24 migration backfills facing anchors once without moving agents or replacing links", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-anchors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "app.sqlite");
  let db = openDatabase(path);
  const workspace = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
  const insert = db.prepare("INSERT INTO agents(id,workspaceId,name,x,y,createdAt,updatedAt) VALUES (?,?,?, ?,?,'then','then')");
  for (const [id, x, y] of [["a", 0, 0], ["b", 0, 400], ["c", 0, 0]] as const) insert.run(id, workspace, id, x, y);
  db.prepare("INSERT INTO communication_links(id,workspaceId,sourceAgentId,targetAgentId,createdAt) VALUES ('vertical',?,'a','b','then'),('coincident',?,'a','c','then')").run(workspace, workspace);
  const agents = db.prepare("SELECT * FROM agents ORDER BY id").all();
  removeCommunicationAnchors(db); db.pragma("user_version=24"); db.close();
  db = openDatabase(path);
  assert.equal(db.pragma("user_version", { simple: true }), 39);
  assert.deepEqual(db.prepare("SELECT * FROM agents ORDER BY id").all(), agents);
  assert.deepEqual(db.prepare("SELECT id,sourceAnchorAngle,targetAnchorAngle FROM communication_links ORDER BY id").all(), [
    { id: "coincident", sourceAnchorAngle: 0, targetAnchorAngle: 180 }, { id: "vertical", sourceAnchorAngle: 90, targetAnchorAngle: 270 },
  ]);
  db.prepare("UPDATE communication_links SET sourceAnchorAngle=45 WHERE id='vertical'").run(); db.close();
  db = openDatabase(path);
  assert.equal((db.prepare("SELECT sourceAnchorAngle FROM communication_links WHERE id='vertical'").get() as { sourceAnchorAngle: number }).sourceAnchorAngle, 45);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.prepare("UPDATE communication_links SET state='revoking' WHERE id='vertical'").run(); db.close();
  const app = createApp({ databasePath: path, serveStatic: false });
  try {
    assert.equal((await app.inject({ method: "PATCH", url: "/api/communication-links/vertical/anchors", payload: { sourceAnchorAngle: 30 } })).statusCode, 409);
  } finally { await app.close(); }
});
