import type { PresetInput, WorkspaceInput } from "./contracts.js";

export class InputError extends Error {
  constructor(public fields: Record<string, string>) {
    super("Please correct the highlighted fields.");
  }
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError({ body: "Expected a JSON object." });
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  field: string,
  max: number,
  fields: Record<string, string>,
  required = true,
): string {
  if (
    typeof value !== "string" ||
    (required && !value.trim()) ||
    value.length > max
  ) {
    fields[field] = required
      ? `Enter text between 1 and ${max} characters.`
      : `Enter at most ${max} characters.`;
    return "";
  }
  return value.trim();
}

export function workspaceInput(
  body: unknown,
  existing?: WorkspaceInput,
): WorkspaceInput {
  const patch = objectBody(body);
  const input = { description: "", ...existing, ...patch };
  const fields: Record<string, string> = {};
  for (const key of Object.keys(patch))
    if (key !== "name" && key !== "description") fields[key] = "Unknown field.";
  const name = text(input.name, "name", 120, fields);
  const description = text(
    input.description,
    "description",
    4000,
    fields,
    false,
  );
  if (Object.keys(fields).length) throw new InputError(fields);
  return { name, description };
}

const inputKeys = new Set([
  "name",
  "integrationKind",
  "provider",
  "customProviderName",
  "modelId",
  "contextWindow",
  "maxOutputTokens",
  "notes",
  "compaction",
]);
const providers = new Set([
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openai-compatible",
  "codex",
  "custom",
]);

export function presetInput(
  body: unknown,
  existing?: PresetInput,
): PresetInput {
  const patch = objectBody(body);
  const input = { ...existing, ...patch } as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(patch))
    if (!inputKeys.has(key)) fields[key] = "Unknown field.";
  const name = text(input.name, "name", 120, fields);
  const modelId = text(input.modelId, "modelId", 200, fields);
  const notes = text(input.notes ?? "", "notes", 4000, fields, false);
  if (
    input.integrationKind !== "provider" &&
    input.integrationKind !== "runtime"
  )
    fields.integrationKind = "Choose an integration kind.";
  if (typeof input.provider !== "string" || !providers.has(input.provider))
    fields.provider = "Choose a provider or runtime.";
  else if (
    input.provider !== "custom" &&
    (input.provider === "codex") !== (input.integrationKind === "runtime")
  )
    fields.provider = "Choose an option matching the integration kind.";
  let customProviderName: string | null = null;
  if (input.provider === "custom")
    customProviderName = text(
      input.customProviderName,
      "customProviderName",
      120,
      fields,
    );
  else if (input.customProviderName != null)
    fields.customProviderName = "Only custom integrations have a custom name.";
  function tokens(value: unknown, field: string): number | null {
    if (value == null) return null;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      fields[field] = "Enter a positive safe integer, or leave empty.";
      return null;
    }
    return value;
  }
  const contextWindow = tokens(input.contextWindow, "contextWindow");
  const maxOutputTokens = tokens(input.maxOutputTokens, "maxOutputTokens");
  if (contextWindow && maxOutputTokens && maxOutputTokens > contextWindow)
    fields.maxOutputTokens = "Must not exceed the context window.";
  const raw =
    input.compaction === undefined
      ? { mode: "percentage", value: 80 }
      : input.compaction;
  let compaction: PresetInput["compaction"] = { mode: "percentage", value: 80 };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    fields.compaction = "Choose a compaction mode and value.";
  else {
    const c = raw as Record<string, unknown>;
    if (Object.keys(c).some((key) => key !== "mode" && key !== "value"))
      fields.compaction = "Unknown compaction field.";
    if (c.mode !== "percentage" && c.mode !== "tokens")
      fields["compaction.mode"] = "Choose percentage or tokens.";
    if (
      typeof c.value !== "number" ||
      !Number.isSafeInteger(c.value) ||
      c.value < 1 ||
      (c.mode === "percentage" && c.value > 100)
    )
      fields["compaction.value"] =
        c.mode === "percentage"
          ? "Enter a whole percentage from 1 to 100."
          : "Enter a positive safe integer.";
    else if (c.mode === "tokens" && contextWindow && c.value > contextWindow)
      fields["compaction.value"] = "Must not exceed the context window.";
    if (c.mode === "percentage" || c.mode === "tokens")
      compaction = { mode: c.mode, value: c.value as number };
  }
  if (Object.keys(fields).length) throw new InputError(fields);
  return {
    name,
    modelId,
    notes,
    integrationKind: input.integrationKind as PresetInput["integrationKind"],
    provider: input.provider as PresetInput["provider"],
    customProviderName,
    contextWindow,
    maxOutputTokens,
    compaction,
  };
}

export function pagination(query: unknown): { limit: number; offset: number } {
  const input = objectBody(query);
  const limit = input.limit === undefined ? 100 : Number(input.limit);
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new InputError({
      query: "Use limit 1–100 and a non-negative integer offset.",
    });
  return { limit, offset };
}
