import type { Agent } from "../../server/src/contracts";
import { modelConfigurationDraft, type ModelConfigurationDraft } from "./preset-form";

export interface DetailsValues {
  name: string;
  presetId: string | null;
  customConfiguration: ModelConfigurationDraft | null;
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
    customConfiguration: agent?.customConfiguration ? modelConfigurationDraft(agent.customConfiguration) : null,
    instructions: agent?.instructions ?? "",
  };
}
export function configurationChanged(draft: DetailsValues, baseline: DetailsValues): boolean {
  return draft.presetId !== baseline.presetId
    || JSON.stringify(draft.customConfiguration) !== JSON.stringify(baseline.customConfiguration);
}

export function customizeDetails(draft: DetailsValues, configuration: ModelConfigurationDraft): DetailsValues {
  return { ...draft, presetId: null, customConfiguration: configuration };
}

export function refreshDetails(
  current: DetailsDraft,
  agent: Agent,
): DetailsDraft {
  if (agent.revision < current.revision) return current;
  const saved = detailsValues(agent);
  const dirtyConfiguration = configurationChanged(current.draft, current.baseline);
  const dirty = dirtyConfiguration || current.draft.name !== current.baseline.name ||
    current.draft.instructions !== current.baseline.instructions;
  const merge = <T extends DetailsValues>(values: T): T => ({
    ...values,
    name:
      current.draft.name === current.baseline.name ? saved.name : values.name,
    presetId: dirtyConfiguration ? values.presetId : saved.presetId,
    customConfiguration: dirtyConfiguration ? values.customConfiguration : saved.customConfiguration,
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
