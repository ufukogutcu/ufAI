import assert from "node:assert/strict";
import { test } from "node:test";
import { canRefractGlass, createGlassMap } from "../src/glass-geometry";

test("capsule refraction bends only the inner rim and leaves the center and exterior calm", () => {
  const map = createGlassMap(68, 224, 34);
  const pixel = (x: number, y: number) => [...map.data.slice((y * map.width + x) * 4, (y * map.width + x) * 4 + 4)];
  assert.deepEqual(pixel(34, 112), [128, 128, 128, 255]);
  assert.deepEqual(pixel(0, 0), [128, 128, 128, 255]);
  assert.ok(pixel(4, 112)[0]! > 128);
  assert.ok(pixel(63, 112)[0]! < 128);
  assert.ok(pixel(34, 4)[1]! > 128);
  assert.ok(pixel(34, 219)[1]! < 128);
  assert.ok(Math.abs(pixel(4, 112)[0]! + pixel(63, 112)[0]! - 256) <= 1);
});

test("displacement maps bound allocation and tolerate hidden or invalid geometry", () => {
  for (const dimensions of [[4000, 2000, 30], [0, 0, 0], [NaN, Infinity, NaN], [68.5, 224.5, 999]] as const) {
    const map = createGlassMap(...dimensions);
    assert.ok(map.width >= 1 && map.width <= 512);
    assert.ok(map.height >= 1 && map.height <= 512);
    assert.equal(map.data.length, map.width * map.height * 4);
    for (let i = 3; i < map.data.length; i += 4) assert.equal(map.data[i], 255);
  }
  assert.deepEqual(createGlassMap(68, 224, 34), createGlassMap(68, 224, 34));
});

test("unsupported engines and accessibility preferences select the non-refractive material", () => {
  const chrome = "Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36";
  assert.equal(canRefractGlass(chrome, false, false), true);
  assert.equal(canRefractGlass(chrome, true, false), false);
  assert.equal(canRefractGlass(chrome, false, true), false);
  assert.equal(canRefractGlass("Version/26.0 Safari/605.1.15", false, false), false);
  assert.equal(canRefractGlass("Firefox/145.0", false, false), false);
  assert.equal(canRefractGlass("CriOS/142.0 Mobile Safari/604.1", false, false), false);
});
