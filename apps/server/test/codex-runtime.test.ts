import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { CodexRuntime, type CodexLauncher } from "../src/codex-runtime.js";
import type { CodexCatalogLauncher } from "../src/codex-process.js";
const fixture = fileURLToPath(
  new URL("./fixtures/codex-process.cjs", import.meta.url),
);
const catalogFixture = fileURLToPath(
  new URL("./fixtures/codex-catalog-process.cjs", import.meta.url),
);
async function setup(
  t: TestContext,
  mode = "success",
  timeout = 1000,
  idle = 60_000,
  catalogMode = "success",
) {
  const directory = await mkdtemp(join(tmpdir(), "ufai-codex-test-"));
  const homes: string[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const launcher: CodexLauncher = (home) => {
    homes.push(home);
    const child = spawn(process.execPath, [fixture, home, mode], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    return child;
  };
  const catalogCalls: { home: string; bundled: boolean }[] = [];
  const catalogLauncher: CodexCatalogLauncher = (home, bundled) => {
    catalogCalls.push({ home, bundled });
    const child = spawn(process.execPath, [catalogFixture, home, bundled ? "bundled" : "provider", catalogMode], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    return child;
  };
  const runtime = new CodexRuntime(directory, launcher, timeout, idle, catalogLauncher);
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { runtime, homes, children, directory, launcher, catalogCalls };
}
test("Codex handshake, same-chunk OAuth completion, pagination, isolation, persistence and logout", async (t) => {
  const { runtime, homes, children, directory, launcher } = await setup(t);
  assert.deepEqual(await runtime.status("one"), { status: "disconnected" });
  await assert.rejects(runtime.models("one"), /Sign in with ChatGPT/);
  assert.equal((await runtime.login("one", false)).status, "connected");
  assert.equal(runtime.hasCredential("one"), true);
  assert.deepEqual(
    (await runtime.models("one")).map((model) => model.id),
    ["first", "second"],
  );
  assert.equal((await runtime.status("two")).status, "disconnected");
  assert.notEqual(homes[0], homes[1]);
  assert.equal(runtime.hasCredential("two"), false);
  await runtime.remove("two");
  await runtime.close();
  const resumed = new CodexRuntime(directory, launcher);
  t.after(() => resumed.close());
  assert.equal((await resumed.status("one")).status, "connected");
  await resumed.logout("one");
  assert.equal(resumed.hasCredential("one"), false);
  assert.equal((await resumed.status("one")).status, "disconnected");
  await resumed.close();
  assert.ok(
    children.every(
      (child) => child.exitCode !== null || child.signalCode !== null,
    ),
  );
});
test("Codex device-code login can be polled and cancelled", async (t) => {
  const { runtime } = await setup(t, "pending");
  const result = await runtime.login("one", true);
  assert.equal(result.status, "pending");
  assert.equal(result.userCode, "ABCD-TEST");
  assert.deepEqual(await runtime.status("one"), result);
  await runtime.cancel("one");
  assert.equal((await runtime.status("one")).status, "disconnected");
});
test("Codex login failures are sanitized", async (t) => {
  const { runtime } = await setup(t, "login-error");
  const result = await runtime.login("one", false);
  assert.equal(result.status, "error");
  assert.equal(JSON.stringify(result).includes("PRIVATE-RAW-ERROR"), false);
});
test("Codex malformed messages, process failures and RPC timeouts settle pending requests", async (t) => {
  for (const mode of ["malformed", "exit", "hang"]) {
    const { runtime } = await setup(t, mode, mode === "hang" ? 50 : 1000);
    await assert.rejects(runtime.status("one"), /stopped|timed out/);
    await runtime.close();
  }
});
test("idle cleanup releases processes and the simultaneous runtime limit is enforced", async (t) => {
  const { runtime, homes } = await setup(t, "success", 1000, 40);
  await runtime.status("one");
  await delay(80);
  await runtime.status("one");
  assert.equal(homes.length, 2);
  // Pending logins retain their runtime until cancelled, rather than timing out as idle.
  const pending = await setup(t, "pending");
  await Promise.all([
    pending.runtime.login("one", true),
    pending.runtime.login("two", true),
    pending.runtime.login("three", true),
  ]);
  await assert.rejects(pending.runtime.status("four"), /busy/);
});

test("Codex test uses an ephemeral restricted turn and handles same-chunk completion with process cleanup", async (t) => {
  const { runtime, children } = await setup(t);
  await runtime.login("one", false);
  assert.equal(
    await runtime.test("one", "test-model", new AbortController().signal),
    "OK",
  );
  assert.ok(
    children.every(
      (child) => child.exitCode !== null || child.signalCode !== null,
    ),
  );
  assert.equal(runtime.hasCredential("one"), true);
});
test("Codex test rejects empty replies, failures, tool requests, approvals, malformed events, and process exits", async (t) => {
  for (const mode of [
    "test-empty",
    "test-failed",
    "test-tool",
    "test-approval",
    "test-malformed",
    "test-exit",
  ]) {
    const { runtime, children } = await setup(t, mode);
    await runtime.login("one", false);
    await assert.rejects(
      runtime.test("one", "test-model", new AbortController().signal),
      /text reply|tool|approval|stopped/,
    );
    assert.ok(
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    );
  }
});
test("Codex test cancellation settles the active turn and closes the child", async (t) => {
  const { runtime, children } = await setup(t, "test-hang");
  await runtime.login("one", false);
  await assert.rejects(
    runtime.test("one", "test-model", AbortSignal.timeout(50)),
    /stopped|cancelled/,
  );
  assert.ok(
    children.every(
      (child) => child.exitCode !== null || child.signalCode !== null,
    ),
  );
});

test("Codex discovery enriches only enumerated models with provider defaults and bundled fallback", async (t) => {
  const { runtime, homes, catalogCalls } = await setup(t);
  await runtime.login("one", false);
  const home = homes[0]!;
  await writeFile(join(home, "provider-catalog.json"), JSON.stringify({ models: [
    { slug: "first", context_window: 500000, max_context_window: 872000, effective_context_window_percent: 95, max_output_tokens: 100 },
    { slug: "hidden", context_window: 999999 },
    { slug: "not-listed", context_window: 999999 },
  ] }));
  await writeFile(join(home, "bundled-catalog.json"), JSON.stringify({ models: [
    { slug: "first", context_window: 272000 },
    { slug: "second", context_window: 272000 },
  ] }));
  const first = runtime.models("one");
  assert.equal(runtime.models("one"), first, "concurrent discovery is coalesced");
  assert.deepEqual(await first, [
    { id: "first", name: "First", contextWindow: 500000 },
    { id: "second", name: "Second", contextWindow: 272000 },
  ]);
  assert.deepEqual(catalogCalls, [{ home, bundled: false }, { home, bundled: true }]);
  await runtime.login("two", false);
  assert.deepEqual((await runtime.models("two")).map((m) => m.contextWindow), [null, null]);
});

test("Codex catalog helpers are stopped and awaited on runtime close and connection removal", async (t) => {
  for (const action of ["close", "remove"] as const) {
    const { runtime, catalogCalls, children, directory } = await setup(t, "success", 1000, 60000, "hang");
    await runtime.login("one", false);
    const discovery = runtime.models("one");
    while (!catalogCalls.length) await delay(5);
    if (action === "close") await runtime.close();
    else await runtime.remove("one");
    assert.deepEqual((await discovery).map((m) => m.contextWindow), [null, null]);
    assert.equal(catalogCalls.length, 1, "cancellation prevents starting bundled fallback");
    assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
    if (action === "remove") await assert.rejects(access(join(directory, "one")));
  }
});

test("Codex usage normalizes plan, windows, credits and detailed reset inventory; reads coalesce and cache", async (t) => {
  const { runtime, homes } = await setup(t);
  await runtime.login("one", false);
  const first = runtime.usage("one");
  assert.equal(runtime.usage("one"), first);
  const snapshot = await first;
  assert.equal(snapshot.planType, "pro");
  assert.equal(snapshot.defaultLimit?.primary?.usedPercent, 25);
  assert.equal(snapshot.defaultLimit?.secondary?.windowDurationMins, 10080);
  assert.equal(snapshot.defaultLimit?.credits?.balance, "123.45");
  assert.equal(snapshot.resetCredits?.availableCount, 2);
  assert.equal(snapshot.resetCredits?.credits, null);
  const detailed = await runtime.usage("one", true);
  assert.equal(detailed.resetCredits?.credits?.[0]?.id, "reset-1");
  assert.equal(await runtime.usage("one"), detailed);
  const path = join(homes[0]!, "usage-response.json");
  await writeFile(path, JSON.stringify({ rateLimits: { secondary: { usedPercent: 80, windowDurationMins: 10080 } }, rateLimitsByLimitId: { reserve: { limitId: "reserve", primary: { usedPercent: 10 } } } }));
  assert.equal(await runtime.usage("one", true), detailed);
  const refreshed = await runtime.usage("one", true, true);
  assert.equal(refreshed.defaultLimit?.primary, null);
  assert.equal(refreshed.defaultLimit?.secondary?.usedPercent, 80);
  assert.equal(refreshed.defaultLimit?.secondary?.resetsAt, null);
  assert.equal(refreshed.limits.length, 2);
  assert.equal(refreshed.resetCredits, null);
});

test("Codex idle clients can be evicted to read usage for more than three Providers", async (t) => {
  const { runtime, children } = await setup(t);
  for (const id of ["one", "two", "three", "four", "five"]) {
    await runtime.login(id, false);
    assert.equal((await runtime.usage(id)).planType, "pro");
    assert.ok(children.filter((child) => child.exitCode === null && child.signalCode === null).length <= 3);
  }
  assert.equal((await runtime.status("one")).status, "connected", "credentials survive eviction");
});

test("Codex reset outcomes use idempotency keys, refresh cache, and invalidate on logout", async (t) => {
  const { runtime } = await setup(t);
  await runtime.login("one", false);
  const snapshot = await runtime.usage("one");
  const input = { idempotencyKey: "test-attempt", creditId: "reset-1" };
  assert.equal(await runtime.consumeReset("one", input), "reset");
  assert.equal(await runtime.consumeReset("one", input), "alreadyRedeemed");
  assert.notEqual(await runtime.usage("one"), snapshot);
  await runtime.logout("one");
  await assert.rejects(runtime.usage("one"), /Sign in/);
  for (const [mode, outcome] of [["reset-empty", "nothingToReset"], ["reset-none", "noCredit"]]) {
    const { runtime: other } = await setup(t, mode);
    await other.login("one", false);
    assert.equal(await other.consumeReset("one", { idempotencyKey: "another-attempt" }), outcome);
  }
});

test("Codex usage is bounded, protects active clients, and rejects stale or private error responses", async (t) => {
  const { runtime } = await setup(t, "usage-hang", 150);
  await runtime.login("one", false);
  await runtime.login("two", false);
  await runtime.login("three", false);
  const one = runtime.usage("one");
  const two = runtime.usage("two");
  const waiting = Promise.allSettled([one, two]);
  await assert.rejects(runtime.usage("three"), /busy/);
  await assert.rejects(runtime.consumeReset("one", { idempotencyKey: "busy" }), /pending/);
  await runtime.close();
  assert.ok((await waiting).every((result) => result.status === "rejected"));
  for (const mode of ["usage-error", "usage-notification"]) {
    const { runtime: other } = await setup(t, mode);
    await other.login("one", false);
    await assert.rejects(other.usage("one"), (error: Error) => !error.message.includes("PRIVATE") && /Retry|retry/.test(error.message));
  }
});

test("removal prevents an awaiting usage acquisition from recreating the deleted runtime", async (t) => {
  const { runtime, directory, children } = await setup(t);
  for (const id of ["one", "two", "three", "four"]) await runtime.login(id, false);
  const pending = runtime.usage("one");
  const rejected = assert.rejects(pending, /removed|shutting/);
  await runtime.remove("one");
  await rejected;
  await assert.rejects(access(join(directory, "one")));
  assert.ok(children.filter((child) => child.exitCode === null && child.signalCode === null).length <= 3);
});
