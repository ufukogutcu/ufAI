import assert from "node:assert/strict";
import { test } from "node:test";
import catalog from "@ufai/character-catalog";
import { accessories, collections, looks, sameAppearance, selectAccessory, shuffleAccessories, slots, type Appearance } from "../src/agent-appearance";

test("approved wardrobe keeps legacy IDs and supplies valid, canonical starting looks", () => {
  assert.deepEqual(Object.keys(catalog.accessories).slice(0, 4), ["glasses", "headphones", "cap", "badge"]);
  assert.equal(accessories.length, 23);
  assert.equal(looks.length, 12);
  assert.ok(!Object.hasOwn(catalog.accessories, "satchel"));
  for (const slot of slots) assert.ok(accessories.some(item => item.slot === slot.id));
  for (const item of accessories) assert.ok(slots.some(slot => slot.id === item.slot));
  assert.equal(new Set(looks.map(look => look.id)).size, looks.length);
  for (const look of looks) {
    assert.ok(collections.includes(look.collection));
    assert.ok(Object.hasOwn(catalog.characters, look.appearance.kind));
    assert.ok(Object.hasOwn(catalog.colors, look.appearance.color));
    const equipped = accessories.filter(item => look.appearance.accessories.includes(item.id));
    assert.equal(equipped.length, look.appearance.accessories.length);
    assert.equal(new Set(equipped.map(item => item.slot)).size, equipped.length);
    assert.deepEqual(equipped.map(item => item.id), look.appearance.accessories);
  }
});

test("editing one accessory group preserves other pieces and leaves the input unchanged", () => {
  const original: Appearance = { kind: "bot", color: "sky", accessories: ["glasses", "headphones", "cap", "badge", "scarf"] };
  const changed = selectAccessory(original, "head", "wizard");
  assert.deepEqual(changed, { kind: "bot", color: "sky", accessories: ["glasses", "headphones", "badge", "wizard", "scarf"] });
  assert.deepEqual(original.accessories, ["glasses", "headphones", "cap", "badge", "scarf"]);
  const cleared = selectAccessory(changed, "neck");
  assert.deepEqual(cleared.accessories, ["glasses", "headphones", "badge", "wizard"]);
  assert.ok(sameAppearance(cleared, { ...cleared, accessories: [...cleared.accessories].reverse() }));
  assert.ok(!sameAppearance(cleared, original));
});

test("shuffle retains character and color and produces two or three distinct accessory groups", () => {
  const original: Appearance = { kind: "droplet", color: "lilac", accessories: ["glasses"] };
  let seed = 91;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 100; i++) {
    const result = shuffleAccessories(original, random);
    assert.equal(result.kind, original.kind);
    assert.equal(result.color, original.color);
    assert.ok(result.accessories.length === 2 || result.accessories.length === 3);
    const groups = result.accessories.map(id => catalog.accessories[id].slot);
    assert.equal(new Set(groups).size, groups.length);
  }
  assert.deepEqual(original.accessories, ["glasses"]);
});
