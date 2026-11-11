import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardStore } from "../src/store.js";
import { draftFromPreset, draftToInput } from "../src/preset-form.js";
import type { ModelPreset, Workspace } from "../src/api.js";

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("application stores and per-workspace viewports stay isolated", () => {
  const first = createDashboardStore();
  const second = createDashboardStore();
  first.getState().saveViewport("a", { x: 50, y: 20, zoom: 1.2 });
  first.getState().saveViewport("b", { x: 0, y: 0, zoom: 1 });
  assert.equal(first.getState().viewports.a?.zoom, 1.2);
  assert.equal(first.getState().viewports.b?.zoom, 1);
  assert.deepEqual(second.getState().viewports, {});
});

test("paginated loads preserve selection and unrelated record identities", async (t) => {
  const first = workspace("a");
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const items = url.includes("offset=0") ? [first] : [workspace("b")];
    return Response.json({ items, total: 2 });
  });
  const store = createDashboardStore();
  await store.getState().loadWorkspaces();
  const before = store.getState().workspaces[0];
  store.getState().selectWorkspace("a");
  await store.getState().loadWorkspaces(true);
  assert.equal(store.getState().workspaces[0], before);
  assert.equal(store.getState().activeWorkspaceId, "a");
  assert.equal(store.getState().workspaceOffset, 2);
  assert.deepEqual(
    store.getState().workspaces.map((item) => item.id),
    ["a", "b"],
  );
});

test("preset state changes only after a successful server response", async (t) => {
  const input = draftToInput({
    ...draftFromPreset(),
    name: "Test",
    modelId: "model",
  });
  const record: ModelPreset = {
    ...input,
    id: "preset",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  let finish!: (response: Response) => void;
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const store = createDashboardStore();
  const saving = store.getState().savePreset(null, input);
  assert.deepEqual(store.getState().presets, []);
  finish(Response.json(record, { status: 201 }));
  await saving;
  const saved = store.getState().presets;
  const failed = store
    .getState()
    .savePreset("preset", { ...input, name: "Failed edit" });
  finish(Response.json({ error: "Try again" }, { status: 500 }));
  await assert.rejects(failed, /Try again/);
  assert.equal(store.getState().presets, saved);
  assert.equal(store.getState().presets[0]?.name, "Test");
});

test("deleting an active workspace selects a neighbor and clears its viewport", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ items: [workspace("a"), workspace("b")], total: 2 }),
  );
  const store = createDashboardStore();
  await store.getState().loadWorkspaces();
  store.getState().selectWorkspace("a");
  store.getState().saveViewport("a", { x: 20, y: 0, zoom: 1 });
  await store.getState().deleteWorkspace("a");
  assert.equal(store.getState().activeWorkspaceId, "b");
  assert.equal(store.getState().viewports.a, undefined);
  await store.getState().deleteWorkspace("b");
  assert.equal(store.getState().activeWorkspaceId, null);
  assert.deepEqual(store.getState().workspaces, []);
});
