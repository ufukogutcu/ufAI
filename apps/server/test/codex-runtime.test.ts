import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { CodexRuntime, type CodexLauncher } from "../src/codex-runtime.js";
const fixture = fileURLToPath(
  new URL("./fixtures/codex-process.cjs", import.meta.url),
);
async function setup(
  t: TestContext,
  mode = "success",
  timeout = 1000,
  idle = 60_000,
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
  const runtime = new CodexRuntime(directory, launcher, timeout, idle);
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { runtime, homes, children, directory, launcher };
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
  assert.throws(() => pending.runtime.status("four"), /busy/);
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
