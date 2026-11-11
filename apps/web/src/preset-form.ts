import type {
  Compaction,
  IntegrationKind,
  ModelPreset,
  PresetInput,
  ProviderId,
  ProviderConnection,
  DiscoveredModel,
} from "./api";
export const providerOptions: {
  id: ProviderId;
  label: string;
  kind: IntegrationKind;
}[] = [
  { id: "openai", label: "OpenAI", kind: "provider" },
  { id: "anthropic", label: "Anthropic", kind: "provider" },
  { id: "google", label: "Google Gemini", kind: "provider" },
  { id: "openrouter", label: "OpenRouter", kind: "provider" },
  { id: "xai", label: "xAI", kind: "provider" },
  { id: "deepseek", label: "DeepSeek", kind: "provider" },
  { id: "mistral", label: "Mistral", kind: "provider" },
  { id: "groq", label: "Groq", kind: "provider" },
  { id: "together", label: "Together", kind: "provider" },
  {
    id: "openai-compatible",
    label: "Custom OpenAI-compatible",
    kind: "provider",
  },
  { id: "codex", label: "Codex", kind: "runtime" },
];
export function providerLabel(
  preset: Pick<ModelPreset, "provider" | "customProviderName">,
) {
  return (
    preset.customProviderName ??
    providerOptions.find((option) => option.id === preset.provider)?.label ??
    preset.provider
  );
}
export interface PresetDraft {
  name: string;
  integrationKind: IntegrationKind;
  provider: ProviderId | "";
  customProviderName: string;
  modelId: string;
  contextWindow: string;
  maxOutputTokens: string;
  connectionId: string | null;
  compactionMode: Compaction["mode"];
  compactionValue: string;
}
export function draftFromPreset(preset?: ModelPreset): PresetDraft {
  return {
    name: preset?.name ?? "",
    integrationKind: preset?.integrationKind ?? "provider",
    provider: preset?.provider ?? "",
    customProviderName: preset?.customProviderName ?? "",
    modelId: preset?.modelId ?? "",
    contextWindow: preset?.contextWindow?.toString() ?? "",
    maxOutputTokens: preset?.maxOutputTokens?.toString() ?? "",
    connectionId: preset?.connectionId ?? null,
    compactionMode: preset?.compaction.mode ?? "percentage",
    compactionValue: preset?.compaction.value.toString() ?? "80",
  };
}
export function draftToInput(draft: PresetDraft): PresetInput {
  return {
    name: draft.name.trim(),
    integrationKind: draft.integrationKind,
    provider: draft.provider as ProviderId,
    customProviderName:
      draft.provider === "custom" ? draft.customProviderName.trim() : null,
    modelId: draft.modelId.trim(),
    contextWindow:
      draft.contextWindow === "" ? null : Number(draft.contextWindow),
    maxOutputTokens:
      draft.maxOutputTokens === "" ? null : Number(draft.maxOutputTokens),
    connectionId: draft.connectionId,
    compaction: {
      mode: draft.compactionMode,
      value: Number(draft.compactionValue),
    },
  };
}
export function validateDraft(draft: PresetDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const input = draftToInput(draft);
  if (!input.name || input.name.length > 120)
    errors.name = "Enter a name between 1 and 120 characters.";
  if (!input.modelId || input.modelId.length > 200)
    errors.modelId = "Enter a model identifier between 1 and 200 characters.";
  if (
    input.provider === "custom" &&
    (!input.customProviderName || input.customProviderName.length > 120)
  )
    errors.customProviderName =
      "Enter a custom integration name (up to 120 characters).";
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    const value = input[field];
    if (value !== null && (!Number.isSafeInteger(value) || value < 1))
      errors[field] = "Enter a positive safe integer, or leave empty.";
  }
  if (!draft.provider) errors.provider = "Choose a provider.";
  if (
    input.contextWindow &&
    input.maxOutputTokens &&
    input.maxOutputTokens > input.contextWindow
  )
    errors.maxOutputTokens = "Must not exceed the context window.";
  const { mode, value } = input.compaction;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (mode === "percentage" && value > 100)
  )
    errors["compaction.value"] =
      mode === "percentage"
        ? "Enter a whole percentage from 1 to 100."
        : "Enter a positive safe integer.";
  else if (
    mode === "tokens" &&
    input.contextWindow &&
    value > input.contextWindow
  )
    errors["compaction.value"] = "Must not exceed the context window.";
  return errors;
}
export function compactionThreshold(
  contextWindow: number | null,
  compaction: Compaction,
): number | null {
  if (!Number.isSafeInteger(compaction.value) || compaction.value < 1)
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

export function changeCompactionMode(
  draft: PresetDraft,
  mode: Compaction["mode"],
): PresetDraft {
  const input = draftToInput(draft);
  const threshold = compactionThreshold(input.contextWindow, input.compaction);
  return {
    ...draft,
    compactionMode: mode,
    compactionValue:
      mode === "percentage" ? "80" : (threshold?.toString() ?? ""),
  };
}

export function selectProvider(
  draft: PresetDraft,
  provider: PresetDraft["provider"],
  kind: IntegrationKind,
  connections: ProviderConnection[],
): PresetDraft {
  return {
    ...draft,
    integrationKind: kind,
    provider,
    customProviderName: "",
    connectionId:
      connections.find(
        (connection) =>
          connection.provider === provider && connection.isDefault,
      )?.id ?? null,
    modelId: "",
    contextWindow: "",
    maxOutputTokens: "",
  };
}
export function selectModel(
  draft: PresetDraft,
  id: string,
  models: DiscoveredModel[],
): PresetDraft {
  if (draft.modelId === id) return draft;
  const model = models.find((item) => item.id === id);
  return {
    ...draft,
    modelId: id,
    contextWindow: model?.contextWindow?.toString() ?? "",
    maxOutputTokens: model?.maxOutputTokens?.toString() ?? "",
  };
}
