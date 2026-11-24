import type { AgentModelConfiguration, Compaction, ModelPreset, PresetInput, ProviderPresetOptions } from "./api";
export interface ModelConfigurationDraft {
  modelId: string;
  connectionId: string | null;
  providerOptions: ProviderPresetOptions | null;
  compactionMode: Compaction["mode"];
  compactionValue: string;
}
export interface PresetDraft extends ModelConfigurationDraft {
  name: string;
  isDefault: boolean;
}

export function draftFromPreset(preset?: ModelPreset): PresetDraft {
  return {
    name: preset?.name ?? "",
    isDefault: preset?.isDefault ?? false,
    ...modelConfigurationDraft(preset),
  };
}

export function modelConfigurationDraft(configuration?: AgentModelConfiguration): ModelConfigurationDraft {
  return {
    modelId: configuration?.modelId ?? "",
    connectionId: configuration?.connectionId ?? null,
    providerOptions: configuration?.providerOptions ?? null,
    compactionMode: configuration?.compaction?.mode ?? "percentage",
    compactionValue: configuration?.compaction?.value.toString() ?? "",
  };
}
export function draftToInput(draft: PresetDraft): PresetInput {
  return {
    name: draft.name.trim(),
    isDefault: draft.isDefault,
    ...modelConfigurationInput(draft),
  };
}

export function modelConfigurationInput(draft: ModelConfigurationDraft): AgentModelConfiguration {
  return {
    connectionId: draft.connectionId,
    modelId: draft.connectionId ? draft.modelId.trim() || null : null,
    providerOptions: draft.connectionId && draft.modelId.trim() ? draft.providerOptions : null,
    compaction:
      draft.compactionValue === ""
        ? null
        : { mode: draft.compactionMode, value: Number(draft.compactionValue) },
  };
}
export function setCodexPresetOption<T extends ModelConfigurationDraft>(
  draft: T,
  field: "reasoningEffort" | "serviceTier",
  value: string,
): T {
  const reasoningEffort = field === "reasoningEffort" ? value : draft.providerOptions?.reasoningEffort;
  const serviceTier = field === "serviceTier" ? value : draft.providerOptions?.serviceTier;
  return {
    ...draft,
    providerOptions: reasoningEffort || serviceTier ? {
      provider: "codex",
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(serviceTier ? { serviceTier } : {}),
    } : null,
  };
}
export function validateDraft(draft: PresetDraft): Record<string, string> {
  const errors = validateModelConfiguration(draft);
  const name = draft.name.trim();
  if (!name || name.length > 120)
    errors.name = "Enter a name between 1 and 120 characters.";
  return errors;
}

export function validateModelConfiguration(draft: ModelConfigurationDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const input = modelConfigurationInput(draft);
  if (input.modelId && input.modelId.length > 200)
    errors.modelId = "Choose a saved model.";
  if (input.compaction) {
    const { mode, value } = input.compaction;
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      (mode === "percentage" && value > 100)
    )
      errors["compaction.value"] =
        "Enter a positive whole token count, or a percentage from 1 to 100.";
  }
  return errors;
}
export function compactionThreshold(
  contextWindow: number | null,
  compaction: Compaction | null | undefined,
): number | null {
  if (
    !compaction ||
    !Number.isSafeInteger(compaction.value) ||
    compaction.value < 1
  )
    return null;
  if (compaction.mode === "tokens") return compaction.value;
  if (
    compaction.value > 100 ||
    contextWindow === null ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow < 1
  )
    return null;
  return Math.max(
    1,
    Number((BigInt(contextWindow) * BigInt(compaction.value)) / 100n),
  );
}
