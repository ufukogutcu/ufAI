import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import {
  catalog,
  colorKeys,
  contrastWarnings,
  defaultThemes,
  hexColor,
  normalizeColor,
  readInitialTheme,
  resolveColors,
  themeStyle,
  type Theme,
} from "../src/themes";
import { createThemeStore } from "../src/theme-store";

function replaceGlobal(t: TestContext, key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { value, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
}
function preferences(t: TestContext, dark = false) {
  const data = new Map<string, string>();
  replaceGlobal(t, "localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  replaceGlobal(t, "window", { matchMedia: () => ({ matches: dark }) });
  return data;
}
const custom: Theme = {
  ...defaultThemes[0]!,
  id: "custom",
  name: "Custom",
  builtIn: false,
  colors: { ...defaultThemes[0]!.colors, text: "#112233" },
};

test("first visit follows system once; cached overrides survive system changes and unsafe cache is ignored", (t) => {
  const data = preferences(t, true);
  assert.equal(readInitialTheme().id, "dark-mode");
  data.set(
    "ufai.theme",
    JSON.stringify({ version: 1, theme: defaultThemes[0] }),
  );
  assert.equal(readInitialTheme().id, "light-mode");
  data.set("ufai.theme", JSON.stringify({ version: 1, theme: custom }));
  assert.equal(readInitialTheme().colors.text, "#112233");
  const old = { ...custom, colors: { text: "#112233" } };
  data.set("ufai.theme", JSON.stringify({ version: 1, theme: old }));
  assert.equal(
    readInitialTheme().colors["canvas-dots"],
    catalog.tokens["canvas-dots"].light,
  );
  data.set(
    "ufai.theme",
    JSON.stringify({
      version: 1,
      theme: { ...custom, colors: { text: "url(unsafe)" } },
    }),
  );
  assert.equal(readInitialTheme().id, "dark-mode");
  data.set("ufai.theme", "broken json");
  assert.equal(readInitialTheme().id, "dark-mode");
  data.set(
    "ufai.theme",
    JSON.stringify({
      version: 1,
      theme: { ...defaultThemes[0], colors: { text: "#123456" } },
    }),
  );
  assert.equal(readInitialTheme().colors.text, catalog.tokens.text.light);
});

test("blocked optional storage does not prevent selection or startup", (t) => {
  preferences(t);
  t.mock.method(localStorage, "getItem", () => {
    throw new Error("blocked");
  });
  t.mock.method(localStorage, "setItem", () => {
    throw new Error("blocked");
  });
  assert.equal(readInitialTheme().id, "light-mode");
  const store = createThemeStore(defaultThemes[0]!);
  assert.doesNotThrow(() => store.getState().select(defaultThemes[1]!));
  assert.equal(store.getState().active.id, "dark-mode");
});

test("active theme refresh retains cached colors on errors and replaces a missing theme with a default", async (t) => {
  preferences(t, true);
  const store = createThemeStore(custom);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Offline" }, { status: 500 }),
  );
  await store.getState().refreshActive();
  assert.equal(store.getState().active, custom);
  assert.match(store.getState().activeError, /cached/);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Missing" }, { status: 404 }),
  );
  await store.getState().refreshActive();
  assert.equal(store.getState().active.id, "dark-mode");
});

test("theme mutations are server-confirmed and preserve unrelated themes and drafts on failure", async (t) => {
  preferences(t);
  const store = createThemeStore(defaultThemes[0]!);
  const builtin = store.getState().themes[0];
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(custom, { status: 201 }),
  );
  const saved = await store.getState().save(null, custom);
  assert.deepEqual(saved, custom);
  assert.equal(store.getState().active, builtin);
  assert.equal(store.getState().themes[0], builtin);
  store.getState().select(custom);
  const before = store.getState().themes;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Try again" }, { status: 500 }),
  );
  await assert.rejects(
    store.getState().save(custom.id, { ...custom, name: "New" }),
    /Try again/,
  );
  await assert.rejects(store.getState().remove(custom.id), /Try again/);
  assert.equal(store.getState().themes, before);
  assert.equal(store.getState().active, custom);
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 204 }),
  );
  await store.getState().remove(custom.id);
  assert.equal(store.getState().active.id, "light-mode");
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

test("an in-flight refresh cannot overwrite a later selection or a saved edit", async (t) => {
  preferences(t);
  const store = createThemeStore(custom);
  let finish!: (response: Response) => void;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const refreshing = store.getState().refreshActive();
  store.getState().select(defaultThemes[1]!);
  finish(Response.json(custom));
  await refreshing;
  assert.equal(store.getState().active.id, "dark-mode");
  store.getState().select(custom);
  const second = store.getState().refreshActive();
  const next = { ...custom, name: "Updated" };
  store.getState().select(next);
  finish(Response.json(custom));
  await second;
  assert.equal(store.getState().active, next);
});

test("theme library paging keeps immutable defaults and unrelated references", async (t) => {
  preferences(t);
  const store = createThemeStore(custom);
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
  assert.equal(store.getState().active, custom);
});
