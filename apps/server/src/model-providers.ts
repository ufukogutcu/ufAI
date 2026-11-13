import type { ConnectionProvider, DiscoveredModel } from "./contracts.js";

export class ConnectionError extends Error {
  constructor(
    message: string,
    public statusCode = 502,
  ) {
    super(message);
  }
}
export const providerEndpoints: Record<
  Exclude<ConnectionProvider, "codex" | "openai-compatible" | "ollama">,
  string
> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
};
export const connectionProviders = new Set<string>([
  ...Object.keys(providerEndpoints),
  "openai-compatible",
  "codex",
  "ollama",
]);
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function limit(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
export function normalizeModel(
  value: unknown,
  provider: ConnectionProvider,
): DiscoveredModel | null {
  const m = record(value);
  const methods = m.supportedGenerationMethods;
  const capabilities = record(m.capabilities);
  const architecture = record(m.architecture);
  const output = m.output_modalities ?? architecture.output_modalities;
  if (
    m.active === false ||
    m.archived === true ||
    capabilities.completion_chat === false ||
    (Array.isArray(methods) && !methods.includes("generateContent")) ||
    (Array.isArray(output) && !output.includes("text")) ||
    (typeof m.type === "string" &&
      !["chat", "language", "text", "code", "base", "fine-tuned"].includes(
        m.type,
      ))
  )
    return null;
  const id =
    provider === "google"
      ? typeof m.name === "string"
        ? m.name.replace(/^models\//, "")
        : null
      : m.id;
  if (typeof id !== "string" || !id.trim() || id.length > 200) return null;
  const name =
    m.display_name ??
    m.displayName ??
    (provider === "google" ? id : m.name) ??
    id;
  const contextWindow = limit(
    m.context_window ??
      m.context_length ??
      m.max_context_length ??
      m.max_input_tokens ??
      m.inputTokenLimit,
  );
  const modalities = m.input_modalities ?? architecture.input_modalities;
  const image = Array.isArray(modalities)
    ? modalities.includes("image")
      ? "supported"
      : "unsupported"
    : typeof capabilities.vision === "boolean"
      ? capabilities.vision
        ? "supported"
        : "unsupported"
      : "unknown";
  return {
    ...(image !== "unknown" ||
    (Array.isArray(modalities) && modalities.includes("file"))
      ? {
          media: {
            image,
            pdf:
              Array.isArray(modalities) && modalities.includes("file")
                ? ("supported" as const)
                : ("unknown" as const),
          },
        }
      : {}),
    id,
    name: typeof name === "string" ? name.slice(0, 300) : id,
    contextWindow,
  };
}

// One deadline covers network reads and every page; no upstream error bodies are exposed.
export async function discoverApiModels(
  provider: Exclude<ConnectionProvider, "codex" | "ollama">,
  endpoint: string,
  apiKey: string | null,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<DiscoveredModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    if (provider === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "google") headers["x-goog-api-key"] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
  }
  const url = new URL(
    `${endpoint}/${provider === "xai" ? "language-models" : "models"}`,
  );
  if (provider === "google") url.searchParams.set("pageSize", "1000");
  if (provider === "anthropic") url.searchParams.set("limit", "1000");
  const models = new Map<string, DiscoveredModel>();
  let totalBytes = 0;
  const cursors = new Set<string>();
  try {
    for (let page = 0; page < 10; page++) {
      const response = await fetcher(url, {
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          throw new ConnectionError(
            "The provider rejected this API key. Update the connection and retry.",
            401,
          );
        if (response.status === 429)
          throw new ConnectionError(
            "The provider is rate limiting requests. Please retry shortly.",
            429,
          );
        throw new ConnectionError(
          "Could not fetch models. Check the connection endpoint, or enter a model ID manually.",
        );
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new ConnectionError("The provider returned an empty response.");
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new ConnectionError(
              "The provider model list is too large. Enter a model ID manually.",
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const body = record(json);
      const rows = Array.isArray(json) ? json : (body.data ?? body.models);
      if (!Array.isArray(rows))
        throw new ConnectionError(
          "The provider returned an invalid model list. Enter a model ID manually.",
        );
      for (const row of rows) {
        const model = normalizeModel(row, provider);
        if (model) models.set(model.id, model);
        if (models.size > 5000)
          throw new ConnectionError(
            "The provider model list is too large. Enter a model ID manually.",
          );
      }
      const cursor =
        provider === "google"
          ? body.nextPageToken
          : provider === "anthropic" && body.has_more
            ? body.last_id
            : null;
      if (!cursor)
        return [...models.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      if (typeof cursor !== "string" || cursors.has(cursor))
        throw new ConnectionError(
          "The provider returned invalid model pagination.",
        );
      cursors.add(cursor);
      url.searchParams.set(
        provider === "google" ? "pageToken" : "after_id",
        cursor,
      );
    }
    throw new ConnectionError(
      "The provider model list has too many pages. Enter a model ID manually.",
    );
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    if (controller.signal.aborted)
      throw new ConnectionError(
        "Model discovery timed out. Retry or enter a model ID manually.",
        504,
      );
    throw new ConnectionError(
      "Cannot read models from this provider. Check the connection or enter a model ID manually.",
    );
  } finally {
    clearTimeout(timer);
  }
}
