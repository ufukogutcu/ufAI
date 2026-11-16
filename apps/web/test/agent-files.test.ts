import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useAgentFiles } from "../src/use-agent-files";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function listing(path = "", total = 0) { return { path, total, items: [] }; }
function location(ownerId = "agent", state = "ready") { return { ownerId, path: "/managed/files", state }; }

async function mount(t: TestContext, fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  t.mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => fetcher(String(url), init));
  const root = createRoot(dom.window.document.getElementById("root")!);
  let current!: ReturnType<typeof useAgentFiles>;
  function Probe({ agentId }: { agentId: string }) { current = useAgentFiles(agentId); return null; }
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  });
  await act(async () => root.render(createElement(Probe, { agentId: "agent" })));
  return {
    get value() { return current; },
    window: dom.window,
    switchAgent: async (agentId: string) => act(async () => root.render(createElement(Probe, { agentId, key: agentId }))),
  };
}

test("navigation and refresh fence stale responses even when fetch ignores cancellation", async t => {
  const slow = deferred<Response>();
  let rootReads = 0, oldSignal: AbortSignal | null | undefined;
  const probe = await mount(t, async (url, init) => {
    if (url.endsWith("/locations")) return Response.json(location());
    const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
    if (!path && !rootReads++) { oldSignal = init?.signal; return slow.promise; }
    return Response.json(listing(path, 3));
  });
  await act(async () => probe.value.navigate("nested"));
  assert.equal(oldSignal?.aborted, true);
  assert.equal(probe.value.listing?.path, "nested");
  await act(async () => slow.resolve(Response.json(listing("", 99))));
  assert.equal(probe.value.listing?.path, "nested");
  assert.equal(probe.value.listing?.total, 3);
  assert.equal(probe.value.busy, false);
  assert.equal(probe.value.error, "");
});

test("agent switching cancels old reads and starts at the new agent's root", async t => {
  const slow = deferred<Response>();
  let oldSignal: AbortSignal | null | undefined;
  const probe = await mount(t, async (url, init) => {
    const agentId = url.split("/")[3]!;
    if (url.endsWith("/locations")) return Response.json(location(agentId));
    if (agentId === "agent") { oldSignal = init?.signal; return slow.promise; }
    return Response.json(listing("", 2));
  });
  await probe.switchAgent("other");
  assert.equal(oldSignal?.aborted, true);
  await act(async () => slow.resolve(Response.json(listing("", 99))));
  assert.equal(probe.value.location?.ownerId, "other");
  assert.equal(probe.value.listing?.total, 2);
  assert.equal(probe.value.path, "");
});

test("pagination hides the previous page and stale errors cannot replace successful refreshes", async t => {
  let reads = 0;
  const slow = deferred<Response>();
  const probe = await mount(t, async url => {
    if (url.endsWith("/locations")) return Response.json(location());
    reads++;
    if (reads === 2) return slow.promise;
    return Response.json(listing("", reads === 1 ? 101 : 102));
  });
  await act(async () => probe.value.paginate(100));
  assert.equal(probe.value.listing, null);
  await act(async () => probe.value.refresh());
  assert.equal(probe.value.listing?.total, 102);
  await act(async () => slow.resolve(Response.json({ error: "Old failure" }, { status: 404 })));
  assert.equal(probe.value.error, "");
  assert.equal(probe.value.listing?.total, 102);
});

test("returning to the browser refreshes the current folder without polling ready folders", async t => {
  let reads = 0;
  const probe = await mount(t, async url => {
    if (url.endsWith("/locations")) return Response.json(location());
    return Response.json(listing("", ++reads));
  });
  assert.equal(reads, 1);
  await act(async () => { probe.window.dispatchEvent(new probe.window.Event("focus")); });
  assert.equal(reads, 2);
  assert.equal(probe.value.listing?.total, 2);
});

test("pending folder setup polls until ready and folder errors recover on retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let state = "pending", fileReads = 0;
  const probe = await mount(t, async url => {
    if (url.endsWith("/locations")) return Response.json(location("agent", state));
    fileReads++;
    return Response.json(listing());
  });
  assert.equal(probe.value.location?.state, "pending");
  assert.equal(fileReads, 0);
  state = "error";
  await act(async () => t.mock.timers.tick(500));
  assert.equal(probe.value.location?.state, "error");
  assert.equal(fileReads, 0);
  state = "ready";
  await act(async () => probe.value.refresh());
  assert.equal(probe.value.location?.state, "ready");
  assert.equal(fileReads, 1);
});
