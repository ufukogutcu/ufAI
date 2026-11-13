import type { TextRequest } from "./execution-types.js";
import { ConnectionError } from "./model-providers.js";
import { providerJson } from "./provider-inference.js";

export type OutputMaximum = (request: TextRequest) => Promise<number>;

// Anthropic requires max_tokens. It describes the model's capacity, rather than
// an application budget. Other protocols omit their optional output controls.
export async function anthropicOutputMaximum(
  endpoint: string,
  key: string | null,
  request: TextRequest,
  fetcher: typeof fetch,
): Promise<number> {
  try {
    const model = await providerJson(
      fetcher,
      `${endpoint}/models/${encodeURIComponent(request.modelId)}`,
      {
        headers: {
          "anthropic-version": "2023-06-01",
          ...(key ? { "x-api-key": key } : {}),
        },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      },
      65536,
    );
    const maximum = model.max_tokens ?? model.max_output_tokens;
    if (typeof maximum === "number" && Number.isSafeInteger(maximum) && maximum > 0)
      return maximum;
  } catch {
    request.signal.throwIfAborted();
  }
  throw new ConnectionError(
    "Cannot determine this Anthropic model's output capacity. Refresh its model metadata or check model-detail access, then retry.",
    409,
  );
}

export function remainingOutput(
  request: TextRequest,
  inputTokens: number,
  maximum: number,
) {
  const remaining = request.contextWindow - inputTokens;
  if (!Number.isSafeInteger(remaining) || remaining < 1)
    throw new ConnectionError(
      "Context is too large for an Anthropic reply. Reduce the task or use a larger context model.",
      409,
    );
  return Math.min(maximum, remaining);
}
