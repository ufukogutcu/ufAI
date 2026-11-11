import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createSettingsStore } from "../src/settings-store.js";
import { createDashboardStore } from "../src/store.js";
import { defaultThemes } from "../src/themes.js";
import { refreshOnFocus } from "../src/focus-refresh.js";
import { connectedSetup, initialSettings } from "./helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test("settings are shared across independent application instances", async (t) => {
  const { settings, initial } = await connectedSetup(t);
  const second = createSettingsStore(initial);
  await settings
    .getState()
    .update({ activeThemeId: "dark-mode", sidebarExpanded: true });
  assert.equal(second.getState().snapshot.activeTheme.id, "light-mode");
  await second.getState().refresh();
  assert.equal(second.getState().snapshot.activeTheme.id, "dark-mode");
  assert.equal(second.getState().snapshot.settings.sidebarExpanded, true);
});

test("settings writes wait for confirmation and failures retain the saved state with a working retry", async (t) => {
  const initial = initialSettings();
  const settings = createSettingsStore(initial);
  const response = deferred<Response>();
  const mock = t.mock.method(globalThis, "fetch", () => response.promise);
  const saving = settings.getState().update({ sidebarExpanded: true });
  assert.equal(settings.getState().snapshot, initial);
  response.resolve(Response.json({ error: "Offline" }, { status: 500 }));
  await saving;
  assert.equal(settings.getState().snapshot, initial);
  assert.match(settings.getState().error, /Offline/);
  mock.mock.mockImplementation(async () =>
    Response.json({
      ...initial,
      settings: { ...initial.settings, sidebarExpanded: true },
    }),
  );
  await settings.getState().retry();
  assert.equal(settings.getState().snapshot.settings.sidebarExpanded, true);
  assert.equal(settings.getState().error, "");
});

test("duplicate refreshes coalesce and an older read cannot overwrite a newer local write", async (t) => {
  const initial = initialSettings();
  const settings = createSettingsStore(initial);
  const oldRead = deferred<Response>();
  let reads = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH")
        return Response.json({
          ...initial,
          settings: { ...initial.settings, activeThemeId: "dark-mode" },
          activeTheme: defaultThemes[1],
        });
      reads += 1;
      return oldRead.promise;
    },
  );
  const first = settings.getState().refresh();
  const second = settings.getState().refresh();
  await settings.getState().update({ activeThemeId: "dark-mode" });
  oldRead.resolve(Response.json(initial));
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(settings.getState().snapshot.activeTheme.id, "dark-mode");
});

test("writes run in action order and a failed post-mutation refresh never repeats the CRUD action", async (t) => {
  const settings = createSettingsStore(initialSettings());
  const first = deferred<Response>();
  const sent: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init?: RequestInit) => {
      if (!init?.body)
        return Response.json({ error: "Read failed" }, { status: 500 });
      const themeId = JSON.parse(String(init.body)).activeThemeId;
      sent.push(themeId);
      if (sent.length === 1) return first.promise;
      return Response.json(initialSettings());
    },
  );
  const one = settings.getState().update({ activeThemeId: "dark-mode" });
  const two = settings.getState().update({ activeThemeId: "light-mode" });
  await Promise.resolve();
  assert.deepEqual(sent, ["dark-mode"]);
  first.resolve(
    Response.json({ ...initialSettings(), activeTheme: defaultThemes[1] }),
  );
  await Promise.all([one, two]);
  assert.deepEqual(sent, ["dark-mode", "light-mode"]);
  let creates = 0;
  assert.equal(
    await settings.getState().mutate(async () => {
      creates += 1;
      return "created";
    }),
    "created",
  );
  await settings.getState().retry();
  assert.equal(creates, 1);
  assert.match(settings.getState().error, /Read failed/);
});

test("viewport reads cannot replace a newer interaction; writes coalesce to the latest completed view", async (t) => {
  const store = createDashboardStore(createSettingsStore(initialSettings()));
  const reading = deferred<Response>();
  const writing = deferred<Response>();
  const writes: unknown[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init?: RequestInit) => {
      if (init?.method !== "PATCH") return reading.promise;
      writes.push(JSON.parse(String(init.body)));
      return writes.length === 1 ? writing.promise : Response.json({});
    },
  );
  const load = store.getState().loadViewport("a");
  store.getState().beginViewportInteraction("a");
  assert.equal(writes.length, 0);
  const one = store.getState().saveViewport("a", { x: 1, y: 0, zoom: 1 });
  const two = store.getState().saveViewport("a", { x: 2, y: 0, zoom: 1 });
  const three = store.getState().saveViewport("a", { x: 3, y: 0, zoom: 1 });
  reading.resolve(Response.json({ x: -10, y: 0, zoom: 1 }));
  await load;
  assert.equal(store.getState().viewports.a?.x, 3);
  writing.resolve(Response.json({}));
  await Promise.all([one, two, three]);
  assert.deepEqual(writes, [
    { x: 1, y: 0, zoom: 1 },
    { x: 3, y: 0, zoom: 1 },
  ]);
});

test("focus and visibility refresh coalesce, skip hidden tabs, and remove their listeners", async (t) => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  for (const [key, value] of [
    ["window", win],
    ["document", doc],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const refreshing = deferred<void>();
  let calls = 0;
  const dispose = refreshOnFocus(async () => {
    calls += 1;
    await refreshing.promise;
  });
  win.dispatchEvent(new Event("focus"));
  assert.equal(calls, 0);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  win.dispatchEvent(new Event("focus"));
  assert.equal(calls, 1);
  refreshing.resolve();
  await refreshing.promise;
  dispose();
  win.dispatchEvent(new Event("focus"));
  assert.equal(calls, 1);
});

test("startup and preference code never consult browser storage or browser color preferences", async () => {
  for (const name of [
    "api.ts",
    "themes.ts",
    "main.tsx",
    "settings-store.ts",
    "store.ts",
    "App.tsx",
  ]) {
    const source = await readFile(
      new URL(`../src/${name}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|indexedDB|prefers-color-scheme/,
    );
  }
});

test("failed viewport saves survive focus reads and retry writes; failed reads retry without overwriting the backend", async (t) => {
  const store = createDashboardStore(createSettingsStore(initialSettings()));
  const methods: string[] = [];
  let failing = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return failing
        ? Response.json({ error: "Unavailable" }, { status: 500 })
        : Response.json({ x: 8, y: 0, zoom: 1 });
    },
  );
  await store.getState().saveViewport("a", { x: 8, y: 0, zoom: 1 });
  assert.match(store.getState().viewportErrors.a!, /Unavailable/);
  await store.getState().loadViewport("a");
  assert.deepEqual(methods, ["PATCH"]);
  assert.equal(store.getState().viewports.a?.x, 8);
  failing = false;
  await store.getState().retryViewport("a");
  assert.deepEqual(methods, ["PATCH", "PATCH"]);
  assert.equal(store.getState().viewportErrors.a, "");
  failing = true;
  await store.getState().loadViewport("a");
  assert.match(store.getState().viewportErrors.a!, /Unavailable/);
  failing = false;
  await store.getState().retryViewport("a");
  assert.deepEqual(methods, ["PATCH", "PATCH", "GET", "GET"]);
});

test("ending an interrupted gesture releases viewport refresh after an earlier save finishes", async (t) => {
  const store = createDashboardStore(createSettingsStore(initialSettings()));
  const writing = deferred<Response>();
  let reads = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return writing.promise;
      reads += 1;
      return Response.json({ x: 12, y: 0, zoom: 1 });
    },
  );
  const saving = store.getState().saveViewport("a", { x: 8, y: 0, zoom: 1 });
  store.getState().beginViewportInteraction("a");
  await store.getState().loadViewport("a");
  assert.equal(reads, 0);
  writing.resolve(Response.json({}));
  await saving;
  store.getState().endViewportInteraction("a");
  await store.getState().loadViewport("a");
  assert.equal(reads, 1);
  assert.equal(store.getState().viewports.a?.x, 12);
});
