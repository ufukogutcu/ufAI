import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, writeFile, symlink, rm, chmod, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { get } from "node:http";
import { createServer } from "node:net";
import { createApp } from "../src/app.js";
import { AgentFiles, fileManagerCommand, registerAgentFiles, type AgentFilesOptions } from "../src/agent-files.js";
import { ManagedFiles } from "../src/managed-files.js";
import { openDatabase } from "../src/database.js";
import type { ManagedLocation, AgentFileListing } from "../src/contracts.js";

async function fixture(t: TestContext, agentFiles: AgentFilesOptions = {}) {
  const app = createApp({ databasePath: ":memory:", execution: { autoStart: false }, agentFiles });
  t.after(() => app.close());
  const workspace = (await app.inject("/api/workspaces")).json().items[0];
  const agent = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/agents`, payload: { name: "Files agent" } })).json();
  const base = `/api/agents/${agent.id}/files`;
  let home!: ManagedLocation;
  for (let i = 0; i < 100; i++) {
    home = (await app.inject(`/api/agents/${agent.id}/locations`)).json();
    if (home.state === "ready") break;
    await delay(5);
  }
  assert.equal(home.state, "ready");
  const list = async (path = "", extra = "") => {
    const response = await app.inject(`${base}?path=${encodeURIComponent(path)}${extra}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<AgentFileListing>();
  };
  return { app, workspace, agent, home, base, list };
}

test("Files lists nested and hidden files, sorts folders first, and paginates bounded metadata", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.list()).items, []);
  await mkdir(join(f.home.path, "z-folder"));
  await mkdir(join(f.home.path, "A-folder"));
  await writeFile(join(f.home.path, ".hidden"), "hidden");
  await writeFile(join(f.home.path, "résumé 中文.txt"), "unicode");
  await writeFile(join(f.home.path, "z-folder", "inner.txt"), "nested");
  const root = await f.list();
  assert.deepEqual(root.items.map(e => e.name), ["A-folder", "z-folder", ".hidden", "résumé 中文.txt"]);
  assert.equal(root.items[2]!.size, 6);
  assert.ok(root.items.every(e => e.modifiedAt && Number.isFinite(Date.parse(e.modifiedAt))));
  const nested = await f.list("z-folder");
  assert.equal(nested.path, "z-folder");
  assert.equal(nested.items[0]!.path, "z-folder/inner.txt");
  for (let i = 0; i < 105; i++) await writeFile(join(f.home.path, `file-${String(i).padStart(3, "0")}.txt`), "");
  const page = await f.list("", "&offset=100");
  assert.equal(page.total, 109);
  assert.equal(page.items.length, 9);
  const first = await f.list();
  assert.equal(first.items.length, 100);
  assert.ok(!page.items.some(e => first.items.some(a => a.path === e.path)));
  assert.equal((await f.app.inject(`${f.base}?limit=101`)).statusCode, 400);
});

test("downloads preserve bytes and safe Unicode attachment names without publishing artifacts", async t => {
  const f = await fixture(t);
  const name = 'résumé "report".html', bytes = Buffer.from([0, 255, 10, 60, 62]);
  await writeFile(join(f.home.path, name), bytes);
  const response = await f.app.inject(`${f.base}/download?path=${encodeURIComponent(name)}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.rawPayload, bytes);
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(String(response.headers["content-disposition"]), /filename="r_sum_ _report_.html"/);
  assert.ok(String(response.headers["content-disposition"]).includes(encodeURIComponent(name)));
  assert.equal((await f.app.inject(`/api/workspaces/${f.workspace.id}/artifacts`)).statusCode, 404);
  assert.equal((await f.app.inject(`${f.base}/download?path=missing`)).statusCode, 404);
  assert.equal((await f.app.inject(`${f.base}/download`)).statusCode, 409);
});

test("traversal, links, non-directories, and foreign origins cannot expose files or launch a file manager", async t => {
  const launches: string[] = [];
  const f = await fixture(t, { platform: "linux", env: { DISPLAY: ":fixture" }, launch: async command => { launches.push(command); } });
  const outside = await mkdtemp(join(tmpdir(), "ufai-files-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "private.txt"), "outside");
  await symlink(outside, join(f.home.path, "link"));
  await symlink(join(outside, "private.txt"), join(f.home.path, "link.txt"));
  await writeFile(join(f.home.path, "regular.txt"), "inside");
  const listed = await f.list();
  assert.deepEqual(listed.items.filter(e => e.name.startsWith("link")).map(e => e.kind), ["unavailable", "unavailable"]);
  for (const path of ["../private.txt", "/etc", "a/../../b", "C:/Windows", "\\outside", "a//b", "a/./b", "a\0b"]) {
    for (const route of [f.base, `${f.base}/download`])
      assert.equal((await f.app.inject(`${route}?path=${encodeURIComponent(path)}`)).statusCode, 400, path);
    assert.equal((await f.app.inject({ method: "POST", url: `${f.base}/open`, payload: { path } })).statusCode, 400);
  }
  for (const path of ["link", "link/private.txt", "link.txt"])
    assert.equal((await f.app.inject(`${f.base}/download?path=${path}`)).statusCode, 409);
  assert.equal((await f.app.inject(`${f.base}?path=regular.txt`)).statusCode, 404);
  for (const headers of [{ origin: "https://example.com" }, { "sec-fetch-site": "cross-site" }, { host: "example.com" }]) {
    for (const route of [f.base, `${f.base}/download?path=regular.txt`])
      assert.equal((await f.app.inject({ url: route, headers })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "POST", url: `${f.base}/open`, headers, payload: { path: "" } })).statusCode, 403);
  }
  assert.deepEqual(launches, []);
  assert.equal(await readFile(join(outside, "private.txt"), "utf8"), "outside");
});

test("directory scan ceiling retains file manager access", async t => {
  const f = await fixture(t, { platform: "darwin", launch: async () => {} });
  for (let start = 0; start < 10001; start += 32)
    await Promise.all(Array.from({ length: Math.min(32, 10001 - start) }, (_, n) => writeFile(join(f.home.path, `entry-${start + n}`), "")));
  const response = await f.app.inject(f.base);
  assert.equal(response.statusCode, 413);
  assert.match(response.json().error, /10,000.*file manager/);
  assert.equal((await f.app.inject({ method: "POST", url: `${f.base}/open`, payload: { path: "" } })).statusCode, 204);
});

test("special filesystem entries are visible but cannot be downloaded", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), socket = createServer();
  // Unix socket addresses have a short OS limit; the file still lives in the real agent folder.
  const alias = await mkdtemp(join(tmpdir(), "ufai-socket-"));
  await symlink(f.home.path, join(alias, "files"));
  t.after(async () => {
    await new Promise<void>(resolve => socket.close(() => resolve()));
    await rm(alias, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(join(alias, "files", "local.socket"), resolve);
  });
  assert.equal((await f.list()).items[0]!.kind, "unavailable");
  assert.equal((await f.app.inject(`${f.base}/download?path=local.socket`)).statusCode, 409);
  assert.equal((await removeFile(f, "local.socket")).statusCode, 409);
});

test("file manager adapters pass the current folder as one argument and report unavailable desktops or launchers", async t => {
  for (const [platform, command] of [["linux", "xdg-open"], ["darwin", "open"], ["win32", "explorer.exe"]] as const) {
    assert.deepEqual(fileManagerCommand(platform, "/folder with $(special) names"), { command, args: ["/folder with $(special) names"] });
    const calls: unknown[] = [];
    const f = await fixture(t, { platform, env: { WAYLAND_DISPLAY: "fixture" }, launch: async (command, args) => { calls.push({ command, args }); } });
    await mkdir(join(f.home.path, "nested & space"));
    const response = await f.app.inject({ method: "POST", url: `${f.base}/open`, payload: { path: "nested & space" } });
    assert.equal(response.statusCode, 204, response.body);
    assert.deepEqual(calls, [{ command, args: [join(f.home.path, "nested & space")] }]);
  }
  const headless = await fixture(t, { platform: "linux", env: {}, launch: async () => assert.fail("No launcher in a headless session") });
  const response = await headless.app.inject({ method: "POST", url: `${headless.base}/open`, payload: {} });
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /Copy path/);
  const missing = await fixture(t, { platform: "darwin", launch: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } });
  assert.equal((await missing.app.inject({ method: "POST", url: `${missing.base}/open`, payload: {} })).statusCode, 503);
});

test("unavailable folders retain repair, permissions are reported, and deletion intent fences all file actions", async t => {
  const f = await fixture(t, { platform: "darwin", launch: async () => assert.fail("Deletion must fence the launcher") });
  await writeFile(join(f.home.path, "readable.txt"), "inside");
  await chmod(join(f.home.path, "readable.txt"), 0);
  t.after(() => chmod(join(f.home.path, "readable.txt"), 0o600).catch(() => {}));
  if (process.getuid?.() !== 0)
    assert.equal((await f.app.inject(`${f.base}/download?path=readable.txt`)).statusCode, 403);
  await chmod(join(f.home.path, "readable.txt"), 0o600);
  await rm(f.home.path, { recursive: true });
  assert.equal((await f.app.inject(f.base)).statusCode, 404);
  assert.equal((await f.app.inject({ method: "POST", url: `/api/locations/agent/${f.agent.id}/repair` })).json().state, "ready");
  assert.deepEqual((await f.list()).items, []);
  // A symlinked parent makes confirmed deletion fail, retaining its durable fence.
  await rm(f.home.path, { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), "ufai-files-fence-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const parent = join(f.home.path, "..");
  await rm(parent, { recursive: true });
  await symlink(outside, parent);
  const deletion = await f.app.inject({ method: "DELETE", url: `/api/agents/${f.agent.id}`, payload: { confirmFilesDeletion: true } });
  assert.equal(deletion.statusCode, 202);
  assert.equal((await f.app.inject(f.base)).statusCode, 409);
  assert.equal((await f.app.inject(`${f.base}/download?path=anything`)).statusCode, 409);
  assert.equal((await removeFile(f, "anything")).statusCode, 409);
  assert.equal((await f.app.inject({ method: "POST", url: `${f.base}/open`, payload: {} })).statusCode, 409);
});

test("paused downloads close on deletion and shutdown", async t => {
  const db = openDatabase(":memory:"), files = new ManagedFiles(db), browser = new AgentFiles(files);
  files.browser = browser;
  t.after(async () => { await files.close(); db.close(); });
  const workspaceId = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
  for (const id of ["first", "second"])
    db.prepare("INSERT INTO agents(id,workspaceId,name,createdAt,updatedAt) VALUES (?,?,?,'now','now')").run(id, workspaceId, id);
  await files.start();
  for (const id of ["first", "second"]) await files.repair("agent", id);
  const file = await open(join(files.location("agent", "first").path, "large.bin"), "w");
  await file.truncate(16 * 1024 * 1024); await file.close();
  await writeFile(join(files.location("agent", "second").path, "small.txt"), "text");
  const first = await browser.download({ kind: "agent", ownerId: "first" }, "large.bin"), second = await browser.download({ kind: "agent", ownerId: "second" }, "small.txt");
  const op = files.requestDeletion("agent", "first", true);
  for (let i = 0; i < 100 && files.deletion(op.id).state !== "completed"; i++) await delay(5);
  assert.equal(files.deletion(op.id).state, "completed");
  assert.equal(first.stream.closed, true);
  assert.equal(second.stream.destroyed, false);
  const workspaceOp = files.requestDeletion("workspace", workspaceId, true);
  for (let i = 0; i < 100 && files.deletion(workspaceOp.id).state !== "completed"; i++) await delay(5);
  assert.equal(files.deletion(workspaceOp.id).state, "completed");
  assert.equal(second.stream.closed, true);
  await browser.close();
  await assert.rejects(browser.download({ kind: "agent", ownerId: "second" }, "small.txt"), /shutting down/);
});

test("a disconnected HTTP download releases its file stream, and shutdown closes paused downloads", { timeout: 5000 }, async t => {
  const db = openDatabase(":memory:"), files = new ManagedFiles(db), browser = new AgentFiles(files);
  const app = Fastify();
  registerAgentFiles(app, browser);
  app.addHook("preClose", async () => browser.close());
  t.after(async () => { await app.close(); await files.close(); db.close(); });
  const workspaceId = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
  db.prepare("INSERT INTO agents(id,workspaceId,name,createdAt,updatedAt) VALUES ('agent',?,'Agent','now','now')").run(workspaceId);
  await files.start(); await files.repair("agent", "agent");
  const file = await open(join(files.location("agent", "agent").path, "large.bin"), "w");
  await file.truncate(128 * 1024 * 1024); await file.close();
  const download = browser.download.bind(browser);
  let stream!: Awaited<ReturnType<typeof download>>["stream"];
  t.mock.method(browser, "download", async (...args: Parameters<typeof download>) => {
    const result = await download(...args); stream = result.stream; return result;
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    const request = get(`${address}/api/agents/agent/files/download?path=large.bin`, { agent: false }, response => {
      assert.equal(response.statusCode, 200);
      response.pause();
      response.once("close", resolve);
      response.destroy();
    });
    request.once("error", reject);
  });
  for (let i = 0; i < 100 && !stream.closed; i++) await delay(5);
  assert.equal(stream.closed, true);
  const paused = await download({ kind: "agent", ownerId: "agent" }, "large.bin");
  await browser.close();
  assert.equal(paused.stream.closed, true);
});

async function removeFile(f: Awaited<ReturnType<typeof fixture>>, path: string, expectedKind = "file", confirmed: unknown = true, headers?: Record<string, string>) {
  return f.app.inject({ method: "DELETE", url: f.base, headers,
    payload: { path, expectedKind, confirmFilesDeletion: confirmed } });
}

test("confirmed entry deletion removes files and nested folders while preserving neighbors and external symlink targets", async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "ufai-entry-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "private.txt"), "outside");
  await mkdir(join(f.home.path, "folder", "nested"), { recursive: true });
  await writeFile(join(f.home.path, "folder", "nested", "inside.txt"), "inside");
  await symlink(outside, join(f.home.path, "folder", "external"));
  await writeFile(join(f.home.path, "résumé 中文.txt"), "delete me");
  await writeFile(join(f.home.path, "neighbor.txt"), "keep");
  assert.equal((await removeFile(f, "résumé 中文.txt")).statusCode, 204);
  assert.equal((await removeFile(f, "folder", "directory")).statusCode, 204);
  assert.deepEqual((await f.list()).items.map(item => item.name), ["neighbor.txt"]);
  assert.equal(await readFile(join(outside, "private.txt"), "utf8"), "outside");
  assert.equal((await f.app.inject(`/api/agents/${f.agent.id}`)).statusCode, 200);
});

test("entry deletion requires confirmation, validates kind and path, and rejects links and foreign origins", async t => {
  const f = await fixture(t);
  await writeFile(join(f.home.path, "keep.txt"), "keep");
  await mkdir(join(f.home.path, "folder"));
  await symlink(join(f.home.path, "folder"), join(f.home.path, "link"));
  for (const confirmed of [false, "true", null]) assert.equal((await removeFile(f, "keep.txt", "file", confirmed)).statusCode, 400);
  for (const path of ["", "..", "../keep.txt", "/etc", "C:/Windows", "a\\b", "a//b", "a/./b", "a\0b"])
    assert.equal((await removeFile(f, path)).statusCode, 400, path);
  assert.equal((await removeFile(f, "keep.txt", "unavailable")).statusCode, 400);
  assert.equal((await removeFile(f, "keep.txt", "directory")).statusCode, 409);
  assert.equal((await removeFile(f, "folder", "file")).statusCode, 409);
  assert.equal((await removeFile(f, "link", "directory")).statusCode, 409);
  assert.equal((await removeFile(f, "link/anything")).statusCode, 409);
  assert.equal((await removeFile(f, "missing")).statusCode, 404);
  for (const headers of [{ origin: "https://example.com" }, { "sec-fetch-site": "cross-site" }, { host: "example.com" }])
    assert.equal((await removeFile(f, "keep.txt", "file", true, headers)).statusCode, 403);
  assert.equal(await readFile(join(f.home.path, "keep.txt"), "utf8"), "keep");
  assert.equal((await f.app.inject({ method: "DELETE", url: f.base, payload: {} })).statusCode, 400);
});

test("entry deletion closes only matching downloads and respects unavailable locations and owner fences", async t => {
  const db = openDatabase(":memory:"), files = new ManagedFiles(db), browser = new AgentFiles(files);
  files.browser = browser;
  t.after(async () => { await files.close(); db.close(); });
  const workspaceId = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
  db.prepare("INSERT INTO agents(id,workspaceId,name,createdAt,updatedAt) VALUES ('agent',?,'Agent','now','now')").run(workspaceId);
  await files.start(); await files.repair("agent", "agent");
  const home = files.location("agent", "agent").path;
  await mkdir(join(home, "folder"));
  await writeFile(join(home, "folder", "remove.txt"), "remove");
  await writeFile(join(home, "keep.txt"), "keep");
  const removed = await browser.download({ kind: "agent", ownerId: "agent" }, "folder/remove.txt"), kept = await browser.download({ kind: "agent", ownerId: "agent" }, "keep.txt");
  await browser.remove({ kind: "agent", ownerId: "agent" }, "folder", "directory", true);
  assert.equal(removed.stream.closed, true);
  assert.equal(kept.stream.destroyed, false);
  db.prepare("UPDATE managed_locations SET state='error' WHERE kind='agent' AND ownerId='agent'").run();
  await assert.rejects(browser.remove({ kind: "agent", ownerId: "agent" }, "keep.txt", "file", true), /unavailable/);
  db.prepare("UPDATE managed_locations SET state='ready' WHERE kind='agent' AND ownerId='agent'").run();
  files.requestDeletion("agent", "agent", true);
  await assert.rejects(browser.remove({ kind: "agent", ownerId: "agent" }, "keep.txt", "file", true), /Deletion is in progress/);
});

test("entry deletion limits concurrency, fences subtree actions, and shutdown waits for in-flight removals", async t => {
  const db = openDatabase(":memory:"), files = new ManagedFiles(db), browser = new AgentFiles(files);
  const app = Fastify();
  registerAgentFiles(app, browser);
  t.after(async () => { await app.close(); await files.close(); db.close(); });
  const workspaceId = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
  for (const id of ["first", "second", "third"])
    db.prepare("INSERT INTO agents(id,workspaceId,name,createdAt,updatedAt) VALUES (?,?,?,'now','now')").run(id, workspaceId, id);
  await files.start();
  for (const id of ["first", "second", "third"]) {
    await files.repair("agent", id);
    await mkdir(join(files.location("agent", id).path, "folder"));
  }
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  t.after(unblock);
  let enteredCount = 0, announce!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const verify = files.verifyAgentDirectory.bind(files);
  t.mock.method(files, "verifyAgentDirectory", async (agentId: string) => {
    if (++enteredCount === 2) announce();
    await gate;
    return verify(agentId);
  });
  const remove = (id: string, path = "folder") => app.inject({ method: "DELETE", url: `/api/agents/${id}/files`,
    payload: { path, expectedKind: "directory", confirmFilesDeletion: true } });
  // light-my-request starts when awaited/then'ed.
  const first = remove("first").then(result => result);
  const second = remove("second").then(result => result);
  await entered;
  assert.equal((await remove("first", "other")).statusCode, 429);
  assert.equal((await remove("third")).statusCode, 429);
  await assert.rejects(browser.list({ kind: "agent", ownerId: "first" }, "folder", 100, 0), /being deleted/);
  await assert.rejects(browser.download({ kind: "agent", ownerId: "first" }, "folder/child"), /being deleted/);
  await assert.rejects(browser.openFolder({ kind: "agent", ownerId: "first" }, "folder"), /being deleted/);
  let closed = false;
  const closing = browser.close().then(() => { closed = true; });
  await delay(5); assert.equal(closed, false);
  unblock();
  await Promise.all([first, second, closing]);
  assert.equal(closed, true);
  await assert.rejects(browser.remove({ kind: "agent", ownerId: "third" }, "folder", "directory", true), /shutting down/);
});

test("entry deletion reports parent permission errors without removing the entry", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.home.path, "protected.txt"), "keep");
  await chmod(f.home.path, 0o500);
  try {
    assert.equal((await removeFile(f, "protected.txt")).statusCode, 403);
    assert.equal(await readFile(join(f.home.path, "protected.txt"), "utf8"), "keep");
  } finally {
    await chmod(f.home.path, 0o700);
  }
});

test("Workspace Folder operates on live shared entries and isolates agent and workspace folders", async t => {
  const f = await fixture(t, { platform: "linux", env: {} });
  const base = `/api/workspaces/${f.workspace.id}/files`;
  const home = (await f.app.inject(`/api/workspaces/${f.workspace.id}/locations`)).json<ManagedLocation>();
  await mkdir(join(home.path, "nested"));
  await writeFile(join(home.path, "nested", ".hidden"), "shared bytes");
  await writeFile(join(f.home.path, "agent-only.txt"), "agent bytes");
  assert.equal((await f.app.inject(`${base}/download?path=agent-only.txt`)).statusCode, 404);
  assert.equal((await f.app.inject(`${f.base}/download?path=nested%2F.hidden`)).statusCode, 404);
  assert.equal((await f.app.inject(`${base}?limit=1&offset=1`)).json().total, 1);
  const nested = await f.app.inject(`${base}?path=nested`);
  assert.deepEqual(nested.json<AgentFileListing>().items.map(entry => entry.name), [".hidden"]);
  assert.equal((await f.app.inject(`${base}/download?path=nested%2F.hidden`)).body, "shared bytes");
  assert.equal((await f.app.inject({ method: "POST", url: `${base}/open`, payload: { path: "nested" } })).statusCode, 503);
  const remove = (path: string, confirmed: boolean) => f.app.inject({ method: "DELETE", url: base,
    payload: { path, expectedKind: "directory", confirmFilesDeletion: confirmed } });
  assert.equal((await remove("nested", false)).statusCode, 400);
  assert.equal((await remove("", true)).statusCode, 400);
  assert.equal((await remove("nested", true)).statusCode, 204);
  assert.deepEqual((await f.app.inject(base)).json<AgentFileListing>().items, []);
  assert.equal(await readFile(join(f.home.path, "agent-only.txt"), "utf8"), "agent bytes");
});
