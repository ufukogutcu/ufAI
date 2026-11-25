import type { DiscoveredModel } from "./contracts.js";
import { ConnectionError, normalizeModel, providerEndpoints } from "./model-providers.js";
import { providerJson } from "./provider-inference.js";

const catalogPageSize = 500;
const maxCatalogPages = 10;
const maxModels = catalogPageSize * maxCatalogPages;
export const maxMakerLength = 120;

const companyNames = new Map([
  ["aion-labs", "AionLabs"],
  ["ai21", "AI21"],
  ["anthropic", "Anthropic"],
  ["black-forest-labs", "Black Forest Labs"],
  ["deepseek", "DeepSeek"],
  ["google", "Google"],
  ["meta-llama", "Meta"],
  ["minimax", "MiniMax"],
  ["mistral", "Mistral AI"],
  ["mistralai", "Mistral AI"],
  ["moonshot", "Moonshot AI"],
  ["moonshotai", "Moonshot AI"],
  ["nvidia", "NVIDIA"],
  ["openai", "OpenAI"],
  ["qwen", "Qwen"],
  ["x-ai", "xAI"],
  ["xai", "xAI"],
  ["z-ai", "Z.ai"],
  ["zai", "Z.ai"],
]);
const unclassifiedVendors = new Set([
  "custom", "exp", "experiential", "experiential-labs", "experiential_labs", "local", "openrouter", "other", "unknown",
]);
type ModelMetadata = {
  maker?: string;
  contextWindow: unknown;
  inputModalities: unknown;
  outputModalities: unknown;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function makerName(value: unknown) {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  if (!label || label.length > maxMakerLength) return undefined;
  return companyNames.get(label.toLowerCase()) ?? label;
}

function vendorId(id: string) {
  const vendor = /^~?([a-z0-9][a-z0-9_-]{0,63})\//i.exec(id)?.[1]?.toLowerCase();
  return vendor && !unclassifiedVendors.has(vendor) ? vendor : undefined;
}

function vendorName(vendor: string) {
  return companyNames.get(vendor) ?? vendor.replace(/(^|[-_])([a-z])/g,
    (_, separator: string, letter: string) => (separator ? " " : "") + letter.toUpperCase());
}

async function discoverMetadata(fetcher: typeof fetch, origin: string, init: RequestInit) {
  const models = new Map<string, ModelMetadata>();
  let offset = 0;
  // providerJson bounds each page to 4 MiB. Keep only the fields ufAI uses.
  for (let page = 0; page < maxCatalogPages; page++) {
    const catalog = await providerJson(fetcher,
      `${origin}/api/models?limit=${catalogPageSize}&offset=${offset}`, init);
    if (!Array.isArray(catalog.models) || catalog.models.length > catalogPageSize ||
      catalog.offset !== offset || typeof catalog.total !== "number" ||
      !Number.isSafeInteger(catalog.total) || catalog.total < 0 || catalog.total > maxModels) break;
    for (const row of catalog.models) {
      const model = object(object(row).model);
      if (typeof model.slug !== "string" || !model.slug || model.slug.length > 200) continue;
      models.set(model.slug, {
        maker: makerName(model.maker),
        contextWindow: model.context_window,
        inputModalities: model.input_modalities,
        outputModalities: model.output_modalities,
      });
    }
    offset += catalog.models.length;
    if (offset >= catalog.total) return models;
    if (!catalog.models.length) break;
  }
  throw new ConnectionError("Experiential Labs returned invalid or oversized catalog metadata.");
}

export async function discoverExperiential(
  apiKey: string | null,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<DiscoveredModel[]> {
  if (!apiKey) throw new ConnectionError("Enter an Experiential Labs API key to load models.", 401);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  const init = { signal, headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` } };
  const origin = new URL(providerEndpoints.experiential).origin;
  try {
    const [catalog, metadata] = await Promise.all([
      providerJson(fetcher, `${origin}/api/v1/models`, init, 8 * 1024 * 1024),
      discoverMetadata(fetcher, origin, init).catch(() => new Map<string, ModelMetadata>()),
    ]);
    if (!Array.isArray(catalog.data) || catalog.data.length > maxModels)
      throw new ConnectionError("Experiential Labs returned an invalid or oversized model list. Add models manually.");

    const models = new Map<string, { model: DiscoveredModel; maker?: string; vendor?: string }>();
    const vendorMakers = new Map<string, string | null>();
    for (const raw of catalog.data) {
      const row = object(raw);
      if (typeof row.id !== "string" || typeof row.canonical_slug !== "string") continue;
      const canonical = row.canonical_slug;
      const variant = /:(free|fast)$/.exec(row.id)?.[1];
      const suffix = variant ? `:${variant}` : "";
      const base = suffix && canonical.endsWith(suffix) ? canonical.slice(0, -suffix.length) : canonical;
      if (!base.trim()) continue;
      const details = metadata.get(base);
      const architecture = object(row.architecture);
      const input = architecture.input_modalities ?? details?.inputModalities;
      const output = architecture.output_modalities ?? details?.outputModalities;
      if (Array.isArray(input) && !input.includes("text")) continue;
      const id = base + suffix;
      const name = typeof row.name === "string" && row.name.trim() ? row.name : base;
      const variantLabel = variant === "free" ? " (Free)" : variant === "fast" ? " (Fast)" : "";
      const model = normalizeModel({
        id,
        name: variantLabel ? name.slice(0, 300 - variantLabel.length) + variantLabel : name,
        context_length: row.context_length ?? details?.contextWindow,
        input_modalities: input,
        output_modalities: output,
      }, "experiential");
      if (!model) continue;
      const maker = details?.maker;
      const vendor = vendorId(row.id);
      if (vendor && maker) {
        const previous = vendorMakers.get(vendor);
        // Reuse a published label only when this vendor identifies a single maker.
        if (previous === undefined) vendorMakers.set(vendor, maker);
        else if (previous !== maker) vendorMakers.set(vendor, null);
      }
      models.set(id, { model, maker, vendor });
    }
    return [...models.values()].map(({ model, maker, vendor }) => {
      const label = maker ?? (vendor ? vendorMakers.get(vendor) ?? vendorName(vendor) : undefined);
      return label ? { ...model, maker: label } : model;
    });
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError(signal.aborted
      ? "Experiential Labs model discovery timed out. Retry or add a model manually."
      : "Cannot read models from Experiential Labs. Check the connection or add a model manually.",
    signal.aborted ? 504 : 502);
  } finally {
    controller.abort();
  }
}
