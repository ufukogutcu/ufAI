import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  catalog,
  colorKeys,
  contrastWarnings,
  defaultThemes,
  hexColor,
  normalizeColor,
  resolveColors,
  themeStyle,
  type Theme,
} from "../src/themes";
import { createThemeStore } from "../src/theme-store";
import { connectedSetup, initialSettings } from "./helpers";
import { createSettingsStore } from "../src/settings-store";

const custom: Theme = {
  ...defaultThemes[0]!,
  id: "custom",
  name: "Custom",
  builtIn: false,
  colors: { ...defaultThemes[0]!.colors, text: "#112233" },
};

test("theme mutations update server-owned selection and preserve unrelated themes and drafts on failure", async (t) => {
  const { settings } = await connectedSetup(t);
  const store = createThemeStore(settings);
  const builtin = store.getState().themes[0];
  const saved = await store
    .getState()
    .save(null, {
      name: custom.name,
      mode: custom.mode,
      colors: custom.colors,
    });
  assert.equal(settings.getState().snapshot.activeTheme.id, builtin?.id);
  assert.equal(store.getState().themes[0], builtin);
  await settings.getState().update({ activeThemeId: saved.id });
  assert.equal(settings.getState().snapshot.activeTheme.id, saved.id);
  const updated = await store
    .getState()
    .save(saved.id, {
      name: "Updated",
      mode: saved.mode,
      colors: saved.colors,
    });
  assert.equal(settings.getState().snapshot.activeTheme.name, updated.name);
  const before = store.getState().themes;
  const active = settings.getState().snapshot.activeTheme;
  const mocking = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Try again" }, { status: 500 }),
  );
  await assert.rejects(
    store.getState().save(saved.id, { ...saved, name: "Failed" }),
    /Try again/,
  );
  await assert.rejects(store.getState().remove(saved.id), /Try again/);
  assert.equal(store.getState().themes, before);
  assert.equal(settings.getState().snapshot.activeTheme, active);
  mocking.mock.restore();
  await store.getState().remove(saved.id);
  assert.equal(settings.getState().snapshot.activeTheme.id, "light-mode");
  assert.equal(store.getState().themes.length, 2);
});

test("catalog has complete palettes, unique variables, editor groups and preview regions", () => {
  const regions = [
    "dashboard",
    "navigation",
    "buttons",
    "form",
    "feedback",
    "canvas",
    "dialog",
    "decoration",
  ];
  assert.equal(
    new Set(colorKeys.map((key) => catalog.tokens[key].cssVariable)).size,
    colorKeys.length,
  );
  for (const key of colorKeys) {
    const token = catalog.tokens[key];
    assert.ok(token.label && token.description && token.components.length, key);
    assert.ok(catalog.groups.includes(token.group), key);
    assert.ok(regions.includes(token.region), key);
    assert.ok(hexColor.test(token.light) && hexColor.test(token.dark), key);
    for (const theme of defaultThemes)
      assert.match(theme.colors[key], /^#[\da-f]{6}(?:[\da-f]{2})?$/, key);
    assert.equal(
      themeStyle(defaultThemes[0]!)[
        token.cssVariable as keyof ReturnType<typeof themeStyle>
      ],
      normalizeColor(token.light),
    );
  }
  assert.equal(resolveColors("dark", { text: "#123456" }).text, "#123456");
  assert.equal(resolveColors("dark", {}).text, catalog.tokens.text.dark);
  assert.deepEqual(contrastWarnings(defaultThemes[0]!), []);
  assert.deepEqual(contrastWarnings(defaultThemes[1]!), []);
  assert.ok(
    contrastWarnings({
      ...custom,
      colors: { ...custom.colors, text: custom.colors.background },
    }).some((message) => message.startsWith("Main text:")),
  );
});

test("application color literals and CSS variables must come from the theme catalog", async () => {
  const used = new Set<string>();
  const variables = new Set(
    colorKeys.map((key) => catalog.tokens[key].cssVariable),
  );
  async function inspect(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        await inspect(new URL(`${entry.name}/`, directory));
        continue;
      }
      if (!/\.(scss|tsx?|html)$/.test(entry.name)) continue;
      const source = await readFile(url, "utf8");
      assert.doesNotMatch(source, /#[\da-f]{3,8}\b/i, url.pathname);
      assert.doesNotMatch(
        source,
        /(?:\b(?:rgba?|hsla?|oklch|lab|lch|hwb)\(\s*[\d.]|(?:color|background(?:-color)?|border-color)\s*:\s*(?:white|black|red|blue)\b)/i,
        url.pathname,
      );
      for (const match of source.matchAll(/var\((--[\w-]+)/g)) {
        if (match[1] === "--swatch") continue;
        assert.ok(
          variables.has(match[1]!),
          `Unregistered ${match[1]} in ${url.pathname}`,
        );
        used.add(match[1]!);
      }
    }
  }
  await inspect(new URL("../src/", import.meta.url));
  for (const variable of variables)
    assert.ok(used.has(variable), `Unused color scope ${variable}`);
});

test("theme library paging keeps immutable defaults and unrelated references", async (t) => {
  const settings = createSettingsStore({
    ...initialSettings(),
    activeTheme: custom,
  });
  const store = createThemeStore(settings);
  t.mock.method(globalThis, "fetch", async (url: string) =>
    Response.json(
      url.includes("offset=0")
        ? { items: defaultThemes, total: 3 }
        : { items: [custom], total: 3 },
    ),
  );
  await store.getState().load();
  const builtin = store.getState().themes[0];
  await store.getState().load(true);
  assert.equal(store.getState().themes[0], builtin);
  assert.equal(store.getState().themes.length, 3);
  assert.equal(store.getState().offset, 3);
  assert.equal(settings.getState().snapshot.activeTheme, custom);
});
