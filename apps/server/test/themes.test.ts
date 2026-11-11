import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import catalog from "@ufai/theme-catalog" with { type: "json" };
import { createApp } from "../src/app.js";
import type { Theme } from "../src/contracts.js";

test("theme defaults are permanent; custom CRUD, duplication and pagination are independent", async (t) => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false });
  t.after(() => app.close());
  const initial = (await app.inject("/api/themes")).json();
  assert.deepEqual(
    initial.items.map((theme: Theme) => theme.name),
    ["Light Mode", "Dark Mode"],
  );
  assert.equal(initial.total, 2);
  for (const theme of initial.items) {
    for (const color of Object.values(theme.colors))
      assert.match(color as string, /^#[\da-f]{6}(?:[\da-f]{2})?$/);
    for (const method of ["PATCH", "DELETE"] as const)
      assert.equal(
        (
          await app.inject({
            method,
            url: `/api/themes/${theme.id}`,
            payload:
              method === "PATCH"
                ? { name: "Changed", colors: { text: "#123" } }
                : undefined,
          })
        ).statusCode,
        403,
      );
    assert.deepEqual(
      (await app.inject(`/api/themes/${theme.id}`)).json(),
      theme,
    );
  }
  const created = await app.inject({
    method: "POST",
    url: "/api/themes",
    payload: {
      name: "  My theme  ",
      mode: "dark",
      colors: { accent: "#AbC8" },
    },
  });
  assert.equal(created.statusCode, 201);
  const custom = created.json<Theme>();
  assert.equal(custom.name, "My theme");
  assert.equal(custom.builtIn, false);
  assert.equal(custom.colors.accent, "#aabbcc88");
  assert.equal(custom.colors.text, catalog.tokens.text.dark);
  assert.ok(custom.createdAt);
  const copy = (
    await app.inject({
      method: "POST",
      url: "/api/themes",
      payload: { name: "Copy", mode: custom.mode, colors: custom.colors },
    })
  ).json<Theme>();
  assert.notEqual(copy.id, custom.id);
  const updated = await app.inject({
    method: "PATCH",
    url: `/api/themes/${copy.id}`,
    payload: { name: "Changed", colors: { text: "#123456" } },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().colors.text, "#123456");
  assert.equal(updated.json().colors.accent, "#aabbcc88");
  assert.deepEqual(
    (await app.inject(`/api/themes/${custom.id}`)).json(),
    custom,
  );
  const items: Theme[] = [];
  for (let offset = 0; offset < 4; offset++) {
    const page = (
      await app.inject(`/api/themes?limit=1&offset=${offset}`)
    ).json();
    assert.equal(page.total, 4);
    assert.equal(page.items.length, 1);
    items.push(...page.items);
  }
  assert.equal(new Set(items.map((theme) => theme.id)).size, 4);
  assert.deepEqual(
    (await app.inject("/api/themes?offset=10")).json().items,
    [],
  );
  for (const theme of [custom, copy])
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/themes/${theme.id}` }))
        .statusCode,
      204,
    );
  assert.deepEqual((await app.inject("/api/themes")).json(), initial);
  for (const method of ["GET", "PATCH", "DELETE"] as const)
    assert.equal(
      (
        await app.inject({
          method,
          url: "/api/themes/missing",
          payload: method === "PATCH" ? { name: "Missing" } : undefined,
        })
      ).statusCode,
      404,
    );
});

test("invalid theme inputs cannot change saved colors or protected fields", async (t) => {
  const app = createApp({ databasePath: ":memory:", serveStatic: false });
  t.after(() => app.close());
  const valid = { name: "Test", mode: "light", colors: {} };
  const invalid = [
    { name: " " },
    { name: "a".repeat(121) },
    { mode: "system" },
    { mode: null },
    { colors: [] },
    { colors: null },
    { colors: { unknown: "#fff" } },
    { colors: { text: "red" } },
    { colors: { text: "var(--text)" } },
    { colors: { text: "#abcde" } },
    { colors: { text: 2 } },
    { id: "dark-mode" },
    { builtIn: true },
    { createdAt: "x" },
  ];
  const saved = (
    await app.inject({ method: "POST", url: "/api/themes", payload: valid })
  ).json<Theme>();
  for (const patch of invalid) {
    const created = await app.inject({
      method: "POST",
      url: "/api/themes",
      payload: { ...valid, ...patch },
    });
    assert.equal(created.statusCode, 400, JSON.stringify(patch));
    assert.ok(created.json().fields);
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/themes/${saved.id}`,
          payload: patch,
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(
      (await app.inject(`/api/themes/${saved.id}`)).json(),
      saved,
    );
  }
  for (const query of [
    "limit=0",
    "limit=101",
    "offset=-1",
    "offset=0.5",
    "limit=no",
  ])
    assert.equal((await app.inject(`/api/themes?${query}`)).statusCode, 400);
  assert.equal((await app.inject("/api/themes")).json().total, 3);
});

test("version 1 upgrades preserve records; themes survive restart and older colors gain new defaults", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-themes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "test.sqlite");
  // Model the pre-theme schema without executing the new migration first.
  const old = new Database(databasePath);
  old.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE model_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, integrationKind TEXT NOT NULL, provider TEXT NOT NULL,
      customProviderName TEXT, modelId TEXT NOT NULL, contextWindow INTEGER, maxOutputTokens INTEGER, notes TEXT NOT NULL,
      compactionMode TEXT NOT NULL, compactionValue INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('existing', 'Existing workspace', 'now', 'now'); PRAGMA user_version = 1;`);
  old.close();
  let app = createApp({ databasePath, serveStatic: false });
  const saved = (
    await app.inject({
      method: "POST",
      url: "/api/themes",
      payload: { name: "Persistent", mode: "light", colors: { text: "#123" } },
    })
  ).json<Theme>();
  assert.equal(
    (await app.inject("/api/workspaces")).json().items[0].id,
    "existing",
  );
  await app.close();
  const storage = new Database(databasePath);
  assert.equal(storage.pragma("user_version", { simple: true }), 5);
  storage
    .prepare("UPDATE themes SET colors = ? WHERE id = ?")
    .run(JSON.stringify({ text: "#112233" }), saved.id);
  storage.close();
  app = createApp({ databasePath, serveStatic: false });
  t.after(() => app.close());
  const restored = (await app.inject(`/api/themes/${saved.id}`)).json<Theme>();
  assert.equal(restored.colors.text, "#112233");
  assert.equal(
    restored.colors["canvas-dots"],
    catalog.tokens["canvas-dots"].light,
  );
  assert.equal(
    Object.keys(restored.colors).length,
    Object.keys(catalog.tokens).length,
  );
  assert.equal((await app.inject("/api/themes")).json().total, 3);
});
