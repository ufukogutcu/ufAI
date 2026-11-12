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
    description: "",
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

test("workspace creates and edits refresh selected details, preserve unrelated records and retain state on failure", async (t) => {
  const { settings } = await connectedSetup(t);
  const store = createDashboardStore(settings);
  await store.getState().loadWorkspaces();
  const original = store.getState().workspaces[0];
  await store
    .getState()
    .createWorkspace("Studio", "Plan products.\nShip useful tools.");
  const created = settings.getState().snapshot.activeWorkspace!;
  assert.equal(created.description, "Plan products.\nShip useful tools.");
  assert.deepEqual(
    store.getState().workspaces.find((item) => item.id === created.id),
    created,
  );
  await store
    .getState()
    .updateWorkspace(created.id, { name: "Renamed", description: "New goal" });
  const updated = settings.getState().snapshot.activeWorkspace!;
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.description, "New goal");
  assert.deepEqual(
    store.getState().workspaces.find((item) => item.id === created.id),
    updated,
  );
  assert.equal(store.getState().workspaces[0], original);
  const before = store.getState().workspaces;
  await assert.rejects(
    store.getState().updateWorkspace(created.id, {
      name: "Not saved",
      description: "x".repeat(4001),
    }),
  );
  assert.equal(store.getState().workspaces, before);
  assert.equal(settings.getState().snapshot.activeWorkspace, updated);
  await assert.rejects(store.getState().createWorkspace("", "Invalid create"));
  assert.equal(store.getState().workspaces, before);
  await store
    .getState()
    .updateWorkspace(created.id, { name: updated.name, description: "" });
  assert.equal(settings.getState().snapshot.activeWorkspace?.description, "");
  await store.getState().createWorkspace("No description");
  assert.equal(settings.getState().snapshot.activeWorkspace?.description, "");
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
    name: input.name,
    connectionId: null,
    modelId: null,
    compaction: null,
    provider: null,
    integrationKind: null,
    customProviderName: null,
    contextWindow: null,
    maxOutputTokens: null,
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

function presetRecord(id: string): ModelPreset {
  return {
    id,
    name: id,
    connectionId: null,
    modelId: null,
    compaction: null,
    provider: null,
    integrationKind: null,
    customProviderName: null,
    contextWindow: null,
    maxOutputTokens: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
test("preset focus refresh retains all loaded pages and unchanged record identities", async (t) => {
  const records = Array.from({ length: 150 }, (_, i) =>
    presetRecord(`preset-${String(i).padStart(3, "0")}`),
  );
  const offsets: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const offset = Number(
      new URL(url, "http://localhost").searchParams.get("offset"),
    );
    offsets.push(offset);
    return Response.json({
      items: records.slice(offset, offset + 100),
      total: records.length,
    });
  });
  const store = createDashboardStore(createSettingsStore(initialSettings()));
  await store.getState().loadPresets();
  await store.getState().loadPresets(true);
  const last = store.getState().presets[149];
  await store.getState().loadPresets();
  assert.equal(store.getState().presets.length, 150);
  assert.equal(store.getState().presets[149], last);
  assert.deepEqual(offsets, [0, 100, 0, 100]);
});
test("an old preset refresh cannot overwrite a newer successful save", async (t) => {
  let finish!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const record = presetRecord("preset");
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options?: RequestInit) =>
      options?.method === "PATCH"
        ? Response.json({ ...record, name: "New" })
        : old,
  );
  const store = createDashboardStore(createSettingsStore(initialSettings()));
  const loading = store.getState().loadPresets();
  await store.getState().savePreset(record.id, { name: "New" });
  finish(Response.json({ items: [record], total: 1 }));
  await loading;
  assert.equal(store.getState().presets[0]?.name, "New");
  assert.equal(store.getState().presetStatus, "ready");
});

test("confirmed provider selection repairs loaded preset bindings and prevents stale refresh restoration", async t => {
  const linked = { ...presetRecord("linked"), connectionId: "provider", modelId: "hidden", contextWindow: 1000, maxOutputTokens: 100 };
  const unrelated = { ...presetRecord("unrelated"), connectionId: "other", modelId: "hidden" };
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return reads === 1 ? Response.json({ items: [linked, unrelated], total: 2 }) : pending;
  });
  const store = createDashboardStore(createSettingsStore(initialSettings()));
  await store.getState().loadPresets();
  const other = store.getState().presets[1];
  const loading = store.getState().loadPresets();
  store.getState().clearPresetModels("provider", ["hidden"]);
  finish(Response.json({ items: [linked, unrelated], total: 2 }));
  await loading;
  const repaired = store.getState().presets[0]!;
  assert.equal(repaired.modelId, null);
  assert.equal(repaired.contextWindow, null);
  assert.equal(repaired.maxOutputTokens, null);
  assert.equal(repaired.connectionId, "provider");
  assert.deepEqual(repaired.compaction, linked.compaction);
  assert.equal(repaired.updatedAt, linked.updatedAt);
  assert.equal(store.getState().presets[1], other);
});
