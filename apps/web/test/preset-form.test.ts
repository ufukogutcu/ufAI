import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactionThreshold,
  draftFromPreset,
  draftToInput,
  validateDraft,
} from "../src/preset-form.js";
test("only a name is required and compaction defaults to empty", () => {
  const draft = { ...draftFromPreset(), name: "  Agent  " };
  assert.deepEqual(validateDraft(draft), {});
  assert.deepEqual(draftToInput(draft), {
    name: "Agent",
    connectionId: null,
    modelId: null,
    compaction: null,
  });
  assert.equal(compactionThreshold(1000, null), null);
  assert.ok(validateDraft({ ...draft, name: " " }).name);
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

test("compaction stays optional with unknown or incompatible model limits", () => {
  const draft = {
    ...draftFromPreset(),
    name: "Agent",
    connectionId: "saved",
    modelId: "model",
    compactionMode: "tokens" as const,
    compactionValue: "9000",
  };
  assert.deepEqual(validateDraft(draft), {});
  assert.deepEqual(draftToInput(draft).compaction, {
    mode: "tokens",
    value: 9000,
  });
  assert.equal(compactionThreshold(null, draftToInput(draft).compaction), 9000);
});
test("supplied numeric values must remain valid, without silently serializing as unknown", () => {
  const draft = {
    ...draftFromPreset(),
    name: "Agent",
    compactionMode: "tokens" as const,
  };
  for (const value of ["-1", "0", "1.5", "NaN", "9007199254740992"])
    assert.ok(
      validateDraft({ ...draft, compactionValue: value })["compaction.value"],
    );
  assert.ok(
    validateDraft({
      ...draft,
      compactionMode: "percentage",
      compactionValue: "101",
    })["compaction.value"],
  );
});
