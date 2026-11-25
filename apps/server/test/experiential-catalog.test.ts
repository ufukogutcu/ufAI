import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { discoverExperiential } from "../src/experiential-catalog.js";
import { ProviderModels } from "../src/provider-models.js";

const origin = "https://api.experientiallabs.ai";
const key = "test-experiential-key";

test("Experiential Labs discovers callable models, groups and filters the saved catalog, and preserves variants and picks", async (t) => {
  const teamSlugs = Array.from({ length: 55 }, (_, index) => `team-${String(index).padStart(2, "0")}`);
  const callable = (id: string, canonical_slug: string, name: string) => ({ id, canonical_slug, name });
  const metadata = [
    ...Array.from({ length: 500 }, (_, index) => ({ model: { slug: `not-callable-${index}` } })),
    { model: { slug: "team-00", maker: " Team & Co. ", context_window: 8192 } },
    { model: { slug: "image-generator", maker: "Other Company", output_modalities: ["image"] } },
  ];
  const offsets: number[] = [];
  let rejectKey = false;
  let rejectMetadata = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, origin);
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
    if (url.pathname === "/api/models") {
      if (rejectMetadata) return new Response(null, { status: 503 });
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      offsets.push(offset);
      return Response.json({ offset, total: metadata.length, models: metadata.slice(offset, offset + limit) });
    }
    if (url.pathname === "/v1/chat/completions") {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, "deepseek-v4:free");
      return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
    }
    assert.equal(url.pathname, "/api/v1/models");
    if (rejectKey) return Response.json({ error: key }, { status: 401 });
    return Response.json({ data: [
      ...teamSlugs.map(id => callable(`team-and-co/${id}`, id, id)),
      { ...callable("deepseek/deepseek-v4", "deepseek-v4", "DeepSeek V4"),
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      callable("deepseek/deepseek-v4:free", "deepseek-v4", "DeepSeek V4"),
      callable("deepseek/deepseek-v4:fast", "deepseek-v4:fast", "DeepSeek V4"),
      callable("exp/private-model", "private-model", "Private model"),
      callable("exp/image-generator", "image-generator", "Image generator"),
      { ...callable("exp/transcription", "transcription", "Transcription"),
        architecture: { input_modalities: ["audio"], output_modalities: ["text"] } },
    ] });
  };
  const app = createApp({ databasePath: ":memory:", serveStatic: false,
    execution: { autoStart: false }, triggers: { autoStart: false }, connections: { fetcher } });
  t.after(() => app.close());
  const call = async (method: "GET" | "POST" | "PATCH", url: string, status: number, payload?: object) => {
    const response = await app.inject({ method, url, payload });
    assert.equal(response.statusCode, status, response.body);
    assert.doesNotMatch(response.body, new RegExp(key));
    return response.json();
  };
  const url = "/api/connections";
  const provider = { provider: "experiential", name: "Experiential Labs" };
  assert.ok((await call("POST", url, 400, provider)).fields.apiKey);
  const { id } = await call("POST", url, 201, { ...provider, apiKey: key });
  const connection = `${url}/${id}`;
  const catalog = `${connection}/models`;
  const selection = `${connection}/model-selection`;
  const first = await call("POST", `${catalog}/refresh`, 200);
  assert.deepEqual(offsets, [0, 500]);
  assert.equal(first.total, 59);
  assert.deepEqual(first.makers, ["DeepSeek", "Team & Co.", null]);
  const team = await call("GET", `${catalog}/team-00`, 200);
  assert.equal(team.maker, "Team & Co.");
  assert.equal(team.contextWindow, 8192);
  assert.equal((await call("GET", `${catalog}/deepseek-v4`, 200)).mediaSettings.effective.image, "supported");
  assert.equal((await call("GET", `${catalog}/deepseek-v4%3Afree`, 200)).name, "DeepSeek V4 (Free)");
  assert.equal((await call("GET", `${catalog}/deepseek-v4%3Afast`, 200)).name, "DeepSeek V4 (Fast)");
  assert.equal((await call("POST", `${catalog}/deepseek-v4%3Afree/test`, 200)).success, true);
  assert.equal((await call("GET", `${catalog}?maker=`, 200)).items[0].id, "private-model");
  const filters = "maker=team+%26+co.&q=TEAM";
  const secondPage = await call("GET", `${catalog}?${filters}&limit=50&offset=50`, 200);
  assert.equal(secondPage.total, 55);
  assert.deepEqual(secondPage.items.map(({ id }: { id: string }) => id), teamSlugs.slice(50));
  assert.deepEqual(secondPage.makers, first.makers);
  const matching = await call("GET", `${selection}?${filters}`, 200);
  assert.deepEqual(matching.items, teamSlugs.map(id => ({ id, enabled: true })));
  assert.equal((await call("GET", `${catalog}?q=team+%26+co.`, 200)).items[0].id, "team-00");
  assert.equal((await call("GET", `${selection}?q=%25`, 200)).items.length, 0);

  await call("POST", catalog, 201, { id: "manual", contextWindowOverride: 2000 });
  await call("PATCH", connection, 200, { draft: false,
    modelSelection: matching.items.map(({ id }: { id: string }) => ({ id, enabled: false })) });
  assert.deepEqual((await call("GET", `${catalog}?enabled=true`, 200)).makers, ["DeepSeek", null]);
  const copy = await call("POST", `${connection}/duplicate`, 201, { name: "Copy" });
  assert.deepEqual((await call("GET", `${url}/${copy.id}/models`, 200)).makers, first.makers);
  assert.equal((await call("GET", `${url}/${copy.id}/models/team-54`, 200)).enabled, false);

  rejectMetadata = true;
  const fallback = await call("POST", `${catalog}/refresh`, 200);
  assert.deepEqual(fallback.makers, ["DeepSeek", "Team And Co", null]);
  assert.equal((await call("GET", `${catalog}/team-54`, 200)).enabled, false);
  assert.equal((await call("GET", `${catalog}/manual`, 200)).contextWindow, 2000);
  rejectKey = true;
  await call("POST", `${catalog}/refresh`, 401);
  assert.deepEqual(await call("GET", `${catalog}?limit=100`, 200), fallback);
});

test("Experiential discovery bounds the authenticated response body", async () => {
  await assert.rejects(discoverExperiential(key, async (input) => {
    if (String(input).endsWith("/api/v1/models")) return new Response("x".repeat(8 * 1024 * 1024 + 1));
    return Response.json({ offset: 0, total: 0, models: [] });
  }), /response exceeded the allowed size/);
});

test("schema 47 adds company metadata without changing existing model settings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-model-company-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "test.sqlite");
  const old = openDatabase(path);
  try {
    old.exec(`ALTER TABLE provider_models DROP COLUMN maker;
      PRAGMA user_version = 46;
      INSERT INTO connections (id, provider, name, createdAt, updatedAt)
        VALUES ('old', 'openai', 'Existing', 'now', 'now');
      INSERT INTO provider_models (connectionId, id, name, contextWindowOverride, manual, enabled)
        VALUES ('old', 'custom', 'Existing model', 16000, 1, 0);`);
  } finally { old.close(); }
  const upgraded = openDatabase(path);
  try {
    assert.equal(upgraded.pragma("user_version", { simple: true }), 47);
    const existing = new ProviderModels(upgraded).get("old", "custom");
    assert.equal(existing?.contextWindow, 16000);
    assert.equal(existing?.manual, true);
    assert.equal(existing?.enabled, false);
    assert.equal(existing?.maker, undefined);
  } finally { upgraded.close(); }
});
