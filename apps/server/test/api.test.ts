import { deleteOwner } from "./deletion-helper.js";
import { removeExecutionTables } from "./legacy-schema.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import type { ModelPreset, Workspace } from "../src/contracts.js";

const basicPreset = { name: "Coding" };
function memoryApp() {
  return createApp({ databasePath: ":memory:", serveStatic: false });
}

test("health, workspace CRUD, pagination and parameterized names", async (t) => {
  const app = memoryApp();
  t.after(() => app.close());
  assert.deepEqual((await app.inject("/api/health")).json(), { status: "ok" });
  const initial = (await app.inject("/api/workspaces")).json();
  assert.equal(initial.total, 1);
  assert.equal(initial.items[0].name, "Default workspace");
  assert.equal(initial.items[0].description, "");
  const created = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "  Studio  " },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<Workspace>();
  assert.equal(workspace.name, "Studio");
  assert.equal(workspace.description, "");
  assert.ok(workspace.id);
  assert.ok(workspace.createdAt);
  const sqlText = "Robert'); DROP TABLE workspaces;--";
  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/workspaces/${workspace.id}`,
    payload: { name: sqlText },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().name, sqlText);
  const page = (await app.inject("/api/workspaces?limit=1&offset=1")).json();
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
  assert.equal(
    (await deleteOwner(app, `/api/workspaces/${workspace.id}`)).statusCode,
    202,
  );
  assert.equal(
    (await deleteOwner(app, `/api/workspaces/${workspace.id}`)).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/workspaces/missing",
        payload: { name: "x" },
      })
    ).statusCode,
    404,
  );
});

test("workspace descriptions support partial updates, clearing, validation and settings resolution", async (t) => {
  const app = memoryApp();
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: {
      name: "Studio",
      description: "  Plan products.\nShip useful tools.  ",
    },
  });
  assert.equal(created.statusCode, 201);
  let workspace = created.json<Workspace>();
  assert.equal(workspace.description, "Plan products.\nShip useful tools.");
  const url = `/api/workspaces/${workspace.id}`;
  const renamed = await app.inject({
    method: "PATCH",
    url,
    payload: { name: "New studio" },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().description, workspace.description);
  const described = await app.inject({
    method: "PATCH",
    url,
    payload: { description: "x".repeat(4000) },
  });
  assert.equal(described.statusCode, 200);
  workspace = described.json<Workspace>();
  assert.equal(workspace.name, "New studio");
  assert.equal(workspace.description.length, 4000);
  const unchanged = await app.inject({ method: "PATCH", url, payload: {} });
  assert.equal(unchanged.statusCode, 200);
  assert.deepEqual(unchanged.json(), workspace);
  for (const description of [null, 42, {}, [], "x".repeat(4001)]) {
    for (const method of ["POST", "PATCH"] as const) {
      const invalid = await app.inject({
        method,
        url: method === "POST" ? "/api/workspaces" : url,
        payload: { name: "Invalid edit", description },
      });
      assert.equal(invalid.statusCode, 400);
      assert.ok(invalid.json().fields.description);
    }
  }
  const invalid = await app.inject({
    method: "PATCH",
    url,
    payload: { name: "Not saved", unknown: true },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(
    (await app.inject("/api/settings")).json().activeWorkspace,
    workspace,
  );
  assert.deepEqual(
    (await app.inject("/api/workspaces"))
      .json()
      .items.find((item: Workspace) => item.id === workspace.id),
    workspace,
  );
  for (const description of ["", "  \n  "]) {
    const cleared = await app.inject({
      method: "PATCH",
      url,
      payload: { description },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().description, "");
    assert.equal(cleared.json().name, workspace.name);
  }
});

test("workspace input and list bounds return actionable errors", async (t) => {
  const app = memoryApp();
  t.after(() => app.close());
  for (const payload of [
    { name: " " },
    { name: "a".repeat(121) },
    { name: 42 },
    { name: "x", id: "client-id" },
    [],
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.ok(response.json().fields);
  }
  for (const query of [
    "limit=101",
    "limit=0",
    "offset=-1",
    "offset=0.5",
    "limit=oops",
  ]) {
    assert.equal(
      (await app.inject(`/api/workspaces?${query}`)).statusCode,
      400,
    );
    assert.equal(
      (await app.inject(`/api/model-presets?${query}`)).statusCode,
      400,
    );
  }
  const malformed = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { "content-type": "application/json" },
    payload: "{",
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(typeof malformed.json().error, "string");
});

test("agent presets allow name-only records, nullable compaction, partial patch and pagination", async (t) => {
  const app = memoryApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/model-presets",
    payload: { name: "  Coding  " },
  });
  assert.equal(response.statusCode, 201);
  const preset = response.json<ModelPreset>();
  assert.equal(preset.name, "Coding");
  for (const key of [
    "connectionId",
    "provider",
    "integrationKind",
    "modelId",
    "contextWindow",
    "compaction",
  ] as const)
    assert.equal(preset[key], null);
  const changed = await app.inject({
    method: "PATCH",
    url: `/api/model-presets/${preset.id}`,
    payload: { compaction: { mode: "tokens", value: 900 } },
  });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(changed.json().compaction, { mode: "tokens", value: 900 });
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/model-presets/${preset.id}`,
        payload: { compaction: null },
      })
    ).json().compaction,
    null,
  );
  await app.inject({
    method: "POST",
    url: "/api/model-presets",
    payload: { name: "Other", connectionId: null, modelId: null },
  });
  const page = (await app.inject("/api/model-presets?limit=1&offset=1")).json();
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/model-presets/${preset.id}`,
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/model-presets/${preset.id}`,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/model-presets/missing",
        payload: { name: "x" },
      })
    ).statusCode,
    404,
  );
});
test("agent presets reject malformed supplied values, derived metadata and protected fields", async (t) => {
  const app = memoryApp();
  t.after(() => app.close());
  const cases: [Record<string, unknown>, string][] = [
    [{ name: "" }, "name"],
    [{ name: "x".repeat(121) }, "name"],
    [{ modelId: 1 }, "modelId"],
    [{ provider: "openai" }, "provider"],
    [{ integrationKind: "runtime" }, "integrationKind"],
    [{ contextWindow: 1000 }, "contextWindow"],
    [{ maxOutputTokens: 10 }, "maxOutputTokens"],
    [{ connectionId: 2 }, "connectionId"],
    [{ connectionId: "missing" }, "connectionId"],
    [{ compaction: { mode: "percentage", value: 101 } }, "compaction.value"],
    [{ compaction: { mode: "percentage", value: 1.2 } }, "compaction.value"],
    [{ compaction: { mode: "tokens", value: 0 } }, "compaction.value"],
    [
      { compaction: { mode: "tokens", value: Number.MAX_SAFE_INTEGER + 1 } },
      "compaction.value",
    ],
    [{ compaction: { mode: "invalid", value: 80 } }, "compaction.mode"],
    [
      { compaction: { mode: "percentage", value: 80, extra: true } },
      "compaction",
    ],
    [{ id: "client-id" }, "id"],
    [{ notes: "removed" }, "notes"],
  ];
  for (const [patch, field] of cases) {
    const result = await app.inject({
      method: "POST",
      url: "/api/model-presets",
      payload: { name: "Test", ...patch },
    });
    assert.equal(result.statusCode, 400, JSON.stringify(patch));
    assert.ok(result.json().fields[field], result.body);
  }
  assert.equal((await app.inject("/api/model-presets")).json().total, 0);
});

test("migration is repeatable, records survive reopen, and deleted seed never returns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-api-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "test.sqlite");
  let app = createApp({ databasePath, serveStatic: false });
  try {
    const seed = (await app.inject("/api/workspaces")).json().items[0];
    await deleteOwner(app, `/api/workspaces/${seed.id}`);
    const workspace = (
      await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: {
          name: "Persisted",
          description: "A lasting goal.\nAcross restarts.",
        },
      })
    ).json<Workspace>();
    const preset = (
      await app.inject({
        method: "POST",
        url: "/api/model-presets",
        payload: basicPreset,
      })
    ).json<ModelPreset>();
    await app.close();
    app = createApp({ databasePath, serveStatic: false });
    assert.deepEqual(
      (await app.inject("/api/workspaces")).json().items[0],
      workspace,
    );
    assert.deepEqual(
      (await app.inject("/api/model-presets")).json().items[0],
      preset,
    );
    await deleteOwner(app, `/api/workspaces/${workspace.id}`);
    await app.close();
    app = createApp({ databasePath, serveStatic: false });
    assert.deepEqual((await app.inject("/api/workspaces")).json(), {
      items: [],
      total: 0,
    });
  } finally {
    await app.close();
  }
});

test("version 3 migration adds empty descriptions without changing existing workspace state", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "ufai-description-migration-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "test.sqlite");
  const old = openDatabase(databasePath);
  const workspace = old
    .prepare("SELECT id, name, createdAt, updatedAt FROM workspaces")
    .get() as Omit<Workspace, "description">;
  old
    .prepare(
      "UPDATE app_settings SET activeThemeId = 'dark-mode', sidebarExpanded = 1 WHERE id = 1",
    )
    .run();
  old
    .prepare("INSERT INTO workspace_viewports VALUES (?, 12, -24, 1.5)")
    .run(workspace.id);
  removeExecutionTables(old);
  old.exec(
    "DROP TABLE provider_models; DROP INDEX model_presets_connection; ALTER TABLE model_presets DROP COLUMN connectionId; DROP TABLE connections; ALTER TABLE model_presets ADD COLUMN maxOutputTokens INTEGER; ALTER TABLE model_presets ADD COLUMN notes TEXT NOT NULL DEFAULT ''; ALTER TABLE workspaces DROP COLUMN description; PRAGMA user_version = 3;",
  );
  old.close();
  let app = createApp({ databasePath, serveStatic: false });
  try {
    const settings = (await app.inject("/api/settings")).json();
    assert.deepEqual(settings.activeWorkspace, {
      ...workspace,
      description: "",
    });
    assert.deepEqual(settings.settings, {
      activeWorkspaceId: workspace.id,
      activeThemeId: "dark-mode",
      sidebarExpanded: true,
      characterAnimationsPaused: false,
    });
    assert.deepEqual(
      (await app.inject(`/api/workspaces/${workspace.id}/viewport`)).json(),
      { x: 12, y: -24, zoom: 1.5 },
    );
    await app.close();
    app = createApp({ databasePath, serveStatic: false });
    assert.deepEqual((await app.inject("/api/settings")).json(), settings);
    assert.equal((await app.inject("/api/workspaces")).json().total, 1);
  } finally {
    await app.close();
  }
});

test("newer database versions fail without downgrading schema", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-version-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "test.sqlite");
  const db = openDatabase(path);
  assert.equal(db.pragma("user_version", { simple: true }), 16);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  db.pragma("user_version = 17");
  db.close();
  assert.throws(() => openDatabase(path), /newer version/);
  const inspection = new Database(path, { readonly: true });
  assert.equal(inspection.pragma("user_version", { simple: true }), 17);
  inspection.close();
});
