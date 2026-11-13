import {
  anthropicOutputMaximum, remainingOutput, type OutputMaximum,
} from "./provider-output.js";
import type { ConnectionProvider } from "./contracts.js";
import type {
  ModelProviderAdapter,
  TextRequest,
  TextResult,
} from "./execution-types.js";
import { ConnectionError } from "./model-providers.js";
import { providerJson } from "./provider-inference.js";

const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
export class TextProvider implements ModelProviderAdapter {
  constructor(
    private provider: Exclude<ConnectionProvider, "codex">,
    private endpoint: string,
    private apiKey: string | null,
    private fetcher: typeof fetch = fetch,
    private outputMaximum?: OutputMaximum,
  ) {}
  private headers() {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.provider === "anthropic")
      headers["anthropic-version"] = "2023-06-01";
    if (this.apiKey) {
      if (this.provider === "anthropic") headers["x-api-key"] = this.apiKey;
      else if (this.provider === "google")
        headers["x-goog-api-key"] = this.apiKey;
      else headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
  async countTokens(r: TextRequest): Promise<number> {
    const fallback =
      Buffer.byteLength(r.instructions) +
      r.messages.reduce((n, m) => n + Buffer.byteLength(m.content) + 32, 64);
    if (!["openai", "anthropic", "google"].includes(this.provider))
      return fallback;
    try {
      const anthropic = this.provider === "anthropic";
      const openai = this.provider === "openai";
      const result = await providerJson(
        this.fetcher,
        this.endpoint +
          (openai
            ? "/responses/input_tokens"
            : anthropic
              ? "/messages/count_tokens"
              : `/models/${encodeURIComponent(r.modelId)}:countTokens`),
        {
          method: "POST",
          headers: this.headers(),
          signal: AbortSignal.any([r.signal, AbortSignal.timeout(15000)]),
          body: JSON.stringify(
            openai
              ? {
                  model: r.modelId,
                  instructions: r.instructions,
                  input: r.messages,
                }
              : anthropic
                ? {
                    model: r.modelId,
                    system: r.instructions,
                    messages: r.messages,
                  }
                : {
                    generateContentRequest: {
                      model: `models/${r.modelId}`,
                      systemInstruction: { parts: [{ text: r.instructions }] },
                      contents: r.messages.map((m) => ({
                        role: m.role === "assistant" ? "model" : "user",
                        parts: [{ text: m.content }],
                      })),
                    },
                  },
          ),
        },
        64 * 1024,
      );
      const count = result.input_tokens ?? result.totalTokens;
      return typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0
        ? count
        : fallback;
    } catch {
      r.signal.throwIfAborted();
      return fallback;
    }
  }
  async generate(r: TextRequest): Promise<TextResult> {
    r.signal.throwIfAborted();
    let path: string;
    let body: Record<string, unknown>;
    const messages = [
      { role: "system", content: r.instructions },
      ...r.messages,
    ];
    if (this.provider === "anthropic") {
      path = "/messages";
      body = {
        model: r.modelId,
        system: r.instructions,
        messages: r.messages,
        stream: true,
      };
    } else if (this.provider === "google") {
      path = `/models/${encodeURIComponent(r.modelId)}:streamGenerateContent?alt=sse`;
      body = {
        systemInstruction: { parts: [{ text: r.instructions }] },
        contents: r.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      };
    } else if (this.provider === "ollama") {
      path = "/api/chat";
      body = {
        model: r.modelId,
        messages,
        stream: true,
        options: { num_predict: -1, num_ctx: r.contextWindow },
      };
    } else if (this.provider === "openai" || this.provider === "xai") {
      path = "/responses";
      body = {
        model: r.modelId,
        instructions: r.instructions,
        input: r.messages,
        stream: true,
        store: false,
      };
    } else {
      path = "/chat/completions";
      body = {
        model: r.modelId,
        messages,
        stream: true,
      };
    }
    if (this.provider === "anthropic") {
      const maximum = await (this.outputMaximum?.(r) ??
        anthropicOutputMaximum(this.endpoint, this.apiKey, r, this.fetcher));
      body.max_tokens = remainingOutput(r, await this.countTokens(r), maximum);
    }
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint + path, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: r.signal,
        redirect: "error",
      });
    } catch {
      r.signal.throwIfAborted();
      throw new ConnectionError(
        "Cannot reach the Provider. Check the connection and retry.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ConnectionError(
        response.status === 401 || response.status === 403
          ? "Provider authentication failed. Reconnect the Provider."
          : response.status === 429
            ? "Provider rate limit reached. Retry later."
            : "The Provider rejected this generation. Check the model and context limits.",
        response.status === 429
          ? 429
          : response.status === 401 || response.status === 403
            ? 401
            : 502,
      );
    }
    let text = "",
      reason = "",
      terminal = false;
    let usage: Record<string, number> | null = null;
    const append = (delta: unknown) => {
      if (typeof delta !== "string" || !delta) return;
      text += delta;
      r.onDelta?.(delta);
    };
    const accept = (raw: unknown, full = false) => {
      const v = object(raw);
      if (v.error || v.type === "error" || v.type === "response.failed")
        throw new ConnectionError(
          "The Provider reported a generation failure. Retry explicitly.",
        );
      const u = v.usage ?? v.usageMetadata ?? v.response?.usage;
      if (u && typeof u === "object")
        usage = {
          ...(usage ?? {}),
          ...(Object.fromEntries(
            Object.entries(u).filter(
              ([, x]) => typeof x === "number" && Number.isFinite(x),
            ),
          ) as Record<string, number>),
        };
      if (this.provider === "anthropic") {
        if (v.type === "content_block_delta" && v.delta?.type === "text_delta")
          append(v.delta.text);
        if (
          v.type === "content_block_start" &&
          v.content_block?.type === "tool_use"
        )
          throw new ConnectionError(
            "Tools are unavailable in text-only execution.",
          );
        if (v.type === "message_delta" && v.delta?.stop_reason)
          reason = v.delta.stop_reason;
        if (v.type === "message_stop") terminal = true;
        if (full) {
          for (const c of v.content ?? []) {
            if (c.type === "tool_use")
              throw new ConnectionError("Unexpected tool request.");
            if (c.type === "text") append(c.text);
          }
          reason = v.stop_reason;
          terminal = !!reason;
        }
      } else if (this.provider === "google") {
        const candidate = v.candidates?.[0];
        for (const p of candidate?.content?.parts ?? []) {
          if (p.functionCall)
            throw new ConnectionError("Unexpected tool request.");
          if (!p.thought) append(p.text);
        }
        if (candidate?.finishReason) {
          reason = candidate.finishReason;
          terminal = true;
        }
        if (v.promptFeedback?.blockReason)
          throw new ConnectionError("The Provider blocked this request.");
      } else if (this.provider === "ollama") {
        if (v.message?.tool_calls?.length)
          throw new ConnectionError("Unexpected tool request.");
        append(v.message?.content);
        if (v.done === true) {
          terminal = true;
          reason = v.done_reason ?? "stop";
          usage = {
            input_tokens: v.prompt_eval_count ?? 0,
            output_tokens: v.eval_count ?? 0,
          };
        }
      } else if (this.provider === "openai" || this.provider === "xai") {
        if (v.type === "response.output_text.delta") append(v.delta);
        if (v.type === "response.refusal.delta") {
          append(v.delta);
          reason = "refusal";
        }
        if (
          v.type === "response.output_item.added" &&
          !["message", "reasoning"].includes(v.item?.type)
        )
          throw new ConnectionError("Unexpected tool request.");
        if (v.type === "response.completed" || full) {
          const result = full ? v : v.response;
          terminal = result?.status === "completed";
          if (!reason) reason = "stop";
          if (!text)
            for (const item of result?.output ?? [])
              for (const c of item.content ?? []) append(c.text ?? c.refusal);
        }
        if (v.type === "response.incomplete") {
          reason = "length";
          terminal = true;
        }
      } else {
        const c = v.choices?.[0];
        if (c?.delta?.tool_calls?.length || c?.message?.tool_calls?.length)
          throw new ConnectionError("Unexpected tool request.");
        append(
          full
            ? (c?.message?.content ?? c?.message?.refusal)
            : (c?.delta?.content ?? c?.delta?.refusal),
        );
        if (c?.finish_reason) {
          reason = c.finish_reason;
          terminal = true;
        }
      }
    };
    const reader = response.body?.getReader();
    if (!reader)
      throw new ConnectionError("The Provider returned no response body.");
    const aborted = () => {
      void reader.cancel().catch(() => {});
    };
    r.signal.addEventListener("abort", aborted, { once: true });
    if (r.signal.aborted) aborted();
    let buffer = "";
    const decoder = new TextDecoder();
    const contentType = response.headers.get("content-type") ?? "";
    const json =
      contentType.includes("application/json") && this.provider !== "ollama";
    const parse = (s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        throw new ConnectionError(
          "The Provider returned malformed text events.",
        );
      }
    };
    const consume = (last = false) => {
      if (json) return;
      if (
        this.provider === "ollama" &&
        !contentType.includes("text/event-stream")
      ) {
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line) accept(parse(line));
        }
        if (last && buffer.trim()) {
          accept(parse(buffer));
          buffer = "";
        }
      } else {
        let i: number;
        while (
          (i = buffer.indexOf("\n\n")) >= 0 ||
          (last && buffer.trim() && (i = buffer.length) >= 0)
        ) {
          const event = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = event
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data && data !== "[DONE]") accept(parse(data));
          if (i === 0 && !buffer) break;
        }
      }
    };
    try {
      while (true) {
        const next = await reader.read();
        r.signal.throwIfAborted();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        consume();
      }
      buffer += decoder.decode();
      if (json) accept(parse(buffer), true);
      else consume(true);
      if (!terminal || !reason || !text.trim())
        throw new ConnectionError(
          "The Provider did not finish a text reply. Retry explicitly.",
        );
      if (
        ![
          "stop",
          "end_turn",
          "stop_sequence",
          "STOP",
          "refusal",
          "content_filter",
        ].includes(reason)
      )
        throw new ConnectionError(
          "Generation stopped before completion (output limit or unsupported action).",
        );
      return { text, finishReason: reason, usage };
    } catch (error) {
      r.signal.throwIfAborted();
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError(
        "The Provider stream ended unexpectedly. Retry explicitly.",
      );
    } finally {
      r.signal.removeEventListener("abort", aborted);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
