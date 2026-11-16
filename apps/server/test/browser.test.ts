import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { openDatabase } from "../src/database.js";
import { ManagedFiles } from "../src/managed-files.js";
import { Skills } from "../src/skills.js";
import { BrowserService } from "../src/browser-service.js";
import { AgentTools } from "../src/agent-tools.js";
import { AgentExecution } from "../src/agent-execution.js";
import { ConnectionService } from "../src/connection-service.js";
import { ProcessService } from "../src/process-service.js";
import { ArtifactService } from "../src/artifact-service.js";
import { browserAction } from "../src/browser-validation.js";
import { createApp } from "../src/app.js";
import type { BrowserServerMessage } from "../src/browser-types.js";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Browser fixture timed out"); await delay(30); }
}
async function website(t: TestContext) {
  const server = createServer((req, res) => {
    if (req.url === "/large-download") { res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="large.bin"', "Content-Length": 2 * 1024 * 1024 }); res.end(Buffer.alloc(2 * 1024 * 1024)); return; }
    if (req.url === "/download") { res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="example.txt"' }); res.end("website download"); return; }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><title>${req.url === "/next" ? "Next" : "Fixture"}</title>
      <label>Draft<input aria-label="Draft"></label><p id="status">Ready</p>
      <button onclick="document.cookie='browser-test=kept;max-age=3600;path=/';document.cookie='session-only=kept;path=/';localStorage.setItem('saved','yes');document.getElementById('status').textContent='Saved '+localStorage.getItem('saved')">Save session</button>
      <button onclick="document.getElementById('status').textContent='Cookie '+document.cookie+' storage '+localStorage.getItem('saved')">Read session</button>
      <a href="/next">Next page</a><a href="/next" target="_blank">Popup</a><a href="/download">Download</a><a href="/large-download">Large download</a>
      <button onclick="alert('Website notice')">Alert</button><button onclick="document.getElementById('status').textContent=prompt('Website question','default')">Prompt</button>
      <label>Upload<input type="file" aria-label="Upload" onchange="document.getElementById('status').textContent='Uploaded '+this.files[0].name"></label>
      <div style="height:1600px"></div><button onclick="document.getElementById('status').textContent='At bottom'">Bottom button</button>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function runtime(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ufai-browser-test-"));
  let current: Awaited<ReturnType<typeof boot>>;
  async function boot() {
    const db = openDatabase(join(root, "app.sqlite"));
    const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
    if (!db.prepare("SELECT 1 FROM agents LIMIT 1").get()) {
      db.prepare("INSERT INTO connections(id,provider,name,createdAt,updatedAt,draft) VALUES('connection','openai-compatible','Fixture','now','now',0)").run();
      db.prepare("INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES('connection','model','Model',1,64000)").run();
      db.prepare("INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES('preset','Fixture','connection','model','now','now')").run();
      for (const id of ["a", "b"]) db.prepare("INSERT INTO agents(id,workspaceId,name,presetId,createdAt,updatedAt) VALUES(?,?,?,'preset','now','now')").run(id, workspaceId, id);
    }
    const files = new ManagedFiles(db), connections = new ConnectionService(db);
    const processes = new ProcessService(db, files, () => {}), artifacts = new ArtifactService(db, files, () => {});
    const skills = new Skills(db, files, () => {}), browsers = new BrowserService(db, files, skills, () => {}, { maxTransferBytes: 1024 * 1024 });
    const tools = new AgentTools(db, files, processes, artifacts, () => {});
    tools.skills = skills; tools.browser = browsers;
    skills.onEnabledChanged = (id, skill, enabled) => browsers.enabledChanged(id, skill, enabled);
    files.agentBrowser = browsers;
    const engine = new AgentExecution(db, connections, { autoStart: false }, files, tools); files.bind(engine);
    await files.start(); await skills.start(); await artifacts.start(); tools.ready = true;
    const task = engine.submit("a", "chat", "Browse", randomUUID());
    const owner = { workspaceId, agentId: "a", taskId: task.taskId!, turnId: task.turnId };
    const dispatch = (name: string, args: Record<string, unknown> = {}, id = randomUUID()) => tools.dispatch(owner, { id, name, arguments: args }, new AbortController().signal, async () => {});
    async function close() { await engine.close(); await browsers.close(); await skills.close(); await processes.close(); await artifacts.close(); await files.close(); await connections.close(); db.close(); }
    return { db, workspaceId, files, skills, browsers, tools, engine, owner, dispatch, close };
  }
  current = await boot();
  t.after(async () => { await current.close(); await rm(root, { recursive: true, force: true }); });
  return { get current() { return current; }, async restart() { await current.close(); current = await boot(); return current; } };
}
class Viewer extends EventEmitter {
  readyState = 1; bufferedAmount = 0; messages: BrowserServerMessage[] = [];
  send(raw: string) { this.messages.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit("close"); }
}
function ref(snapshot: string, label: string) {
  const line = snapshot.split("\n").find(line => line.includes(`"${label}"`));
  assert.ok(line, snapshot);
  const match = line.match(/\[ref=([^\]]+)\]/); assert.ok(match, line); return match[1]!;
}
async function snapshot(f: Awaited<ReturnType<typeof runtime>>["current"]) { return String((await f.browsers.action("a", { action: "snapshot" })).snapshot); }
async function click(f: Awaited<ReturnType<typeof runtime>>["current"], label: string) { return f.browsers.action("a", { action: "click", ref: ref(await snapshot(f), label) }); }

test("Browser defaults are consistent across filters, details, catalog and saved disable overrides", async t => {
  const rt = await runtime(t); let f = rt.current;
  assert.equal(f.skills.list("a", { status: "enabled" }).total, 2);
  assert.deepEqual(f.skills.catalog("a").map(s => s.id), ["builtin-browser", "builtin-duckduckgo-instant-answer"]);
  assert.deepEqual((await f.skills.detail("builtin-browser", "a")).enabledAgents.map(a => a.id), ["a", "b"]);
  assert.equal((await f.dispatch("skill_activate", { skillId: "builtin-browser" })).ok, true);
  f.skills.setEnabled("a", "builtin-browser", false);
  assert.deepEqual(f.skills.catalog("a").map(s => s.id), ["builtin-duckduckgo-instant-answer"]);
  assert.deepEqual(f.skills.activeContext("a", f.owner.taskId), []);
  assert.equal(f.skills.list("a", { status: "disabled" }).total, 3);
  assert.equal((await f.dispatch("browser_snapshot")).ok, false);
  await assert.rejects(f.browsers.start("a"), /disabled/);
  f = await rt.restart();
  assert.equal(f.browsers.state("a").enabled, false);
  assert.equal(f.browsers.state("b").enabled, true);
  assert.equal(f.browsers.state("a").status, "idle");
});

test("real Chromium preserves live forms, scroll and tabs across toggles and viewer closure, and restores profile/tab data after restart", async t => {
  const url = await website(t); const rt = await runtime(t); let f = rt.current;
  await f.browsers.action("a", { action: "navigate", url });
  await f.browsers.action("a", { action: "fill", ref: ref(await snapshot(f), "Draft"), text: "Unsaved draft" });
  await click(f, "Save session");
  await f.browsers.action("a", { action: "scroll", x: 0, y: 500 });
  const s = (f.browsers as any).sessions.get("a");
  const page = s.pages.get(s.activeTabId);
  await until(async () => await page.evaluate(() => scrollY) > 0);
  const y = await page.evaluate(() => scrollY);
  const tabId = f.browsers.state("a").activeTabId;
  const viewer = new Viewer(); const viewerId = f.browsers.attach("a", viewer as unknown as WebSocket);
  await until(() => viewer.messages.some(m => m.type === "frame"));
  await f.browsers.control("a", viewerId, true);
  f.skills.setEnabled("a", "builtin-browser", false);
  assert.equal(viewer.readyState, 3);
  assert.equal(s.context.pages()[0], page);
  assert.equal(await page.evaluate(() => scrollY), y);
  f.skills.setEnabled("a", "builtin-browser", true);
  await f.browsers.start("a");
  assert.equal(f.browsers.state("a").activeTabId, tabId);
  assert.match(await snapshot(f), /Unsaved draft/);
  assert.equal(await page.evaluate(() => scrollY), y);
  const again = new Viewer(); const againId = f.browsers.attach("a", again as unknown as WebSocket);
  await f.browsers.control("a", againId, true); again.close();
  assert.equal(f.browsers.state("a").controller, null);
  assert.match(await snapshot(f), /Unsaved draft/);
  await click(f, "Popup");
  await until(() => f.browsers.state("a").tabs.length === 2);
  const selected = f.browsers.state("a").activeTabId;
  f = await rt.restart();
  assert.equal(f.browsers.state("a").status, "idle");
  await f.browsers.start("a");
  assert.equal(f.browsers.state("a").tabs.length, 2);
  assert.equal(f.browsers.state("a").activeTabId, selected);
  await f.browsers.action("a", { action: "navigate", url }); await click(f, "Read session");
  assert.match(await snapshot(f), /browser-test=kept; session-only=kept storage yes/);
  await f.browsers.action("b", { action: "navigate", url });
  const b = (await f.browsers.action("b", { action: "snapshot" })).snapshot;
  assert.doesNotMatch(String(b), /Unsaved draft/);
  const bSession = (f.browsers as any).sessions.get("b");
  assert.equal((await bSession.context.cookies()).length, 0);
});

test("real browser tools journal effects, serialize tasks, enforce handoff and cancel without closing pages", async t => {
  const url = await website(t); const { current: f } = await runtime(t);
  assert.equal((await f.dispatch("browser_navigate", { action: "navigate", url })).ok, true);
  const first = await f.dispatch("browser_tabs", { action: "newTab" }, "same-call");
  assert.equal(first.ok, true);
  assert.deepEqual(await f.dispatch("browser_tabs", { action: "newTab" }, "same-call"), first);
  assert.equal(f.browsers.state("a").tabs.length, 2);
  const viewer = new Viewer(); const id = f.browsers.attach("a", viewer as unknown as WebSocket);
  const waiting = f.browsers.action("a", { action: "wait", ms: 100 });
  const take = f.browsers.control("a", id, true);
  await waiting; await take;
  assert.equal((await f.dispatch("browser_navigate", { action: "navigate", url })).ok, false);
  const other = new Viewer(); const otherId = f.browsers.attach("a", other as unknown as WebSocket);
  await assert.rejects(f.browsers.control("a", otherId, true), /Another/);
  await f.browsers.action("a", { action: "navigate", url }, undefined, id);
  await f.browsers.control("a", id, false);
  const abort = new AbortController(); const pending = f.browsers.action("a", { action: "wait", ms: 5000 }, abort.signal);
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(pending, /abort/i);
  assert.equal(f.browsers.state("a").status, "ready");
  assert.match(await snapshot(f), /Fixture|Draft/);
  other.close(); viewer.close();
});

test("real browser handles file uploads, website downloads, screenshots and JavaScript dialogs", async t => {
  const url = await website(t); const { current: f } = await runtime(t);
  await f.browsers.action("a", { action: "navigate", url });
  const folder = f.files.location("agent", "a").path;
  const source = join(folder, "source.txt"); await writeFile(source, "upload body");
  await f.browsers.upload("a", [source], ref(await snapshot(f), "Upload"));
  assert.match(await snapshot(f), /Uploaded source.txt/);
  await click(f, "Download");
  await until(() => f.browsers.state("a").downloads[0]?.state !== undefined && f.browsers.state("a").downloads[0]?.state !== "downloading");
  const download = f.browsers.state("a").downloads[0]!;
  assert.equal(download.state, "ready", JSON.stringify(download));
  assert.equal(await readFile(join(folder, download.path!), "utf8"), "website download");
  const shot = await f.dispatch("browser_screenshot"); assert.equal(shot.ok, true, JSON.stringify(shot));
  assert.equal((await readFile(String(shot.path))).subarray(1, 4).toString(), "PNG");
  // An open dialog must remain handleable while its triggering click awaits a browser acknowledgement.
  const alert = click(f, "Alert");
  await until(() => !!f.browsers.state("a").dialog);
  await f.browsers.action("a", { action: "dialog", accept: true });
  await alert;
  assert.equal(f.browsers.state("a").dialog, null);
  const prompt = click(f, "Prompt");
  await until(() => !!f.browsers.state("a").dialog);
  await f.browsers.action("a", { action: "dialog", accept: true, text: "Answered" }); await prompt;
  assert.match(await snapshot(f), /Answered/);
});

test("HTTP and WebSocket routes enforce origin, enablement and live controller ownership", async t => {
  const websiteUrl = await website(t);
  const root = await mkdtemp(join(tmpdir(), "ufai-browser-http-"));
  const app = createApp({ databasePath: join(root, "db.sqlite"), serveStatic: false, execution: { autoStart: false } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = (await app.inject("/api/workspaces")).json().items[0];
  const agent = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/agents`, payload: { name: "Browser" } })).json();
  const prefix = `/api/agents/${agent.id}/browser`;
  assert.equal((await app.inject({ url: prefix, headers: { origin: "https://external.example" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `${prefix}/actions`, payload: { viewerId: "forged", action: { action: "newTab" } } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: `${prefix}/start` })).statusCode, 200);
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}${prefix}/stream`, { origin: address });
  t.after(() => socket.close());
  const messages: BrowserServerMessage[] = []; socket.on("message", data => messages.push(JSON.parse(data.toString())));
  await until(() => messages.some(m => m.type === "hello") && messages.some(m => m.type === "frame"));
  socket.send(JSON.stringify({ type: "control", take: true }));
  await until(() => messages.some(m => m.type === "state" && !!m.state.controller));
  const viewer = messages.find(m => m.type === "hello") as Extract<BrowserServerMessage, { type: "hello" }>;
  const boundary = `test-${randomUUID()}`;
  const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nupload\r\n--${boundary}--\r\n`);
  // No website chooser is open, so a well-formed transfer reaches the service and gets a useful failure.
  const upload = await app.inject({ method: "POST", url: `${prefix}/uploads?viewerId=${viewer.viewerId}`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
  assert.equal(upload.statusCode, 409, upload.body); assert.match(upload.body, /chooser/);
  const action = (action: unknown) => app.inject({ method: "POST", url: `${prefix}/actions`, payload: { viewerId: viewer.viewerId, action } });
  assert.equal((await action({ action: "navigate", url: websiteUrl })).statusCode, 200);
  const uploadRef = ref((await action({ action: "snapshot" })).json().snapshot, "Upload");
  assert.equal((await action({ action: "click", ref: uploadRef })).statusCode, 200);
  await until(async () => !!(await app.inject(prefix)).json().fileChooser);
  const successfulUpload = await app.inject({ method: "POST", url: `${prefix}/uploads?viewerId=${viewer.viewerId}`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
  assert.equal(successfulUpload.statusCode, 200, successfulUpload.body);
  assert.match((await action({ action: "snapshot" })).json().snapshot, /Uploaded test.txt/);
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/skills/builtin-browser`, payload: { enabled: false } });
  await closed;
  assert.equal((await app.inject(prefix)).json().enabled, false);
  assert.equal((await app.inject({ method: "POST", url: `${prefix}/start` })).statusCode, 403);
  await assert.rejects(new Promise<void>((resolve, reject) => { const denied = new WebSocket(`${address.replace('http:', 'ws:')}${prefix}/stream`, { origin: address }); denied.on("error", reject); denied.on("open", () => { denied.close(); resolve(); }); }), /403/);
});

test("browser action validation rejects malformed actions and unsupported navigation", async t => {
  for (const value of [{ action: "wait", ms: -1 }, { action: "click", x: -1, y: 0 }, { action: "fill", text: "missing ref" }, { action: "type", text: "a", surprise: true }, { action: "__proto__" }]) assert.throws(() => browserAction(value), /Invalid/);
  const { current: f } = await runtime(t);
  await assert.rejects(f.browsers.action("a", { action: "navigate", url: "file:///etc/passwd" }), /HTTP/);
});

test("disabling fences queued actions and closing the last viewer stops capture without closing pages", async t => {
  const url = await website(t); const { current: f } = await runtime(t);
  await f.browsers.action("a", { action: "navigate", url });
  const viewer = new Viewer(); f.browsers.attach("a", viewer as unknown as WebSocket);
  const session = (f.browsers as any).sessions.get("a");
  await until(() => !!session.capture);
  viewer.close(); await until(() => !session.capture);
  assert.equal(session.context.pages().length, 1);
  const busy = f.browsers.action("a", { action: "wait", ms: 100 });
  await delay(10);
  const queued = f.browsers.action("a", { action: "navigate", url: `${url}/next` });
  const denied = assert.rejects(queued, /disabled/);
  f.skills.setEnabled("a", "builtin-browser", false);
  await busy; await denied;
  f.skills.setEnabled("a", "builtin-browser", true);
  assert.equal(f.browsers.state("a").tabs[0]!.url, `${url}/`);
});

test("agent deletion closes a real browser before removing its profile and workspace deletion closes remaining browsers", async t => {
  const root = await mkdtemp(join(tmpdir(), "ufai-browser-delete-"));
  const contexts: Awaited<ReturnType<typeof chromium.launchPersistentContext>>[] = [];
  const app = createApp({ databasePath: join(root, "db.sqlite"), execution: { autoStart: false }, serveStatic: false,
    browser: { launch: async (...args) => { const context = await chromium.launchPersistentContext(...args); contexts.push(context); return context; } } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = (await app.inject("/api/workspaces")).json().items[0];
  const agents = [];
  for (const name of ["One", "Two"]) {
    const agent = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/agents`, payload: { name } })).json(); agents.push(agent);
    assert.equal((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/browser/start` })).statusCode, 200);
  }
  let closedFirst = false, closedSecond = false;
  contexts[0]!.once("close", () => { closedFirst = true; }); contexts[1]!.once("close", () => { closedSecond = true; });
  const deleted = (await app.inject({ method: "DELETE", url: `/api/agents/${agents[0].id}`, payload: { confirmFilesDeletion: true } })).json();
  await until(async () => (await app.inject(`/api/deletions/${deleted.id}`)).json().state === "completed");
  assert.equal(closedFirst, true); assert.equal(closedSecond, false);
  const profile = join(root, "db.sqlite.files", "workspaces", workspace.id, "agents", agents[0].id, "browser", "profile");
  await assert.rejects(readFile(join(profile, "Default", "Preferences")), /ENOENT/);
  const removedWorkspace = (await app.inject({ method: "DELETE", url: `/api/workspaces/${workspace.id}`, payload: { confirmFilesDeletion: true } })).json();
  await until(async () => (await app.inject(`/api/deletions/${removedWorkspace.id}`)).json().state === "completed");
  assert.equal(closedSecond, true);
});

test("browser launch errors leave the dashboard usable and give an installation instruction", async t => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false, execution: { autoStart: false },
    browser: { launch: async () => { throw new Error("Executable doesn't exist"); } } });
  t.after(() => app.close());
  const workspace = (await app.inject("/api/workspaces")).json().items[0];
  const agent = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/agents`, payload: { name: "Missing Chromium" } })).json();
  const response = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/browser/start` });
  assert.equal(response.statusCode, 503); assert.match(response.body, /npm run browser:install/);
  assert.equal((await app.inject("/api/workspaces")).statusCode, 200);
  assert.equal((await app.inject(`/api/agents/${agent.id}/browser`)).json().status, "error");
});

test("adding Browser preserves a pre-existing custom skill called browser", async t => {
  const { current: f } = await runtime(t);
  f.db.prepare("DELETE FROM skills WHERE id='builtin-browser'").run();
  const custom = await f.skills.create("a", { name: "browser", description: "Existing custom guidance", instructions: "Preserve my package." });
  await f.skills.start();
  assert.equal((await f.skills.detail(custom.id, "a")).name, "browser");
  assert.equal((await f.skills.detail(custom.id, "a")).instructions, "Preserve my package.");
  assert.equal((await f.skills.detail(custom.id, "a")).enabled, true);
  const builtin = await f.skills.detail("builtin-browser", "b");
  assert.equal(builtin.name, "browser-builtin"); assert.equal(builtin.enabled, true);
  await f.skills.start();
  assert.equal((await f.skills.detail("builtin-browser", "b")).name, builtin.name);
});


test("browser transfer limits reject large uploads and cancel oversized website downloads", async t => {
  const url = await website(t); const { current: f } = await runtime(t);
  await f.browsers.action("a", { action: "navigate", url });
  const path = join(f.files.location("agent", "a").path, "too-large.bin");
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(f.browsers.upload("a", [path], ref(await snapshot(f), "Upload")), /transfer limit/);
  await click(f, "Large download");
  await until(() => f.browsers.state("a").downloads[0]?.state === "failed");
  assert.equal(f.browsers.state("a").downloads[0]?.path, undefined);
});
