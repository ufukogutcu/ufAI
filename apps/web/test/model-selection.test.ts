import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileSelection, selectModels, selectedCount, selectionChanges, type SelectionDraft } from "../src/model-selection.js";

const empty = (): SelectionDraft => ({ saved: new Map(), changes: new Map() });
test("selection drafts support all pages, filtered bulk changes, temporary zero, and cancellation", () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `model-${i}`, enabled: true }));
  const baseline = reconcileSelection(empty(), items);
  let draft = selectModels(baseline, items.map(model => model.id), false);
  assert.equal(selectedCount(draft), 0);
  draft = selectModels(draft, ["model-0", "model-90"], true);
  assert.equal(selectedCount(draft), 2);
  assert.equal(selectionChanges(draft).length, 118);
  assert.equal(selectedCount(baseline), 120);
  assert.equal(selectionChanges(reconcileSelection(empty(), items)).length, 0);
});
test("refresh and model edits retain drafts, adopt new models, and discard removed IDs", () => {
  let draft = reconcileSelection(empty(), [{ id: "kept", enabled: true }, { id: "removed", enabled: true }]);
  draft = selectModels(draft, ["kept", "removed"], false);
  draft = reconcileSelection(draft, [{ id: "kept", enabled: true }, { id: "new", enabled: true }]);
  assert.deepEqual(selectionChanges(draft), [{ id: "kept", enabled: false }]);
  assert.equal(selectedCount(draft), 1);
  const saved = reconcileSelection(draft, [{ id: "kept", enabled: false }, { id: "new", enabled: true }]);
  assert.equal(saved.changes.size, 0);
  assert.equal(selectedCount(saved), 1);
});
