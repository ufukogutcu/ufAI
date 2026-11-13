import type Database from "better-sqlite3";
import catalog from "@ufai/character-catalog" with { type: "json" };
import type { AgentAppearance, CharacterAccessory, CharacterColor, CharacterKind } from "./contracts.js";
import { InputError, objectBody } from "./validation.js";

const kinds = Object.keys(catalog.characters) as CharacterKind[];
const colors = Object.keys(catalog.colors) as CharacterColor[];
const accessories = Object.keys(catalog.accessories) as CharacterAccessory[];
const countProbabilities = [0.1, 0.4, 0.35, 0.12, 0.03];
const subsetCounts = [1, 4, 6, 4, 1];
export interface AppearanceCount { appearance: AgentAppearance; count: number }

export function validateAppearance(value: unknown): AgentAppearance {
  const invalid = (): never => { throw new InputError({ appearance: "Choose a character, body color and valid accessories." }); };
  let input: Record<string, unknown>;
  try { input = objectBody(value); } catch { return invalid(); }
  if (Object.keys(input).some(key => !["kind", "color", "accessories"].includes(key)) ||
      typeof input.kind !== "string" || !Object.hasOwn(catalog.characters, input.kind) ||
      typeof input.color !== "string" || !Object.hasOwn(catalog.colors, input.color) ||
      !Array.isArray(input.accessories) || input.accessories.length > accessories.length ||
      input.accessories.some(id => typeof id !== "string" || !Object.hasOwn(catalog.accessories, id)) ||
      new Set(input.accessories).size !== input.accessories.length) return invalid();
  return { kind: input.kind as CharacterKind, color: input.color as CharacterColor,
    accessories: accessories.filter(id => (input.accessories as unknown[]).includes(id)) };
}
export function appearanceKey(value: AgentAppearance): string {
  return `${value.kind}:${value.color}:${accessories.filter(id => value.accessories.includes(id)).join(",")}`;
}
export const allAppearances: readonly AgentAppearance[] = kinds.flatMap(kind => colors.flatMap(color =>
  Array.from({ length: 1 << accessories.length }, (_, mask) => ({
    kind, color, accessories: accessories.filter((_, index) => mask & (1 << index)),
  })),
));

export function appearanceCandidates(used: readonly AppearanceCount[]) {
  const exact = new Map<string, number>(), type = new Map<string, number>(), color = new Map<string, number>(),
    pair = new Map<string, number>(), sets = new Map<string, number>();
  const add = (map: Map<string, number>, key: string, count: number) => map.set(key, (map.get(key) ?? 0) + count);
  const accessoryKey = (value: AgentAppearance) => accessories.filter(id => value.accessories.includes(id)).join(",");
  for (const { appearance: value, count } of used) {
    add(exact, appearanceKey(value), count); add(type, value.kind, count); add(color, value.color, count);
    add(pair, `${value.kind}:${value.color}`, count); add(sets, accessoryKey(value), count);
  }
  const minimum = Math.min(...allAppearances.map(value => exact.get(appearanceKey(value)) ?? 0));
  return allAppearances.filter(value => (exact.get(appearanceKey(value)) ?? 0) === minimum).map(value => ({
    appearance: value,
    weight: countProbabilities[value.accessories.length]! / subsetCounts[value.accessories.length]! /
      ((1 + (type.get(value.kind) ?? 0)) * (1 + (color.get(value.color) ?? 0)) *
        (1 + (pair.get(`${value.kind}:${value.color}`) ?? 0)) ** 3 * (1 + (sets.get(accessoryKey(value)) ?? 0))),
  }));
}
export function generateAppearance(used: readonly AppearanceCount[], random: () => number = Math.random): AgentAppearance {
  const candidates = appearanceCandidates(used);
  let cursor = random() * candidates.reduce((sum, item) => sum + item.weight, 0);
  const selected = candidates.find(item => (cursor -= item.weight) < 0) ?? candidates[candidates.length - 1]!;
  return { ...selected.appearance, accessories: [...selected.appearance.accessories] };
}
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
    // Read existing agents in bounded batches; retain counts for at most 384 combinations.
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
