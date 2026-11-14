import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { AgentIssues } from "../src/agent-issues.js";
import { AgentExecution } from "../src/agent-execution.js";
import { ConnectionService } from "../src/connection-service.js";
import { createApp } from "../src/app.js";

function seed(db: ReturnType<typeof openDatabase>) {
  const workspace = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
  db.prepare("INSERT INTO connections(id,provider,name,endpoint,draft,createdAt,updatedAt) VALUES ('connection','openai-compatible','Local','http://127.0.0.1:9999/v1',0,'now','now')").run();
  db.prepare("INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES ('connection','model','Model',1,32000)").run();
  db.prepare("INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES ('preset','Preset','connection','model','now','now')").run();
  for (const id of ["agent", "other"])
    db.prepare("INSERT INTO agents(id,workspaceId,name,presetId,createdAt,updatedAt) VALUES (?, ?, ?, 'preset','now','now')").run(id, workspace, id);
  return workspace;
}

test("configuration diagnostics follow prerequisites, use effective saved context and do not expose credentials", t => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  seed(db);
  const issues = new AgentIssues(db);
  const codes = () => issues.warnings("agent").map(item => item.id);
  assert.deepEqual(codes(), []);
  db.exec("UPDATE agents SET presetId=NULL WHERE id='agent'");
  assert.deepEqual(codes(), ["missing-preset"]);
  db.exec("UPDATE agents SET presetId='preset'; UPDATE model_presets SET connectionId=NULL");
  assert.deepEqual(codes(), ["missing-provider"]);
  db.exec("UPDATE model_presets SET connectionId='connection'; UPDATE connections SET draft=1");
  assert.deepEqual(codes(), ["missing-provider"]);
  db.exec("UPDATE connections SET draft=0; UPDATE model_presets SET modelId=NULL");
  assert.deepEqual(codes(), ["missing-model"]);
  db.exec("UPDATE model_presets SET modelId='missing'");
  assert.deepEqual(codes(), ["unavailable-model"]);
  db.exec("UPDATE model_presets SET modelId='model'; UPDATE provider_models SET enabled=0");
  assert.deepEqual(codes(), ["unavailable-model"]);
  db.exec("UPDATE provider_models SET enabled=1, contextWindowOverride=NULL");
  assert.deepEqual(codes(), ["unknown-context"]);
  db.exec("UPDATE provider_models SET discoveredContextWindow=4096, contextWindowOverride=512");
  assert.deepEqual(codes(), ["insufficient-context"]);
  db.exec("UPDATE provider_models SET contextWindowOverride=NULL");
  assert.deepEqual(codes(), []);
  db.exec("UPDATE connections SET provider='openai'");
  assert.deepEqual(codes(), ["missing-credentials"]);
  db.exec("UPDATE connections SET credential='never-return-this-secret'");
  assert.deepEqual(codes(), []);
  assert.ok(!JSON.stringify(issues.list("agent", "warning", 20, 0)).includes("never-return"));
  db.exec("UPDATE connections SET provider='codex',credential=NULL");
  assert.deepEqual(codes(), []);
  db.exec("UPDATE connections SET provider='ollama'");
  assert.deepEqual(codes(), []);
});

test("counts include each unresolved task and Chat once, even while another task runs, and clear on retry/cancel/deletion", async t => {
  const db = openDatabase(":memory:");
  seed(db);
  const connections = new ConnectionService(db);
  const engine = new AgentExecution(db, connections, { autoStart: false });
  t.after(async () => { await engine.close(); await connections.close(); db.close(); });
  function submit(agentId: string, target: string, status: string, key: string) {
    const result = engine.submit(agentId, target, `Work ${key}`, `request_${key}`);
    db.prepare("UPDATE agent_tasks SET status=?,error=? WHERE id=?").run(status, status === "failed" ? "Recorded failure" : null, result.taskId);
    db.prepare("UPDATE agent_turns SET status=? WHERE id=?").run(status, result.turnId);
    return result;
  }
  const failed = submit("agent", "new", "failed", "first");
  const chat = submit("agent", "chat", "blocked", "chat");
  const running = submit("agent", "new", "running", "running");
  submit("agent", "new", "waiting", "waiting");
  submit("agent", "new", "awaiting_user", "input");
  submit("other", "new", "failed", "other");
  assert.equal(engine.requiredAgent("agent").state, "running");
  assert.deepEqual(engine.requiredAgent("agent").issueCounts, { warning: 0, error: 2 });
  assert.equal(engine.issues.list("agent", "error", 20, 0).items.find(item => item.taskId === failed.taskId)?.message, "Recorded failure");
  assert.ok(engine.issues.list("agent", "error", 20, 0).items.some(item => item.taskTitle === "Chat"));
  const retry = engine.retry(failed.taskId!);
  assert.equal(engine.requiredAgent("agent").issueCounts.error, 1);
  // A second failed attempt still contributes only one issue for this task.
  db.prepare("UPDATE agent_turns SET status='failed' WHERE id=?").run(retry.turnId);
  db.prepare("UPDATE agent_tasks SET status='failed' WHERE id=?").run(failed.taskId);
  assert.equal(engine.requiredAgent("agent").issueCounts.error, 2);
  await engine.cancelTask(chat.taskId!);
  assert.equal(engine.requiredAgent("agent").issueCounts.error, 1);
  db.prepare("DELETE FROM agent_tasks WHERE id=?").run(failed.taskId);
  assert.equal(engine.requiredAgent("agent").issueCounts.error, 0);
  await engine.cancelTask(running.taskId!);
});

test("issue API paginates all failures and validates severity, ownership and pagination", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-issues-"));
  const path = join(directory, "app.sqlite");
  const db = openDatabase(path);
  const workspace = seed(db);
  for (let i = 0; i < 25; i++) {
    const id = `task-${String(i).padStart(2, "0")}`;
    db.prepare("INSERT INTO conversations(id,agentId,kind,createdAt) VALUES (?,'agent','task','now')").run(id);
    db.prepare("INSERT INTO agent_tasks(id,agentId,conversationId,title,status,error,createdAt,updatedAt) VALUES (?,'agent',?,?,'failed','Retry this work','now','now')").run(id, id, id);
  }
  db.close();
  const app = createApp({ databasePath: path, filesRoot: join(directory, "files"), serveStatic: false, execution: { autoStart: false } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const first = await app.inject("/api/agents/agent/issues?severity=error");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().items.length, 20);
  assert.equal(first.json().total, 25);
  const rest = (await app.inject("/api/agents/agent/issues?severity=error&offset=20")).json();
  assert.equal(rest.items.length, 5);
  assert.equal(new Set([...first.json().items, ...rest.items].map(item => item.id)).size, 25);
  assert.deepEqual((await app.inject(`/api/workspaces/${workspace}/agents`)).json().items.find((a: { id: string }) => a.id === "agent").issueCounts, { warning: 0, error: 25 });
  assert.equal((await app.inject("/api/agents/other/issues?severity=error")).json().total, 0);
  assert.equal((await app.inject("/api/agents/missing/issues?severity=error")).statusCode, 404);
  for (const query of ["", "severity=other", "severity=error&limit=101", "severity=error&offset=-1"])
    assert.equal((await app.inject(`/api/agents/agent/issues?${query}`)).statusCode, 400, query);
});

test("shared configuration mutations invalidate affected workspaces before bindings are removed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-issue-events-"));
  const path = join(directory, "app.sqlite");
  const db = openDatabase(path);
  const workspace = seed(db);
  db.exec("INSERT INTO workspaces(id,name,createdAt,updatedAt) VALUES ('second','Second','now','now'); UPDATE agents SET workspaceId='second' WHERE id='other'");
  const app = createApp({ databasePath: path, filesRoot: join(directory, "files"), serveStatic: false, execution: { autoStart: false } });
  t.after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  async function change(method: "PATCH" | "DELETE", url: string, payload?: object) {
    const before = (db.prepare("SELECT coalesce(max(sequence),0) n FROM execution_events").get() as { n: number }).n;
    const response = await app.inject({ method, url, payload });
    assert.ok(response.statusCode < 300, response.body);
    const events = db.prepare("SELECT DISTINCT workspaceId FROM execution_events WHERE sequence>? AND kind='issues' ORDER BY workspaceId").all(before) as { workspaceId: string }[];
    assert.deepEqual(events.map(event => event.workspaceId), [workspace, "second"].sort());
  }
  await change("PATCH", "/api/model-presets/preset", { name: "Edited" });
  const beforeFailure = (db.prepare("SELECT max(sequence) n FROM execution_events").get() as { n: number }).n;
  assert.equal((await app.inject({ method: "PATCH", url: "/api/model-presets/preset", payload: { name: "" } })).statusCode, 400);
  assert.equal((db.prepare("SELECT max(sequence) n FROM execution_events").get() as { n: number }).n, beforeFailure);
  await change("PATCH", "/api/connections/connection/models/model", { contextWindowOverride: 512 });
  assert.equal((await app.inject("/api/agents/agent")).json().issueCounts.warning, 1);
  await change("PATCH", "/api/connections/connection", { name: "Edited Provider" });
  await change("DELETE", "/api/connections/connection");
  assert.equal((await app.inject("/api/agents/agent/issues?severity=warning")).json().items[0].id, "missing-provider");
  await change("DELETE", "/api/model-presets/preset");
  assert.equal((await app.inject("/api/agents/agent/issues?severity=warning")).json().items[0].id, "missing-preset");
});
