import type { Compaction, ModelPreset, PresetInput } from "./api";
export interface PresetDraft {
  name: string;
  modelId: string;
  connectionId: string | null;
  compactionMode: Compaction["mode"];
  compactionValue: string;
}
export function draftFromPreset(preset?: ModelPreset): PresetDraft {
  return {
    name: preset?.name ?? "",
    modelId: preset?.modelId ?? "",
    connectionId: preset?.connectionId ?? null,
    compactionMode: preset?.compaction?.mode ?? "percentage",
    compactionValue: preset?.compaction?.value.toString() ?? "",
  };
}
export function draftToInput(draft: PresetDraft): PresetInput {
  return {
    name: draft.name.trim(),
    connectionId: draft.connectionId,
    modelId: draft.connectionId ? draft.modelId.trim() || null : null,
    compaction:
      draft.compactionValue === ""
        ? null
        : { mode: draft.compactionMode, value: Number(draft.compactionValue) },
  };
}
export function validateDraft(draft: PresetDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const input = draftToInput(draft);
  if (!input.name || input.name.length > 120)
    errors.name = "Enter a name between 1 and 120 characters.";
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
