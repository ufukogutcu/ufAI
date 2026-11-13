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
export const accessories = (Object.keys(catalog.accessories) as CharacterAccessory[]).map(id => ({ id, name: catalog.accessories[id] }));
export const activities = (Object.keys(catalog.activities) as CharacterActivity[]).map(id => ({ id, ...catalog.activities[id] }));
export const defaultAppearance: AgentAppearance = { kind: "pebble", color: "sage", accessories: [] };
export function agentActivity(state: Agent["state"]): CharacterActivity {
  return state === "running" ? "working" : "idle";
}
