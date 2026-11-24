import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { CodexRuntime } from "../src/codex-runtime.js";
import { openDatabase } from "../src/database.js";

function requests(app: ReturnType<typeof createApp>) {
  return async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, status: number, payload?: object) => {
    const response = await app.inject({ method, url, payload });
    assert.equal(response.statusCode, status, response.body);
    return status === 204 ? undefined : response.json();
  };
}

test("Provider copies include every catalog page and use a separately encrypted key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-provider-copy-"));
  const databasePath = join(directory, "app.sqlite");
  const key = "local-test-key";
  const endpoint = "http://127.0.0.1:53031/v1";
  const catalog = Array.from({ length: 123 }, (_, i) => ({ id: `model-${String(i).padStart(3, "0")}` }));
  const sentKeys: string[] = [];
  const app = createApp({ databasePath, filesRoot: join(directory, "files"), serveStatic: false,
    execution: { autoStart: false }, triggers: { autoStart: false },
    connections: { fetcher: async (url, init) => {
      sentKeys.push(new Headers(init?.headers).get("authorization") ?? "");
      if (String(url) === `${endpoint}/models`) return Response.json({ data: catalog });
      assert.equal(String(url), `${endpoint}/chat/completions`);
      return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
    } },
  });
  const db = openDatabase(databasePath);
  t.after(async () => {
    db.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = requests(app);
  const { id } = await call("POST", "/api/connections", 201, {
    provider: "openai-compatible", name: "Original", endpoint, apiKey: key,
  });
  const source = `/api/connections/${id}`;
  await call("POST", `${source}/duplicate`, 409, { name: "Draft copy" });
  await call("POST", `${source}/models/refresh`, 200, {});
  await call("POST", `${source}/models`, 201, {
    id: "custom/model", contextWindowOverride: 12288, mediaOverrides: { image: true, pdf: false },
  });
  await call("PATCH", source, 200, {
    draft: false, modelSelection: [{ id: "model-122", enabled: false }],
  });
  assert.equal((await call("POST", `${source}/models/model-000/test`, 200, {})).success, true);
  await call("POST", `${source}/duplicate`, 400, { name: " ", apiKey: "ignored" });
  assert.equal((await app.inject({
    method: "POST", url: `${source}/duplicate`, payload: { name: "Cross origin" },
    headers: { "sec-fetch-site": "cross-site" },
  })).statusCode, 403);

  db.exec(`CREATE TRIGGER reject_copied_media BEFORE INSERT ON model_media_capabilities
    BEGIN SELECT raise(ABORT, 'test copy failure'); END`);
  await call("POST", `${source}/duplicate`, 500, { name: "Roll back" });
  assert.equal((await call("GET", "/api/connections", 200)).total, 1);
  assert.equal((db.prepare("SELECT count(*) AS count FROM provider_models").get() as { count: number }).count, 124);
  db.exec("DROP TRIGGER reject_copied_media");

  const copy = await call("POST", `${source}/duplicate`, 201, { name: "  Original (copy)  " });
  const target = `/api/connections/${copy.id}`;
  assert.notEqual(copy.id, id);
  assert.equal(copy.name, "Original (copy)");
  assert.equal(copy.endpoint, endpoint);
  assert.equal(copy.hasCredential, true);
  assert.equal(copy.draft, false);
  assert.equal(Object.hasOwn(copy, "credential"), false);
  assert.equal(JSON.stringify(copy).includes(key), false);
  const encrypted = db.prepare("SELECT credential FROM connections WHERE id = ?").pluck();
  assert.notEqual(encrypted.get(copy.id), encrypted.get(id));

  for (const offset of [0, 100]) {
    const original = await call("GET", `${source}/models?limit=100&offset=${offset}`, 200);
    const duplicated = await call("GET", `${target}/models?limit=100&offset=${offset}`, 200);
    assert.equal(duplicated.total, 124);
    assert.deepEqual(duplicated.items, original.items.map((model: object) => ({
      ...model, connectionId: copy.id, lastTest: null,
    })));
  }
  assert.equal((await call("GET", `${target}/models/model-122`, 200)).enabled, false);
  const model = await call("GET", `${target}/models/custom%2Fmodel`, 200);
  assert.equal(model.contextWindow, 12288);
  assert.deepEqual(model.mediaSettings.overrides, { image: true, pdf: false });
  await call("PATCH", source, 200, { apiKey: "new-original-key" });
  await call("DELETE", source, 204);
  assert.equal((await call("POST", `${target}/models/model-000/test`, 200, {})).success, true);
  assert.equal(sentKeys.at(-1), `Bearer ${key}`);

  db.exec(`WITH RECURSIVE drafts(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM drafts WHERE n<99)
    INSERT INTO connections(id, provider, name, draft, createdAt, updatedAt)
    SELECT 'draft-' || n, 'ollama', 'Draft', 1, '0', '0' FROM drafts`);
  await call("POST", `${target}/duplicate`, 409, { name: "Over limit" });
  assert.equal((await call("GET", "/api/connections", 200)).total, 100);
});

test("Codex Provider copies retain one sign-in across restart and detach independently", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-codex-copy-"));
  const databasePath = join(directory, "app.sqlite");
  const runtimeDirectory = join(directory, "codex");
  const fixture = fileURLToPath(new URL("./fixtures/codex-process.cjs", import.meta.url));
  const homes: string[] = [];
  let mode = "success";
  const start = () => createApp({
    databasePath, filesRoot: join(directory, "files"), serveStatic: false,
    execution: { autoStart: false }, triggers: { autoStart: false },
    connections: { codex: new CodexRuntime(runtimeDirectory, home => {
      homes.push(home);
      return spawn(process.execPath, [fixture, home, mode]);
    }) },
  });
  let app = start();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  let call = requests(app);
  const { id } = await call("POST", "/api/connections", 201, { provider: "codex", name: "ChatGPT" });
  const source = `/api/connections/${id}`;
  await call("POST", `${source}/models`, 201, { id: "model", contextWindowOverride: 12000 });
  await call("PATCH", source, 200, { draft: false });
  const disconnected = await call("POST", `${source}/duplicate`, 201, { name: "Signed-out copy" });
  assert.equal(disconnected.hasCredential, false);
  assert.equal((await call("POST", `${source}/login`, 200, {})).status, "connected");
  assert.equal((await call("GET", `/api/connections/${disconnected.id}/login`, 200)).status, "disconnected");

  await app.close();
  const legacy = openDatabase(databasePath);
  try {
    legacy.exec(`DROP INDEX connections_codex_session;
      ALTER TABLE connections DROP COLUMN codexSessionId;
      PRAGMA user_version = 43`);
  } finally {
    legacy.close();
  }
  app = start();
  call = requests(app);
  assert.equal((await call("GET", `${source}/login`, 200)).status, "connected");
  const first = await call("POST", `${source}/duplicate`, 201, { name: "First" });
  const firstPath = `/api/connections/${first.id}`;
  const second = await call("POST", `${firstPath}/duplicate`, 201, { name: "Second" });
  const secondPath = `/api/connections/${second.id}`;
  assert.equal(first.hasCredential && second.hasCredential, true);
  assert.equal(Object.hasOwn(first, "codexSessionId"), false);
  assert.equal(existsSync(join(runtimeDirectory, id, "auth.json")), true);
  assert.equal(existsSync(join(runtimeDirectory, first.id)), false);
  assert.equal(existsSync(join(runtimeDirectory, second.id)), false);
  await app.close();

  app = start();
  call = requests(app);
  homes.length = 0;
  assert.equal((await call("GET", `${firstPath}/login`, 200)).status, "connected");
  assert.equal((await call("GET", `${secondPath}/login`, 200)).status, "connected");
  assert.deepEqual(homes, [join(runtimeDirectory, id)]);
  await call("DELETE", source, 204);
  assert.equal((await call("POST", `${firstPath}/models/model/test`, 200, {})).success, true);
  await call("POST", `${firstPath}/logout`, 204, {});
  assert.equal((await call("GET", `${firstPath}/login`, 200)).status, "disconnected");
  assert.equal((await call("GET", `${secondPath}/login`, 200)).status, "connected");

  const third = await call("POST", `${secondPath}/duplicate`, 201, { name: "Third" });
  const thirdPath = `/api/connections/${third.id}`;
  mode = "pending";
  assert.equal((await call("POST", `${thirdPath}/login`, 200, { deviceCode: true })).status, "pending");
  await call("POST", `${thirdPath}/duplicate`, 409, { name: "Incomplete sign-in" });
  await call("DELETE", `${thirdPath}/login`, 204);
  assert.equal((await call("GET", `${secondPath}/login`, 200)).status, "connected");
  await call("DELETE", secondPath, 204);
  assert.equal(existsSync(join(runtimeDirectory, id)), false);
  assert.equal((await call("GET", `${thirdPath}/login`, 200)).status, "disconnected");
});
