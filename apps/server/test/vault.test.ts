import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { ConnectionSecrets } from "../src/connection-secrets.js";
import { ConnectionService } from "../src/connection-service.js";
import { AgentExecution } from "../src/agent-execution.js";
import { MessagingService } from "../src/messaging.js";
import { ManagedFiles } from "../src/managed-files.js";
import { Vault, redactSecrets } from "../src/vault.js";
import { ProcessService } from "../src/process-service.js";
import { ArtifactService } from "../src/artifact-service.js";
import { AgentTools, validateTool } from "../src/agent-tools.js";

async function setup(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "ufai-vault-test-"));
  const path = join(directory, "app.sqlite");
  const db = openDatabase(path), crypto = new ConnectionSecrets(path + ".connections");
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  for (const id of ["a", "b"]) db.prepare("INSERT INTO agents(id,workspaceId,name,createdAt,updatedAt) VALUES(?,?,?,'now','now')").run(id, workspaceId, id);
  const connections = new ConnectionService(db), files = new ManagedFiles(db, join(directory, "files"));
  const processes = new ProcessService(db, files, () => {}), artifacts = new ArtifactService(db, files, () => {});
  const tools = new AgentTools(db, files, processes, artifacts, () => {});
  const engine = new AgentExecution(db, connections, { autoStart: false }, files, tools);
  files.bind(engine); await files.start(); await artifacts.start(); tools.ready = true;
  const messaging = new MessagingService(db, engine, connections); engine.messaging = messaging;
  const vault = new Vault(db, crypto, () => {}); vault.messaging = messaging; tools.messaging = messaging; tools.vault = vault;
  const task = engine.submit("a", "new", "Private work", randomUUID());
  const owner = { workspaceId, agentId: "a", taskId: task.taskId!, turnId: task.turnId };
  db.prepare("UPDATE agent_turns SET status='running' WHERE id=?").run(task.turnId);
  db.prepare("UPDATE agent_tasks SET status='running' WHERE id=?").run(owner.taskId);
  t.after(async () => { vault.close(); await engine.close(); await messaging.close(); await processes.close(); await artifacts.close(); await connections.close(); await files.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, db, vault, crypto, owner, engine, messaging, connections, tools };
}

test("vault values are encrypted, authenticated, revisioned, and preserve opaque whitespace", async t => {
  const s = await setup(t), value = "  private-value\nwith-newlines  ";
  const saved = s.vault.save({ name: "Service", value });
  assert.equal(s.vault.value(saved.id), value);
  assert.equal(JSON.stringify(saved).includes(value), false);
  const row = s.db.prepare("SELECT ciphertext FROM vault_secrets WHERE id=?").get(saved.id) as { ciphertext: string };
  assert.ok(!row.ciphertext.includes(value));
  assert.equal(new ConnectionSecrets(s.path + ".connections").decrypt(row.ciphertext, "vault:" + saved.id), value);
  assert.throws(() => s.crypto.decrypt(row.ciphertext, "vault:wrong-id"));
  assert.equal((await stat(join(s.path + ".connections", "connections.key"))).mode & 0o777, 0o600);
  assert.throws(() => s.vault.save({ name: "Changed", expectedRevision: 0 }, saved.id), /changed/);
  const changed = s.vault.save({ description: "Useful", expectedRevision: 1 }, saved.id);
  assert.equal(changed.revision, 2); assert.equal(s.vault.value(saved.id), value);
  assert.throws(() => s.vault.delete(saved.id, 1), /changed/);
  s.db.prepare("UPDATE vault_secrets SET ciphertext=? WHERE id=?").run(Buffer.alloc(40).toString("base64"), saved.id);
  assert.throws(() => s.vault.value(saved.id), /Cannot unlock/);
  assert.throws(() => s.vault.save({ name: "Other", value: "other" }), /Cannot unlock/);
});

test("missing encryption key never gets replaced while encrypted records exist", async t => {
  const s = await setup(t), saved = s.vault.save({ name: "Key", value: "vault-canary-missing-key" });
  const keyPath = join(s.path + ".connections", "connections.key");
  await unlink(keyPath);
  const vault = new Vault(s.db, new ConnectionSecrets(s.path + ".connections"), () => {});
  assert.throws(() => vault.value(saved.id), /Cannot unlock/);
  assert.throws(() => vault.save({ name: "Another", value: "other" }), /Cannot unlock/);
  await assert.rejects(readFile(keyPath), { code: "ENOENT" });
});

test("private input creates one Inbox notification, yields, resolves once and resumes with metadata only", async t => {
  const s = await setup(t);
  const r = s.vault.request(s.owner, { kind: "secret", name: "Login", purpose: "Sign in" }, "call-one");
  assert.equal(s.vault.request(s.owner, { kind: "secret", name: "Login", purpose: "Sign in" }, "call-one").id, r.id);
  assert.equal((s.db.prepare("SELECT count(*) n FROM workspace_inbox").get() as any).n, 1);
  assert.equal(s.messaging.yieldTask(s.owner, "Waiting for private input").taskYield, true);
  assert.equal(s.engine.task(s.owner.taskId).pendingReason, "user_input");
  s.db.prepare("UPDATE agent_turns SET status='completed',phase='yielded' WHERE id=?").run(s.owner.turnId);
  s.db.prepare("UPDATE agent_tasks SET status='waiting' WHERE id=?").run(s.owner.taskId);
  const value = "private-input-canary-9765";
  const fulfilled = s.vault.resolve(r.id, { value });
  assert.equal(fulfilled.state, "fulfilled"); assert.equal(s.vault.value(fulfilled.secretId!), value);
  assert.equal(s.vault.resolve(r.id, { value: "different" }).secretId, fulfilled.secretId);
  assert.equal(s.vault.list().total, 1);
  s.messaging.start();
  const turns = s.db.prepare("SELECT * FROM agent_turns WHERE taskId=? ORDER BY rowid").all(s.owner.taskId) as any[];
  assert.equal(turns.length, 2);
  assert.equal((s.db.prepare("SELECT deliveredTurnId FROM user_input_requests WHERE id=?").get(r.id) as any).deliveredTurnId, turns[1].id);
  const serialized = JSON.stringify([
    s.db.prepare("SELECT * FROM agent_messages").all(), s.db.prepare("SELECT * FROM execution_items").all(),
    s.db.prepare("SELECT * FROM workspace_inbox").all(), s.db.prepare("SELECT * FROM user_input_requests").all(),
  ]);
  assert.ok(!serialized.includes(value)); assert.ok(serialized.includes(fulfilled.secretId!));
});

test("private request revisions, declined input, ownership and task cancellation", async t => {
  const s = await setup(t), saved = s.vault.save({ name: "Service", value: "first" });
  const r = s.vault.request(s.owner, { kind: "secret", name: "Service", purpose: "Replace", secretId: saved.id }, "replace");
  s.vault.save({ value: "second", expectedRevision: 1 }, saved.id);
  assert.throws(() => s.vault.resolve(r.id, { value: "third" }), /changed/);
  assert.equal(s.vault.requestDetail(r.id).state, "pending");
  assert.equal(s.vault.value(saved.id), "second");
  assert.equal(s.vault.resolve(r.id, { value: "third", expectedRevision: 2 }).state, "fulfilled");
  const declined = s.vault.request(s.owner, { kind: "secret", name: "Other", purpose: "Optional" }, "decline");
  assert.throws(() => s.vault.cancel(declined.id, { ...s.owner, taskId: "other" }), /outside/);
  assert.equal(s.vault.resolve(declined.id, { decline: true }).state, "declined");
  const cancelled = s.vault.request(s.owner, { kind: "secret", name: "Cancel", purpose: "Unneeded" }, "cancel");
  s.messaging.cancelTaskCheckIns(s.owner.taskId);
  assert.equal(s.vault.requestDetail(cancelled.id).state, "cancelled");
});

test("private HTTP injects references, refuses redirects and redacts echoes before output", async t => {
  const s = await setup(t), value = "private-api-canary\nα";
  const saved = s.vault.save({ name: "API", value });
  let sent: RequestInit | undefined;
  const vault = new Vault(s.db, s.crypto, () => {}, async (_url, init) => {
    sent = init;
    return new Response(JSON.stringify({ echo: value, encoded: encodeURIComponent(value) }), { status: 200 });
  });
  const args = { url: "https://example.com/token", method: "POST", json: { token: { secretId: saved.id }, nested: [{ secretId: saved.id, prefix: "Value " }] } };
  const result = await vault.http(args, new AbortController().signal);
  assert.equal(JSON.parse(sent!.body as string).token, value);
  assert.equal(sent!.redirect, "manual"); assert.equal(new Headers(sent!.headers).get("sec-fetch-site"), "cross-site");
  assert.ok(!JSON.stringify(result).includes(value)); assert.ok(!result.body.includes(encodeURIComponent(value))); assert.match(result.body, /secret hidden/);
  assert.equal(JSON.stringify(args).includes(value), false);
  await assert.rejects(vault.http({ url: "http://example.com" }, new AbortController().signal), /HTTPS/);
  await assert.rejects(vault.http({ url: "https://example.com", headers: { "Sec-Fetch-Site": "same-origin" } }, new AbortController().signal), /header/);
  assert.deepEqual(redactSecrets({ status: 200, body: "a" }, ["a"]), { status: 200, body: "[secret hidden]" });
  assert.throws(() => validateTool("user_input_request", { kind: "secret", name: "Key", purpose: "Auth", value: "no" }), /Unknown/);
});

test("vault routes return metadata, enforce local origin, and keep reveal uncached", async t => {
  const app = createApp({ databasePath: ":memory:", execution: { autoStart: false }, serveStatic: false });
  t.after(() => app.close());
  const value = "vault-route-canary";
  const created = await app.inject({ method: "POST", url: "/api/vault/secrets", payload: { name: "API", value } });
  assert.equal(created.statusCode, 201, created.body); assert.ok(!created.body.includes(value));
  const id = created.json().id;
  assert.ok(!(await app.inject("/api/vault/secrets")).body.includes(value));
  const reveal = await app.inject({ method: "POST", url: "/api/vault/secrets/" + id + "/reveal" });
  assert.equal(reveal.json().value, value); assert.equal(reveal.headers["cache-control"], "no-store");
  const denied = await app.inject({ method: "POST", url: "/api/vault/secrets/" + id + "/reveal", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
  assert.equal(denied.statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/vault/secrets/" + id + "/reveal" })).statusCode, 404);
});

test("a model requests private input, yields, resumes and uses a secret without receiving plaintext", async t => {
  const s = await setup(t), canary = "private-provider-canary-49716";
  s.db.exec("INSERT INTO connections(id,provider,name,createdAt,updatedAt,draft) VALUES('c','openai-compatible','Fixture','now','now',0); INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES('c','m','Model',1,200000); INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES('p','Preset','c','m','now','now'); UPDATE agents SET presetId='p'");
  const vault = new Vault(s.db, s.crypto, () => {}, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + canary);
    return new Response(JSON.stringify({ echoed: canary }));
  });
  vault.messaging = s.messaging; s.tools.vault = vault;
  let round = 0, reference = "";
  s.connections.countTokens = async () => 100;
  s.connections.generate = async () => ({ text: JSON.stringify({ status: "completed", summary: "Done", memories: [] }), finishReason: "stop", usage: null });
  s.connections.toolRound = async (_snapshot, request) => {
    assert.ok(!JSON.stringify([request.instructions, request.messages, request.continuation]).includes(canary));
    let call;
    switch (round++) {
      case 0: call = { id: "ask", name: "user_input_request", arguments: { kind: "secret", name: "API", purpose: "Authenticate a request" } }; break;
      case 1: call = { id: "yield", name: "task_yield", arguments: { summary: "Waiting for a private secret" } }; break;
      case 2: call = { id: "http", name: "vault_http_request", arguments: { url: "https://example.com/test", headers: { Authorization: { secretId: reference, prefix: "Bearer " } } } }; break;
      default:
        assert.match(JSON.stringify(request.continuation), /secret hidden/);
        return { text: "Authenticated the request.", calls: [], continuation: [], usage: null };
    }
    return { text: "", calls: [call], continuation: [], usage: null };
  };
  s.db.prepare("UPDATE agent_turns SET status='queued' WHERE id=?").run(s.owner.turnId);
  s.db.prepare("UPDATE agent_tasks SET status='queued' WHERE id=?").run(s.owner.taskId);
  (s.engine as any).options.autoStart = true; s.messaging.start(); s.engine.wake();
  async function until(check: () => boolean) {
    const deadline = Date.now() + 8000;
    while (!check()) { if (Date.now() > deadline) assert.fail(JSON.stringify(s.engine.task(s.owner.taskId))); await new Promise(r => setTimeout(r, 15)); }
  }
  await until(() => s.engine.task(s.owner.taskId).status === "waiting");
  const r = vault.requests(s.owner.taskId).items[0]!;
  reference = vault.resolve(r.id, { value: canary }).secretId!;
  await until(() => s.engine.task(s.owner.taskId).status === "completed");
  assert.equal(round, 4);
  const persisted = JSON.stringify([s.db.prepare("SELECT * FROM tool_invocations").all(), s.db.prepare("SELECT * FROM execution_items").all(), s.db.prepare("SELECT * FROM agent_messages").all()]);
  assert.ok(!persisted.includes(canary));
});

test("oversized private HTTP bodies never expose a secret fragment at the response boundary", async t => {
  const s = await setup(t), value = "boundary-canary-value-78543";
  const secret = s.vault.save({ name: "API", value });
  const vault = new Vault(s.db, s.crypto, () => {}, async () => new Response("x".repeat(23990) + value + "trailing"));
  const result = await vault.http({ url: "https://example.com", headers: { Authorization: { secretId: secret.id } } }, new AbortController().signal);
  assert.equal(result.body, ""); assert.equal(result.truncated, true);
});

test("creating the first Vault secret cannot replace a missing shared provider key", async t => {
  const s = await setup(t), ciphertext = s.crypto.encrypt("provider-canary", "provider");
  s.db.prepare("INSERT INTO connections(id,provider,name,credential,createdAt,updatedAt,draft) VALUES('provider','openai','Provider',?,'now','now',0)").run(ciphertext);
  const keyPath = join(s.path + ".connections", "connections.key"); await unlink(keyPath);
  const vault = new Vault(s.db, new ConnectionSecrets(s.path + ".connections"), () => {});
  assert.throws(() => vault.save({ name: "First", value: "another" }), /existing credentials/);
  await assert.rejects(readFile(keyPath), { code: "ENOENT" });
  assert.equal(vault.list().total, 0);
});
