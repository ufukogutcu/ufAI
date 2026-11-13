import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentStore } from "../src/agent-store";

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
