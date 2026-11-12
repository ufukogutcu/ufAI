import type { ModelSelection } from "./api";

export interface SelectionDraft {
  saved: Map<string, boolean>;
  changes: Map<string, boolean>;
}
export function reconcileSelection(
  current: SelectionDraft,
  items: ModelSelection[],
): SelectionDraft {
  const saved = new Map(items.map((model) => [model.id, model.enabled]));
  const changes = new Map(
    [...current.changes].filter(
      ([id, enabled]) => saved.has(id) && saved.get(id) !== enabled,
    ),
  );
  return { saved, changes };
}
export function selectModels(
  current: SelectionDraft,
  ids: string[],
  enabled: boolean,
): SelectionDraft {
  const changes = new Map(current.changes);
  for (const id of ids) {
    if (!current.saved.has(id)) continue;
    if (current.saved.get(id) === enabled) changes.delete(id);
    else changes.set(id, enabled);
  }
  return { saved: current.saved, changes };
}
export function selectedCount(current: SelectionDraft): number {
  let count = 0;
  for (const [id, enabled] of current.saved)
    if (current.changes.get(id) ?? enabled) count++;
  return count;
}
export function selectionChanges(current: SelectionDraft): ModelSelection[] {
  return [...current.changes].map(([id, enabled]) => ({ id, enabled }));
}
