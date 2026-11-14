import assert from "node:assert/strict";
import { test } from "node:test";
import { createMessageTransitStore } from "../src/message-transit-store";
import type { MessageTransit } from "../../server/src/contracts";

const epoch = Date.parse("2026-11-14T12:00:00.000Z");
function flight(messageId = "one", workspaceId = "workspace", linkId = "link"): MessageTransit {
  return { messageId, workspaceId, linkId, requestId: "request", senderAgentId: "a", recipientAgentId: "b", startedAt: new Date(epoch).toISOString(), arrivesAt: new Date(epoch + 2000).toISOString(), state: "in_flight" };
}
function page(items: MessageTransit[], nextCursor: number | null = null, serverNow = epoch) {
  return Response.json({ items, nextCursor, serverNow: new Date(serverNow).toISOString() });
}

test("transmission snapshots deduplicate pages, preserve unchanged links and stay workspace scoped", async t => {
  const previous = globalThis.fetch;
  const store = createMessageTransitStore(() => 100);
  t.after(() => { globalThis.fetch = previous; store.getState().clear(); });
  globalThis.fetch = async url => String(url).includes("after=7")
    ? page([flight("one"), flight("other", "elsewhere"), flight("two", "workspace", "second")])
    : page([flight()], 7);
  await store.getState().refresh("workspace");
  assert.equal(store.getState().byLink.link!.length, 1);
  assert.equal(store.getState().byLink.second!.length, 1);
  assert.equal(Object.values(store.getState().byLink).flat().length, 2);
  const first = store.getState().byLink.link;
  const second = store.getState().byLink.second;
  await store.getState().refresh("workspace");
  assert.equal(store.getState().byLink.link, first);
  assert.equal(store.getState().byLink.second, second);
  const transit = first![0]!;
  assert.equal(transit.localStartedAt, 100);
  assert.equal(transit.localArrivesAt, 2100);
});

test("a slow earlier snapshot cannot resurrect cancelled mail or leak into a different workspace", async t => {
  const previous = globalThis.fetch;
  const store = createMessageTransitStore(() => 100);
  t.after(() => { globalThis.fetch = previous; store.getState().clear(); });
  let release!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => calls++ === 0
    ? new Promise<Response>(resolve => { release = resolve; })
    : page([]);
  const old = store.getState().refresh("workspace");
  await store.getState().refresh("new-workspace");
  release(page([flight()]));
  await old;
  assert.deepEqual(store.getState().byLink, {});
});

test("reconnect joins an ongoing trip and expired mail disappears without further events", async t => {
  const previous = globalThis.fetch;
  let time = 100;
  const store = createMessageTransitStore(() => time);
  t.after(() => { globalThis.fetch = previous; store.getState().clear(); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = async () => page([flight()], null, epoch + 1200);
  await store.getState().refresh("workspace");
  const transit = store.getState().byLink.link![0]!;
  assert.equal((time - transit.localStartedAt) / (transit.localArrivesAt - transit.localStartedAt), 0.6);
  time += 801;
  t.mock.timers.tick(801);
  assert.deepEqual(store.getState().byLink, {});
  globalThis.fetch = async () => page([flight()], null, epoch + 3000);
  await store.getState().refresh("workspace");
  assert.deepEqual(store.getState().byLink, {});
});

test("clearing a canvas invalidates an in-flight refresh and failed reads retain current flights", async t => {
  const previous = globalThis.fetch;
  const store = createMessageTransitStore(() => 100);
  t.after(() => { globalThis.fetch = previous; store.getState().clear(); });
  globalThis.fetch = async () => page([flight()]);
  await store.getState().refresh("workspace");
  const before = store.getState().byLink;
  globalThis.fetch = async () => { throw new Error("offline"); };
  await store.getState().refresh("workspace");
  assert.equal(store.getState().byLink, before);
  let release!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve; });
  const reading = store.getState().refresh("workspace");
  store.getState().clear();
  release(page([flight()]));
  await reading;
  assert.deepEqual(store.getState().byLink, {});
});
