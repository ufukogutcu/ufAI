import type { Agent } from "../../server/src/contracts";

export interface DetailsValues {
  name: string;
  presetId: string | null;
  instructions: string;
}
export interface DetailsDraft {
  draft: DetailsValues;
  baseline: DetailsValues;
  revision: number;
}
export function detailsValues(agent?: Agent): DetailsValues {
  return {
    name: agent?.name ?? "",
    presetId: agent?.presetId ?? null,
    instructions: agent?.instructions ?? "",
  };
}
export function refreshDetails(
  current: DetailsDraft,
  agent: Agent,
): DetailsDraft {
  const saved = detailsValues(agent);
  const dirty = (Object.keys(saved) as (keyof DetailsValues)[]).some(
    (key) => current.draft[key] !== current.baseline[key],
  );
  const merge = <T extends DetailsValues>(values: T): T => ({
    ...values,
    name:
      current.draft.name === current.baseline.name ? saved.name : values.name,
    presetId:
      current.draft.presetId === current.baseline.presetId
        ? saved.presetId
        : values.presetId,
    instructions:
      current.draft.instructions === current.baseline.instructions
        ? saved.instructions
        : values.instructions,
  });
  return {
    draft: merge(current.draft),
    baseline: merge(current.baseline),
    revision: dirty ? current.revision : agent.revision,
  };
}
