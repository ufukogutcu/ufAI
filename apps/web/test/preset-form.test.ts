import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeCompactionMode,
  compactionThreshold,
  draftFromPreset,
  draftToInput,
  validateDraft,
} from "../src/preset-form.js";

test("new drafts default to 80% and allow unknown metadata", () => {
  const draft = {
    ...draftFromPreset(),
    name: "Local",
    modelId: "example-model",
  };
  assert.deepEqual(draftToInput(draft).compaction, {
    mode: "percentage",
    value: 80,
  });
  assert.deepEqual(validateDraft(draft), {});
  assert.equal(compactionThreshold(null, draftToInput(draft).compaction), null);
});

test("percentage thresholds round down, clamp to one, and stay exact for safe integers", () => {
  assert.equal(compactionThreshold(101, { mode: "percentage", value: 80 }), 80);
  assert.equal(compactionThreshold(1, { mode: "percentage", value: 1 }), 1);
  assert.equal(
    compactionThreshold(128000, { mode: "percentage", value: 80 }),
    102400,
  );
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(
    compactionThreshold(max, { mode: "percentage", value: 99 }),
    Number((BigInt(max) * 99n) / 100n),
  );
  assert.equal(
    compactionThreshold(100, { mode: "percentage", value: 101 }),
    null,
  );
});

test("mode switching converts known percentage thresholds and requires unknown token limits", () => {
  const initial = {
    ...draftFromPreset(),
    name: "Test",
    modelId: "test",
    contextWindow: "1001",
  };
  const tokens = changeCompactionMode(initial, "tokens");
  assert.equal(tokens.compactionValue, "800");
  assert.deepEqual(validateDraft(tokens), {});
  assert.equal(
    changeCompactionMode(tokens, "percentage").compactionValue,
    "80",
  );
  const unknown = changeCompactionMode(
    { ...initial, contextWindow: "" },
    "tokens",
  );
  assert.equal(unknown.compactionValue, "");
  assert.ok(validateDraft(unknown)["compaction.value"]);
  assert.equal(compactionThreshold(null, { mode: "tokens", value: 100 }), 100);
});

test("context changes recalculate percentages and invalidate excessive absolute limits", () => {
  const draft = {
    ...draftFromPreset(),
    name: "Test",
    modelId: "test",
    contextWindow: "1000",
    maxOutputTokens: "700",
  };
  assert.equal(compactionThreshold(1000, draftToInput(draft).compaction), 800);
  assert.equal(compactionThreshold(500, draftToInput(draft).compaction), 400);
  assert.ok(validateDraft({ ...draft, contextWindow: "500" }).maxOutputTokens);
  const tokens = changeCompactionMode(draft, "tokens");
  assert.ok(
    validateDraft({ ...tokens, contextWindow: "500" })["compaction.value"],
  );
  assert.equal(
    validateDraft({ ...tokens, contextWindow: "", maxOutputTokens: "" })[
      "compaction.value"
    ],
    undefined,
  );
});

test("invalid numeric drafts cannot silently serialize as unknown values", () => {
  const draft = { ...draftFromPreset(), name: "Test", modelId: "test" };
  for (const value of ["-1", "1.5", "NaN", "9007199254740992"]) {
    assert.ok(validateDraft({ ...draft, contextWindow: value }).contextWindow);
    assert.ok(
      validateDraft({
        ...draft,
        compactionMode: "tokens",
        compactionValue: value,
      })["compaction.value"],
    );
  }
  assert.ok(validateDraft({ ...draft, provider: "custom" }).customProviderName);
});
