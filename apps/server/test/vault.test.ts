import Fastify from "fastify";
import { registerInboxNotifications } from "../src/inbox-notifications.js";
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
  const feed = Fastify();
  registerInboxNotifications(feed, s.db, s.engine.events);
  t.after(() => feed.close());
  const r = s.vault.request(s.owner, { kind: "secret", name: "Login", purpose: "Sign in" }, "call-one");
  assert.equal(s.vault.request(s.owner, { kind: "secret", name: "Login", purpose: "Sign in" }, "call-one").id, r.id);
  assert.equal((s.db.prepare("SELECT count(*) n FROM workspace_inbox").get() as any).n, 1);
  const arrivals = (await feed.inject("/api/inbox/notifications?after=0")).json();
  assert.equal(arrivals.items.length, 1);
  assert.equal(arrivals.items[0].preview, "Private input requested. Open Inbox to respond.");
  assert.ok(!JSON.stringify(arrivals).includes("Login"));
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

const choices = [{ id: "fast", label: "Fast", description: "Quick result" }, { id: "careful", label: "Careful" }];
test("ordinary inputs validate typed forms and choices, defaults, bounds and payload sizes", async () => {
  const { validateDefinition, validateAnswer } = await import("../src/user-input-validation.js");
  const { InputError } = await import("../src/validation.js");
  const fields = [
    { id: "text", type: "text", label: "Text", required: true, minLength: 2, maxLength: 20, default: "Hello" },
    { id: "choice", type: "single_choice", label: "Choice", options: choices, allowOther: true },
    { id: "multi", type: "multi_select", label: "Multi", options: choices, minSelections: 1, maxSelections: 2 },
    { id: "bool", type: "boolean", label: "Boolean", required: true, default: false },
    { id: "number", type: "number", label: "Number", minimum: 0, maximum: 2 },
    { id: "integer", type: "integer", label: "Integer" },
    { id: "email", type: "email", label: "Email" }, { id: "url", type: "url", label: "URL" },
    { id: "date", type: "date", label: "Date" }, { id: "time", type: "date_time", label: "Time" },
    { id: "optional", type: "text", label: "Optional" },
  ];
  const definition = validateDefinition("form", { fields });
  const answer = { text: "Hello", choice: { selected: [], other: "Custom" }, multi: { selected: ["careful", "fast"] }, bool: false, number: 1.5, integer: 3, email: "a@example.com", url: "https://example.com/", date: "2028-02-29", time: "2028-02-29T12:30:00+02:00", optional: "" };
  const saved = validateAnswer("form", "Form", definition, answer) as any;
  assert.equal(saved.bool, false); assert.equal(saved.optional, undefined); assert.deepEqual(saved.multi.selected, ["fast", "careful"]);
  for (const [key, bad] of Object.entries({ text: "x", choice: { selected: ["missing"] }, multi: { selected: ["fast", "fast"] }, bool: "yes", number: 3, integer: 0.5, email: "no", url: "relative", date: "2026-02-30", time: "2028-02-29T12:30" })) {
    assert.throws(() => validateAnswer("form", "Form", definition, { ...answer, [key]: bad }), InputError, key);
  }
  assert.throws(() => validateAnswer("form", "Form", definition, { ...answer, bool: undefined }), InputError);
  for (const invalid of [{ fields: [...fields, fields[0]] }, { fields: Array(21).fill(fields[0]) }, { fields: [{ id: "bad", type: "number", label: "Number", default: "text" }] }, { fields: [{ id: "bad", type: "text", label: "Bad", minLength: 10, maxLength: 2 }] }]) assert.throws(() => validateDefinition("form", invalid), InputError);
  assert.throws(() => validateDefinition("single_choice", { options: Array(51).fill(choices[0]) }), InputError);
  assert.throws(() => validateDefinition("form", { fields: fields.map(f => ({ ...f, description: "界".repeat(1900) })) }), InputError);
  assert.throws(() => validateAnswer("text", "Text", {}, "界".repeat(3000)), InputError);
  assert.deepEqual(validateAnswer("single_choice", "Choice", { options: choices, allowOther: true }, { selected: [], other: "Custom" }), { selected: [], other: "Custom" });
});

test("ordinary requests persist answers, scope listings, reject conflicting writes and preserve secret isolation", async t => {
  const s = await setup(t);
  const r = s.vault.request(s.owner, { kind: "multi_select", name: "Preferences", purpose: "Choose your approach", definition: { options: choices, allowOther: true } }, "ordinary");
  assert.equal(s.engine.requiredAgent("a").pendingUserInputCount, 1);
  assert.equal(s.engine.task(s.owner.taskId).pendingReason, "user_input");
  assert.equal(s.vault.request(s.owner, { kind: "multi_select" }, "ordinary").id, r.id);
  assert.equal(s.vault.requests(undefined, 0, 100, { agentId: "a", workspaceId: s.owner.workspaceId, kind: "multi_select", state: "pending" }).total, 1);
  assert.equal(s.vault.requests(undefined, 0, 100, { agentId: "b" }).total, 0);
  assert.throws(() => s.vault.requests(undefined, 0, 100, { kind: "invalid" }));
  assert.throws(() => s.vault.cancel(r.id, { ...s.owner, taskId: "other" }), /outside/);
  const answer = { selected: ["careful", "fast"], other: "Custom" };
  const saved = s.vault.resolve(r.id, { answer });
  assert.equal(saved.state, "fulfilled");
  assert.equal(s.vault.resolve(r.id, { answer }).id, r.id);
  assert.throws(() => s.vault.resolve(r.id, { answer: { selected: ["fast"] } }), (e: any) => e.statusCode === 409 && e.request.id === r.id);
  assert.throws(() => s.vault.resolve(r.id, { decline: true }), (e: any) => e.statusCode === 409);
  assert.equal(s.vault.list().total, 0);
  assert.equal(s.engine.requiredAgent("a").pendingUserInputCount, 0);
  assert.equal((s.db.prepare("SELECT readAt FROM workspace_inbox WHERE userInputRequestId=?").get(r.id) as any).readAt !== null, true);
  assert.equal(s.vault.requests(s.owner.taskId).total, 1);
});

test("answers arriving during work are consumed fully as user input without mixing secret outcomes", async t => {
  const s = await setup(t);
  const ordinary = s.vault.request(s.owner, { kind: "text", name: "Instructions", purpose: "Clarify the requested result" }, "text");
  const secret = s.vault.request(s.owner, { kind: "secret", name: "Key", purpose: "Authenticate" }, "secret");
  const answer = "Answer " + "x".repeat(7900);
  s.vault.resolve(ordinary.id, { answer }); s.vault.resolve(secret.id, { value: "secret-canary-never-in-history" });
  const batch = s.messaging.consumeInputs(s.owner);
  assert.equal(batch.length, 1);
  let rows = s.db.prepare("SELECT authorType,content FROM agent_messages WHERE turnId=? ORDER BY sequence").all(s.owner.turnId) as any[];
  assert.ok(rows.some(row => row.authorType === "user" && row.content.includes(answer)));
  s.messaging.consumeInputs(s.owner);
  rows = s.db.prepare("SELECT authorType,content FROM agent_messages WHERE turnId=? ORDER BY sequence").all(s.owner.turnId) as any[];
  assert.ok(rows.some(row => row.authorType === "system" && row.content.includes(secret.id)));
  assert.ok(!JSON.stringify(rows).includes("secret-canary-never-in-history"));
  assert.deepEqual(s.messaging.consumeInputs(s.owner), []);
});

test("each answer or decline resumes a yielded task while other requests remain pending", async t => {
  const s = await setup(t);
  const first = s.vault.request(s.owner, { kind: "text", name: "First", purpose: "First input" }, "first");
  const second = s.vault.request(s.owner, { kind: "single_choice", name: "Second", purpose: "Second input", definition: { options: choices } }, "second");
  s.messaging.yieldTask(s.owner, "Awaiting the user");
  s.db.prepare("UPDATE agent_turns SET status='completed',phase='yielded' WHERE id=?").run(s.owner.turnId);
  s.db.prepare("UPDATE agent_tasks SET status='waiting' WHERE id=?").run(s.owner.taskId);
  s.vault.resolve(first.id, { answer: "First answer" }); s.messaging.start();
  let turns = s.db.prepare("SELECT * FROM agent_turns WHERE taskId=? ORDER BY rowid").all(s.owner.taskId) as any[];
  assert.equal(turns.length, 2);
  assert.equal(s.vault.requestDetail(second.id).state, "pending");
  assert.equal((s.db.prepare("SELECT authorType FROM agent_messages WHERE id=?").get(turns[1].inputMessageId) as any).authorType, "user");
  s.db.prepare("UPDATE agent_turns SET status='completed',phase='yielded' WHERE id=?").run(turns[1].id);
  s.db.prepare("UPDATE agent_tasks SET status='waiting' WHERE id=?").run(s.owner.taskId);
  s.vault.resolve(second.id, { decline: true });
  assert.equal(s.vault.resolve(second.id, { decline: true }).state, "declined");
  s.messaging.start();
  // start() is idempotent; force the next scheduler scan through its existing entrypoint.
  (s.messaging as any).tick();
  turns = s.db.prepare("SELECT * FROM agent_turns WHERE taskId=? ORDER BY rowid").all(s.owner.taskId) as any[];
  assert.equal(turns.length, 3);
  (s.messaging as any).tick();
  assert.equal((s.db.prepare("SELECT count(*) n FROM agent_turns WHERE taskId=?").get(s.owner.taskId) as any).n, 3);
});

test("pending input prevents completion, failed tasks retain replies and cancellation closes requests", async t => {
  const s = await setup(t);
  const r = s.vault.request(s.owner, { kind: "text", name: "Question", purpose: "Clarify" }, "ask");
  s.db.prepare("UPDATE agent_turns SET status='completed',phase='done' WHERE id=?").run(s.owner.turnId);
  (s.engine as any).refreshTask(s.owner.taskId, "completed");
  assert.equal(s.engine.task(s.owner.taskId).status, "waiting");
  s.db.prepare("UPDATE agent_tasks SET status='failed' WHERE id=?").run(s.owner.taskId);
  s.vault.resolve(r.id, { answer: "Retry later" }); s.messaging.start();
  assert.equal((s.db.prepare("SELECT deliveredTurnId FROM user_input_requests WHERE id=?").get(r.id) as any).deliveredTurnId, null);
  assert.equal(s.engine.task(s.owner.taskId).status, "failed");
  s.db.prepare("UPDATE agent_tasks SET status='blocked' WHERE id=?").run(s.owner.taskId);
  (s.messaging as any).tick();
  assert.equal((s.db.prepare("SELECT deliveredTurnId FROM user_input_requests WHERE id=?").get(r.id) as any).deliveredTurnId, null);
  const next = s.vault.request(s.owner, { kind: "text", name: "Next", purpose: "Next question" }, "next");
  s.messaging.cancelTaskCheckIns(s.owner.taskId);
  assert.equal(s.vault.requestDetail(next.id).state, "cancelled");
  assert.equal(s.engine.requiredAgent("a").pendingUserInputCount, 0);
});

test("version 33 migration preserves secret requests, Inbox foreign keys and undelivered outcomes", async t => {
  const s = await setup(t);
  const pending = s.vault.request(s.owner, { kind: "secret", name: "Pending", purpose: "Awaiting entry" }, "pending");
  const answered = s.vault.request(s.owner, { kind: "secret", name: "Answered", purpose: "Saved entry" }, "answered");
  const fulfilled = s.vault.resolve(answered.id, { value: "migration-secret" });
  let sql = (s.db.prepare("SELECT sql FROM sqlite_master WHERE name='user_input_requests'").get() as any).sql as string;
  sql = sql.replace("CREATE TABLE \"user_input_requests\"", "CREATE TABLE legacy_inputs").replace("CREATE TABLE user_input_requests", "CREATE TABLE legacy_inputs").replace("CHECK(kind IN ('secret','text','single_choice','multi_select','form'))", "CHECK(kind='secret')").replace(/,\s*definition TEXT NOT NULL DEFAULT '\{\}', answer TEXT/, "");
  s.db.pragma("foreign_keys=OFF");
  s.db.exec(sql);
  const columns = (s.db.prepare("PRAGMA table_info(legacy_inputs)").all() as any[]).map(c => c.name).join(",");
  s.db.exec(`INSERT INTO legacy_inputs(${columns}) SELECT ${columns} FROM user_input_requests; DROP TABLE user_input_requests; ALTER TABLE legacy_inputs RENAME TO user_input_requests; PRAGMA user_version=33`);
  s.db.pragma("foreign_keys=ON");
  const upgraded = openDatabase(s.path); t.after(() => upgraded.close());
  assert.equal(upgraded.pragma("user_version", { simple: true }), 42);
  assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
  assert.equal((upgraded.prepare("SELECT secretId FROM user_input_requests WHERE id=?").get(answered.id) as any).secretId, fulfilled.secretId);
  assert.equal((upgraded.prepare("SELECT deliveredTurnId FROM user_input_requests WHERE id=?").get(answered.id) as any).deliveredTurnId, null);
  assert.equal((upgraded.prepare("SELECT userInputRequestId FROM workspace_inbox WHERE userInputRequestId=?").get(pending.id) as any).userInputRequestId, pending.id);
  s.messaging.start();
  assert.equal(s.vault.requestDetail(pending.id).state, "pending");
});

test("typed request tool schema accepts numeric bounds and typed defaults through the dispatcher", () => {
  validateTool("user_input_request", { kind: "form", name: "Form", purpose: "Clarify", definition: { fields: [
    { id: "n", label: "Number", type: "number", minimum: 0.5, maximum: 2.5, default: 1.5 },
    { id: "b", label: "Boolean", type: "boolean", default: false },
    { id: "c", label: "Choice", type: "single_choice", options: choices, default: { selected: ["fast"] } },
  ] } });
});

test("ordinary HTTP request resolution supports Inbox answers, filters and authoritative conflicts", async t => {
  const s = await setup(t), app = Fastify();
  const { registerVault } = await import("../src/vault-routes.js");
  const { InputError } = await import("../src/validation.js");
  app.setErrorHandler((e: any, _req, reply) => reply.code(e instanceof InputError ? 400 : e.statusCode ?? 500).send({ error: e.message, ...(e instanceof InputError ? { fields: e.fields } : {}) }));
  registerVault(app, s.vault, s.engine.events); t.after(() => app.close());
  const r = s.vault.request(s.owner, { kind: "single_choice", name: "Approach", purpose: "Choose approach", definition: { options: choices } }, "api");
  const listing = await app.inject(`/api/user-input-requests?agentId=a&workspaceId=${s.owner.workspaceId}&state=pending&kind=single_choice`);
  assert.equal(listing.json().items[0].id, r.id); assert.equal(listing.headers["cache-control"], "no-store");
  const invalid = await app.inject({ method: "POST", url: `/api/user-input-requests/${r.id}/resolve`, payload: { answer: { selected: ["bad"] } } });
  assert.equal(invalid.statusCode, 400); assert.ok(invalid.json().fields.answer);
  const done = await app.inject({ method: "POST", url: `/api/user-input-requests/${r.id}/resolve`, payload: { answer: { selected: ["fast"] } } });
  assert.equal(done.statusCode, 200); assert.deepEqual(done.json().answer, { selected: ["fast"] });
  const conflict = await app.inject({ method: "POST", url: `/api/user-input-requests/${r.id}/resolve`, payload: { answer: { selected: ["careful"] } } });
  assert.equal(conflict.statusCode, 409); assert.deepEqual(conflict.json().request.answer, { selected: ["fast"] });
  const denied = await app.inject({ method: "POST", url: `/api/user-input-requests/${r.id}/resolve`, headers: { origin: "https://external.example", "sec-fetch-site": "cross-site" }, payload: { decline: true } });
  assert.equal(denied.statusCode, 403);
});

test("ordinary model tool requests yield, resume per reply and cannot complete with another answer pending", async t => {
  const s = await setup(t);
  s.db.exec("INSERT INTO connections(id,provider,name,createdAt,updatedAt,draft) VALUES('c','openai-compatible','Fixture','now','now',0); INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES('c','m','Model',1,200000); INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES('p','Preset','c','m','now','now'); UPDATE agents SET presetId='p'");
  let round = 0;
  s.connections.countTokens = async () => 100;
  s.connections.generate = async (_snapshot, request) => {
    assert.match(request.messages[0]!.content as string, /originalRequest/);
    return { text: JSON.stringify({ status: "completed", summary: "Processed available answers", memories: [] }), finishReason: "stop", usage: null };
  };
  s.connections.toolRound = async (_snapshot, request) => {
    const step = round++;
    let call;
    if (step === 0) { assert.match(request.instructions, /Whenever you need information/); call = { id: "first", name: "user_input_request", arguments: { kind: "text", name: "Audience", purpose: "Who is the report for?" } }; }
    else if (step === 1) call = { id: "second", name: "user_input_request", arguments: { kind: "single_choice", name: "Approach", purpose: "Choose the approach", definition: { options: choices, default: { selected: ["fast"] } } } };
    else if (step === 2) call = { id: "yield", name: "task_yield", arguments: { summary: "Waiting for user answers" } };
    else { assert.match(JSON.stringify(request.messages), step === 3 ? /Product team/ : /careful/); return { text: "Processed the available answer.", calls: [], continuation: [], usage: null }; }
    return { text: "", calls: [call], continuation: [], usage: null };
  };
  s.db.prepare("UPDATE agent_turns SET status='queued' WHERE id=?").run(s.owner.turnId);
  s.db.prepare("UPDATE agent_tasks SET status='queued' WHERE id=?").run(s.owner.taskId);
  (s.engine as any).options.autoStart = true; s.messaging.start(); s.engine.wake();
  async function until(check: () => boolean) { const deadline = Date.now() + 8000; while (!check()) { if (Date.now() > deadline) assert.fail(JSON.stringify(s.engine.task(s.owner.taskId))); await new Promise(r => setTimeout(r, 15)); } }
  await until(() => s.engine.task(s.owner.taskId).status === "waiting");
  const all = s.vault.requests(s.owner.taskId).items;
  s.vault.resolve(all.find(r => r.kind === "text")!.id, { answer: "Product team" });
  await until(() => round === 4 && s.engine.task(s.owner.taskId).status === "waiting");
  assert.equal(s.engine.requiredAgent("a").pendingUserInputCount, 1);
  s.vault.resolve(all.find(r => r.kind === "single_choice")!.id, { answer: { selected: ["careful"] } });
  await until(() => s.engine.task(s.owner.taskId).status === "completed");
  assert.equal(round, 5); assert.equal(s.engine.requiredAgent("a").pendingUserInputCount, 0);
  const inputs = s.db.prepare("SELECT authorType,content FROM agent_messages WHERE conversationId=(SELECT conversationId FROM agent_tasks WHERE id=?) AND authorType='user'").all(s.owner.taskId);
  assert.match(JSON.stringify(inputs), /Product team/); assert.match(JSON.stringify(inputs), /careful/);
});
