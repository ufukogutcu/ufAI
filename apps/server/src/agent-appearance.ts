import type Database from "better-sqlite3";
import catalog from "@ufai/character-catalog" with { type: "json" };
import type { AgentAppearance, CharacterAccessory, CharacterColor, CharacterKind } from "./contracts.js";
import { InputError, objectBody } from "./validation.js";

const kinds = Object.keys(catalog.characters) as CharacterKind[];
const colors = Object.keys(catalog.colors) as CharacterColor[];
const accessories = Object.keys(catalog.accessories) as CharacterAccessory[];
const countProbabilities = [0.08, 0.22, 0.42, 0.20, 0.06, 0.015, 0.004, 0.001];
export interface AppearanceCount { appearance: AgentAppearance; count: number }

export function validateAppearance(value: unknown): AgentAppearance {
  const invalid = (): never => { throw new InputError({ appearance: "Choose a character, body color and at most one valid accessory per group." }); };
  let input: Record<string, unknown>;
  try { input = objectBody(value); } catch { return invalid(); }
  if (Object.keys(input).some(key => !["kind", "color", "accessories"].includes(key)) ||
      typeof input.kind !== "string" || !Object.hasOwn(catalog.characters, input.kind) ||
      typeof input.color !== "string" || !Object.hasOwn(catalog.colors, input.color) ||
      !Array.isArray(input.accessories) || input.accessories.length > accessories.length ||
      input.accessories.some(id => typeof id !== "string" || !Object.hasOwn(catalog.accessories, id)) ||
      new Set(input.accessories).size !== input.accessories.length ||
      new Set((input.accessories as CharacterAccessory[]).map(id => catalog.accessories[id].slot)).size !== input.accessories.length) return invalid();
  return { kind: input.kind as CharacterKind, color: input.color as CharacterColor,
    accessories: accessories.filter(id => (input.accessories as unknown[]).includes(id)) };
}
export function appearanceKey(value: AgentAppearance): string {
  return `${value.kind}:${value.color}:${accessories.filter(id => value.accessories.includes(id)).join(",")}`;
}
export interface AppearanceSpace {
  kinds: readonly CharacterKind[];
  colors: readonly CharacterColor[];
  groups: readonly (readonly CharacterAccessory[])[];
}

// Mixed-radix indexing provides a fallback without constructing the entire wardrobe.
export function createAppearanceAllocator(space: AppearanceSpace) {
  const total = space.kinds.length * space.colors.length * space.groups.reduce((size, group) => size * (group.length + 1), 1);
  function at(index: number): AgentAppearance {
    if (!Number.isSafeInteger(index) || index < 0 || index >= total) throw new RangeError("Appearance index is outside the catalog.");
    let cursor = index;
    const selected: CharacterAccessory[] = [];
    for (const group of space.groups) {
      const choice = cursor % (group.length + 1);
      cursor = Math.floor(cursor / (group.length + 1));
      if (choice) selected.push(group[choice - 1]!);
    }
    return { kind: space.kinds[Math.floor(cursor / space.colors.length)]!, color: space.colors[cursor % space.colors.length]!,
      accessories: accessories.filter(id => selected.includes(id)) };
  }
  function draw(random: () => number): AgentAppearance {
    const kind = space.kinds[Math.floor(random() * space.kinds.length)]!;
    const color = space.colors[Math.floor(random() * space.colors.length)]!;
    let cursor = random();
    const count = Math.min(space.groups.length, countProbabilities.findIndex((probability, index) => {
      cursor -= probability;
      return cursor < 0 || index === countProbabilities.length - 1;
    }));
    const available = [...space.groups];
    const selected: CharacterAccessory[] = [];
    for (let i = 0; i < count; i++) {
      const [group] = available.splice(Math.floor(random() * available.length), 1);
      selected.push(group![Math.floor(random() * group!.length)]!);
    }
    return { kind, color, accessories: accessories.filter(id => selected.includes(id)) };
  }
  function candidates(used: readonly AppearanceCount[], random: () => number = Math.random) {
    const exact = new Map<string, AppearanceCount>(), type = new Map<string, number>(), color = new Map<string, number>(),
      pair = new Map<string, number>(), sets = new Map<string, number>();
    const add = (map: Map<string, number>, key: string, count: number) => map.set(key, (map.get(key) ?? 0) + count);
    for (const item of used) {
      const key = appearanceKey(item.appearance);
      const previous = exact.get(key);
      exact.set(key, { appearance: item.appearance, count: (previous?.count ?? 0) + item.count });
      add(type, item.appearance.kind, item.count); add(color, item.appearance.color, item.count);
      add(pair, `${item.appearance.kind}:${item.appearance.color}`, item.count);
      add(sets, accessories.filter(id => item.appearance.accessories.includes(id)).join(","), item.count);
    }
    const pool = new Map<string, AgentAppearance>();
    if (exact.size < total) {
      for (let attempt = 0; attempt < 128 && pool.size < 64; attempt++) {
        const value = draw(random), key = appearanceKey(value);
        if (!exact.has(key)) pool.set(key, value);
      }
      // At most used-count + 1 indices are needed to locate an unused appearance.
      if (!pool.size) for (let index = 0; index <= exact.size && index < total; index++) {
        const value = at(index), key = appearanceKey(value);
        if (!exact.has(key)) { pool.set(key, value); break; }
      }
    } else {
      let minimum = Infinity;
      for (const item of exact.values()) minimum = Math.min(minimum, item.count);
      const reservoir: AgentAppearance[] = [];
      let seen = 0;
      for (const item of exact.values()) if (item.count === minimum) {
        seen++;
        if (reservoir.length < 64) reservoir.push(item.appearance);
        else {
          const index = Math.floor(random() * seen);
          if (index < 64) reservoir[index] = item.appearance;
        }
      }
      for (const value of reservoir) pool.set(appearanceKey(value), value);
    }
    return [...pool.values()].map(value => ({ appearance: value,
      weight: 1 / ((1 + (type.get(value.kind) ?? 0)) * (1 + (color.get(value.color) ?? 0)) *
        (1 + (pair.get(`${value.kind}:${value.color}`) ?? 0)) ** 3 *
        (1 + (sets.get(accessories.filter(id => value.accessories.includes(id)).join(",")) ?? 0))),
    }));
  }
  function generate(used: readonly AppearanceCount[], random: () => number = Math.random): AgentAppearance {
    const options = candidates(used, random);
    let cursor = random() * options.reduce((sum, item) => sum + item.weight, 0);
    const selected = options.find(item => (cursor -= item.weight) < 0) ?? options[options.length - 1]!;
    return { ...selected.appearance, accessories: [...selected.appearance.accessories] };
  }
  return { total, at, candidates, generate };
}
const allocator = createAppearanceAllocator({ kinds, colors,
  groups: Object.keys(catalog.slots).map(slot => accessories.filter(id => catalog.accessories[id].slot === slot)),
});
export const appearanceSpaceSize = allocator.total;
export const appearanceAt = allocator.at;
export const appearanceCandidates = allocator.candidates;
export const generateAppearance = allocator.generate;

export function workspaceAppearanceCounts(db: Database.Database, workspaceId: string): AppearanceCount[] {
  return (db.prepare("SELECT appearance, count(*) AS count FROM agents WHERE workspaceId=? GROUP BY appearance")
    .all(workspaceId) as { appearance: string; count: number }[])
    .map(row => ({ appearance: JSON.parse(row.appearance) as AgentAppearance, count: row.count }));
}

export function migrateCharacters(db: Database.Database) {
  db.exec(`ALTER TABLE agents ADD COLUMN appearance TEXT NOT NULL DEFAULT '{"kind":"pebble","color":"sage","accessories":[]}';
    ALTER TABLE app_settings ADD COLUMN characterAnimationsPaused INTEGER NOT NULL DEFAULT 0 CHECK(characterAnimationsPaused IN (0,1));`);
  const update = db.prepare("UPDATE agents SET appearance=?, x=?, y=? WHERE id=?");
  for (const workspace of db.prepare("SELECT id FROM workspaces ORDER BY id").all() as { id: string }[]) {
    const counts: AppearanceCount[] = [];
    // Read existing agents in bounded batches; retain grouped counts for assigned appearances.
    let offset = 0;
    while (true) {
      const batch = db.prepare("SELECT id,x,y FROM agents WHERE workspaceId=? ORDER BY createdAt,id LIMIT 100 OFFSET ?")
        .all(workspace.id, offset) as { id: string; x: number; y: number }[];
      if (!batch.length) break;
      for (const agent of batch) {
        const appearance = generateAppearance(counts);
        const found = counts.find(item => appearanceKey(item.appearance) === appearanceKey(appearance));
        if (found) found.count++; else counts.push({ appearance, count: 1 });
        // Migration 16 must retain its original geometry, independent of later catalog changes.
        const x = agent.x + (224 - 208) / 2;
        const y = agent.y + (104 - 192) / 2;
        update.run(JSON.stringify(appearance), Math.max(-1e6, Math.min(1e6, x)), Math.max(-1e6, Math.min(1e6, y)), agent.id);
      }
      offset += batch.length;
    }
  }
}
