import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectionStore } from "../src/connection-store.js";
import {
  createModelLoader,
  type ModelDiscoveryState,
} from "../src/model-discovery.js";
import {
  draftFromPreset,
  draftToInput,
  selectProvider,
  selectModel,
  validateDraft,
  providerOptions,
} from "../src/preset-form.js";
import type { DiscoveredModel, ProviderConnection } from "../src/api.js";
const connection: ProviderConnection = {
  id: "primary",
  provider: "openai",
  name: "Primary",
  endpoint: null,
  hasCredential: true,
  isDefault: true,
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

test("new presets require an explicit provider; provider and model changes reset only model details", () => {
  const draft = draftFromPreset();
  assert.equal(draft.provider, "");
  assert.ok(validateDraft(draft).provider);
  const selected = selectProvider(
    {
      ...draft,
      name: "Kept",
      modelId: "old",
      contextWindow: "500",
      maxOutputTokens: "100",
    },
    "openai",
    "provider",
    [connection],
  );
  assert.equal(selected.connectionId, "primary");
  assert.equal(selected.modelId, "");
  assert.equal(selected.contextWindow, "");
  assert.equal(selected.name, "Kept");
  assert.equal(selected.compactionValue, "80");
  const model = {
    id: "new",
    name: "New",
    contextWindow: 1000,
    maxOutputTokens: 200,
  };
  const chosen = selectModel(selected, model.id, [model]);
  assert.equal(chosen.contextWindow, "1000");
  assert.equal(chosen.maxOutputTokens, "200");
  assert.equal(selectModel(chosen, "new", [model]), chosen);
  const manual = selectModel(chosen, "manual", []);
  assert.equal(manual.contextWindow, "");
  assert.equal(manual.maxOutputTokens, "");
  assert.equal("notes" in draftToInput(manual), false);
  assert.deepEqual(
    providerOptions.filter((p) => p.kind === "runtime").map((p) => p.id),
    ["codex"],
  );
  assert.equal(
    providerOptions.some((p) => p.id === "ollama" || p.id === "custom"),
    false,
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
  const saving = store.getState().save("primary", { name: "Updated" });
  await tick();
  old.resolve(Response.json({ items: [connection], total: 1 }));
  await Promise.all([loading, saving]);
  assert.equal(store.getState().connections[0]?.name, "Updated");
});
