import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat, chmod, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { createApp } from "../src/app.js";
import type { WorkspaceDuplicateInput, WorkspaceDuplication } from "../src/contracts.js";

const defaults = { name: "Copy", description: "Copied description", includeConnections: true, includeSkills: true, includeMcp: true,
  includeMemories: false, includeWorkspaceFiles: false, includeAgentFiles: false, includeTriggers: false };
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ufai-duplicate-test-")), databasePath = join(root, "test.sqlite"), filesRoot = join(root, "files");
  const options = { databasePath, filesRoot, serveStatic: false, execution: { autoStart: false }, triggers: { autoStart: false } };
  let app = createApp(options);
  await app.ready();
  const db = new Database(databasePath); db.pragma("foreign_keys = ON");
  t.after(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const source = (await app.inject("/api/workspaces")).json().items[0];
  async function agent(name: string) {
    const response = await app.inject({ method: "POST", url: `/api/workspaces/${source.id}/agents`, payload: { name, instructions: `Instructions for ${name}`, x: 12, y: 34, presetId: null } });
    assert.equal(response.statusCode, 201, response.body); return response.json();
  }
  const a = await agent("A"), b = await agent("B");
  const path = (kind: string, id: string) => join(filesRoot, (db.prepare("SELECT relativePath FROM managed_locations WHERE kind=? AND ownerId=?").get(kind, id) as { relativePath: string }).relativePath);
  for (const [kind, id] of [["workspace", source.id], ["agent", a.id], ["agent", b.id]]) {
    // Let the normal folder worker finish before creating fixture contents.
    for (let n = 0; n < 200; n++) {
      const row = db.prepare("SELECT state FROM managed_locations WHERE kind=? AND ownerId=?").get(kind, id) as { state: string };
      if (row.state === "ready") break;
      await delay(10);
    }
    await mkdir(path(kind, id), { recursive: true });
  }
  async function duplicate(requestId: string, extra: Partial<WorkspaceDuplicateInput> = {}) {
    const response = await app.inject({ method: "POST", url: `/api/workspaces/${source.id}/duplicate`, payload: { ...defaults, ...extra, requestId } });
    assert.equal(response.statusCode, 202, response.body); return response.json<WorkspaceDuplication>();
  }
  async function finish(id: string) {
    for (let n = 0; n < 400; n++) {
      const op = (await app.inject(`/api/workspace-duplications/${id}`)).json<WorkspaceDuplication>();
      if (op.state === "completed" || op.state === "failed") return op;
      await delay(10);
    }
    assert.fail("Duplication did not settle");
  }
  return { get app() { return app; }, db, root, filesRoot, source, a, b, path, duplicate, finish,
    restart: async () => { await app.close(); app = createApp(options); await app.ready(); } };
}

test("duplication defaults preserve independent agent setup and settings, with fresh histories", async t => {
  const s = await setup(t), { db, a, b, source } = s;
  const presetResponse = await s.app.inject({ method: "POST", url: "/api/model-presets", payload: { name: "Shared default", isDefault: true } });
  assert.equal(presetResponse.statusCode, 201, presetResponse.body);
  const preset = presetResponse.json();
  await s.app.inject({ method: "PATCH", url: `/api/agents/${a.id}`, payload: { presetId: preset.id } });
  db.prepare("INSERT INTO communication_links(id,workspaceId,sourceAgentId,targetAgentId,state,createdAt,sourceAnchorAngle,targetAnchorAngle) VALUES ('link',?,?,?,'active',?,42,222)").run(source.id, a.id, b.id, a.createdAt);
  db.prepare("INSERT INTO agent_skills VALUES (?,'builtin-browser',0)").run(a.id);
  db.prepare("INSERT INTO mcp_servers(id,name,transport,config,secrets,createdAt,updatedAt) VALUES ('mcp','Example','stdio','{}','{}',?,?)").run(a.createdAt, a.createdAt);
  db.prepare("INSERT INTO agent_mcp_servers VALUES (?,'mcp',1)").run(a.id);
  db.prepare("INSERT INTO workspace_viewports VALUES (?,10,20,1.5)").run(source.id);
  const op = await s.duplicate("default-copy"), done = await s.finish(op.id);
  assert.equal(done.state, "completed", done.error ?? "");
  const agents = (await s.app.inject(`/api/workspaces/${done.workspaceId}/agents`)).json().items;
  assert.equal(agents.length, 2);
  const copy = agents.find((agent: { name: string }) => agent.name === "A");
  assert.notEqual(copy.id, a.id); assert.deepEqual(copy.appearance, a.appearance);
  assert.equal(copy.instructions, a.instructions); assert.equal(copy.presetId, preset.id); assert.equal(copy.x, a.x);
  assert.equal(agents.find((agent: { name: string }) => agent.name === "B").presetId, null);
  assert.equal(copy.revision, 1);
  assert.equal(copy.state, "idle");
  const link = db.prepare("SELECT * FROM communication_links WHERE workspaceId=?").get(done.workspaceId) as any;
  assert.notEqual(link.id, "link"); assert.equal(link.sourceAgentId, copy.id); assert.equal(link.sourceAnchorAngle, 42);
  assert.deepEqual(db.prepare("SELECT skillId,enabled FROM agent_skills WHERE agentId=?").get(copy.id), { skillId: "builtin-browser", enabled: 0 });
  assert.deepEqual(db.prepare("SELECT serverId,enabled FROM agent_mcp_servers WHERE agentId=?").get(copy.id), { serverId: "mcp", enabled: 1 });
  assert.deepEqual((await s.app.inject(`/api/workspaces/${done.workspaceId}/viewport`)).json(), { x: 10, y: 20, zoom: 1.5 });
  assert.equal((await s.app.inject(`/api/agents/${copy.id}/tasks`)).json().total, 0);
  assert.equal((await s.app.inject(`/api/agents/${copy.id}/chat`)).json().task, null);
  assert.equal(db.prepare("SELECT snapshot FROM workspace_duplications WHERE id=?").get(op.id)!.snapshot, null);
  assert.equal((await s.app.inject("/api/settings")).json().settings.activeWorkspaceId, source.id);
  const repeat = await s.duplicate(op.id); assert.equal(repeat.workspaceId, done.workspaceId);
  const conflict = await s.app.inject({ method: "POST", url: `/api/workspaces/${source.id}/duplicate`, payload: { ...defaults, requestId: op.id, name: "Other" } });
  assert.equal(conflict.statusCode, 409);
  const excluded = await s.finish((await s.duplicate("no-settings", { includeConnections: false, includeSkills: false, includeMcp: false })).id);
  assert.equal(excluded.state, "completed", excluded.error ?? "");
  assert.equal((db.prepare("SELECT count(*) n FROM agent_skills e JOIN agents a ON a.id=e.agentId WHERE a.workspaceId=?").get(excluded.workspaceId) as any).n, 0);
  assert.equal((db.prepare("SELECT count(*) n FROM agent_mcp_servers e JOIN agents a ON a.id=e.agentId WHERE a.workspaceId=?").get(excluded.workspaceId) as any).n, 0);
  assert.equal((db.prepare("SELECT count(*) n FROM communication_links WHERE workspaceId=?").get(excluded.workspaceId) as any).n, 0);
});

test("selected folders and memories copy independently, including hidden files and empty folders", async t => {
  const s = await setup(t);
  await writeFile(join(s.path("workspace", s.source.id), ".hidden"), "shared");
  await mkdir(join(s.path("agent", s.a.id), "empty"));
  await writeFile(join(s.path("agent", s.a.id), "notes.txt"), "private");
  s.db.prepare("INSERT INTO agent_memories(id,agentId,key,content,kind,sources,revision,createdAt,updatedAt) VALUES ('memory',?,'topic','Remember','finding','[\"old-message\"]',9,?,?)").run(s.a.id, s.a.createdAt, s.a.createdAt);
  s.db.prepare("INSERT INTO agent_memories(id,agentId,key,content,kind,sources,deleted,createdAt,updatedAt) VALUES ('deleted',?,'gone','Forgotten','finding','[]',1,?,?)").run(s.a.id, s.a.createdAt, s.a.createdAt);
  const done = await s.finish((await s.duplicate("copy-files", { includeWorkspaceFiles: true, includeAgentFiles: true, includeMemories: true })).id);
  assert.equal(done.state, "completed", done.error ?? "");
  const a = s.db.prepare("SELECT id FROM agents WHERE workspaceId=? AND name='A'").get(done.workspaceId) as { id: string };
  assert.equal(await readFile(join(s.path("workspace", done.workspaceId!), ".hidden"), "utf8"), "shared");
  const copied = join(s.path("agent", a.id), "notes.txt"), original = join(s.path("agent", s.a.id), "notes.txt");
  assert.notEqual((await stat(copied)).ino, (await stat(original)).ino);
  await writeFile(copied, "changed"); assert.equal(await readFile(original, "utf8"), "private");
  assert.ok((await stat(join(s.path("agent", a.id), "empty"))).isDirectory());
  const memory = s.db.prepare("SELECT * FROM agent_memories WHERE agentId=?").get(a.id) as any;
  assert.notEqual(memory.id, "memory"); assert.equal(memory.revision, 1); assert.equal(memory.sources, "[]");
  assert.equal((s.db.prepare("SELECT count(*) n FROM agent_memories WHERE agentId=?").get(a.id) as any).n, 1);
  assert.equal((s.db.prepare("SELECT count(*) n FROM artifacts WHERE workspaceId=?").get(done.workspaceId) as any).n, 0);
  const omitted = await s.finish((await s.duplicate("omit-data")).id);
  assert.equal((s.db.prepare("SELECT count(*) n FROM agent_memories m JOIN agents a ON a.id=m.agentId WHERE a.workspaceId=?").get(omitted.workspaceId) as any).n, 0);
  await assert.rejects(readFile(join(s.path("workspace", omitted.workspaceId!), ".hidden")));
});

test("unsafe or unreadable files fail without publishing; retry and restart keep one destination", async t => {
  const s = await setup(t), file = join(s.path("workspace", s.source.id), "link");
  await symlink(s.root, file);
  const op = await s.duplicate("retry-copy", { includeWorkspaceFiles: true });
  const failed = await s.finish(op.id);
  assert.equal(failed.state, "failed"); assert.match(failed.error!, /links/);
  assert.equal((await s.app.inject("/api/workspaces")).json().total, 1);
  await rm(file); await writeFile(file, "regular"); await chmod(file, 0);
  await s.app.inject({ method: "POST", url: `/api/workspace-duplications/${op.id}/retry` });
  assert.match((await s.finish(op.id)).error!, /permissions/);
  await chmod(file, 0o600);
  await s.restart();
  assert.equal((await s.app.inject("/api/workspace-duplications")).json().items[0].state, "failed");
  const response = await s.app.inject({ method: "POST", url: `/api/workspace-duplications/${op.id}/retry` });
  assert.equal(response.statusCode, 202, response.body);
  const done = await s.finish(op.id); assert.equal(done.state, "completed", done.error ?? "");
  assert.equal((await s.app.inject("/api/workspaces")).json().total, 2);
});

test("triggers retain switches and dependency review while schedules and event sources are independent", async t => {
  const s = await setup(t), stamp = s.a.createdAt;
  const definitions = [
    { name: "Every", when: { kind: "every", everyMs: 60000, anchor: "2020-01-01T00:00:00.000Z" }, enabled: true, paused: true },
    { name: "Past", when: { kind: "at", at: "2020-01-01T00:00:00.000Z", timezone: "UTC" }, enabled: true, paused: false },
    { name: "Event", when: { kind: "event", sourceId: "source", eventType: "custom.event", filters: [{ path: "agentId", operator: "eq", value: s.a.id }] }, enabled: false, paused: false },
    { name: "Builtin", when: { kind: "event", eventType: "ufai.task.completed", filters: [{ path: "agentId", operator: "in", value: [s.a.id, s.b.id] }] }, enabled: true, paused: false },
  ];
  s.db.prepare("INSERT INTO trigger_event_sources(id,workspaceId,name,tokenHash,enabled,createdAt,updatedAt) VALUES ('source',?,'Webhook','old-hash',1,?,?)").run(s.source.id, stamp, stamp);
  for (const definition of definitions) s.db.prepare("INSERT INTO agent_triggers(id,workspaceId,agentId,revision,input,createdAt,updatedAt) VALUES (?,?,?,1,?,?,?)")
    .run(definition.name, s.source.id, s.a.id, JSON.stringify({ ...definition, instructions: s.a.id, requiredSkillIds: ["builtin-browser"] }), stamp, stamp);
  s.db.prepare("INSERT INTO trigger_dependencies VALUES ('Builtin','builtin-browser','old-fingerprint','{}')").run();
  const done = await s.finish((await s.duplicate("copy-triggers", { includeTriggers: true })).id);
  assert.equal(done.state, "completed", done.error ?? "");
  const copied = (s.db.prepare("SELECT id,input FROM agent_triggers WHERE workspaceId=?").all(done.workspaceId) as any[]).map(row => ({ ...row, definition: JSON.parse(row.input) }));
  assert.equal(copied.length, 4);
  for (const item of copied) { assert.notEqual(item.id, item.definition.name); assert.equal(item.definition.instructions, s.a.id); }
  const every = copied.find(row => row.definition.name === "Every")!;
  assert.equal(every.definition.enabled, true); assert.equal(every.definition.paused, true);
  const revision = s.db.prepare("SELECT * FROM trigger_revisions WHERE triggerId=?").get(every.id) as any;
  assert.ok(revision.nextAt > done.updatedAt); assert.equal(revision.startedAt, done.updatedAt);
  assert.equal((s.db.prepare("SELECT nextAt FROM trigger_revisions WHERE triggerId=?").get(copied.find(row => row.definition.name === "Past")!.id) as any).nextAt, null);
  const event = copied.find(row => row.definition.name === "Event")!.definition;
  assert.notEqual(event.when.sourceId, "source"); assert.equal(event.when.filters[0].value, s.a.id);
  const src = s.db.prepare("SELECT * FROM trigger_event_sources WHERE workspaceId=?").get(done.workspaceId) as any;
  assert.notEqual(src.tokenHash, "old-hash"); assert.equal(src.enabled, 1);
  const builtin = copied.find(row => row.definition.name === "Builtin")!;
  assert.ok(builtin.definition.when.filters[0].value.every((id: string) => id !== s.a.id && id !== s.b.id));
  assert.equal((s.db.prepare("SELECT fingerprint FROM trigger_dependencies WHERE triggerId=?").get(builtin.id) as any).fingerprint, "old-fingerprint");
  assert.equal((s.db.prepare("SELECT count(*) n FROM trigger_occurrences").get() as any).n, 0);
});

test("guards, validation, busy protection and interrupted-operation recovery", async t => {
  const s = await setup(t);
  const invalid = await s.app.inject({ method: "POST", url: `/api/workspaces/${s.source.id}/duplicate`, payload: { ...defaults, includeSkills: "yes", requestId: "bad-input" } });
  assert.equal(invalid.statusCode, 400); assert.ok(invalid.json().fields.includeSkills);
  assert.equal((await s.app.inject({ url: "/api/workspace-duplications", headers: { origin: "https://untrusted.example" } })).statusCode, 403);
  s.db.prepare("INSERT INTO workspace_duplications VALUES ('interrupted-copy',?,'destination-id',?,NULL,'running','copying',NULL,?,?)").run(s.source.id, JSON.stringify({ ...defaults, requestId: "interrupted-copy" }), s.a.createdAt, s.a.createdAt);
  assert.equal((await s.app.inject({ method: "POST", url: `/api/workspaces/${s.source.id}/duplicate`, payload: { ...defaults, requestId: "busy-request" } })).statusCode, 409);
  await mkdir(join(s.filesRoot, "duplications", "destination-id"), { recursive: true });
  await writeFile(join(s.filesRoot, "duplications", "destination-id", "partial"), "incomplete");
  await s.restart();
  const recovered = (await s.app.inject("/api/workspace-duplications/interrupted-copy")).json();
  assert.equal(recovered.state, "failed"); assert.match(recovered.error, /interrupted/);
  await assert.rejects(stat(join(s.filesRoot, "duplications", "destination-id")));
  const missing = await s.app.inject({ method: "POST", url: "/api/workspaces/missing/duplicate", payload: { ...defaults, requestId: "missing-source" } });
  assert.equal(missing.statusCode, 404);
});

test("workspace and agent file flags act independently and exclude sibling runtime folders", async t => {
  const s = await setup(t);
  await writeFile(join(s.path("workspace", s.source.id), "workspace.txt"), "shared");
  await writeFile(join(s.path("agent", s.a.id), "agent.txt"), "working");
  await mkdir(join(s.path("agent", s.a.id), "..", "tasks", "old-task"), { recursive: true });
  await writeFile(join(s.path("agent", s.a.id), "..", "tasks", "old-task", "history.txt"), "history");
  for (const includeWorkspaceFiles of [false, true]) {
    const done = await s.finish((await s.duplicate(`independent-files-${includeWorkspaceFiles}`, { includeWorkspaceFiles, includeAgentFiles: !includeWorkspaceFiles })).id);
    assert.equal(done.state, "completed", done.error ?? "");
    const agent = s.db.prepare("SELECT id FROM agents WHERE workspaceId=? AND name='A'").get(done.workspaceId) as { id: string };
    if (includeWorkspaceFiles) {
      assert.equal(await readFile(join(s.path("workspace", done.workspaceId!), "workspace.txt"), "utf8"), "shared");
      await assert.rejects(readFile(join(s.path("agent", agent.id), "agent.txt")));
    } else {
      await assert.rejects(readFile(join(s.path("workspace", done.workspaceId!), "workspace.txt")));
      assert.equal(await readFile(join(s.path("agent", agent.id), "agent.txt"), "utf8"), "working");
    }
    await assert.rejects(stat(join(s.path("agent", agent.id), "..", "tasks")));
  }
});

test("source deletion during an accepted copy never publishes orphaned owners", async t => {
  const s = await setup(t);
  const pending = await s.duplicate("deleted-source");
  s.db.prepare("DELETE FROM workspaces WHERE id=?").run(s.source.id);
  const done = await s.finish(pending.id);
  assert.equal(done.state, "failed"); assert.match(done.error!, /Source workspace/);
  assert.equal((await s.app.inject("/api/workspaces")).json().total, 0);
  assert.equal((s.db.prepare("SELECT snapshot FROM workspace_duplications WHERE id=?").get(pending.id) as any).snapshot, null);
});

test("terminal operation retention clears old request identities and snapshots", async t => {
  const s = await setup(t);
  const insert = s.db.prepare("INSERT INTO workspace_duplications VALUES (?,?,?, ?,NULL,'completed','completed',NULL,?,?)");
  for (let n = 0; n < 55; n++) insert.run(`old-copy-${n}`, s.source.id, `unused-${n}`, JSON.stringify({ ...defaults, requestId: `old-copy-${n}` }), s.a.createdAt, s.a.createdAt);
  await s.restart();
  assert.equal((await s.app.inject("/api/workspace-duplications")).json().items.length, 50);
  assert.equal((s.db.prepare("SELECT count(*) n FROM workspace_duplications WHERE snapshot IS NOT NULL").get() as any).n, 0);
});


test("detected source writes abort copying and retain the original workspace", async t => {
  const s = await setup(t), file = join(s.path("workspace", s.source.id), "changing.txt");
  await writeFile(file, Buffer.alloc(512 * 1024, "a"));
  const handle = await open(file, "r"), prototype = Object.getPrototypeOf(handle), originalRead = prototype.read;
  await handle.close();
  let changed = false;
  t.mock.method(prototype, "read", async function (this: unknown, ...args: unknown[]) {
    const result = await originalRead.apply(this, args);
    if (!changed) { changed = true; await writeFile(file, "updated during the copy"); }
    return result;
  });
  const done = await s.finish((await s.duplicate("changing-files", { includeWorkspaceFiles: true })).id);
  assert.equal(done.state, "failed"); assert.match(done.error!, /changed/);
  assert.equal((await s.app.inject("/api/workspaces")).json().total, 1);
  assert.equal(await readFile(file, "utf8"), "updated during the copy");
});
