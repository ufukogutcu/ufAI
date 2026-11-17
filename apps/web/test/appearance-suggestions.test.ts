import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentStore } from "../src/agent-store";
import type { Agent, AgentAppearance } from "../../server/src/contracts";

const first: AgentAppearance = { kind: "sprout", color: "sage", accessories: ["bowtie"] };
const next: AgentAppearance = { kind: "bot", color: "honey", accessories: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

test("appearance requests coalesce, retain cancellation previews, and stay workspace scoped", async t => {
  const one = deferred<Response>(), two = deferred<Response>();
  const fetch = t.mock.method(globalThis, "fetch", (url: string) => url.includes("/one/") ? one.promise : two.promise);
  const store = createAgentStore();
  const pending = store.getState().loadAppearanceSuggestion("one");
  assert.equal(store.getState().loadAppearanceSuggestion("one"), pending);
  const other = store.getState().loadAppearanceSuggestion("two");
  two.resolve(Response.json({ appearance: next }));
  await other;
  one.resolve(Response.json({ appearance: first }));
  await pending;
  assert.deepEqual(store.getState().appearanceSuggestions.two?.appearance, next);
  store.setState({ createIn: "one" });
  store.setState({ createIn: null });
  assert.deepEqual(await store.getState().loadAppearanceSuggestion("one"), first);
  assert.equal(fetch.mock.callCount(), 2);
});

test("failed suggestions wait for explicit retry, which also coalesces", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const store = createAgentStore();
  await assert.rejects(store.getState().loadAppearanceSuggestion("one"));
  assert.ok(store.getState().appearanceSuggestions.one?.error);
  await assert.rejects(store.getState().loadAppearanceSuggestion("one"));
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => Response.json({ appearance: first }));
  const retry = store.getState().loadAppearanceSuggestion("one", true);
  assert.equal(store.getState().loadAppearanceSuggestion("one", true), retry);
  assert.deepEqual(await retry, first);
  assert.equal(store.getState().appearanceSuggestions.one?.error, "");
});

test("successful creation replaces the preview and fences a late old suggestion", async t => {
  const old = deferred<Response>(), replacement = deferred<Response>();
  let reads = 0, failCreate = true;
  const agent: Agent = { id: "agent", workspaceId: "one", name: "Ava", instructions: "", presetId: null,
    appearance: first, x: 0, y: 0, revision: 1, state: "idle", queuedCount: 0, runningTaskCount: 0, unfinishedTaskCount: 0,
    pendingUserInputCount: 0, issueCounts: { warning: 0, error: 0 }, createdAt: "now", updatedAt: "now" };
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return failCreate
      ? Response.json({ error: "Try again" }, { status: 500 }) : Response.json(agent);
    return ++reads === 1 ? old.promise : replacement.promise;
  });
  const store = createAgentStore();
  const pending = store.getState().loadAppearanceSuggestion("one");
  await assert.rejects(store.getState().create("one", { name: "Ava", appearance: first }));
  assert.equal(reads, 1);
  failCreate = false;
  await store.getState().create("one", { name: "Ava", appearance: first });
  assert.equal(reads, 2);
  old.resolve(Response.json({ appearance: first }));
  await pending;
  assert.equal(store.getState().appearanceSuggestions.one?.appearance, null);
  replacement.resolve(Response.json({ appearance: next }));
  await store.getState().loadAppearanceSuggestion("one");
  assert.deepEqual(store.getState().appearanceSuggestions.one?.appearance, next);
  assert.equal(store.getState().selected.one, "agent");
});

test("preview cache is bounded and preserves an open dialog's source", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ appearance: first }));
  const store = createAgentStore();
  await store.getState().loadAppearanceSuggestion("open");
  store.setState({ createIn: "open" });
  for (let i = 0; i < 20; i++) await store.getState().loadAppearanceSuggestion(String(i));
  assert.equal(Object.keys(store.getState().appearanceSuggestions).length, 16);
  assert.deepEqual(store.getState().appearanceSuggestions.open?.appearance, first);
});
