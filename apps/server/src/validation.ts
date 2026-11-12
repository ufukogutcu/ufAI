import type { PresetConfiguration, WorkspaceInput } from "./contracts.js";

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

// Provider identity and context are resolved from saved records, never preset overrides.
export function presetInput(
  body: unknown,
  existing?: PresetConfiguration,
): PresetConfiguration {
  const patch = objectBody(body);
  const input = { ...existing, ...patch };
  const fields: Record<string, string> = {};
  for (const key of Object.keys(patch))
    if (!["name", "connectionId", "modelId", "compaction"].includes(key))
      fields[key] = "Unknown field.";
  const name = text(input.name, "name", 120, fields);
  const connectionId = input.connectionId ?? null;
  if (
    connectionId !== null &&
    (typeof connectionId !== "string" ||
      !connectionId ||
      connectionId.length > 100)
  )
    fields.connectionId = "Choose a saved Provider, or leave empty.";
  const rawModel = input.modelId ?? null;
  let modelId: string | null = null;
  if (rawModel !== null && rawModel !== "")
    modelId = text(rawModel, "modelId", 200, fields);
  if (!connectionId) modelId = null;
  let compaction: PresetConfiguration["compaction"] = null;
  if (input.compaction != null) {
    const c = objectBody(input.compaction);
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
        "Enter a positive whole token count, or a percentage from 1 to 100.";
    else if (c.mode === "percentage" || c.mode === "tokens")
      compaction = { mode: c.mode, value: c.value };
  }
  if (Object.keys(fields).length) throw new InputError(fields);
  return {
    name,
    connectionId: connectionId as string | null,
    modelId,
    integrationKind: null,
    provider: null,
    customProviderName: null,
    contextWindow: null,
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
