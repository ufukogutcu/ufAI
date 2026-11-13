import type { Agent } from "../../server/src/contracts";

export interface ConfigurationValues {
  name: string;
  presetId: string | null;
  instructions: string;
}
export interface ConfigurationDraft {
  draft: ConfigurationValues;
  baseline: ConfigurationValues;
  revision: number;
}
export function configurationValues(agent?: Agent): ConfigurationValues {
  return {
    name: agent?.name ?? "",
    presetId: agent?.presetId ?? null,
    instructions: agent?.instructions ?? "",
  };
}
export function refreshConfiguration(
  current: ConfigurationDraft,
  agent: Agent,
): ConfigurationDraft {
  const saved = configurationValues(agent);
  const dirty = (Object.keys(saved) as (keyof ConfigurationValues)[]).some(
    (key) => current.draft[key] !== current.baseline[key],
  );
  const merge = <T extends ConfigurationValues>(values: T): T => ({
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
