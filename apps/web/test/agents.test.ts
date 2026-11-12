import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentStore } from "../src/agent-store";
import type { Agent } from "../../server/src/contracts";
const a: Agent = {
  id: "agent",
  workspaceId: "workspace",
  name: "Researcher",
  instructions: "Help",
  presetId: null,
  x: 10,
  y: 20,
  revision: 1,
  createdAt: "now",
  updatedAt: "now",
  state: "idle",
  queuedCount: 0,
};

test("unchanged workspace snapshots retain node and agent references; status updates do not rebuild canvas nodes", async (t) => {
  const old = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = old;
  });
  let agent = a;
  globalThis.fetch = async () => Response.json({ items: [agent], total: 1 });
  const s = createAgentStore();
  await s.getState().loadWorkspace("workspace");
  const nodes = s.getState().nodes.workspace,
    record = s.getState().agents.agent;
  await s.getState().loadWorkspace("workspace");
  assert.equal(s.getState().nodes.workspace, nodes);
  assert.equal(s.getState().agents.agent, record);
  agent = { ...a, state: "running", queuedCount: 2 };
  await s.getState().loadWorkspace("workspace");
  assert.equal(s.getState().nodes.workspace, nodes);
  assert.notEqual(s.getState().agents.agent, record);
});
test("composer drafts and request identities survive selection changes without sharing between tasks", () => {
  const original = globalThis.crypto;
  if (!original)
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: () => Math.random().toString() },
      configurable: true,
    });
  const s = createAgentStore();
  s.getState().setDraft("task-one", "Draft one");
  s.getState().setDraft("task-two", "Draft two");
  const id = s.getState().submissionId("task-one", "Draft one");
  assert.equal(s.getState().submissionId("task-one", "Draft one"), id);
  assert.notEqual(s.getState().submissionId("task-two", "Draft one"), id);
  assert.notEqual(s.getState().submissionId("task-one", "Changed"), id);
  assert.equal(s.getState().drafts["task-one"], "Draft one");
});
test("position writes coalesce and stale workspace snapshots cannot reset an unsaved move", async (t) => {
  const old = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = old;
  });
  const positions: any[] = [];
  let release!: () => void;
  let first = true;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH") {
      const input = JSON.parse(String(init.body));
      positions.push(input);
      if (first) {
        first = false;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return Response.json({ ...a, ...input });
    }
    return Response.json({ items: [a], total: 1 });
  };
  const s = createAgentStore();
  await s.getState().loadWorkspace("workspace");
  const one = s.getState().position("agent", 30, 40);
  const two = s.getState().position("agent", 50, 60);
  void s.getState().position("agent", 70, 80);
  await s.getState().loadWorkspace("workspace");
  assert.equal(s.getState().agents.agent!.x, 70);
  release();
  await Promise.all([one, two]);
  assert.deepEqual(positions, [
    { x: 30, y: 40 },
    { x: 70, y: 80 },
  ]);
});
test("older message pages merge without losing refreshed streamed text or duplicating messages", async (t) => {
  const old = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = old;
  });
  const m = (sequence: number, content: string) => ({
    id: String(sequence),
    sequence,
    content,
    role: "assistant",
    state: "complete",
    conversationId: "c",
    turnId: "turn",
    createdAt: "now",
  });
  let current = "Partial";
  globalThis.fetch = async (url) =>
    String(url).includes("/messages")
      ? Response.json({
          items: String(url).includes("before=")
            ? [m(1, "Earlier")]
            : [m(2, current)],
          total: 2,
        })
      : Response.json({ task: { id: "task" }, turns: [] });
  const s = createAgentStore();
  await s.getState().loadMessages("agent", "task");
  await s.getState().loadMessages("agent", "task", true);
  current = "Complete";
  await s.getState().loadMessages("agent", "task");
  assert.deepEqual(
    s.getState().messages.task!.map((v) => v.content),
    ["Earlier", "Complete"],
  );
});
