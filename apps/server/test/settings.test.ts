import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createApp } from "../src/app.js";
import type { SettingsResponse } from "../src/contracts.js";

function app() {
  return createApp({ databasePath: ":memory:", serveStatic: false });
}

test("one settings record, resolved selections beyond pagination, and independent partial updates", async (t) => {
  const server = app();
  t.after(() => server.close());
  const initial = (
    await server.inject("/api/settings")
  ).json<SettingsResponse>();
  assert.equal(initial.settings.activeThemeId, "light-mode");
  assert.equal(initial.settings.sidebarExpanded, false);
  assert.equal(initial.activeWorkspace?.name, "Default workspace");
  let workspaceId = "";
  for (let i = 0; i < 101; i++) {
    workspaceId = (
      await server.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: `W${i}` },
      })
    ).json().id;
  }
  let themeId = "";
  for (let i = 0; i < 101; i++) {
    themeId = (
      await server.inject({
        method: "POST",
        url: "/api/themes",
        payload: { name: `T${i}`, mode: "dark", colors: {} },
      })
    ).json().id;
  }
  workspaceId = (await server.inject("/api/workspaces?offset=100")).json()
    .items[0].id;
  themeId = (await server.inject("/api/themes?offset=100")).json().items[0].id;
  await server.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { activeThemeId: themeId, activeWorkspaceId: workspaceId },
  });
  await server.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { sidebarExpanded: true },
  });
  const settings = (
    await server.inject("/api/settings")
  ).json<SettingsResponse>();
  assert.deepEqual(settings.settings, {
    activeThemeId: themeId,
    activeWorkspaceId: workspaceId,
    sidebarExpanded: true,
  });
  assert.equal(settings.activeTheme.id, themeId);
  assert.equal(settings.activeWorkspace?.id, workspaceId);
  assert.ok(
    !(await server.inject("/api/workspaces"))
      .json()
      .items.some((w: { id: string }) => w.id === workspaceId),
  );
  assert.ok(
    !(await server.inject("/api/themes"))
      .json()
      .items.some((theme: { id: string }) => theme.id === themeId),
  );
});

test("settings and viewport validation is atomic and rejects invalid references and fields", async (t) => {
  const server = app();
  t.after(() => server.close());
  const initial = (
    await server.inject("/api/settings")
  ).json<SettingsResponse>();
  for (const payload of [
    [],
    null,
    { sidebarExpanded: 1 },
    { activeThemeId: "missing", sidebarExpanded: true },
    { activeThemeId: null },
    { activeWorkspaceId: "missing" },
    { activeWorkspaceId: 3 },
    { userId: "user" },
  ]) {
    assert.equal(
      (await server.inject({ method: "PATCH", url: "/api/settings", payload }))
        .statusCode,
      400,
    );
    assert.deepEqual((await server.inject("/api/settings")).json(), initial);
  }
  const path = `/api/workspaces/${initial.settings.activeWorkspaceId}/viewport`;
  assert.deepEqual((await server.inject(path)).json(), { x: 0, y: 0, zoom: 1 });
  for (const payload of [
    [],
    { x: "1" },
    { x: null },
    { y: true },
    { zoom: 0.24 },
    { zoom: 2.01 },
    { workspaceId: "missing" },
  ])
    assert.equal(
      (await server.inject({ method: "PATCH", url: path, payload })).statusCode,
      400,
    );
  const infinite = await server.inject({
    method: "PATCH",
    url: path,
    headers: { "content-type": "application/json" },
    payload: '{"x":1e999}',
  });
  assert.equal(infinite.statusCode, 400);
  assert.equal(
    (await server.inject("/api/workspaces/missing/viewport")).statusCode,
    404,
  );
  assert.equal(
    (
      await server.inject({
        method: "PATCH",
        url: "/api/workspaces/missing/viewport",
        payload: { zoom: 1 },
      })
    ).statusCode,
    404,
  );
  assert.deepEqual(
    (
      await server.inject({
        method: "PATCH",
        url: path,
        payload: { x: -150, zoom: 0.25 },
      })
    ).json(),
    { x: -150, y: 0, zoom: 0.25 },
  );
  assert.deepEqual(
    (
      await server.inject({
        method: "PATCH",
        url: path,
        payload: { y: 72.5, zoom: 2 },
      })
    ).json(),
    { x: -150, y: 72.5, zoom: 2 },
  );
});

test("deletions repair selected records and cascade viewports; empty setup stays empty", async (t) => {
  const server = app();
  t.after(() => server.close());
  const initialId = (await server.inject("/api/settings")).json().settings
    .activeWorkspaceId;
  const second = (
    await server.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Second" },
    })
  ).json();
  const third = (
    await server.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Third" },
    })
  ).json();
  const ordered = (await server.inject("/api/workspaces")).json().items;
  const middle = ordered[1];
  await server.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { activeWorkspaceId: middle.id },
  });
  await server.inject({
    method: "PATCH",
    url: `/api/workspaces/${middle.id}/viewport`,
    payload: { x: 100 },
  });
  await server.inject({
    method: "DELETE",
    url: `/api/workspaces/${middle.id}`,
  });
  assert.equal(
    (await server.inject("/api/settings")).json().settings.activeWorkspaceId,
    ordered[2].id,
  );
  await server.inject({
    method: "DELETE",
    url: `/api/workspaces/${ordered[2].id}`,
  });
  assert.equal(
    (await server.inject("/api/settings")).json().settings.activeWorkspaceId,
    ordered[0].id,
  );
  await server.inject({
    method: "DELETE",
    url: `/api/workspaces/${ordered[0].id}`,
  });
  assert.equal(
    (await server.inject("/api/settings")).json().activeWorkspace,
    null,
  );
  assert.equal(
    (await server.inject(`/api/workspaces/${middle.id}/viewport`)).statusCode,
    404,
  );
  const theme = (
    await server.inject({
      method: "POST",
      url: "/api/themes",
      payload: { name: "Custom", mode: "dark", colors: {} },
    })
  ).json();
  await server.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { activeThemeId: theme.id },
  });
  await server.inject({ method: "DELETE", url: `/api/themes/${theme.id}` });
  assert.equal(
    (await server.inject("/api/settings")).json().settings.activeThemeId,
    "light-mode",
  );
  assert.ok(initialId && second.id && third.id);
});

test("version 2 migration preserves data; all settings survive reopening by independent clients", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "local.sqlite");
  let server = createApp({ databasePath, serveStatic: false });
  const workspace = (await server.inject("/api/settings")).json()
    .activeWorkspace;
  const theme = (
    await server.inject({
      method: "POST",
      url: "/api/themes",
      payload: { name: "Kept", mode: "dark", colors: { text: "#123456" } },
    })
  ).json();
  const preset = (
    await server.inject({
      method: "POST",
      url: "/api/model-presets",
      payload: {
        name: "Kept preset",
      },
    })
  ).json();
  await server.close();
  const old = new Database(databasePath);
  old.exec(
    "DROP TABLE provider_models; DROP INDEX model_presets_connection; ALTER TABLE model_presets DROP COLUMN connectionId; DROP TABLE connections; ALTER TABLE model_presets ADD COLUMN maxOutputTokens INTEGER; ALTER TABLE model_presets ADD COLUMN notes TEXT NOT NULL DEFAULT ''; DROP TABLE workspace_viewports; DROP TABLE app_settings; ALTER TABLE workspaces DROP COLUMN description; PRAGMA user_version = 2;",
  );
  old.close();
  server = createApp({ databasePath, serveStatic: false });
  const initial = (
    await server.inject("/api/settings")
  ).json<SettingsResponse>();
  assert.equal(initial.settings.activeWorkspaceId, workspace.id);
  assert.equal(initial.settings.activeThemeId, "light-mode");
  assert.deepEqual(
    (await server.inject(`/api/themes/${theme.id}`)).json(),
    theme,
  );
  assert.deepEqual(
    (await server.inject("/api/model-presets")).json().items[0],
    preset,
  );
  await server.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { activeThemeId: theme.id, sidebarExpanded: true },
  });
  await server.inject({
    method: "PATCH",
    url: `/api/workspaces/${workspace.id}/viewport`,
    payload: { x: 17, y: -20, zoom: 1.5 },
  });
  const saved = (await server.inject("/api/settings")).json();
  await server.close();
  server = createApp({ databasePath, serveStatic: false });
  const otherClient = createApp({ databasePath, serveStatic: false });
  t.after(async () => {
    await server.close();
    await otherClient.close();
  });
  assert.deepEqual((await server.inject("/api/settings")).json(), saved);
  assert.deepEqual((await otherClient.inject("/api/settings")).json(), saved);
  assert.deepEqual(
    (
      await otherClient.inject(`/api/workspaces/${workspace.id}/viewport`)
    ).json(),
    { x: 17, y: -20, zoom: 1.5 },
  );
  await otherClient.inject({
    method: "DELETE",
    url: `/api/workspaces/${workspace.id}`,
  });
  await server.close();
  const storage = new Database(databasePath);
  assert.equal(storage.pragma("user_version", { simple: true }), 9);
  assert.equal(
    (
      storage
        .prepare("SELECT count(*) AS n FROM workspace_viewports")
        .get() as { n: number }
    ).n,
    0,
  );
  storage.close();
  server = createApp({ databasePath, serveStatic: false });
  assert.equal(
    (await server.inject("/api/settings")).json().activeWorkspace,
    null,
  );
  assert.equal((await server.inject("/api/workspaces")).json().total, 0);
});
