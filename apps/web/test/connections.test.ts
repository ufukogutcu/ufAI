import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectionStore } from "../src/connection-store.js";
import {
  createModelLoader,
  type ModelDiscoveryState,
} from "../src/model-discovery.js";
import { providerOptions } from "../src/provider-options.js";
import { connectedSetup } from "./helpers.js";
import type { DiscoveredModel, ProviderConnection } from "../src/api.js";
const connection: ProviderConnection = {
  id: "primary",
  provider: "openai",
  name: "Primary",
  endpoint: null,
  hasCredential: true,
  draft: false,
  createdAt: "now",
  updatedAt: "now",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Provider options retain API and subscription choices and add dedicated Ollama", () => {
  assert.deepEqual(
    providerOptions.filter((p) => p.kind === "runtime").map((p) => p.id),
    ["codex"],
  );
  assert.equal(
    providerOptions.some((p) => p.id === "ollama"),
    true,
  );
  assert.equal(
    providerOptions.some((p) => p.id === "openai-compatible"),
    true,
  );
});
test("model discovery ignores old responses and cancellation; errors preserve manual choices", async () => {
  const first = deferred<{ items: DiscoveredModel[] }>();
  const second = deferred<{ items: DiscoveredModel[] }>();
  const states: ModelDiscoveryState[] = [];
  const loader = createModelLoader((id) =>
    id === "first" ? first.promise : second.promise,
  );
  loader.load("first", (state) => states.push(state));
  const cancel = loader.load("second", (state) => states.push(state));
  second.resolve({
    items: [
      { id: "new", name: "New", contextWindow: null, maxOutputTokens: null },
    ],
  });
  await tick();
  first.resolve({
    items: [
      { id: "old", name: "Old", contextWindow: null, maxOutputTokens: null },
    ],
  });
  await tick();
  assert.equal(states.at(-1)?.connectionId, "second");
  assert.equal(states.at(-1)?.models[0]?.id, "new");
  cancel();
  const failing = createModelLoader(async () => {
    throw new Error("Retry manually");
  });
  failing.load("connection", (state) => states.push(state));
  await tick();
  assert.equal(states.at(-1)?.status, "error");
  assert.equal(states.at(-1)?.error, "Retry manually");
  const unmount = deferred<{ items: DiscoveredModel[] }>();
  const disposed: ModelDiscoveryState[] = [];
  const stop = createModelLoader(() => unmount.promise).load(
    "connection",
    (state) => disposed.push(state),
  );
  stop();
  unmount.resolve({ items: [] });
  await tick();
  assert.equal(disposed.length, 1);
});
test("connection stores are isolated and only publish successful mutations", async (t) => {
  const response = deferred<Response>();
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options?: RequestInit) => {
      if (options?.method === "POST") return response.promise;
      return Response.json({ items: [connection], total: 1 });
    },
  );
  const store = createConnectionStore();
  const other = createConnectionStore();
  const saving = store
    .getState()
    .save(null, { provider: "openai", name: "Primary", apiKey: "secret" });
  assert.deepEqual(store.getState().connections, []);
  response.resolve(Response.json(connection, { status: 201 }));
  await saving;
  assert.equal(store.getState().connections[0]?.id, "primary");
  assert.deepEqual(other.getState().connections, []);
  const original = store.getState().connections;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Failed" }, { status: 500 }),
  );
  await assert.rejects(
    store.getState().save("primary", { name: "Bad edit" }),
    /Failed/,
  );
  assert.equal(store.getState().connections, original);
});
test("connection refreshes exclude setup drafts and preserve saved record identity and navigation memory", async (t) => {
  const draft = { ...connection, id: "unfinished", draft: true };
  let items = [draft, connection];
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ items, total: items.length }),
  );
  const store = createConnectionStore();
  await store.getState().load();
  assert.deepEqual(store.getState().connections, [connection]);
  const saved = store.getState().connections[0];
  store.getState().rememberOpened(connection.id);
  await store.getState().load();
  assert.equal(store.getState().connections[0], saved);
  assert.equal(store.getState().lastOpenedId, connection.id);

  items = [draft];
  await store.getState().load();
  assert.deepEqual(store.getState().connections, []);
  assert.equal(store.getState().status, "ready");
});
test("API, Ollama, and Codex setups enter the library only after successful final Save", async (t) => {
  const { app } = await connectedSetup(t);
  const store = createConnectionStore();
  const stop = store.subscribe((state) => {
    assert.ok(state.connections.every((item) => !item.draft));
  });
  t.after(stop);
  for (const provider of ["openai", "ollama", "codex"] as const) {
    const previous = store.getState().connections;
    const draft = await store.getState().save(null, {
      provider,
      name: `New ${provider}`,
      draft: true,
      ...(provider === "openai" ? { apiKey: "TEST-KEY" } : {}),
    });
    assert.equal(draft.draft, true);
    assert.deepEqual(store.getState().connections, previous);
    assert.equal(store.getState().lastOpenedId, null);
    await store.getState().load();
    const updated = await store.getState().save(draft.id, {
      name: `Updated ${provider}`,
    });
    assert.equal(updated.id, draft.id);
    assert.equal(updated.draft, true);
    assert.deepEqual(store.getState().connections, previous);

    const beforeFailure = store.getState().connections;
    await assert.rejects(
      store.getState().save(draft.id, { draft: false }),
    );
    assert.equal(store.getState().connections, beforeFailure);
    assert.equal(
      (await app.inject("/api/connections")).json().items
        .find((item: ProviderConnection) => item.id === draft.id).draft,
      true,
    );
    for (const id of ["chosen", "unchecked"]) {
      const added = await app.inject({
        method: "POST",
        url: `/api/connections/${draft.id}/models`,
        payload: { id },
      });
      assert.equal(added.statusCode, 201, added.body);
    }
    const finalized = await store.getState().save(draft.id, {
      draft: false,
      modelSelection: [{ id: "unchecked", enabled: false }],
    });
    assert.equal(finalized.draft, false);
    assert.deepEqual(store.getState().connections, [...previous, finalized]);
    assert.equal(store.getState().lastOpenedId, null);
    const selection = await app.inject(`/api/connections/${draft.id}/model-selection`);
    assert.deepEqual(selection.json().items, [
      { id: "chosen", enabled: true },
      { id: "unchecked", enabled: false },
    ]);
    await store.getState().load();
    await store.getState().save(draft.id, { name: `Saved ${provider}` });
    assert.equal(store.getState().connections.filter((item) => item.id === draft.id).length, 1);
  }
});
test("cancelling a hidden setup removes its backend draft without changing the saved library", async (t) => {
  const { app } = await connectedSetup(t);
  const store = createConnectionStore();
  const draft = await store.getState().save(null, {
    provider: "ollama", name: "Cancelled setup", draft: true,
  });
  assert.deepEqual(store.getState().connections, []);
  await store.getState().remove(draft.id);
  assert.deepEqual(store.getState().connections, []);
  assert.equal(store.getState().lastOpenedId, null);
  assert.deepEqual((await app.inject("/api/connections")).json().items, []);
});
test("an old connection refresh cannot overwrite a newer saved connection", async (t) => {
  const old = deferred<Response>();
  let reads = 0;
  const updated = { ...connection, name: "Updated" };
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options?: RequestInit) => {
      if (options?.method === "PATCH") return Response.json(updated);
      reads++;
      return reads === 1
        ? old.promise
        : Response.json({ items: [updated], total: 1 });
    },
  );
  const store = createConnectionStore();
  const loading = store.getState().load();
  const saving = store.getState().save("primary", { name: "Updated", draft: false });
  await tick();
  assert.deepEqual(store.getState().connections, [updated]);
  old.resolve(Response.json({ items: [{ ...connection, draft: true }], total: 1 }));
  await Promise.all([loading, saving]);
  assert.deepEqual(store.getState().connections, [updated]);
});
