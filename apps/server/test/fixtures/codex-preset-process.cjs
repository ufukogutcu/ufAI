// App-server fixture for preset discovery and turn arguments. No upstream calls.
const assert = require("node:assert/strict");
const { appendFileSync, readFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const [modelsPath, turnsPath] = process.argv.slice(2);
const threads = new Map();
let nextThread = 0;

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) => send({ id, result });
  if (method === "initialized") return;
  if (method === "account/read") return reply({ account: { type: "chatgpt" } });
  if (method === "model/list") {
    return reply({ data: JSON.parse(readFileSync(modelsPath, "utf8")), nextCursor: null });
  }
  if (method === "thread/start") {
    assert.equal(params.config.agents.enabled, false);
    assert.equal(params.config.features.multi_agent_v2, false);
    assert.equal(params.serviceTier, undefined);
    const threadId = String(++nextThread);
    const purpose = params.baseInstructions.startsWith("Maintain this task") ? "maintenance"
      : params.baseInstructions.includes("Main agent Chat.") ? "chat"
      : params.dynamicTools?.length ? "task" : "text";
    threads.set(threadId, purpose);
    return reply({ thread: { id: threadId } });
  }
  if (method === "turn/start") {
    const { threadId, effort, serviceTierForTurn } = params;
    const purpose = threads.get(threadId);
    const turnId = "turn-" + threadId;
    appendFileSync(turnsPath, JSON.stringify({ purpose, effort, serviceTierForTurn }) + "\n");
    reply({ turn: { id: turnId } });
    const text = purpose === "maintenance"
      ? JSON.stringify({ status: "completed", summary: "Done", memories: [] })
      : "Hello from Codex";
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "final", delta: text } });
    return send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  }
  return reply({});
});
