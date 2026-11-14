import type Database from "better-sqlite3";
import { InputError } from "./validation.js";

export const agentFirstNames = [
  "Alex", "Amara", "Amir", "Anika", "Aria", "Arjun", "Avery", "Aya",
  "Ben", "Cameron", "Casey", "Chloe", "Dara", "Dev", "Eden", "Eli",
  "Emery", "Esme", "Felix", "Finley", "Hana", "Harper", "Idris", "Iris",
  "Jamie", "Jasper", "Jordan", "Jules", "Kai", "Kiran", "Leila", "Leo",
  "Lina", "Luca", "Mae", "Maya", "Micah", "Milo", "Mina", "Morgan",
  "Nadia", "Nico", "Noah", "Noor", "Nova", "Omar", "Quinn", "Ravi",
  "Remy", "Riley", "Robin", "Rowan", "Sage", "Sam", "Sasha", "Sofia",
  "Tara", "Theo", "Uma", "Vera", "Wren", "Yara", "Zara", "Zoe",
] as const;

export function agentNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

export function workspaceAgentNameKeys(db: Database.Database, workspaceId: string, excludeId?: string): Set<string> {
  const keys = new Set<string>();
  for (const row of db.prepare("SELECT id,name FROM agents WHERE workspaceId=?").iterate(workspaceId) as Iterable<{ id: string; name: string }>) {
    if (row.id !== excludeId) keys.add(agentNameKey(row.name));
  }
  return keys;
}

// Call inside the same transaction as the write, including for unchanged configuration names.
export function assertAgentNameAvailable(db: Database.Database, workspaceId: string, name: string, excludeId?: string): void {
  if (workspaceAgentNameKeys(db, workspaceId, excludeId).has(agentNameKey(name))) {
    throw new InputError({ name: "Another agent in this workspace already uses this name. Choose a different name." });
  }
}

export function generateAgentName(used: ReadonlySet<string>, random: () => number = Math.random): string {
  const available = agentFirstNames.filter(name => !used.has(agentNameKey(name)));
  if (available.length) return available[Math.floor(random() * available.length)]!;
  const base = agentFirstNames[Math.floor(random() * agentFirstNames.length)]!;
  // At most used.size + 1 candidates are needed to find an unused suffix.
  for (let suffix = 2; suffix <= used.size + 2; suffix++) {
    const name = `${base} ${suffix}`;
    if (!used.has(agentNameKey(name))) return name;
  }
  throw new Error("Unable to suggest an agent name.");
}
