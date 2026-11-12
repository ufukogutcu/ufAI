import type { ConnectionProvider, DiscoveredModel } from "./contracts.js";
import { ConnectionError } from "./model-providers.js";

export const TEST_PROMPT = "Reply with OK.";
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
export async function providerJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  maxBytes = 4 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { ...init, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new ConnectionError(
        "The provider rejected authentication. Update your credentials and retry.",
        401,
      );
    if (response.status === 429)
      throw new ConnectionError(
        "The provider is rate limiting requests. Retry shortly.",
        429,
      );
    throw new ConnectionError(
      "The provider could not complete the request. Check the endpoint and model ID.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new ConnectionError("The provider returned an empty response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ConnectionError(
          "The provider response exceeded the allowed size.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
export async function discoverOllama(
  endpoint: string,
  apiKey: string | null,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<DiscoveredModel[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const catalog = await providerJson(fetcher, `${endpoint}/api/tags`, {
      signal,
      headers,
    });
    if (!Array.isArray(catalog.models) || catalog.models.length > 5000)
      throw new ConnectionError(
        "Ollama returned an invalid or oversized model list. Add models manually.",
      );
    const models: DiscoveredModel[] = [];
    for (const raw of catalog.models) {
      const m = object(raw);
      const id = m.model ?? m.name;
      if (typeof id === "string" && id.trim() && id.length <= 200)
        models.push({
          id,
          name: id,
          contextWindow: null,
          maxOutputTokens: null,
        });
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, models.length) }, async () => {
        while (next < models.length && !signal.aborted) {
          const model = models[next++]!;
          try {
            const detail = await providerJson(fetcher, `${endpoint}/api/show`, {
              method: "POST",
              headers,
              signal,
              body: JSON.stringify({ model: model.id }),
            });
            const info = object(detail.model_info);
            const key = Object.keys(info).find((key) =>
              key.endsWith(".context_length"),
            );
            // num_ctx is the configured context when present; otherwise report model capacity.
            const numCtx =
              typeof detail.parameters === "string"
                ? detail.parameters.match(/^num_ctx\s+(\d+)$/m)?.[1]
                : undefined;
            model.contextWindow = positive(
              numCtx ? Number(numCtx) : key ? info[key] : null,
            );
          } catch {
            /* Model enumeration remains useful when details are unavailable. */
          }
        }
      }),
    );
    return [...new Map(models.map((model) => [model.id, model])).values()];
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError(
      signal.aborted
        ? "Ollama discovery timed out. Retry or add a model manually."
        : "Cannot reach Ollama. Check that it is running and its URL is correct.",
      signal.aborted ? 504 : 502,
    );
  }
}
export async function testApiModel(
  provider: Exclude<ConnectionProvider, "codex">,
  endpoint: string,
  apiKey: string | null,
  modelId: string,
  maxOutputTokens: number | null,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) {
    if (provider === "anthropic") headers["x-api-key"] = apiKey;
    else if (provider === "google") headers["x-goog-api-key"] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
  }
  const cap = Math.min(2048, maxOutputTokens ?? 2048);
  let path: string;
  let body: Record<string, unknown>;
  if (provider === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    path = "/messages";
    body = {
      model: modelId,
      max_tokens: cap,
      messages: [{ role: "user", content: TEST_PROMPT }],
    };
  } else if (provider === "google") {
    path = `/models/${encodeURIComponent(modelId)}:generateContent`;
    body = {
      contents: [{ parts: [{ text: TEST_PROMPT }] }],
      generationConfig: { maxOutputTokens: cap },
    };
  } else if (provider === "ollama") {
    path = "/api/chat";
    body = {
      model: modelId,
      stream: false,
      messages: [{ role: "user", content: TEST_PROMPT }],
      options: { num_predict: cap },
    };
  } else if (provider === "openai" || provider === "xai") {
    path = "/responses";
    body = {
      model: modelId,
      input: TEST_PROMPT,
      max_output_tokens: cap,
      store: false,
    };
  } else {
    path = "/chat/completions";
    body = {
      model: modelId,
      messages: [{ role: "user", content: TEST_PROMPT }],
      max_tokens: cap,
      stream: false,
    };
  }
  try {
    const result = await providerJson(
      fetcher,
      endpoint + path,
      { method: "POST", headers, body: JSON.stringify(body), signal },
      1024 * 1024,
    );
    let reply: unknown;
    if (provider === "anthropic")
      reply = Array.isArray(result.content)
        ? result.content
            .filter((c) => object(c).type === "text")
            .map((c) => object(c).text)
            .join("")
        : "";
    else if (provider === "google") {
      const parts = object(
        object((result.candidates as unknown[] | undefined)?.[0]).content,
      ).parts;
      reply = Array.isArray(parts)
        ? parts
            .filter((p) => object(p).thought !== true)
            .map((p) => object(p).text ?? "")
            .join("")
        : "";
    } else if (provider === "ollama")
      reply = result.done === true ? object(result.message).content : "";
    else if (provider === "openai" || provider === "xai") {
      if (result.status !== "completed")
        throw new ConnectionError(
          "The model did not complete a reply within the test output budget.",
        );
      reply = Array.isArray(result.output)
        ? result.output
            .filter((o) => object(o).type === "message")
            .flatMap((o) => {
              const content = object(o).content;
              return Array.isArray(content)
                ? content
                    .filter((c) => object(c).type === "output_text")
                    .map((c) => object(c).text ?? "")
                : [];
            })
            .join("")
        : "";
    } else {
      const choice = object((result.choices as unknown[] | undefined)?.[0]);
      if (choice.finish_reason !== "stop")
        throw new ConnectionError(
          "The model did not complete a text reply within the test output budget.",
        );
      reply = object(choice.message).content;
    }
    if (typeof reply !== "string" || !reply.trim())
      throw new ConnectionError(
        "The model returned no assistant text. Check the model ID or retry.",
      );
    return reply.trim().slice(0, 300);
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError(
      signal.aborted
        ? "The model test was cancelled or timed out. Retry when the provider is ready."
        : "Cannot read a reply from this model. Check the connection and model ID.",
      signal.aborted ? 504 : 502,
    );
  }
}
