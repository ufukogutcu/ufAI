import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentStore } from "../src/agent-store";
import type { CommunicationLink } from "../../server/src/contracts";

const anchoredLink: CommunicationLink = {
  id: "link", workspaceId: "one", sourceAgentId: "a", targetAgentId: "b",
  sourceAnchorAngle: 0, targetAnchorAngle: 180, state: "active", createdAt: "now",
};

test("anchor writes coalesce completed adjustments and keep newer drafts over older responses", async t => {
  let saved = { ...anchoredLink };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const patches: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(init.body as string);
      patches.push(patch);
      if (patches.length === 1) await blocked;
      saved = { ...saved, ...patch };
      return Response.json(saved);
    }
    return Response.json(String(url).includes("communication-links") ? { items: [saved], total: 1 } : { items: [], total: 0, unread: 0 });
  });
  const store = createAgentStore();
  await store.getState().loadCommunication("one");
  const nodes = store.getState().nodes;
  const first = store.getState().saveCommunicationAnchors("one", "link", { sourceAnchorAngle: 20 });
  const second = store.getState().saveCommunicationAnchors("one", "link", { sourceAnchorAngle: 40 });
  const third = store.getState().saveCommunicationAnchors("one", "link", { targetAnchorAngle: 90 });
  assert.deepEqual(store.getState().anchorDrafts.link, { sourceAnchorAngle: 40, targetAnchorAngle: 90 });
  assert.deepEqual(patches, [{ sourceAnchorAngle: 20 }]);
  await store.getState().loadCommunication("one");
  assert.equal(store.getState().anchorDrafts.link?.sourceAnchorAngle, 40);
  release(); await Promise.all([first, second, third]);
  assert.deepEqual(patches, [{ sourceAnchorAngle: 20 }, { sourceAnchorAngle: 40, targetAnchorAngle: 90 }]);
  assert.equal(store.getState().communication.one!.links[0]!.sourceAnchorAngle, 40);
  assert.equal(store.getState().communication.one!.links[0]!.targetAnchorAngle, 90);
  assert.deepEqual(store.getState().anchorDrafts, {});
  assert.equal(store.getState().nodes, nodes);
});

test("a stale communication read cannot rewind a completed anchor save", async t => {
  let saved = { ...anchoredLink }, block = false;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { saved = { ...saved, ...JSON.parse(init.body as string) }; return Response.json(saved); }
    if (String(url).includes("communication-links")) {
      const snapshot = { ...saved };
      if (block) await blocked;
      return Response.json({ items: [snapshot], total: 1 });
    }
    return Response.json({ items: [], total: 0, unread: 0 });
  });
  const store = createAgentStore(); await store.getState().loadCommunication("one");
  block = true;
  const read = store.getState().loadCommunication("one");
  await store.getState().saveCommunicationAnchors("one", "link", { sourceAnchorAngle: 100 });
  release(); await read;
  assert.equal(store.getState().communication.one!.links[0]!.sourceAnchorAngle, 100);
});

test("failed anchor saves keep visible drafts for Retry saves; permanent failures discard them", async t => {
  let status = 503;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return status === 200
      ? Response.json({ ...anchoredLink, ...JSON.parse(init.body as string) })
      : Response.json({ error: "Save failed" }, { status });
    return Response.json(String(url).includes("communication-links") ? { items: [anchoredLink], total: 1 } : { items: [], total: 0, unread: 0 });
  });
  const store = createAgentStore(); await store.getState().loadCommunication("one");
  await assert.rejects(store.getState().saveCommunicationAnchors("one", "link", { sourceAnchorAngle: 60 }), /Save failed/);
  await store.getState().loadCommunication("one");
  assert.equal(store.getState().anchorDrafts.link?.sourceAnchorAngle, 60);
  assert.equal(store.getState().positionError, "Save failed");
  status = 200; await store.getState().retryPositions();
  assert.deepEqual(store.getState().anchorDrafts, {});
  assert.equal(store.getState().communication.one!.links[0]!.sourceAnchorAngle, 60);
  assert.equal(store.getState().positionError, "");
  status = 409;
  await assert.rejects(store.getState().saveCommunicationAnchors("one", "link", { targetAnchorAngle: 10 }));
  assert.deepEqual(store.getState().anchorDrafts, {});
  assert.equal(store.getState().communication.one!.links[0]!.targetAnchorAngle, 180);
});

test("deleting a link during a failed save cannot restore its draft or queue a retry", async t => {
  let deleted = false, writes = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { writes++; await blocked; return Response.json({ error: "Disconnected" }, { status: 503 }); }
    return Response.json(String(url).includes("communication-links")
      ? { items: deleted ? [] : [anchoredLink], total: deleted ? 0 : 1 } : { items: [], total: 0, unread: 0 });
  });
  const store = createAgentStore(); await store.getState().loadCommunication("one");
  const saving = store.getState().saveCommunicationAnchors("one", "link", { sourceAnchorAngle: 60 });
  const rejected = assert.rejects(saving, /Disconnected/);
  deleted = true; await store.getState().loadCommunication("one");
  assert.deepEqual(store.getState().anchorDrafts, {});
  release(); await rejected;
  await store.getState().retryPositions();
  assert.deepEqual(store.getState().anchorDrafts, {});
  assert.equal(writes, 1);
  assert.deepEqual(store.getState().communication.one!.links, []);
});

test("communication refresh preserves stable links, canvas nodes, and unsaved drafts", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => (globalThis.fetch = previous));
  const link = {
    id: "link",
    workspaceId: "one",
    sourceAgentId: "a",
    targetAgentId: "b",
    state: "active",
    createdAt: "now",
  };
  globalThis.fetch = async (url) =>
    Response.json(
      String(url).includes("/communication-links")
        ? { items: [link], total: 1 }
        : { items: [], total: 0, unread: 0 },
    );
  const store = createAgentStore();
  store.getState().setDraft("task", "Keep draft");
  await store.getState().loadCommunication("one");
  const snapshot = store.getState().communication.one;
  const links = store.getState().communication.one!.links,
    nodes = store.getState().nodes;
  await store.getState().loadCommunication("one");
  assert.equal(store.getState().communication.one, snapshot);
  assert.equal(store.getState().communication.one!.links, links);
  assert.equal(store.getState().nodes, nodes);
  assert.equal(store.getState().drafts.task, "Keep draft");
});
test("refresh requested during an in-flight permission save fetches a fresh snapshot after acceptance", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => (globalThis.fetch = previous));
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    blocked = new Promise<void>((r) => (release = r));
  let reads = 0,
    created = false;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      created = true;
      return Response.json({ id: "link" });
    }
    if (String(url).includes("/communication-links")) {
      const snapshot = created ? [{ id: "link", workspaceId: "one" }] : [];
      if (reads++ === 0) {
        entered();
        await blocked;
      }
      return Response.json({ items: snapshot, total: snapshot.length });
    }
    return Response.json({ items: [], total: 0, unread: 0 });
  };
  const store = createAgentStore(),
    loading = store.getState().loadCommunication("one");
  await started;
  const saving = store.getState().createCommunicationLink("one", "a", "b");
  await Promise.resolve();
  release();
  await Promise.all([loading, saving]);
  assert.equal(store.getState().communication.one!.links.length, 1);
  assert.ok(reads >= 2);
});
test("workspace responses stay scoped, failed saves retain snapshots, and inbox drafts remain separate", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => (globalThis.fetch = previous));
  globalThis.fetch = async (url, init) =>
    init?.method === "POST"
      ? Response.json({ error: "Save failed" }, { status: 409 })
      : Response.json(
          String(url).includes("/communication-links")
            ? {
                items: [
                  {
                    id: String(url).includes("/one/") ? "one-link" : "two-link",
                  },
                ],
                total: 1,
              }
            : {
                items: [],
                total: 0,
                unread: String(url).includes("/one/") ? 2 : 5,
              },
        );
  const store = createAgentStore();
  store.getState().setDraft("inbox:one", "First");
  store.getState().setDraft("inbox:two", "Second");
  await Promise.all([
    store.getState().loadCommunication("one"),
    store.getState().loadCommunication("two"),
  ]);
  const before = store.getState().communication.one;
  await assert.rejects(
    () => store.getState().createCommunicationLink("one", "a", "b"),
    /Save failed/,
  );
  assert.equal(store.getState().communication.one, before);
  assert.equal(store.getState().communication.one!.unread, 2);
  assert.equal(store.getState().communication.two!.unread, 5);
  assert.equal(store.getState().drafts["inbox:two"], "Second");
});
