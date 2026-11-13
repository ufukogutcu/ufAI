import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentStore } from "../src/agent-store";
import type { Agent } from "../../server/src/contracts";
import { agentActivity } from "../src/agent-appearance";
import { AGENT_WIDTH, AGENT_HEIGHT, dropCluster } from "../src/canvas-layout";
const a: Agent = {
  appearance: { kind: "pebble", color: "sage", accessories: [] },
  id: "agent",
  workspaceId: "workspace",
  name: "Researcher",
  instructions: "Help",
  presetId: null,
  clusterId: null,
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
  agent = { ...a, state: "running", queuedCount: 2 };
  await s.getState().loadWorkspace("workspace");
  assert.equal(s.getState().nodes.workspace, nodes);
  assert.notEqual(s.getState().agents.agent, record);
  const running = s.getState().agents.agent;
  agent = { ...agent, appearance: { kind: "droplet", color: "coral", accessories: ["glasses"] } };
  await s.getState().loadWorkspace("workspace");
  assert.equal(s.getState().nodes.workspace, nodes);
  assert.notEqual(s.getState().agents.agent, running);
  assert.deepEqual(s.getState().agents.agent!.appearance, agent.appearance);
});

test("only running agents work and Cluster membership uses the character node center", () => {
  assert.equal(agentActivity("running"), "working");
  for (const state of ["idle", "queued", "waiting", "awaiting_user", "completed", "blocked", "failed", "cancelled"] as const)
    assert.equal(agentActivity(state), "idle");
  assert.equal(AGENT_WIDTH, 208); assert.equal(AGENT_HEIGHT, 192);
  const cluster = { id: "cluster", workspaceId: "workspace", name: "Group", description: "", x: 0, y: 0, width: 320, height: 200, colorSlot: 0, createdAt: "now", updatedAt: "now" };
  assert.equal(dropCluster([cluster], -104, -48), "cluster");
  assert.equal(dropCluster([cluster], -104, -49), null);
  assert.equal(dropCluster([cluster], 217, 0), null);
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

test("Cluster layout preserves absolute persistence, relative rendering, deterministic drop targets, and unchanged node identities", async () => {
  const { workspaceNodes, dropCluster } = await import("../src/canvas-layout");
  const cluster = {
    id: "department",
    workspaceId: a.workspaceId,
    name: "Research",
    description: "",
    x: 100,
    y: 100,
    width: 600,
    height: 360,
    colorSlot: 0,
    createdAt: "now",
    updatedAt: "now",
  };
  const member = { ...a, clusterId: cluster.id, x: 124, y: 172 };
  const nodes = workspaceNodes([member], [cluster], []);
  assert.equal(nodes[0]!.type, "cluster");
  assert.equal(nodes[1]!.parentId, cluster.id);
  assert.deepEqual(nodes[1]!.position, { x: 24, y: 72 });
  assert.equal(
    workspaceNodes([{ ...member, state: "running" }], [cluster], nodes),
    nodes,
  );
  assert.equal(dropCluster([cluster], 124, 172), cluster.id);
  assert.equal(dropCluster([cluster], 900, 172), null);
  assert.equal(dropCluster([cluster], 124, -10), null);
  const small = { ...cluster, id: "small", width: 320, height: 200 };
  assert.equal(dropCluster([cluster, small], 124, 172), "small");
  assert.equal(
    dropCluster(
      [
        { ...small, id: "z" },
        { ...small, id: "b" },
      ],
      124,
      172,
    ),
    "b",
  );
  const moved = workspaceNodes(
    [{ ...member, x: 224, y: 272 }],
    [{ ...cluster, x: 200, y: 200 }],
    nodes,
  );
  assert.equal(moved[1], nodes[1]);
  assert.notEqual(moved[0], nodes[0]);
  const ungrouped = workspaceNodes([{ ...member, clusterId: null }], [], nodes);
  assert.equal(ungrouped[0]!.parentId, undefined);
  assert.deepEqual(ungrouped[0]!.position, { x: 124, y: 172 });
});

test("failed membership writes preserve the requested position and membership through refresh and retry", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const cluster = {
    id: "cluster",
    workspaceId: a.workspaceId,
    name: "Team",
    description: "",
    x: 0,
    y: 0,
    width: 600,
    height: 360,
    colorSlot: 0,
    createdAt: "now",
    updatedAt: "now",
  };
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
        : String(url).includes("/clusters")
          ? { items: [cluster], total: 1 }
          : { items: [], total: 0 },
    );
  };
  const s = createAgentStore();
  await s.getState().loadWorkspace(a.workspaceId);
  await s.getState().moveAgent(a.id, 24, 72, cluster.id);
  await s.getState().loadWorkspace(a.workspaceId);
  assert.equal(s.getState().agents[a.id]!.clusterId, cluster.id);
  assert.equal(s.getState().agents[a.id]!.x, 24);
  assert.equal(s.getState().positionError, "Try again");
  fail = false;
  await s.getState().retryPositions();
  assert.equal(agent.clusterId, cluster.id);
  assert.equal(agent.y, 72);
  assert.equal(s.getState().positionError, "");
});

test("workspace and membership mutations win over an older in-flight workspace refresh", async (t) => {
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

test("failed Cluster layout writes can be retried and group movements coalesce without stale responses winning", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let cluster = {
    id: "cluster",
    workspaceId: a.workspaceId,
    name: "Team",
    description: "",
    x: 0,
    y: 0,
    width: 600,
    height: 360,
    colorSlot: 0,
    createdAt: "now",
    updatedAt: "now",
  };
  let agent = { ...a, clusterId: cluster.id, x: 24, y: 72 },
    fail = true,
    hold = false,
    release!: () => void;
  const writes: Record<string, number>[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === "PATCH") {
      const input = JSON.parse(String(init.body));
      writes.push(input);
      if (fail)
        return Response.json({ error: "Cluster save failed" }, { status: 500 });
      if (hold) {
        hold = false;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      const next = { ...cluster, ...input };
      agent = {
        ...agent,
        x: agent.x + next.x - cluster.x,
        y: agent.y + next.y - cluster.y,
      };
      cluster = next;
      return Response.json(cluster);
    }
    return Response.json(
      String(url).includes("/agents")
        ? { items: [agent], total: 1 }
        : String(url).includes("/clusters")
          ? { items: [cluster], total: 1 }
          : { items: [], total: 0 },
    );
  };
  const store = createAgentStore();
  await store.getState().loadWorkspace(a.workspaceId);
  await assert.rejects(
    store.getState().updateCluster(cluster.id, { x: 100, y: 100 }),
    /Cluster save failed/,
  );
  assert.equal(store.getState().clusters.cluster!.x, 0);
  fail = false;
  await store.getState().retryPositions();
  assert.equal(cluster.x, 100);
  assert.equal(store.getState().agents[a.id]!.x, 124);
  assert.equal(store.getState().positionError, "");
  hold = true;
  const first = store.getState().updateCluster(cluster.id, { x: 200 });
  const second = store.getState().updateCluster(cluster.id, { x: 300 });
  const third = store.getState().updateCluster(cluster.id, { x: 400 });
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(writes, [
    { x: 100, y: 100 },
    { x: 100, y: 100 },
    { x: 200 },
    { x: 400 },
  ]);
  assert.equal(store.getState().clusters.cluster!.x, 400);
  assert.equal(store.getState().agents[a.id]!.x, 424);
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

test("name-only client creation and ordinary configuration updates omit instructions", async (t) => {
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
