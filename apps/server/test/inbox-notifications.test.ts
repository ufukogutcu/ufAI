import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { InputError } from "../src/validation.js";
import { openDatabase } from "../src/database.js";
import { registerInboxNotifications, inboxPreview } from "../src/inbox-notifications.js";

function setup(t: any) {
  const db = openDatabase(":memory:"), app = Fastify(), events = new EventEmitter().setMaxListeners(128);
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  app.setErrorHandler((error: any, _req, reply) => reply.code(error instanceof InputError ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  registerInboxNotifications(app, db, events);
  app.addHook("preClose", async () => { events.emit("close"); });
  t.after(async () => { await app.close(); db.close(); });
  function insert(workspace = workspaceId, content = "A new **message**") {
    const id = randomUUID();
    db.prepare("INSERT INTO workspace_inbox(id,workspaceId,agentName,content,attachments,createdAt) VALUES(?,?,'Agent',?,'[]','now')").run(id, workspace, content);
    return id;
  }
  return { db, app, events, workspaceId, insert };
}

test("global feed baselines history, paginates across workspaces and never replays read changes", async t => {
  const s = setup(t);
  const old = s.insert();
  s.db.prepare("INSERT INTO workspaces(id,name,createdAt,updatedAt) VALUES('other','Other','now','now')").run();
  const initial = (await s.app.inject("/api/inbox/notifications")).json();
  assert.equal(initial.cursor, 1); assert.equal(initial.unreadTotal, 1); assert.deepEqual(initial.items, []);
  const ids = Array.from({ length: 105 }, (_, i) => s.insert(i % 2 ? "other" : s.workspaceId));
  const page = (await s.app.inject("/api/inbox/notifications?after=1")).json();
  assert.equal(page.items.length, 100); assert.equal(page.cursor, 101); assert.equal(page.hasMore, true);
  assert.equal(page.unreadTotal, 106); assert.equal(page.items[1].workspaceName, "Other");
  assert.equal(page.items[0].preview, "A new message");
  const next = (await s.app.inject(`/api/inbox/notifications?after=${page.cursor}`)).json();
  assert.equal(next.items.length, 5); assert.equal(next.cursor, 106); assert.equal(next.hasMore, false);
  const detail = await s.app.inject(`/api/inbox/${old}`);
  assert.equal(detail.json().readAt, null); assert.deepEqual(detail.json().attachments, []);
  s.db.prepare("UPDATE workspace_inbox SET readAt='read' WHERE id=?").run(ids[0]);
  const read = (await s.app.inject("/api/inbox/notifications?after=106")).json();
  assert.equal(read.unreadTotal, 105); assert.deepEqual(read.items, []);
  s.db.prepare("UPDATE workspace_inbox SET readAt=NULL WHERE id=?").run(ids[0]);
  assert.deepEqual((await s.app.inject("/api/inbox/notifications?after=106")).json().items, []);
  s.db.prepare("DELETE FROM workspace_inbox").run();
  assert.equal((await s.app.inject("/api/inbox/notifications?after=106")).json().cursor, 106);
  assert.equal((await s.app.inject(`/api/inbox/${old}`)).statusCode, 404);
});

test("feed validates cursors, prevents cross-site reads and keeps responses uncached", async t => {
  const { app } = setup(t);
  for (const cursor of ["-1", "1.5", "NaN", "9007199254740992", "1", ""]) {
    assert.equal((await app.inject(`/api/inbox/notifications?after=${cursor}`)).statusCode, 400);
  }
  assert.equal((await app.inject({ url: "/api/inbox/notifications", headers: { origin: "https://other.example" } })).statusCode, 403);
  assert.equal((await app.inject("/api/inbox/notifications")).headers["cache-control"], "no-store");
});

test("previews strip formatting, stay bounded and hide private request names and content", () => {
  assert.equal(inboxPreview("# Hello [world](https://example.test) <b>today</b>", false), "Hello world today");
  assert.equal(inboxPreview("<script>hidden</script>Visible", false), "Visible");
  assert.equal(inboxPreview("a".repeat(10000), false).length, 180);
  assert.equal(inboxPreview("", false), "New Inbox message.");
  assert.equal(inboxPreview("Private service credential name", true), "Private input requested. Open Inbox to respond.");
  assert.equal(inboxPreview("Private input requested: Retained private service name", false), "Private input requested. Open Inbox to respond.");
});

test("global invalidations coalesce, release subscribers and close streams on shutdown", async t => {
  const { app, events } = setup(t);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${app.listeningOrigin}/api/inbox/events`);
  const reader = response.body!.getReader();
  assert.match(response.headers.get("content-type")!, /event-stream/);
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: change/);
  assert.equal(events.listenerCount("change"), 1);
  events.emit("change", "workspace-a"); events.emit("change", "workspace-b");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "event: change\ndata: {}\n\n");
  events.emit("close");
  assert.equal((await reader.read()).done, true);
  assert.equal(events.listenerCount("change"), 0); assert.equal(events.listenerCount("close"), 0);
});

test("stream capacity is bounded and a disconnected viewer releases its slot", async t => {
  const { app } = setup(t);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  t.after(async () => { await Promise.all(readers.map(reader => reader.cancel())); });
  for (let i = 0; i < 32; i++) {
    const response = await fetch(`${app.listeningOrigin}/api/inbox/events`);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); readers.push(reader); await reader.read();
  }
  const overflow = await fetch(`${app.listeningOrigin}/api/inbox/events`);
  assert.equal(overflow.status, 429); await overflow.text();
  await readers.shift()!.cancel();
  // Wait for the close event on the server socket, rather than assuming client cancellation is synchronous.
  let status = 429;
  for (let attempt = 0; attempt < 10 && status === 429; attempt++) {
    const response = await fetch(`${app.listeningOrigin}/api/inbox/events`);
    status = response.status;
    if (status === 200) { const reader = response.body!.getReader(); readers.push(reader); await reader.read(); }
    else await response.text();
  }
  assert.equal(status, 200);
});
