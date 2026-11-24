import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { openDatabase } from "../src/database.js";
import { ManagedFiles } from "../src/managed-files.js";
import { ArtifactService } from "../src/artifact-service.js";
import { createApp } from "../src/app.js";
import { restoreClusters } from "./legacy-schema.js";

async function legacy(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ufai-retire-clusters-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "app.sqlite"), filesRoot = join(root, "files");
  const db = openDatabase(path);
  const workspaceId = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
  const files = new ManagedFiles(db, filesRoot);
  await files.start();
  db.prepare(`INSERT INTO agents(id,workspaceId,name,instructions,x,y,revision,createdAt,updatedAt)
    VALUES ('a',?,'A','Keep instructions',124,172,7,'then','then'),('b',?,'B','Help A',-300,900,2,'then','then')`).run(workspaceId, workspaceId);
  db.exec(`INSERT INTO conversations(id,agentId,kind,createdAt) VALUES ('conversation','a','task','then');
    INSERT INTO agent_tasks(id,agentId,conversationId,title,status,createdAt,updatedAt) VALUES ('task','a','conversation','Keep task','completed','then','then');
    INSERT INTO agent_messages(id,conversationId,role,content,state,createdAt) VALUES ('message','conversation','user','Keep history','complete','then');
    INSERT INTO agent_memories(id,agentId,key,content,kind,sources,createdAt,updatedAt) VALUES ('memory','a','topic','Keep memory','finding','["message"]','then','then');`);
  db.prepare("INSERT INTO communication_links(id,workspaceId,sourceAgentId,targetAgentId,createdAt) VALUES ('link',?,'a','b','then')").run(workspaceId);
  db.prepare("INSERT INTO workspace_viewports(workspaceId,x,y,zoom) VALUES (?,31,-90,0.75)").run(workspaceId);
  db.prepare("INSERT INTO themes VALUES ('custom','Custom','dark',?,'then','then')").run(JSON.stringify({ text: "#123456", "cluster-color-1": "#abcdef", "cluster-color-16": "#fedcba", "cluster-surface": "#112233", "cluster-border": "#334455", "cluster-drop-surface": "#556677" }));
  db.exec("UPDATE app_settings SET activeThemeId='custom'");
  for (const [kind, id] of [["workspace", workspaceId], ["agent", "a"], ["agent", "b"], ["task", "task"]] as const) {
    const folder = await files.repair(kind, id);
    await writeFile(join(folder.path, "keep.txt"), kind);
  }
  const artifacts = new ArtifactService(db, files, () => {});
  const version = await artifacts.publish({ workspaceId, agentId: "a", taskId: "task" }, {
    stream: Readable.from([Buffer.from("published")]), size: 9, name: "keep.txt",
  }, new AbortController().signal);
  await artifacts.close();
  await files.close();
  restoreClusters(db);
  db.prepare("INSERT INTO clusters(id,workspaceId,name,colorSlot,createdAt,updatedAt) VALUES ('team',?,'Team',0,'then','then'),('missing',?,'Missing',1,'then','then')").run(workspaceId, workspaceId);
  db.exec("UPDATE agents SET clusterId='team' WHERE id='a'");
  const tree = `workspaces/${workspaceId}/clusters/team`;
  const shared = join(filesRoot, tree, "shared");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "remove.txt"), "retired");
  const orphan = `workspaces/${workspaceId}/clusters/orphan`;
  await mkdir(join(filesRoot, orphan), { recursive: true });
  await writeFile(join(filesRoot, orphan, "remove.txt"), "unfinished deletion");
  const deletion = db.prepare(`INSERT INTO deletion_operations(id,kind,ownerId,workspaceId,relativePath,state,error,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,'then','then')`);
  deletion.run("failed-team", "cluster", "team", workspaceId, tree, "failed", "old failure");
  deletion.run("pending-orphan", "cluster", "orphan", workspaceId, orphan, "running", null);
  deletion.run("kept-history", "agent", "deleted", workspaceId, `workspaces/${workspaceId}/agents/deleted`, "completed", null);
  db.pragma("user_version=25");
  return { root, path, filesRoot, db, workspaceId, tree, shared, orphan, version };
}

test("v25 retirement preserves application records, absolute positions and files while removing grouping and retired theme overrides", async t => {
  const f = await legacy(t);
  const tables = ["agents", "agent_tasks", "agent_messages", "agent_memories", "communication_links", "workspace_viewports", "app_settings", "artifacts", "artifact_versions"];
  const before = Object.fromEntries(tables.map(table => [table, (f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[])
    .map(row => { const { clusterId: _, ...retained } = row; return retained; })]));
  const locations = f.db.prepare("SELECT * FROM managed_locations WHERE kind!='cluster' ORDER BY id").all();
  const deletions = f.db.prepare("SELECT * FROM deletion_operations WHERE kind!='cluster'").all();
  f.db.close();
  const db = openDatabase(f.path);
  try {
    assert.equal(db.pragma("user_version", { simple: true }), 44);
    for (const table of tables) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[table], table);
    assert.deepEqual(db.prepare("SELECT * FROM managed_locations ORDER BY id").all(), locations);
    assert.deepEqual(db.prepare("SELECT * FROM deletion_operations").all(), deletions);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='clusters'").get(), undefined);
    assert.equal((db.pragma("table_info(agents)") as { name: string }[]).some(column => column.name === "clusterId"), false);
    assert.deepEqual(db.prepare("SELECT * FROM managed_path_cleanup ORDER BY relativePath").all(), ["missing", "orphan", "team"].map(id => ({ relativePath: `workspaces/${f.workspaceId}/clusters/${id}` })));
    assert.deepEqual(JSON.parse((db.prepare("SELECT colors FROM themes WHERE id='custom'").get() as { colors: string }).colors), { text: "#123456" });
    assert.deepEqual(db.prepare("SELECT name,mode,createdAt,updatedAt FROM themes WHERE id='custom'").get(), { name: "Custom", mode: "dark", createdAt: "then", updatedAt: "then" });
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.throws(() => db.prepare("INSERT INTO managed_locations(id,kind,ownerId,workspaceId,relativePath) VALUES ('invalid','cluster','team',?,'invalid')").run(f.workspaceId), /CHECK constraint/);
    assert.throws(() => db.prepare("INSERT INTO deletion_operations(id,kind,ownerId,workspaceId,relativePath,createdAt,updatedAt) VALUES ('invalid','cluster','team',?,'invalid','then','then')").run(f.workspaceId), /CHECK constraint/);
    const files = new ManagedFiles(db, f.filesRoot);
    try {
      await files.start();
      await assert.rejects(lstat(join(f.filesRoot, f.tree)), { code: "ENOENT" });
      await assert.rejects(lstat(join(f.filesRoot, f.orphan)), { code: "ENOENT" });
      assert.deepEqual(db.prepare("SELECT * FROM managed_path_cleanup").all(), []);
      for (const [kind, id] of [["workspace", f.workspaceId], ["agent", "a"], ["task", "task"]] as const)
        assert.equal(await readFile(join(files.location(kind, id).path, "keep.txt"), "utf8"), kind);
      const artifacts = new ArtifactService(db, files, () => {});
      try {
        assert.equal((await artifacts.bytes(f.version.id, f.workspaceId)).bytes.toString("utf8"), "published");
      } finally { await artifacts.close(); }
    } finally { await files.close(); }
  } finally { db.close(); }
  // Reopen again after cleanup; obsolete folders must never be provisioned anew.
  const app = createApp({ databasePath: f.path, filesRoot: f.filesRoot, execution: { autoStart: false }, serveStatic: false });
  try {
    await app.ready();
    const agent = (await app.inject("/api/agents/a")).json();
    assert.deepEqual([agent.x, agent.y, agent.revision], [124, 172, 7]);
    assert.equal(Object.hasOwn(agent, "clusterId"), false);
    const themes = (await app.inject("/api/themes")).json().items;
    const theme = themes.find((entry: { id: string }) => entry.id === "custom");
    assert.equal(Object.keys(theme.colors).some(key => key.startsWith("cluster-")), false);
    const saved = await app.inject({ method: "PATCH", url: "/api/themes/custom", payload: { colors: theme.colors } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().colors.text, "#123456");
    for (const url of [`/api/workspaces/${f.workspaceId}/clusters`, "/api/clusters/team", "/api/clusters/team/locations", "/api/locations/cluster/team/repair"]) {
      const response = await app.inject({ method: url.endsWith("repair") ? "POST" : "GET", url });
      assert.equal(response.statusCode, 404, response.body);
    }
    for (const method of ["PATCH", "DELETE"] as const)
      assert.equal((await app.inject({ method, url: "/api/clusters/team", payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/workspaces/${f.workspaceId}/clusters`, payload: { name: "Retired" } })).statusCode, 404);
    for (const [method, url] of [["POST", `/api/workspaces/${f.workspaceId}/agents`], ["PATCH", "/api/agents/a"]] as const) {
      const response = await app.inject({ method, url, payload: { name: "New", clusterId: null } });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().fields.clusterId, "Unknown field.");
    }
    const created = await app.inject({ method: "POST", url: `/api/workspaces/${f.workspaceId}/agents`, payload: { name: "New" } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal((await app.inject(`/api/agents/${created.json().id}/locations`)).statusCode, 200);
  } finally { await app.close(); }
});

test("retired cleanup unlinks interior and target symlinks without following external files", async t => {
  const f = await legacy(t);
  const external = join(f.root, "external");
  await mkdir(external);
  await writeFile(join(external, "keep.txt"), "outside");
  await symlink(external, join(f.shared, "external"));
  await rm(join(f.filesRoot, f.orphan), { recursive: true });
  await symlink(external, join(f.filesRoot, f.orphan));
  f.db.close();
  const db = openDatabase(f.path), files = new ManagedFiles(db, f.filesRoot);
  try {
    await files.start();
    assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "outside");
    await assert.rejects(lstat(join(f.filesRoot, f.orphan)), { code: "ENOENT" });
  } finally { await files.close(); db.close(); }
});

test("failed startup keeps durable cleanup intent and retries after an unsafe ancestor is repaired", async t => {
  const f = await legacy(t);
  const ancestor = join(f.filesRoot, "workspaces", f.workspaceId, "clusters");
  const external = join(f.root, "outside");
  await mkdir(external);
  await writeFile(join(external, "keep.txt"), "untouched");
  await rm(ancestor, { recursive: true });
  await symlink(external, ancestor);
  f.db.close();
  let app = createApp({ databasePath: f.path, filesRoot: f.filesRoot, execution: { autoStart: false } });
  await assert.rejects(app.ready(), /cleanup failed.*restart ufAI/i);
  await app.close();
  let db = openDatabase(f.path);
  assert.equal((db.prepare("SELECT count(*) n FROM managed_path_cleanup").get() as { n: number }).n, 3);
  assert.equal((db.prepare("SELECT count(*) n FROM agents").get() as { n: number }).n, 2);
  db.close();
  await unlink(ancestor);
  await mkdir(ancestor);
  app = createApp({ databasePath: f.path, filesRoot: f.filesRoot, execution: { autoStart: false } });
  try { await app.ready(); } finally { await app.close(); }
  db = openDatabase(f.path);
  assert.deepEqual(db.prepare("SELECT * FROM managed_path_cleanup").all(), []);
  db.close();
  assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "untouched");
});

test("cleanup rejects non-retired paths and a foreign storage root without deleting contents", async t => {
  const f = await legacy(t);
  f.db.close();
  const db = openDatabase(f.path);
  const path = `workspaces/${f.workspaceId}/agents/a`;
  db.prepare("INSERT INTO managed_path_cleanup VALUES (?)").run(path);
  const files = new ManagedFiles(db, f.filesRoot);
  try {
    await assert.rejects(files.start(), /cleanup failed/);
    assert.equal(await readFile(join(f.filesRoot, path, "files/keep.txt"), "utf8"), "agent");
    assert.ok(db.prepare("SELECT 1 FROM managed_path_cleanup WHERE relativePath=?").get(path));
  } finally { await files.close(); db.close(); }
  const other = openDatabase(join(f.root, "foreign.sqlite"));
  other.prepare("INSERT INTO managed_path_cleanup VALUES (?)").run(f.tree);
  const foreign = new ManagedFiles(other, f.filesRoot);
  try {
    await assert.rejects(foreign.start(), /another installation/);
    assert.equal(await readFile(join(f.shared, "remove.txt"), "utf8"), "retired");
  } finally { await foreign.close(); other.close(); }
});
