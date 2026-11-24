import type {
  ProviderPresetCapabilities,
  ProviderPresetOptions,
} from "./contracts.js";

export function isPresetOptionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 100 && value === value.trim();
}

function choices<T extends { id: string }>(
  values: unknown,
  parse: (value: Record<string, unknown>) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(values) || values.length > 100) return;
  const entries = new Map<string, T>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const choice = parse(value);
    if (choice && !entries.has(choice.id)) entries.set(choice.id, choice);
  }
  // An explicit empty list is meaningful. An invalid list is missing metadata.
  if (!values.length || entries.size) return [...entries.values()];
}

function description(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

export function codexPresetCapabilities(
  model: Record<string, unknown>,
): ProviderPresetCapabilities | undefined {
  const reasoningEfforts = choices(model.supportedReasoningEfforts, (entry) =>
    isPresetOptionId(entry.reasoningEffort)
      ? { id: entry.reasoningEffort, description: description(entry.description) }
      : undefined);
  const serviceTiers = choices(model.serviceTiers, (entry) =>
    isPresetOptionId(entry.id)
      ? {
          id: entry.id,
          name: typeof entry.name === "string" && entry.name.trim()
            ? entry.name.trim().slice(0, 120)
            : entry.id,
          description: description(entry.description),
        }
      : undefined);
  if (reasoningEfforts || serviceTiers)
    return { provider: "codex", reasoningEfforts, serviceTiers };
}

export function codexPresetOptionErrors(
  options: ProviderPresetOptions,
  capabilities: ProviderPresetCapabilities | undefined,
): Record<string, string> {
  const fields: Record<string, string> = {};
  if (options.reasoningEffort &&
      !capabilities?.reasoningEfforts?.some(({ id }) => id === options.reasoningEffort))
    fields["providerOptions.reasoningEffort"] =
      "Choose a thinking level offered by this model, or use Codex default.";
  if (options.serviceTier &&
      (!capabilities?.serviceTiers?.length ||
        (options.serviceTier !== "default" &&
          !capabilities.serviceTiers.some(({ id }) => id === options.serviceTier))))
    fields["providerOptions.serviceTier"] =
      "Choose a speed offered by this model, or use Codex default.";
  return fields;
}

export const unavailableCodexPresetOptions =
  "The Agent Preset has a thinking level or speed this Codex model no longer offers. Update the preset, then retry.";
