import assert from "node:assert/strict";
import { test } from "node:test";
import { TextProvider } from "../src/text-provider.js";
import type { ConnectionProvider } from "../src/contracts.js";
import type { TextRequest } from "../src/execution-types.js";
const base: TextRequest = {
  modelId: "model",
  instructions: "Instructions",
  messages: [{ role: "user", content: "Hello" }],
  outputTokens: 4096,
  contextWindow: 32000,
  signal: new AbortController().signal,
};
function stream(text: string, type = "text/event-stream") {
  const encoded = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < encoded.length; i += 7)
          c.enqueue(encoded.slice(i, i + 7));
        c.close();
      },
    }),
    { headers: { "content-type": type } },
  );
}
const cases: {
  provider: Exclude<ConnectionProvider, "codex">;
  path: string;
  text: string;
  type?: string;
}[] = [
  {
    provider: "openai",
    path: "/responses",
    text: 'data: {"type":"response.output_text.delta","delta":"Héllo"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3}}}\n\n',
  },
  {
    provider: "xai",
    path: "/responses",
    text: 'data: {"type":"response.output_text.delta","delta":"Héllo"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n',
  },
  {
    provider: "anthropic",
    path: "/messages",
    text: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Héllo"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
  },
  {
    provider: "google",
    path: "/models/model:streamGenerateContent?alt=sse",
    text: 'data: {"candidates":[{"content":{"parts":[{"text":"private","thought":true},{"text":"Héllo"}]},"finishReason":"STOP"}]}\n\n',
  },
  {
    provider: "ollama",
    path: "/api/chat",
    type: "application/x-ndjson",
    text: '{"message":{"content":"Héllo","thinking":"private"},"done":false}\n{"done":true,"done_reason":"stop","prompt_eval_count":2,"eval_count":1}\n',
  },
  ...(
    [
      "openrouter",
      "deepseek",
      "mistral",
      "groq",
      "together",
      "openai-compatible",
    ] as const
  ).map((provider) => ({
    provider,
    path: "/chat/completions",
    text: 'data: {"choices":[{"delta":{"content":"Héllo"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  })),
];
for (const c of cases)
  test(`${c.provider} streams bounded text with correct protocol and cancellation signal`, async () => {
    let body: any,
      url = "";
    const deltas: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      url = String(input);
      body = JSON.parse(init!.body as string);
      assert.equal(init!.signal, base.signal);
      assert.equal(init!.redirect, "error");
      return stream(c.text, c.type);
    };
    const answer = await new TextProvider(
      c.provider,
      "https://provider.example",
      "private",
      fetcher,
    ).generate({ ...base, onDelta: (t) => deltas.push(t) });
    assert.equal(answer.text, "Héllo");
    assert.equal(deltas.join(""), "Héllo");
    assert.equal(url, "https://provider.example" + c.path);
    assert.equal(JSON.stringify(body).includes("Instructions"), true);
    assert.equal(JSON.stringify(answer).includes("private"), false);
  });
test("compatible JSON replies work without a second generation request", async () => {
  let calls = 0;
  const p = new TextProvider(
    "openai-compatible",
    "https://local.example",
    null,
    async () => {
      calls++;
      return Response.json({
        choices: [{ message: { content: "Answer" }, finish_reason: "stop" }],
      });
    },
  );
  assert.equal((await p.generate(base)).text, "Answer");
  assert.equal(calls, 1);
});
test("malformed streams, missing completion, output limits, tools and provider errors fail explicitly", async () => {
  for (const text of [
    "data: broken\n\n",
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n',
    'data: {"error":{"message":"SECRET"}}\n\n',
  ]) {
    const p = new TextProvider(
      "openai-compatible",
      "https://local.example",
      null,
      async () => stream(text),
    );
    await assert.rejects(
      p.generate(base),
      (e) => e instanceof Error && !e.message.includes("SECRET"),
    );
  }
});
test("aborting an active stream cancels its reader and rejects generation", async () => {
  const controller = new AbortController();
  let cancel = false;
  const p = new TextProvider(
    "openai-compatible",
    "https://local.example",
    null,
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
              ),
            );
          },
          cancel() {
            cancel = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  await assert.rejects(
    p.generate({
      ...base,
      signal: controller.signal,
      onDelta: () => controller.abort(),
    }),
  );
  assert.equal(cancel, true);
});
test("provider-side token counting is used when available, with a conservative fallback", async () => {
  const p = new TextProvider(
    "anthropic",
    "https://api.example",
    "test",
    async () => Response.json({ input_tokens: 23 }),
  );
  assert.equal(await p.countTokens(base), 23);
  const q = new TextProvider(
    "google",
    "https://api.example",
    "test",
    async () => new Response("", { status: 404 }),
  );
  assert.ok((await q.countTokens(base)) > 20);
});
test("OpenAI counts the exact Responses input and instructions before generation", async () => {
  const p = new TextProvider(
    "openai",
    "https://api.example",
    "test",
    async (url, init) => {
      assert.equal(String(url), "https://api.example/responses/input_tokens");
      assert.deepEqual(JSON.parse(String(init!.body)), {
        model: "model",
        instructions: "Instructions",
        input: [{ role: "user", content: "Hello" }],
      });
      return Response.json({
        object: "response.input_tokens",
        input_tokens: 19,
      });
    },
  );
  assert.equal(await p.countTokens(base), 19);
});
