// Pinned app-server protocol fixture. No network or tool execution.
const readline = require("node:readline");
let thread = 0;
const send = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const turns = new Map();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  const result = (v) => send({ id: r.id, result: v });
  if (r.method === "initialize") return result({});
  if (r.method === "initialized") return;
  if (r.method === "account/read")
    return result({ account: { type: "chatgpt" } });
  if (r.method === "thread/start") {
    const p = r.params;
    if (
      !p.ephemeral ||
      p.sandbox !== "read-only" ||
      p.approvalPolicy !== "never" ||
      p.config.features.shell_tool !== false ||
      p.config.features.multi_agent !== false ||
      p.config.web_search !== "disabled"
    )
      return send({ id: r.id, error: { message: "unsafe execution" } });
    return result({ thread: { id: "thread-" + ++thread } });
  }
  if (r.method === "turn/start") {
    const threadId = r.params.threadId,
      turnId = "turn-" + threadId;
    turns.set(threadId, turnId);
    result({ turn: { id: turnId } });
    const text = r.params.input[0].text;
    if (text.includes("hang")) return;
    if (text.includes("multiple-items")) {
      send({
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          itemId: "comment",
          delta: "Preparing an answer.",
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: "comment",
            type: "agentMessage",
            text: "Preparing an answer.",
          },
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { id: "final", type: "agentMessage", text: "Final answer." },
        },
      });
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          tokenUsage: { last: { inputTokens: 12, outputTokens: 8 } },
        },
      });
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      });
      return;
    }
    const events = text.includes("tool")
      ? [
          {
            method: "item/started",
            params: { threadId, item: { type: "commandExecution" } },
          },
        ]
      : [
          {
            method: "item/agentMessage/delta",
            params: { threadId, turnId, delta: "Hello " },
          },
          {
            method: "item/agentMessage/delta",
            params: { threadId, turnId, delta: "world" },
          },
          {
            method: "turn/completed",
            params: { threadId, turn: { id: turnId, status: "completed" } },
          },
        ];
    process.stdout.write(
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    return;
  }
  if (r.method === "turn/interrupt") {
    result({});
    send({
      method: "turn/completed",
      params: {
        threadId: r.params.threadId,
        turn: { id: r.params.turnId, status: "interrupted" },
      },
    });
    return;
  }
  result({});
});
