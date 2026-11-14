import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Agent, Cluster } from "../../server/src/contracts";
import { createAgentStore } from "../src/agent-store";

const agent: Agent = {
  id: "agent", workspaceId: "workspace", name: "Assistant", instructions: "",
  presetId: null, clusterId: null, x: 10, y: 20, revision: 1,
  createdAt: "now", updatedAt: "now", state: "idle", queuedCount: 0, runningTaskCount: 0,
  appearance: { kind: "pebble", color: "sage", accessories: [] },
  issueCounts: { warning: 1, error: 0 },
};
const running: Agent = { ...agent, state: "running", runningTaskCount: 1, issueCounts: { warning: 0, error: 2 } };
const cluster: Cluster = {
  id: "cluster", workspaceId: "workspace", name: "Team", description: "",
  x: 0, y: 0, width: 600, height: 360, colorSlot: 0, createdAt: "now", updatedAt: "now",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function snapshots(t: TestContext) {
  let current = agent;
  let intercept: (url: string, init?: RequestInit) => Promise<Response> | undefined = () => undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const response = intercept(String(url), init);
    if (response) return response;
    const path = String(url).split("?")[0];
    if (path === "/api/agents/agent") return Response.json(current);
    if (path === "/api/agents/agent/status") return Response.json({ agentId: agent.id });
    if (path === "/api/agents/agent/chat") return Response.json({ task: null, turns: [] });
    return Response.json({
      items: path === "/api/workspaces/workspace/agents" ? [current]
        : path === "/api/workspaces/workspace/clusters" ? [cluster] : [],
      total: path?.endsWith("/agents") || path?.endsWith("/clusters") ? 1 : 0,
    });
  });
  return {
    set(value: Agent) { current = value; },
    intercept(fn: typeof intercept) { intercept = fn; },
  };
}

for (const resource of ["workspace", "agent"] as const) {
  test(`${resource} invalidations coalesce into serial follow-up reads, including invalidations during that follow-up`, async t => {
    const source = snapshots(t), store = createAgentStore();
    await store.getState().loadWorkspace(agent.workspaceId);
    const gates = [deferred<Response>(), deferred<Response>()];
    const started = [deferred<void>(), deferred<void>()];
    let reads = 0;
    source.intercept(url => {
      if (resource === "workspace" ? url.includes("/workspace/agents?") : url === "/api/agents/agent") {
        const index = reads++;
        if (index < 2) {
          started[index]!.resolve();
          return gates[index]!.promise;
        }
      }
    });
    const refresh = () => resource === "workspace"
      ? store.getState().loadWorkspace(agent.workspaceId)
      : store.getState().refreshAgent(agent.id);
    const first = refresh();
    await started[0]!.promise;
    const overlaps = [refresh(), refresh(), refresh()];
    assert.equal(reads, 1);
    source.set(running);
    const response = (value: Agent) => Response.json(resource === "workspace" ? { items: [value], total: 1 } : value);
    gates[0]!.resolve(response(agent));
    await started[1]!.promise;
    overlaps.push(refresh(), refresh());
    assert.equal(reads, 2);
    gates[1]!.resolve(response(running));
    await Promise.all([first, ...overlaps]);
    assert.equal(reads, 3);
    assert.equal(store.getState().agents.agent!.state, "running");
    assert.deepEqual(store.getState().agents.agent!.issueCounts, running.issueCounts);
  });
}

for (const older of ["workspace", "agent"] as const) {
  test(`an older ${older} snapshot cannot rewind newer activity at the same saved revision`, async t => {
    const source = snapshots(t), store = createAgentStore();
    await store.getState().loadWorkspace(agent.workspaceId);
    const gate = deferred<Response>(), started = deferred<void>();
    source.intercept(url => {
      if (older === "workspace" ? url.includes("/workspace/agents?") : url === "/api/agents/agent") {
        started.resolve();
        return gate.promise;
      }
    });
    const first = older === "workspace" ? store.getState().loadWorkspace(agent.workspaceId) : store.getState().refreshAgent(agent.id);
    await started.promise;
    source.set(running);
    await (older === "workspace" ? store.getState().refreshAgent(agent.id) : store.getState().loadWorkspace(agent.workspaceId));
    const record = store.getState().agents.agent, nodes = store.getState().nodes.workspace;
    gate.resolve(Response.json(older === "workspace" ? { items: [agent], total: 1 } : agent));
    await first;
    assert.equal(store.getState().agents.agent, record);
    assert.equal(store.getState().nodes.workspace, nodes);
  });
}

test("canvas interactions accept activity changes while protecting geometry, membership, node identity and drafts", async t => {
  const source = snapshots(t), store = createAgentStore();
  await store.getState().loadWorkspace(agent.workspaceId);
  const nodes = store.getState().nodes.workspace;
  store.getState().setDraft("chat:agent", "Unsent");
  const generation = store.getState().beginCanvasInteraction();
  source.set({ ...running, x: 300, y: 400, clusterId: cluster.id });
  await store.getState().loadWorkspace(agent.workspaceId);
  assert.equal(store.getState().agents.agent!.state, "running");
  assert.deepEqual(store.getState().agents.agent!.issueCounts, running.issueCounts);
  source.set({ ...running, state: "waiting", runningTaskCount: 0, x: 300, clusterId: cluster.id });
  await store.getState().refreshAgent(agent.id);
  assert.equal(store.getState().agents.agent!.state, "waiting");
  assert.equal(store.getState().agents.agent!.x, agent.x);
  assert.equal(store.getState().agents.agent!.clusterId, null);
  assert.equal(store.getState().nodes.workspace, nodes);
  assert.equal(store.getState().drafts["chat:agent"], "Unsent");
  store.getState().endCanvasInteraction(generation);
  await store.getState().loadWorkspace(agent.workspaceId);
  assert.equal(store.getState().agents.agent!.x, 300);
});

test("pending position saves accept activity and their older responses cannot rewind it", async t => {
  const source = snapshots(t), store = createAgentStore();
  await store.getState().loadWorkspace(agent.workspaceId);
  const gate = deferred<Response>();
  source.intercept((_url, init) => init?.method === "PATCH" ? gate.promise : undefined);
  const save = store.getState().position(agent.id, 100, 120, cluster.id);
  const nodes = store.getState().nodes.workspace;
  source.set(running);
  await store.getState().refreshAgent(agent.id);
  await store.getState().loadWorkspace(agent.workspaceId);
  assert.equal(store.getState().agents.agent!.state, "running");
  assert.equal(store.getState().agents.agent!.x, 100);
  assert.equal(store.getState().agents.agent!.clusterId, cluster.id);
  assert.equal(store.getState().nodes.workspace, nodes);
  gate.resolve(Response.json({ ...agent, x: 100, y: 120, clusterId: cluster.id, revision: 2 }));
  await save;
  assert.equal(store.getState().agents.agent!.state, "running");
  assert.equal(store.getState().agents.agent!.revision, 2);
  assert.equal(store.getState().nodes.workspace, nodes);
});

test("failed position saves retain local layout through activity refreshes and retry", async t => {
  const source = snapshots(t), store = createAgentStore();
  await store.getState().loadWorkspace(agent.workspaceId);
  source.intercept((_url, init) => init?.method === "PATCH"
    ? Promise.resolve(Response.json({ error: "Offline" }, { status: 503 })) : undefined);
  await store.getState().position(agent.id, 100, 120, cluster.id);
  const nodes = store.getState().nodes.workspace;
  source.set({ ...running, state: "waiting", runningTaskCount: 0 });
  await store.getState().loadWorkspace(agent.workspaceId);
  await store.getState().refreshAgent(agent.id);
  assert.equal(store.getState().agents.agent!.state, "waiting");
  assert.equal(store.getState().agents.agent!.x, 100);
  assert.equal(store.getState().agents.agent!.clusterId, cluster.id);
  assert.equal(store.getState().nodes.workspace, nodes);
  source.intercept((_url, init) => init?.method === "PATCH"
    ? Promise.resolve(Response.json({ ...running, state: "completed", runningTaskCount: 0, x: 100, y: 120, clusterId: cluster.id, revision: 2 })) : undefined);
  await store.getState().retryPositions();
  assert.equal(store.getState().agents.agent!.state, "completed");
  assert.equal(store.getState().positionError, "");
  assert.equal(store.getState().nodes.workspace, nodes);
});

test("an older configuration response keeps newer activity while applying its saved revision", async t => {
  const source = snapshots(t), store = createAgentStore();
  await store.getState().loadWorkspace(agent.workspaceId);
  const gate = deferred<Response>();
  source.intercept((_url, init) => init?.method === "PATCH" ? gate.promise : undefined);
  const save = store.getState().update(agent.id, { name: "Renamed" });
  source.set(running);
  await store.getState().loadWorkspace(agent.workspaceId);
  gate.resolve(Response.json({ ...agent, name: "Renamed", revision: 2 }));
  await save;
  assert.equal(store.getState().agents.agent!.name, "Renamed");
  assert.equal(store.getState().agents.agent!.state, "running");
});
