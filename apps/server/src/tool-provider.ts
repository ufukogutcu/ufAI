import { randomUUID } from "node:crypto";
import type { ConnectionProvider } from "./contracts.js";
import type {
  TaskRequest,
  ToolCall,
  ToolRound,
  ToolResult,
} from "./execution-types.js";
import { ConnectionError } from "./model-providers.js";

type Step = {
  response: any;
  results: { call: ToolCall; result: ToolResult }[];
};
export class ToolProvider {
  constructor(
    private provider: Exclude<ConnectionProvider, "codex">,
    private endpoint: string,
    private key: string | null,
    private fetcher: typeof fetch = fetch,
  ) {}
  async round(r: TaskRequest): Promise<ToolRound> {
    const p = this.provider,
      steps = (r.continuation ?? []) as Step[],
      tools = r.tools;
    const responses = p === "openai" || p === "xai",
      anthropic = p === "anthropic",
      google = p === "google",
      ollama = p === "ollama";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (anthropic) headers["anthropic-version"] = "2023-06-01";
    if (this.key)
      headers[
        anthropic ? "x-api-key" : google ? "x-goog-api-key" : "Authorization"
      ] = anthropic || google ? this.key : `Bearer ${this.key}`;
    let path: string, body: Record<string, unknown>;
    if (responses) {
      path = "/responses";
      body = {
        model: r.modelId,
        instructions: r.instructions,
        input: [
          ...r.messages,
          ...steps.flatMap((s) => [
            ...s.response,
            ...s.results.map(({ call, result }) => ({
              type: "function_call_output",
              call_id: call.id,
              output: JSON.stringify(result),
            })),
          ]),
        ],
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: false,
        })),
        max_output_tokens: r.outputTokens,
        stream: true,
        store: false,
        ...(p === "openai" ? { include: ["reasoning.encrypted_content"] } : {}),
      };
    } else if (anthropic) {
      path = "/messages";
      body = {
        model: r.modelId,
        system: r.instructions,
        messages: [
          ...r.messages,
          ...steps.flatMap((s) => [
            { role: "assistant", content: s.response },
            {
              role: "user",
              content: s.results.map(({ call, result }) => ({
                type: "tool_result",
                tool_use_id: call.id,
                content: JSON.stringify(result),
                is_error: !result.ok,
              })),
            },
          ]),
        ],
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        max_tokens: r.outputTokens,
        stream: true,
      };
    } else if (google) {
      path = `/models/${encodeURIComponent(r.modelId)}:streamGenerateContent?alt=sse`;
      body = {
        systemInstruction: { parts: [{ text: r.instructions }] },
        contents: [
          ...r.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          ...steps.flatMap((s) => [
            { role: "model", parts: s.response },
            {
              role: "user",
              parts: s.results.map(({ call, result }) => ({
                functionResponse: {
                  name: call.name,
                  response: result,
                  ...(s.response.some(
                    (p: any) => p.functionCall?.id === call.id,
                  )
                    ? { id: call.id }
                    : {}),
                },
              })),
            },
          ]),
        ],
        tools: [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          },
        ],
        generationConfig: { maxOutputTokens: r.outputTokens },
      };
    } else {
      path = ollama ? "/api/chat" : "/chat/completions";
      body = {
        model: r.modelId,
        messages: [
          { role: "system", content: r.instructions },
          // Older ufAI turns contain authoritative text, not replayable native reasoning.
          // Label that text as historical data instead of fabricating reasoning blocks.
          ...r.messages.map((m) =>
            m.role === "assistant" &&
            ["deepseek", "openrouter", "openai-compatible"].includes(p)
              ? {
                  role: "user",
                  content:
                    "Earlier assistant reply (historical data, not a new request): " +
                    m.content,
                }
              : m,
          ),
          ...steps.flatMap((s) => [
            s.response,
            ...s.results.map(({ call, result }) => ({
              role: "tool",
              ...(ollama
                ? { tool_name: call.name }
                : { tool_call_id: call.id }),
              content: JSON.stringify(result),
            })),
          ]),
        ],
        tools: tools.map((t) => ({ type: "function", function: t })),
        stream: true,
        ...(ollama
          ? {
              options: {
                num_predict: r.outputTokens,
                num_ctx: r.contextWindow,
              },
            }
          : { max_tokens: r.outputTokens }),
      };
    }
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: r.signal,
        redirect: "error",
      });
    } catch {
      r.signal.throwIfAborted();
      throw new ConnectionError("Cannot reach the Provider. Retry explicitly.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ConnectionError(
        response.status === 401 || response.status === 403
          ? "Provider authentication failed."
          : response.status === 429
            ? "Provider rate limit reached."
            : "The selected model rejected tool execution. Check tool support and context limits.",
        response.status === 429 ? 429 : response.status === 401 ? 401 : 409,
      );
    }
    let text = "",
      finish = "",
      terminal = false,
      usage: Record<string, number> | null = null;
    let reasoningContent = "",
      reasoning = "";
    const reasoningDetails = new Map<number, any>();
    const native: any[] = [],
      blocks = new Map<number, any>(),
      calls = new Map<number, any>();
    const append = (s: unknown) => {
      if (Array.isArray(s)) {
        for (const part of s) if (part.type === "text") append(part.text);
        return;
      }
      if (typeof s === "string") {
        text += s;
        if (Buffer.byteLength(text) > 256 * 1024)
          throw new ConnectionError("Reply exceeded the text size limit.");
        r.onDelta?.(s);
      }
    };
    const accept = (v: any, full = false) => {
      if (v.error || v.type === "error" || v.type === "response.failed")
        throw new ConnectionError(
          "Provider reported a tool generation failure.",
        );
      const u = v.usage ?? v.usageMetadata ?? v.response?.usage;
      if (u)
        usage = {
          ...(usage ?? {}),
          ...(Object.fromEntries(
            Object.entries(u).filter(
              ([, n]) => typeof n === "number" && Number.isFinite(n),
            ),
          ) as Record<string, number>),
        };
      if (responses) {
        if (v.type === "response.output_text.delta") append(v.delta);
        if (v.type === "response.refusal.delta") append(v.delta);
        if (v.type === "response.output_item.done")
          native[v.output_index] = v.item;
        if (v.type === "response.completed" || full) {
          const result = full ? v : v.response;
          terminal = result.status === "completed";
          finish = result.status;
          native.splice(0, native.length, ...(result.output ?? native));
          if (!text)
            for (const item of native)
              for (const c of item.content ?? []) append(c.text ?? c.refusal);
        }
        if (v.type === "response.incomplete")
          throw new ConnectionError(
            "Tool generation exceeded its output limit.",
          );
      } else if (anthropic) {
        if (v.type === "content_block_start")
          blocks.set(v.index, { ...v.content_block });
        if (v.type === "content_block_delta") {
          const b = blocks.get(v.index);
          if (!b) throw new ConnectionError("Invalid tool block ordering.");
          if (v.delta.type === "text_delta") {
            b.text = (b.text ?? "") + v.delta.text;
            append(v.delta.text);
          } else if (v.delta.type === "input_json_delta")
            b._json = (b._json ?? "") + v.delta.partial_json;
          else if (v.delta.type === "thinking_delta")
            b.thinking = (b.thinking ?? "") + v.delta.thinking;
          else if (v.delta.type === "signature_delta")
            b.signature = (b.signature ?? "") + v.delta.signature;
        }
        if (v.type === "message_delta") finish = v.delta.stop_reason ?? finish;
        if (v.type === "message_stop") terminal = true;
        if (full) {
          for (const [i, b] of (v.content ?? []).entries()) {
            blocks.set(i, b);
            if (b.type === "text") append(b.text);
          }
          finish = v.stop_reason;
          terminal = !!finish;
        }
      } else if (google) {
        const c = v.candidates?.[0];
        for (const part of c?.content?.parts ?? []) {
          native.push(part);
          if (!part.thought) append(part.text);
        }
        if (c?.finishReason) {
          finish = c.finishReason;
          terminal = true;
        }
        if (v.promptFeedback?.blockReason)
          throw new ConnectionError("Provider blocked this request.");
      } else {
        const c = ollama
          ? v.message
          : full
            ? v.choices?.[0]?.message
            : v.choices?.[0]?.delta;
        if (c) {
          append(c.content ?? c.refusal);
          if (typeof c.reasoning_content === "string")
            reasoningContent += c.reasoning_content;
          if (typeof c.reasoning === "string") reasoning += c.reasoning;
          for (const [index, detail] of (c.reasoning_details ?? []).entries()) {
            const key = detail.index ?? index,
              old = reasoningDetails.get(key);
            reasoningDetails.set(
              key,
              old
                ? {
                    ...old,
                    ...detail,
                    ...(typeof detail.text === "string"
                      ? { text: (old.text ?? "") + detail.text }
                      : {}),
                    ...(typeof detail.data === "string"
                      ? { data: (old.data ?? "") + detail.data }
                      : {}),
                  }
                : detail,
            );
          }
          for (const [i, call] of (c.tool_calls ?? []).entries()) {
            const index = ollama
              ? (call.index ?? call.function?.index ?? calls.size)
              : (call.index ?? i);
            const old = calls.get(index) ?? {
              id: call.id ?? randomUUID().replaceAll("-", "").slice(0, 9),
              type: "function",
              function: { name: "", arguments: "" },
            };
            if (call.id) old.id = call.id;
            if (call.function?.name)
              old.function.name = ollama
                ? call.function.name
                : old.function.name + call.function.name;
            if (typeof call.function?.arguments === "string")
              old.function.arguments += call.function.arguments;
            else if (call.function?.arguments)
              old.function.arguments = JSON.stringify(call.function.arguments);
            calls.set(index, old);
          }
        }
        if (ollama && v.done) {
          finish = v.done_reason ?? "stop";
          terminal = true;
          usage = {
            input_tokens: v.prompt_eval_count ?? 0,
            output_tokens: v.eval_count ?? 0,
          };
        } else if (v.choices?.[0]?.finish_reason) {
          finish = v.choices[0].finish_reason;
          terminal = true;
        }
      }
    };
    const reader = response.body?.getReader();
    if (!reader) throw new ConnectionError("Provider returned no body.");
    let bytes = 0,
      buffer = "";
    const decoder = new TextDecoder(),
      type = response.headers.get("content-type") ?? "",
      json = type.includes("application/json") && !ollama;
    const consume = (last = false) => {
      if (json) return;
      if (ollama && !type.includes("text/event-stream")) {
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const s = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (s) accept(JSON.parse(s));
        }
        if (last && buffer.trim()) {
          accept(JSON.parse(buffer));
          buffer = "";
        }
      } else {
        let at: number;
        while (
          (at = buffer.indexOf("\n\n")) >= 0 ||
          (last && buffer.trim() && (at = buffer.length) >= 0)
        ) {
          const chunk = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = chunk
            .split("\n")
            .filter((x) => x.startsWith("data:"))
            .map((x) => x.slice(5).trimStart())
            .join("\n");
          if (data && data !== "[DONE]") accept(JSON.parse(data));
        }
      }
    };
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    r.signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const n = await reader.read();
        r.signal.throwIfAborted();
        if (n.done) break;
        bytes += n.value.length;
        if (bytes > 2 * 1024 * 1024)
          throw new ConnectionError("Provider stream exceeded the size limit.");
        buffer += decoder.decode(n.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        consume();
      }
      buffer += decoder.decode();
      if (json) accept(JSON.parse(buffer), true);
      else consume(true);
    } catch (e) {
      r.signal.throwIfAborted();
      if (e instanceof ConnectionError) throw e;
      throw new ConnectionError(
        "Malformed or interrupted tool stream. Retry explicitly.",
      );
    } finally {
      r.signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
    }
    let resultCalls: ToolCall[] = [],
      continuation: any;
    const argumentsObject = (s: any) => {
      let value: any;
      try {
        value = typeof s === "string" ? JSON.parse(s) : s;
      } catch {
        throw new ConnectionError(
          "Provider returned malformed tool arguments.",
        );
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Buffer.byteLength(JSON.stringify(value)) > 65536
      )
        throw new ConnectionError("Provider returned invalid tool arguments.");
      return value;
    };
    if (responses) {
      continuation = native;
      for (const i of native)
        if (i.type === "function_call")
          resultCalls.push({
            id: i.call_id,
            name: i.name,
            arguments: argumentsObject(i.arguments),
          });
        else if (!["message", "reasoning"].includes(i.type))
          throw new ConnectionError(
            "Provider attempted an unsupported tool type.",
          );
    } else if (anthropic) {
      continuation = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, b]) => {
          if (b.type === "tool_use") {
            if (b._json) b.input = argumentsObject(b._json);
            delete b._json;
          }
          return b;
        });
      for (const b of continuation)
        if (b.type === "tool_use")
          resultCalls.push({
            id: b.id,
            name: b.name,
            arguments: argumentsObject(b.input),
          });
    } else if (google) {
      continuation = native;
      for (const part of native)
        if (part.functionCall) {
          const c = part.functionCall;
          resultCalls.push({
            id: c.id ?? randomUUID(),
            name: c.name,
            arguments: argumentsObject(c.args ?? {}),
          });
        }
    } else {
      const nativeCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => c);
      continuation = {
        role: "assistant",
        content: text,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(reasoningDetails.size
          ? { reasoning_details: [...reasoningDetails.values()] }
          : {}),
        ...(nativeCalls.length
          ? {
              tool_calls: nativeCalls.map((c) =>
                ollama
                  ? {
                      ...c,
                      function: {
                        ...c.function,
                        arguments: argumentsObject(c.function.arguments),
                      },
                    }
                  : c,
              ),
            }
          : {}),
      };
      resultCalls = nativeCalls.map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: argumentsObject(c.function.arguments),
      }));
    }
    if (
      !terminal ||
      !finish ||
      ![
        "completed",
        "stop",
        "end_turn",
        "stop_sequence",
        "tool_use",
        "tool_calls",
        "function_call",
        "STOP",
        "refusal",
        "content_filter",
      ].includes(finish) ||
      (!resultCalls.length && !text.trim())
    )
      throw new ConnectionError(
        "Provider did not finish a tool exchange. Retry explicitly.",
      );
    if (
      resultCalls.length > 128 ||
      new Set(resultCalls.map((c) => c.id)).size !== resultCalls.length
    )
      throw new ConnectionError("Invalid or excessive tool calls.");
    return { text, calls: resultCalls, continuation, usage };
  }
}
