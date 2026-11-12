import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolProvider } from "../src/tool-provider.js";
import type { TaskRequest } from "../src/execution-types.js";
const tool = {
  name: "files_read",
  description: "Read text",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};
const base: TaskRequest = {
  modelId: "model",
  instructions: "Use tools",
  messages: [{ role: "user", content: "Read a file" }],
  outputTokens: 1024,
  contextWindow: 32000,
  signal: new AbortController().signal,
  tools: [tool],
  onTool: async () => ({ ok: true }),
};
function streaming(events: any[], ndjson = false) {
  const payload = events
    .map((e) =>
      ndjson ? JSON.stringify(e) + "\n" : "data: " + JSON.stringify(e) + "\n\n",
    )
    .join("");
  const bytes = new TextEncoder().encode(payload);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": ndjson ? "application/x-ndjson" : "text/event-stream",
      },
    },
  );
}
for (const provider of [
  "openai",
  "xai",
  "anthropic",
  "google",
  "ollama",
  "openai-compatible",
  "openrouter",
  "deepseek",
  "mistral",
  "groq",
  "together",
] as const) {
  test(`${provider} completes native tool exchanges and retains required continuation`, async () => {
    const bodies: any[] = [];
    const fetcher = async (_input: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      const final = bodies.length === 2;
      if (provider === "openai" || provider === "xai")
        return streaming(
          final
            ? [
                { type: "response.output_text.delta", delta: "Done" },
                {
                  type: "response.completed",
                  response: {
                    status: "completed",
                    output: [
                      {
                        type: "message",
                        content: [{ type: "output_text", text: "Done" }],
                      },
                    ],
                    usage: { input_tokens: 10 },
                  },
                },
              ]
            : [
                {
                  type: "response.output_item.added",
                  output_index: 1,
                  item: {
                    type: "function_call",
                    id: "fc-1",
                    call_id: "call-1",
                    name: "files_read",
                    arguments: "",
                  },
                },
                {
                  type: "response.function_call_arguments.delta",
                  delta: '{"path":',
                },
                {
                  type: "response.function_call_arguments.delta",
                  delta: '"a.txt"}',
                },
                {
                  type: "response.completed",
                  response: {
                    status: "completed",
                    output: [
                      {
                        type: "reasoning",
                        id: "r-1",
                        encrypted_content: "opaque",
                      },
                      {
                        type: "function_call",
                        id: "fc-1",
                        call_id: "call-1",
                        name: "files_read",
                        arguments: '{"path":"a.txt"}',
                      },
                    ],
                  },
                },
              ],
        );
      if (provider === "anthropic")
        return streaming(
          final
            ? [
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Done" },
                },
                { type: "message_delta", delta: { stop_reason: "end_turn" } },
                { type: "message_stop" },
              ]
            : [
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: {
                    type: "tool_use",
                    id: "call-1",
                    name: "files_read",
                    input: {},
                  },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "input_json_delta", partial_json: '{"path":' },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "input_json_delta", partial_json: '"a.txt"}' },
                },
                { type: "message_delta", delta: { stop_reason: "tool_use" } },
                { type: "message_stop" },
              ],
        );
      if (provider === "google")
        return streaming([
          {
            candidates: [
              {
                content: {
                  parts: final
                    ? [{ text: "Done" }]
                    : [
                        {
                          functionCall: {
                            name: "files_read",
                            args: { path: "a.txt" },
                            id: "call-1",
                          },
                          thoughtSignature: "opaque-signature",
                        },
                      ],
                },
                finishReason: "STOP",
              },
            ],
          },
        ]);
      if (provider === "ollama")
        return streaming(
          [
            {
              message: final
                ? { role: "assistant", content: "Done" }
                : {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        function: {
                          name: "files_read",
                          arguments: { path: "a.txt" },
                        },
                      },
                    ],
                  },
              done: true,
              done_reason: "stop",
            },
          ],
          true,
        );
      return streaming(
        final
          ? [
              {
                choices: [{ delta: { content: "Done" }, finish_reason: null }],
              },
              { choices: [{ delta: {}, finish_reason: "stop" }] },
            ]
          : [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-1",
                          function: {
                            name: "files_read",
                            arguments: '{"path":',
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, function: { arguments: '"a.txt"}' } },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ],
      );
    };
    const adapter = new ToolProvider(
        provider,
        "http://127.0.0.1:9999",
        "test-key",
        fetcher as typeof fetch,
      ),
      first = await adapter.round(base);
    assert.equal(first.calls.length, 1);
    assert.deepEqual(first.calls[0]!.arguments, { path: "a.txt" });
    const second = await adapter.round({
      ...base,
      continuation: [
        {
          response: first.continuation,
          results: [
            { call: first.calls[0], result: { ok: true, text: "contents" } },
          ],
        },
      ],
    });
    assert.equal(second.text, "Done");
    assert.equal(second.calls.length, 0);
    const replay = JSON.stringify(bodies[1]);
    assert.match(replay, /contents/);
    if (provider === "openai" || provider === "xai")
      assert.match(replay, /opaque/);
    if (provider === "google") assert.match(replay, /opaque-signature/);
    assert.equal(bodies[0].tools.length > 0, true);
  });
}
test("malformed tool arguments and unsupported models fail without fallback", async () => {
  const unsupported = new ToolProvider(
    "ollama",
    "http://127.0.0.1",
    null,
    async () => new Response("unsupported", { status: 400 }),
  );
  await assert.rejects(
    () => unsupported.round(base),
    /rejected tool execution/,
  );
  const malformed = new ToolProvider(
    "openai-compatible",
    "http://127.0.0.1",
    null,
    async () =>
      streaming([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "bad",
                    function: { name: "files_read", arguments: "broken" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
  );
  await assert.rejects(() => malformed.round(base), /malformed tool arguments/);
});

test("reasoning continuation stays opaque and survives a compatible tool round", async () => {
  let count = 0,
    body: any;
  const adapter = new ToolProvider(
    "deepseek",
    "http://127.0.0.1",
    null,
    async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return count++ === 0
        ? streaming([
            {
              choices: [
                {
                  delta: {
                    reasoning_content: "private-",
                    reasoning_details: [
                      {
                        index: 0,
                        type: "reasoning.encrypted",
                        data: "opaque-",
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    reasoning_content: "state",
                    reasoning_details: [
                      {
                        index: 0,
                        type: "reasoning.encrypted",
                        data: "continuation",
                      },
                    ],
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-1",
                        function: {
                          name: "files_read",
                          arguments: '{"path":"a"}',
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ])
        : streaming([
            {
              choices: [{ delta: { content: "Done" }, finish_reason: "stop" }],
            },
          ]);
    },
  );
  const first = await adapter.round(base);
  assert.equal(first.text, "");
  await adapter.round({
    ...base,
    continuation: [
      {
        response: first.continuation,
        results: [{ call: first.calls[0], result: { ok: true } }],
      },
    ],
  });
  assert.equal(
    body.messages.find((m: any) => m.role === "assistant").reasoning_content,
    "private-state",
  );
  assert.equal(
    body.messages.find((m: any) => m.role === "assistant").reasoning_details[0]
      .data,
    "opaque-continuation",
  );
});
test("Ollama preserves separate complete calls emitted in successive chunks", async () => {
  const adapter = new ToolProvider(
    "ollama",
    "http://127.0.0.1",
    null,
    async () =>
      streaming(
        [
          {
            message: {
              tool_calls: [
                { function: { name: "files_read", arguments: { path: "a" } } },
              ],
            },
            done: false,
          },
          {
            message: {
              tool_calls: [
                { function: { name: "files_read", arguments: { path: "b" } } },
              ],
            },
            done: true,
            done_reason: "stop",
          },
        ],
        true,
      ),
  );
  const result = await adapter.round(base);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(
    result.calls.map((c) => c.arguments.path),
    ["a", "b"],
  );
});

test("older text-only assistant history is labeled data for reasoning-compatible endpoints", async () => {
  let body: any;
  const adapter = new ToolProvider(
    "deepseek",
    "http://127.0.0.1",
    null,
    async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return streaming([
        { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] },
      ]);
    },
  );
  await adapter.round({
    ...base,
    messages: [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier reply without native metadata" },
      { role: "user", content: "Continue" },
    ],
  });
  assert.equal(
    body.messages.some((m: any) => m.role === "assistant"),
    false,
  );
  assert.match(body.messages[2].content, /historical data/);
  assert.match(body.messages[2].content, /Earlier reply/);
});
