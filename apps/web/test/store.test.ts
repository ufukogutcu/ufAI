import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedSetup, initialSettings } from "./helpers";
import { createSettingsStore } from "../src/settings-store.js";
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

test("application caches stay isolated while saved per-workspace viewports are shared", async (t) => {
  const { settings, initial } = await connectedSetup(t);
  const first = createDashboardStore(settings);
  const second = createDashboardStore(settings);
  const id = initial.settings.activeWorkspaceId!;
  await first.getState().saveViewport(id, { x: 50, y: 20, zoom: 1.2 });
  assert.equal(first.getState().viewports[id]?.zoom, 1.2);
  assert.deepEqual(second.getState().viewports, {});
  await second.getState().loadViewport(id);
  assert.equal(second.getState().viewports[id]?.zoom, 1.2);
});

test("paginated loads preserve selection and unrelated record identities", async (t) => {
  const first = workspace("a");
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const items = url.includes("offset=0") ? [first] : [workspace("b")];
    return Response.json({ items, total: 2 });
  });
  const settings = createSettingsStore(initialSettings());
  const store = createDashboardStore(settings);
  await store.getState().loadWorkspaces();
  const before = store.getState().workspaces[0];
  settings.setState({
    snapshot: {
      ...initialSettings(),
      settings: { ...initialSettings().settings, activeWorkspaceId: "a" },
      activeWorkspace: first,
    },
  });
  await store.getState().loadWorkspaces(true);
  assert.equal(store.getState().workspaces[0], before);
  assert.equal(settings.getState().snapshot.settings.activeWorkspaceId, "a");
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
  const settings = createSettingsStore(initialSettings());
  const store = createDashboardStore(settings);
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

test("deleting an active workspace uses the backend neighbor and clears its viewport", async (t) => {
  const { settings } = await connectedSetup(t);
  const store = createDashboardStore(settings);
  await store.getState().createWorkspace("a");
  const id = settings.getState().snapshot.settings.activeWorkspaceId!;
  await store.getState().saveViewport(id, { x: 20, y: 0, zoom: 1 });
  await store.getState().deleteWorkspace(id);
  assert.notEqual(settings.getState().snapshot.settings.activeWorkspaceId, id);
  assert.equal(store.getState().viewports[id], undefined);
});
