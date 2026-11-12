import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "../src/api.js";
import { contextDifference, resetContextToAutomatic } from "../src/model-context.js";

test("context comparisons require a known automatic value and a differing manual override", () => {
  for (const [manual, automatic] of [[null, null], [null, 272000], [400000, null], [272000, 272000]]) {
    assert.equal(contextDifference({ contextWindowOverride: manual, discoveredContextWindow: automatic }), null);
  }
  for (const manual of [100000, 400000]) {
    assert.deepEqual(contextDifference({ contextWindowOverride: manual, discoveredContextWindow: 272000 }), {
      manual, automatic: 272000,
    });
  }
});

test("switching to automatic context patches only that override and returns saved metadata", async (t) => {
  const saved = { id: "model/with space", contextWindowOverride: null, contextWindow: 272000, maxOutputTokensOverride: 42 };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/connections/provider/models/model%2Fwith%20space");
    assert.equal(init.method, "PATCH");
    assert.deepEqual(JSON.parse(init.body as string), { contextWindowOverride: null });
    return Response.json(saved);
  });
  assert.deepEqual(await resetContextToAutomatic({ connectionId: "provider", id: saved.id }), saved);
});

test("failed switches expose request and validation errors for inline feedback", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    error: "Check the model limits.", fields: { maxOutputTokensOverride: "Maximum output must not exceed context." },
  }, { status: 400 }));
  const model = { connectionId: "provider", id: "model" };
  await assert.rejects(resetContextToAutomatic(model), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.fields.maxOutputTokensOverride, "Maximum output must not exceed context.");
    return true;
  });
  fetch.mock.mockImplementation(async () => { throw new Error("Disconnected"); });
  await assert.rejects(resetContextToAutomatic(model), /Cannot reach ufAI/);
});
