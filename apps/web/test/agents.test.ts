import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentStore } from "../src/agent-store";
import type { Agent } from "../../server/src/contracts";
import { agentActivity } from "../src/agent-appearance";
import { AGENT_WIDTH, AGENT_HEIGHT } from "../src/canvas-layout";
const a: Agent = {
  issueCounts: { warning: 1, error: 0 },
  appearance: { kind: "pebble", color: "sage", accessories: [] },
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
  runningTaskCount: 0,
};

test("unchanged workspace snapshots retain node and agent references; status updates do not rebuild canvas nodes", async (t) => {
  const old = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = old;
  });
  let agent = a;
  globalThis.fetch = async (url) =>
    Response.json(
      String(url).includes("/agents")
        ? { items: [agent], total: 1 }
        : { items: [], total: 0 },
    );
  const s = createAgentStore();
  await s.getState().loadWorkspace("workspace");
  const nodes = s.getState().nodes.workspace,
    record = s.getState().agents.agent;
  await s.getState().loadWorkspace("workspace");
  assert.equal(s.getState().nodes.workspace, nodes);
  assert.equal(s.getState().agents.agent, record);
  agent = { ...a, state: "running", queuedCount: 2, runningTaskCount: 1 };
  await s.getState().loadWorkspace("workspace");
  assert.equal(s.getState().nodes.workspace, nodes);
  assert.notEqual(s.getState().agents.agent, record);
  const running = s.getState().agents.agent;
  agent = { ...agent, runningTaskCount: 2 };
  await s.getState().loadWorkspace("workspace");
  assert.equal(s.getState().nodes.workspace, nodes);
  assert.notEqual(s.getState().agents.agent, running);
  assert.equal(s.getState().agents.agent!.runningTaskCount, 2);
  agent = { ...agent, appearance: { kind: "droplet", color: "coral", accessories: ["glasses"] } };
  await s.getState().loadWorkspace("workspace");
  assert.equal(s.getState().nodes.workspace, nodes);
  assert.notEqual(s.getState().agents.agent, running);
  assert.deepEqual(s.getState().agents.agent!.appearance, agent.appearance);
});

test("running and waiting agents work with the shared node dimensions", () => {
  assert.equal(agentActivity("running"), "working");
  assert.equal(agentActivity("waiting"), "working");
  for (const state of ["idle", "queued", "awaiting_user", "completed", "blocked", "failed", "cancelled"] as const)
    assert.equal(agentActivity(state), "idle");
  assert.equal(AGENT_WIDTH, 176); assert.equal(AGENT_HEIGHT, 224);

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
    return Response.json(
      String(_url).includes("/agents")
        ? { items: [a], total: 1 }
        : { items: [], total: 0 },
    );
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

test("canvas nodes use absolute positions and retain unchanged node identities", async () => {
  const { workspaceNodes } = await import("../src/canvas-layout");
  const member = { ...a, x: 124, y: 172 };
  const nodes = workspaceNodes([member], []);
  assert.equal(nodes[0]!.parentId, undefined);
  assert.deepEqual(nodes[0]!.position, { x: 124, y: 172 });
  assert.equal(workspaceNodes([{ ...member, state: "running" }], nodes), nodes);
  const moved = workspaceNodes([{ ...member, x: 224 }], nodes);
  assert.notEqual(moved[0], nodes[0]);
  assert.deepEqual(moved[0]!.position, { x: 224, y: 172 });
});

test("failed position writes preserve requested coordinates through refresh and retry", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let fail = true,
    agent = a;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "PATCH") {
      if (fail) return Response.json({ error: "Try again" }, { status: 500 });
      agent = { ...agent, ...JSON.parse(String(init.body)) };
      return Response.json(agent);
    }
    return Response.json(
      String(url).includes("/agents")
        ? { items: [agent], total: 1 }
        : { items: [], total: 0 },
    );
  };
  const s = createAgentStore();
  await s.getState().loadWorkspace(a.workspaceId);
  await s.getState().moveAgent(a.id, 24, 72);
  await s.getState().loadWorkspace(a.workspaceId);
  assert.equal(s.getState().agents[a.id]!.x, 24);
  assert.equal(s.getState().positionError, "Try again");
  fail = false;
  await s.getState().retryPositions();
  assert.equal(agent.y, 72);
  assert.equal(s.getState().positionError, "");
});

test("workspace and agent mutations win over an older in-flight workspace refresh", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let agent = a,
    resolveOld!: (value: Response) => void,
    hold = false;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "PATCH") {
      agent = { ...agent, ...JSON.parse(String(init.body)) };
      return Response.json(agent);
    }
    if (String(url).includes("/agents")) {
      if (hold) {
        hold = false;
        return new Promise<Response>((r) => {
          resolveOld = r;
        });
      }
      return Response.json({ items: [agent], total: 1 });
    }
    return Response.json({ items: [], total: 0 });
  };
  const s = createAgentStore();
  await s.getState().loadWorkspace(a.workspaceId);
  hold = true;
  const old = s.getState().loadWorkspace(a.workspaceId);
  // The deletion snapshot is fetched before the agent page.
  for (let i = 0; i < 20 && !resolveOld; i++)
    await new Promise((r) => setImmediate(r));
  await s.getState().update(a.id, { name: "New name" });
  resolveOld(Response.json({ items: [a], total: 1 }));
  await old;
  assert.equal(s.getState().agents[a.id]!.name, "New name");
});

test("background layout snapshots defer to active canvas interactions, and older completion cannot unlock a newer drag", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let agent = a;
  globalThis.fetch = async (url) =>
    Response.json(
      String(url).includes("/agents")
        ? { items: [agent], total: 1 }
        : { items: [], total: 0 },
    );
  const store = createAgentStore();
  await store.getState().loadWorkspace(a.workspaceId);
  const originalNodes = store.getState().nodes[a.workspaceId];
  const old = store.getState().beginCanvasInteraction();
  agent = { ...a, x: 200 };
  await store.getState().loadWorkspace(a.workspaceId);
  assert.equal(store.getState().nodes[a.workspaceId], originalNodes);
  const latest = store.getState().beginCanvasInteraction();
  store.getState().endCanvasInteraction(old);
  await store.getState().loadWorkspace(a.workspaceId);
  assert.equal(store.getState().nodes[a.workspaceId], originalNodes);
  store.getState().endCanvasInteraction(latest);
  await store.getState().loadWorkspace(a.workspaceId);
  assert.equal(store.getState().agents[a.id]!.x, 200);
});

test("tool refresh invalidation during an in-flight read reloads latest data without changing canvas or drafts", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const store = createAgentStore();
  const nodes = [];
  store.setState({ nodes: { workspace: nodes }, drafts: { task: "unsaved" } });
  let reads = 0,
    release!: (value: Response) => void;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/activity")) {
      if (reads++ === 0)
        return new Promise<Response>((r) => {
          release = r;
        });
      return Response.json({
        items: [{ id: "new", sequence: 2, content: "latest" }],
        total: 1,
      });
    }
    return Response.json({ items: [], total: 0 });
  };
  const first = store.getState().loadToolData("task");
  const again = store.getState().loadToolData("task");
  release(Response.json({ items: [], total: 0 }));
  await Promise.all([first, again]);
  assert.equal(reads, 2);
  assert.equal(store.getState().toolData.task!.activity[0]!.id, "new");
  assert.equal(store.getState().nodes.workspace, nodes);
  assert.equal(store.getState().drafts.task, "unsaved");
});
test("tool snapshots remain task-scoped across selection changes and failed refreshes preserve prior data", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let failing = false;
  globalThis.fetch = async (url) => {
    if (failing) throw new Error("offline");
    const task = String(url).includes("/one/") ? "one" : "two";
    return Response.json({
      items: String(url).includes("/processes")
        ? [{ id: task, state: "running" }]
        : [],
      total: 1,
    });
  };
  const store = createAgentStore();
  await store.getState().loadToolData("one");
  const before = store.getState().toolData.one;
  await store.getState().loadToolData("two");
  assert.equal(store.getState().toolData.one, before);
  assert.equal(store.getState().toolData.two!.processes[0]!.id, "two");
  failing = true;
  await assert.rejects(() => store.getState().loadToolData("one"));
  assert.equal(store.getState().toolData.one, before);
});

test("activity refresh uses a sequence cursor instead of replaying large prior tool results", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const urls: string[] = [];
  let seq = 5;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return Response.json({
      items: String(url).includes("/activity")
        ? [
            {
              id: String(seq),
              sequence: seq++,
              kind: "tool_result",
              content: "result",
            },
          ]
        : [],
      total: seq,
    });
  };
  const store = createAgentStore();
  await store.getState().loadToolData("task");
  await store.getState().loadToolData("task");
  assert.match(urls.filter((url) => url.includes("/activity"))[1]!, /after=5/);
  assert.deepEqual(
    store.getState().toolData.task!.activity.map((x) => x.sequence),
    [5, 6],
  );
});
test("attachment drafts stay scoped and retain File identities through refreshes and failed sends",async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const one=new File(["a"],"one.txt"),two=new File(["b"],"two.txt"),store=createAgentStore();
 const first=[{id:"one",file:one,mode:"file" as const}],second=[{id:"two",file:two,mode:"file" as const}];
 store.getState().setFileDraft("new:agent",first);store.getState().setFileDraft("task-other",second);
 store.getState().setDraft("new:agent","Keep this");
 globalThis.fetch=async()=>Response.json({items:[],total:0});
 await store.getState().loadWorkspace("elsewhere");
 assert.equal(store.getState().fileDrafts["new:agent"],first);assert.equal(store.getState().fileDrafts["task-other"]![0]!.file,two);
 globalThis.fetch=async()=>Response.json({error:"Unavailable"},{status:503});
 await assert.rejects(()=>store.getState().submit("agent",null,"Keep this","request-123",true),/Unavailable/);
 assert.equal(store.getState().fileDrafts["new:agent"]![0]!.file,one);assert.equal(store.getState().drafts["new:agent"],"Keep this");
 store.getState().setFileDraft("new:agent",[]);assert.equal(store.getState().fileDrafts["task-other"],second);
});

test("name-only client creation and ordinary details updates omit instructions", async (t) => {
  const { connectedSetup } = await import("./helpers.js");
  const { app, initial } = await connectedSetup(t);
  const store = createAgentStore();
  const agent = await store.getState().create(initial.activeWorkspace!.id, { name: "Name only" });
  assert.equal(agent.instructions, "");
  assert.equal(agent.presetId, null);
  await app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, payload: { instructions: "Agentically saved role" } });
  const updated = await store.getState().update(agent.id, { name: "New name", presetId: null });
  assert.equal(updated.instructions, "Agentically saved role");
});

test("Chat submissions and transcripts stay separate from task and draft state", async t => {
  const { connectedSetup } = await import("./helpers.js");
  const { initial } = await connectedSetup(t);
  const store = createAgentStore();
  const agent = await store.getState().create(initial.activeWorkspace!.id, { name: "Assistant" });
  store.getState().setDraft(`chat:${agent.id}`, "Unsent Chat draft");
  store.getState().setDraft(`new:${agent.id}`, "Unsent task draft");
  const chatId = await store.getState().submit(agent.id, null, "Hello in Chat", "chat_submission");
  assert.equal(store.getState().chats[agent.id]!.task!.id, chatId);
  assert.equal(store.getState().chats[agent.id]!.task!.kind, "chat");
  assert.equal(store.getState().messages[`chat:${agent.id}`]![0]!.content, "Hello in Chat");
  assert.equal(store.getState().tasks[agent.id]!.length, 0);
  const taskId = await store.getState().submit(agent.id, null, "Separate work", "task_submission", true);
  assert.notEqual(chatId, taskId);
  assert.equal(store.getState().tasks[agent.id]!.length, 1);
  assert.equal(store.getState().drafts[`chat:${agent.id}`], "Unsent Chat draft");
  assert.equal(store.getState().drafts[`new:${agent.id}`], "Unsent task draft");
});

test("details refresh updates clean fields and preserves dirty instructions with the original revision", async () => {
  const { detailsValues, refreshDetails } = await import("../src/agent-details.js");
  const saved = detailsValues(a);
  const next = { ...a, name: "Renamed", instructions: "Saved by agent", revision: 2 };
  const clean = refreshDetails({ draft: saved, baseline: saved, revision: 1 }, next);
  assert.equal(clean.draft.instructions, "Saved by agent");
  assert.equal(clean.revision, 2);
  const dirty = refreshDetails({ draft: { ...saved, instructions: "My unsaved role" }, baseline: saved, revision: 1 }, next);
  assert.equal(dirty.draft.instructions, "My unsaved role");
  assert.equal(dirty.baseline.instructions, saved.instructions);
  assert.equal(dirty.draft.name, "Renamed");
  assert.equal(dirty.baseline.name, "Renamed");
  assert.equal(dirty.revision, 1);
});

test("stale workspace snapshots cannot replace a newer saved instruction revision", async t => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  let agent = { ...a, instructions: "Newest role", revision: 2 };
  globalThis.fetch = async url => Response.json(String(url).includes("/agents") ? { items: [agent], total: 1 } : { items: [], total: 0 });
  const store = createAgentStore();
  await store.getState().loadWorkspace("workspace");
  agent = { ...a, instructions: "Stale role", revision: 1 };
  await store.getState().loadWorkspace("workspace");
  assert.equal(store.getState().agents.agent!.instructions, "Newest role");
  assert.equal(store.getState().agents.agent!.revision, 2);
});
