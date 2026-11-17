import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardStore } from "../src/store";
import { createSettingsStore } from "../src/settings-store";
import { initialSettings, connectedSetup } from "./helpers";
import type { Workspace } from "../src/api";
const workspace = (id: string, sortOrder: number): Workspace => ({ id, name: id, description: "", sortOrder,
  createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test("saved order survives refreshes, pagination, creation, and preserves the selected workspace", async t => {
  const { settings } = await connectedSetup(t);
  const store = createDashboardStore(settings);
  await store.getState().loadWorkspaces();
  await store.getState().createWorkspace("B");
  await store.getState().createWorkspace("C");
  const [a, b, c] = store.getState().workspaces;
  const activeId = settings.getState().snapshot.settings.activeWorkspaceId;
  assert.equal(await store.getState().reorderWorkspace(c!.id, a!.id, "before"), true);
  assert.deepEqual(store.getState().workspaces.map(w => w.id), [c!.id, a!.id, b!.id]);
  await store.getState().loadWorkspaces();
  assert.deepEqual(store.getState().workspaces.map(w => w.id), [c!.id, a!.id, b!.id]);
  assert.equal(settings.getState().snapshot.settings.activeWorkspaceId, activeId);
  await store.getState().createWorkspace("D");
  assert.deepEqual(store.getState().workspaces.map(w => w.name), ["C", a!.name, "B", "D"]);
});

test("a move is optimistic, excludes concurrent saves and pagination, and ignores a stale read", async t => {
  const settings = createSettingsStore(initialSettings());
  const store = createDashboardStore(settings);
  const items = [workspace("a", 0), workspace("b", 1), workspace("c", 2)];
  store.setState({ workspaces: items, workspaceOffset: 3, workspaceTotal: 3, workspaceStatus: "ready" });
  const stale = deferred<Response>(), write = deferred<Response>();
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"}:${url}`);
    if (init?.method === "PATCH") return write.promise;
    if (calls.length === 1) return stale.promise;
    return Response.json({ items: [{ ...items[2], sortOrder: 0 }, { ...items[0], sortOrder: 1 }, { ...items[1], sortOrder: 2 }], total: 3 });
  });
  const loading = store.getState().loadWorkspaces();
  const saving = store.getState().reorderWorkspace("c", "a", "before");
  assert.deepEqual(store.getState().workspaces.map(w => w.id), ["c", "a", "b"]);
  assert.equal(store.getState().workspaceOrderSaving, true);
  assert.equal(await store.getState().reorderWorkspace("b", "c", "before"), false);
  await store.getState().loadWorkspaces(true);
  assert.equal(calls.length, 2);
  write.resolve(new Response(null, { status: 204 }));
  assert.equal(await saving, true);
  stale.resolve(Response.json({ items, total: 3 })); await loading;
  assert.deepEqual(store.getState().workspaces.map(w => w.id), ["c", "a", "b"]);
  assert.equal(store.getState().workspaceOrderSaving, false);
});

test("failed writes reconcile, preserve newer metadata, and retry the same relative move", async t => {
  const store = createDashboardStore(createSettingsStore(initialSettings()));
  const items = [workspace("a", 0), workspace("b", 1)];
  store.setState({ workspaces: items, workspaceOffset: 2, workspaceTotal: 2, workspaceStatus: "ready" });
  let writes = 0;
  const write = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { writes++; return writes === 1 ? write.promise : new Response(null, { status: 204 }); }
    return Response.json({ items: writes < 2 ? items : [{ ...items[1], sortOrder: 0 }, { ...items[0], sortOrder: 1 }], total: 2 });
  });
  const saving = store.getState().reorderWorkspace("b", "a", "before");
  store.setState(state => ({ workspaces: state.workspaces.map(w => w.id === "a" ? { ...w, name: "Edited", updatedAt: "2026-02-01" } : w) }));
  write.resolve(Response.json({ error: "Offline" }, { status: 503 }));
  assert.equal(await saving, false);
  assert.equal(store.getState().workspaceOrderError, "Offline");
  assert.deepEqual(store.getState().workspaces.map(w => w.id), ["a", "b"]);
  assert.equal(store.getState().workspaces[0]!.name, "Edited");
  await store.getState().retryWorkspaceOrder();
  assert.deepEqual(store.getState().workspaces.map(w => w.id), ["b", "a"]);
  assert.equal(store.getState().workspaceOrderError, "");
  assert.equal(store.getState().workspaces[1]!.name, "Edited");
});

test("a confirmed save with a failed refresh retries only the read", async t => {
  const store = createDashboardStore(createSettingsStore(initialSettings()));
  const items = [workspace("a", 0), workspace("b", 1)];
  store.setState({ workspaces: items, workspaceOffset: 2, workspaceTotal: 2, workspaceStatus: "ready" });
  let writes = 0, reads = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { writes++; return new Response(null, { status: 204 }); }
    if (++reads === 1) throw new Error("Disconnected");
    return Response.json({ items: [{ ...items[1], sortOrder: 0 }, { ...items[0], sortOrder: 1 }], total: 2 });
  });
  assert.equal(await store.getState().reorderWorkspace("b", "a", "before"), false);
  assert.deepEqual(store.getState().workspaces.map(w => w.id), ["b", "a"]);
  await store.getState().retryWorkspaceOrder();
  assert.equal(writes, 1); assert.equal(reads, 2);
  assert.equal(store.getState().workspaceOrderError, "");
});

test("moving beside an active workspace outside the loaded page retains moved tabs and loads the intervening range", async t => {
  const items = Array.from({ length: 105 }, (_, i) => workspace(`w${i}`, i));
  const initial = initialSettings(); initial.activeWorkspace = items[104]!; initial.settings.activeWorkspaceId = items[104]!.id;
  const store = createDashboardStore(createSettingsStore(initial));
  store.setState({ workspaces: items.slice(0, 100), workspaceOffset: 100, workspaceTotal: 105, workspaceStatus: "ready" });
  let saved = false;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { saved = true; return new Response(null, { status: 204 }); }
    const ordered = saved ? [...items.slice(1), items[0]!].map((w, sortOrder) => ({ ...w, sortOrder })) : items;
    const offset = Number(new URL(url, "http://localhost").searchParams.get("offset"));
    return Response.json({ items: ordered.slice(offset, offset + 100), total: 105 });
  });
  assert.equal(await store.getState().reorderWorkspace("w0", "w104", "after"), true);
  assert.equal(store.getState().workspaceOffset, 105);
  assert.equal(store.getState().workspaces.at(-1)!.id, "w0");
  assert.equal(new Set(store.getState().workspaces.map(w => w.id)).size, 105);
});
