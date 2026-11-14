import catalog from "@ufai/character-catalog";
import type { Agent, AgentAppearance, CharacterActivity, CharacterAccessory, CharacterColor, CharacterKind } from "../../server/src/contracts";
export type { CharacterKind };
export type Appearance = AgentAppearance;
export type Activity = CharacterActivity;
export type Accessory = CharacterAccessory;
export type BodyColor = CharacterColor;
export const characters = Object.keys(catalog.characters) as CharacterKind[];
export const characterNames = catalog.characters;
export const colors = (Object.keys(catalog.colors) as CharacterColor[]).map(id => ({ id, ...catalog.colors[id] }));
export const accessories = (Object.keys(catalog.accessories) as CharacterAccessory[]).map(id => ({ id, ...catalog.accessories[id] }));
export const activities = (Object.keys(catalog.activities) as CharacterActivity[]).map(id => ({ id, ...catalog.activities[id] }));
export const defaultAppearance: AgentAppearance = { kind: "pebble", color: "sage", accessories: [] };
export function agentActivity(state: Agent["state"]): CharacterActivity {
  return state === "running" || state === "waiting" ? "working" : "idle";
}

export type Slot = keyof typeof catalog.slots;
export const slots = (Object.keys(catalog.slots) as Slot[]).map(id => ({ id, name: catalog.slots[id] }));
export const collections = ["All", "Cute", "Fantasy", "Tech"] as const;
export type Collection = typeof collections[number];
export interface Look { id: keyof typeof catalog.looks; name: string; collection: Exclude<Collection, "All">; appearance: Appearance }
export const looks: Look[] = (Object.keys(catalog.looks) as (keyof typeof catalog.looks)[]).map(id => ({
  id, ...catalog.looks[id], collection: catalog.looks[id].collection as Look["collection"],
  appearance: { ...catalog.looks[id].appearance,
    accessories: accessories.filter(item => (catalog.looks[id].appearance.accessories as readonly string[]).includes(item.id)).map(item => item.id),
  } as Appearance,
}));
export function selectAccessory(appearance: Appearance, slot: Slot, id?: Accessory): Appearance {
  return { ...appearance, accessories: accessories.filter(item => item.slot === slot ? item.id === id : appearance.accessories.includes(item.id)).map(item => item.id) };
}
export function sameAppearance(a: Appearance, b: Appearance) {
  return a.kind === b.kind && a.color === b.color && a.accessories.length === b.accessories.length && a.accessories.every(id => b.accessories.includes(id));
}
export function shuffleAccessories(appearance: Appearance, random: () => number = Math.random): Appearance {
  const available = [...slots];
  const selected = Array.from({ length: 2 + Math.floor(random() * 2) }, () => {
    const [slot] = available.splice(Math.floor(random() * available.length), 1);
    const options = accessories.filter(item => item.slot === slot!.id);
    return options[Math.floor(random() * options.length)]!.id;
  });
  return { ...appearance, accessories: accessories.filter(item => selected.includes(item.id)).map(item => item.id) };
}
