import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import type { CodexAdapter } from "../src/codex-runtime.js";
import type { CodexResetInput, CodexResetOutcome, CodexUsageSnapshot } from "../src/contracts.js";
import { normalizeCodexUsage } from "../src/codex-usage.js";

test("usage endpoints guard provider/draft/origin, validate input, and lock authentication/deletion during account work", async (t) => {
  const snapshot = normalizeCodexUsage({ planType: "plus" }, { rateLimits: { secondary: { usedPercent: 25, windowDurationMins: 10080 } } });
  let read: (() => void) | undefined;
  let finishReset: ((outcome: CodexResetOutcome) => void) | undefined;
  const attempts: CodexResetInput[] = [];
  const codex: CodexAdapter = {
    status: async () => ({ status: "connected" }), login: async () => ({ status: "connected" }),
    cancel: async () => {}, logout: async () => {}, remove: async () => {}, close: async () => {}, hasCredential: () => true,
    models: async () => [], test: async () => "OK",
    usage: async () => new Promise<CodexUsageSnapshot>((resolve) => { read = () => resolve(snapshot); }),
    consumeReset: async (_id, input) => { attempts.push(input); return new Promise((resolve) => { finishReset = resolve; }); },
  };
  const app = createApp({ databasePath: ":memory:", serveStatic: false, connections: { codex } });
  t.after(() => app.close());
  const create = async (provider: string) => (await app.inject({ method: "POST", url: "/api/connections", payload: { provider, name: provider, ...(provider === "openai" ? { apiKey: "test" } : {}) } })).json().id as string;
  const id = await create("codex");
  const root = `/api/connections/${id}`;
  assert.equal((await app.inject(`${root}/usage`)).statusCode, 400);
  await app.inject({ method: "POST", url: `${root}/models`, payload: { id: "manual" } });
  await app.inject({ method: "PATCH", url: root, payload: { draft: false } });
  const other = await create("openai");
  assert.equal((await app.inject(`/api/connections/${other}/usage`)).statusCode, 400);
  assert.equal((await app.inject({ url: `${root}/usage`, headers: { origin: "https://foreign.example" } })).statusCode, 403);
  assert.equal((await app.inject(`${root}/usage?details=wrong`)).statusCode, 400);
  for (const payload of [{}, { idempotencyKey: "" }, { idempotencyKey: "ok", creditId: "" }, { idempotencyKey: "ok", surprise: true }])
    assert.equal((await app.inject({ method: "POST", url: `${root}/usage/resets/consume`, payload })).statusCode, 400);
  const pending = app.inject(`${root}/usage?details=true`);
  while (!read) await new Promise((resolve) => setImmediate(resolve));
  for (const [method, url, payload] of [["POST", `${root}/logout`, {}], ["DELETE", root, undefined], ["POST", `${root}/usage/resets/consume`, { idempotencyKey: "blocked" }]] as const)
    assert.equal((await app.inject({ method, url, payload })).statusCode, 409);
  read();
  const response = await pending;
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.json().defaultLimit.secondary.usedPercent, 25);
  const reset = app.inject({ method: "POST", url: `${root}/usage/resets/consume`, payload: { idempotencyKey: "logical-attempt", creditId: "opaque-reset" } });
  while (!finishReset) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app.inject(`${root}/usage`)).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: `${root}/usage/resets/consume`, payload: { idempotencyKey: "another" } })).statusCode, 409);
  finishReset("reset");
  assert.deepEqual((await reset).json(), { outcome: "reset" });
  assert.deepEqual(attempts, [{ idempotencyKey: "logical-attempt", creditId: "opaque-reset" }]);
});
