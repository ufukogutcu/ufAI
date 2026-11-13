import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexUsageStore } from "../src/codex-usage-store.js";
import { createConnectionStore } from "../src/connection-store.js";
import { startUsagePolling } from "../src/codex-usage-polling.js";
import { durationLabel, remainingPercent, resetCountdown, usageTooltip } from "../src/codex-usage-format.js";
import type { CodexUsageSnapshot } from "../src/api.js";
const snapshot: CodexUsageSnapshot = { planType: "pro", defaultLimit: null, limits: [], resetCredits: { availableCount: 1, credits: null }, ordinaryUsageAllowed: null, fetchedAt: "2026-11-12T12:00:00Z" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

test("usage stores isolate Providers, coalesce reads, retain stale snapshots, and clear disconnected/deleted accounts", async (t) => {
  const pending = deferred<Response>();
  t.mock.method(globalThis, "fetch", async () => pending.promise);
  const store = createCodexUsageStore(); store.getState().sync(["one", "two"]);
  const first = store.getState().refresh("one");
  assert.equal(store.getState().refresh("one"), first);
  pending.resolve(Response.json(snapshot)); await first;
  const other = store.getState().entries.two;
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Retry later" }, { status: 503 }));
  await store.getState().refresh("one");
  assert.equal(store.getState().entries.one?.snapshot?.planType, "pro");
  assert.equal(store.getState().entries.one?.error, "Retry later");
  assert.equal(store.getState().entries.two, other);
  const independent = createCodexUsageStore(); independent.getState().sync(["one"]);
  assert.equal(independent.getState().entries.one?.snapshot, undefined);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Sign in" }, { status: 401 }));
  await store.getState().refresh("one");
  assert.equal(store.getState().entries.one?.snapshot, undefined);
  assert.equal(store.getState().entries.one?.disconnected, true);
  store.getState().sync(["two"]);
  assert.equal(store.getState().entries.one, undefined);
});

test("reset retries retain the logical key across failed results and refresh detailed snapshots", async (t) => {
  const bodies: { idempotencyKey: string; creditId?: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) throw new Error("network lost after redemption");
      return Response.json({ outcome: "alreadyRedeemed" });
    }
    return Response.json(snapshot);
  });
  const store = createCodexUsageStore(); store.getState().sync(["one"]);
  await store.getState().refresh("one");
  await store.getState().redeem("one", "reset-1");
  assert.equal(store.getState().entries.one?.attempt?.creditId, "reset-1");
  assert.match(store.getState().entries.one!.message, /same reset attempt/);
  await store.getState().redeem("one", "different-reset");
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(store.getState().entries.one?.attempt, undefined);
  assert.match(store.getState().entries.one!.message, /already used/);
});

test("deleted or invalidated usage reads cannot restore stale snapshots, including Strict Mode cleanup", async (t) => {
  const response = deferred<Response>();
  t.mock.method(globalThis, "fetch", async () => response.promise);
  const store = createCodexUsageStore(); store.getState().sync(["one"]);
  const reading = store.getState().refresh("one");
  store.getState().invalidate("one", true);
  response.resolve(Response.json(snapshot)); await reading;
  assert.equal(store.getState().entries.one?.snapshot, undefined);
  store.getState().dispose(); store.getState().sync(["one"]);
  t.mock.method(globalThis, "fetch", async () => Response.json(snapshot));
  await store.getState().refresh("one");
  assert.equal(store.getState().entries.one?.snapshot?.planType, "pro");
});

test("Provider refresh reads beyond the first 100 rows and filters setup drafts", async (t) => {
  const urls: string[] = [];
  const providers = Array.from({ length: 102 }, (_, index) => ({ id: String(index), provider: index === 101 ? "codex" : "openai", name: String(index), draft: index === 0 }));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url); const offset = new URL(url, "http://localhost").searchParams.get("offset");
    return Response.json({ items: offset ? providers.slice(100) : providers.slice(0, 100), total: 102 });
  });
  const store = createConnectionStore(); await store.getState().load();
  assert.equal(store.getState().connections.length, 101);
  assert.equal(store.getState().connections.at(-1)?.provider, "codex");
  assert.equal(urls.length, 2);
});

test("usage polling pauses hidden tabs, coalesces focus, and cleans up timers/listeners", async (t) => {
  const win = new EventTarget(); const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  for (const [key, value] of [["window", win], ["document", doc]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0; const pending = deferred<void>();
  const stop = startUsagePolling(async () => { calls++; await pending.promise; });
  t.mock.timers.tick(60000); assert.equal(calls, 0);
  doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); win.dispatchEvent(new Event("focus"));
  assert.equal(calls, 1); pending.resolve(); await tick();
  t.mock.timers.tick(60000); await tick(); assert.equal(calls, 2);
  doc.visibilityState = "hidden"; t.mock.timers.tick(60000); assert.equal(calls, 2);
  stop(); doc.visibilityState = "visible"; win.dispatchEvent(new Event("focus")); t.mock.timers.tick(60000); assert.equal(calls, 2);
});

test("duration and countdown formatting retain arbitrary quota lengths and never imply recovery", () => {
  assert.equal(durationLabel(300), "5h"); assert.equal(durationLabel(10080), "7d");
  assert.equal(durationLabel(null), "Window"); assert.equal(durationLabel(90), "90m");
  assert.match(resetCountdown(100, 100000), /refresh to check/);
  assert.equal(resetCountdown(null, 0), "Reset time unknown");
});

test("usage tooltips show remaining allowance, including exhausted and over-limit windows", () => {
  for (const [usedPercent, remaining] of [[0, 100], [20, 80], [100, 0], [120, 0]]) {
    const limit = { id: "codex", name: null, primary: { usedPercent, windowDurationMins: 300, resetsAt: null }, secondary: null, credits: null, reachedType: null };
    const current = { ...snapshot, defaultLimit: limit, limits: [limit] };
    assert.equal(remainingPercent(usedPercent), remaining);
    const tooltip = usageTooltip("Codex", current, "", 0);
    assert.ok(tooltip.includes(`5h: ${remaining}% remaining · Reset time unknown`));
    assert.doesNotMatch(tooltip, /% used/);
  }
});

test("usage tooltips preserve missing and stale snapshot information", () => {
  const missing = usageTooltip("Codex", undefined, "Sign in", 0);
  assert.match(missing, /Usage unavailable/);
  assert.match(missing, /Sign in/);
  assert.doesNotMatch(missing, /% remaining/);
  const limit = { id: "codex", name: null, primary: null, secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: null }, credits: null, reachedType: null };
  const stale = usageTooltip("Codex", { ...snapshot, defaultLimit: limit, limits: [limit] }, "Retry later", 0);
  assert.match(stale, /7d: 80% remaining/);
  assert.match(stale, /Updated /);
  assert.match(stale, /Stale · Retry later/);
  assert.doesNotMatch(stale, /5h|% used/);
});

test("batch usage refresh bounds concurrency and retains detailed reads while a modal is open", async (t) => {
  let active = 0; let peak = 0;
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url); active++; peak = Math.max(peak, active);
    await tick(); active--;
    return Response.json(snapshot);
  });
  const store = createCodexUsageStore(); store.getState().sync(["one", "two", "three", "four", "five"]);
  store.getState().setDetails("three", true);
  await store.getState().refreshAll();
  assert.equal(peak, 2);
  assert.equal(urls.length, 5);
  assert.ok(urls.find((url) => url.includes("/three/") && url.includes("details=true")));
  store.getState().setDetails("three", false);
  await store.getState().refresh("three");
  assert.ok(urls.at(-1)?.includes("details=false"));
});
