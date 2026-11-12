import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { readCodexContexts } from "../src/codex-catalog.js";
import type { CodexCatalogLauncher } from "../src/codex-process.js";

const fixture = fileURLToPath(new URL("./fixtures/codex-catalog-process.cjs", import.meta.url));
async function setup(t: TestContext, providerMode = "success", bundledMode = "success") {
  const home = await mkdtemp(join(tmpdir(), "ufai-catalog-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls: boolean[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const launcher: CodexCatalogLauncher = (directory, bundled) => {
    assert.equal(directory, home);
    calls.push(bundled);
    const child = spawn(process.execPath, [fixture, directory, bundled ? "bundled" : "provider", bundled ? bundledMode : providerMode], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    return child;
  };
  const catalog = async (source: string, models: unknown[]) =>
    writeFile(join(home, `${source}-catalog.json`), JSON.stringify({ models }));
  const read = (ids: string[], timeout = 1000, deadline = Date.now() + 5000, signal = new AbortController().signal) =>
    readCodexContexts(home, ids, deadline, signal, launcher, timeout);
  return { home, calls, children, catalog, read };
}

test("catalogs use exact model IDs and positive safe integer default context values", async (t) => {
  const { catalog, read, calls } = await setup(t);
  const invalid = [null, 0, -1, 1.5, "4000", Number.MAX_SAFE_INTEGER + 1];
  await catalog("provider", [
    { slug: "exact", context_window: 500000, max_context_window: 872000, effective_context_window_percent: 95 },
    { slug: "case", context_window: 1000 },
    { slug: "missing-default", max_context_window: 872000 },
    ...invalid.map((value, index) => ({ slug: `invalid-${index}`, context_window: value })),
    null,
  ]);
  await catalog("bundled", [
    { slug: "exact", context_window: 272000 },
    { slug: "missing-default", context_window: 2000 },
    ...invalid.map((_, index) => ({ slug: `invalid-${index}`, context_window: 3000 + index })),
  ]);
  const result = await read(["exact", "CASE", "unknown", "missing-default", ...invalid.map((_, index) => `invalid-${index}`)]);
  assert.equal(result.get("exact"), 500000);
  assert.equal(result.get("CASE"), undefined);
  assert.equal(result.get("unknown"), undefined);
  assert.equal(result.get("missing-default"), 2000);
  invalid.forEach((_, index) => assert.equal(result.get(`invalid-${index}`), 3000 + index));
  assert.deepEqual(calls, [false, true]);
});

test("complete provider metadata avoids bundled execution and empty lists start no helpers", async (t) => {
  const { catalog, read, calls } = await setup(t);
  await catalog("provider", [{ slug: "model", context_window: 1234 }]);
  assert.equal((await read(["model"])).get("model"), 1234);
  assert.deepEqual(calls, [false]);
  assert.equal((await read([])).size, 0);
  assert.deepEqual(calls, [false]);
});

test("malformed, failed, oversized, and timed-out provider helpers fall back without exposing errors", async (t) => {
  for (const mode of ["malformed", "exit", "oversize", "multibyte", "hang"]) {
    const { catalog, read, children } = await setup(t, mode);
    await catalog("bundled", [{ slug: "model", context_window: 1234 }]);
    const result = await read(["model"], mode === "hang" ? 150 : 1000);
    assert.equal(result.get("model"), 1234, mode);
    assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
  }
});

test("invalid catalog shapes and excess entries degrade to bundled metadata or unknown", async (t) => {
  const { home, catalog, read } = await setup(t);
  await catalog("bundled", [{ slug: "model", context_window: 5678 }]);
  for (const raw of ["null", "[]", '{}', '{"models":{}}', JSON.stringify({ models: Array.from({ length: 5001 }, () => ({ slug: "model", context_window: 1000 })) })]) {
    await writeFile(join(home, "provider-catalog.json"), raw);
    assert.equal((await read(["model"])).get("model"), 5678);
  }
  await writeFile(join(home, "bundled-catalog.json"), "invalid");
  assert.equal((await read(["model"])).size, 0);
});

test("launch failures, exhausted discovery budgets, and aborted reads leave metadata unknown", async (t) => {
  const { home, read, calls } = await setup(t);
  const contexts = await readCodexContexts(home, ["model"], Date.now() + 1000, new AbortController().signal, () => {
    throw new Error("PRIVATE-LAUNCH-ERROR");
  });
  assert.equal(contexts.size, 0);
  assert.equal((await read(["model"], 1000, Date.now() - 1)).size, 0);
  assert.equal((await read(["model"], 1000, Date.now() + 1000, AbortSignal.abort())).size, 0);
  assert.deepEqual(calls, []);
});

test("the shared discovery deadline stops a hanging helper and prevents fallback", async (t) => {
  const { read, calls, children } = await setup(t, "hang");
  const started = Date.now();
  assert.equal((await read(["model"], 3000, started + 150)).size, 0);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(calls, [false]);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
});

test("bundled helper failures retain valid provider values and leave missing values unknown", async (t) => {
  const { catalog, read } = await setup(t, "success", "exit");
  await catalog("provider", [{ slug: "known", context_window: 1234 }]);
  const contexts = await read(["known", "unknown"]);
  assert.equal(contexts.get("known"), 1234);
  assert.equal(contexts.get("unknown"), undefined);
});
