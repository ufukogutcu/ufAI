import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import { workspaceNodes } from "./canvas-layout";
import type { WorkspaceFlowNode } from "./canvas-layout";
export type {
  AgentFlowNode,
  ClusterFlowNode,
  WorkspaceFlowNode,
} from "./canvas-layout";
import { deleteManaged } from "./managed-files";
import { request, errorMessage, RequestError } from "./api";
import type {
  Agent,
  Cluster,
  DeletionOperation,
  ManagedLocation,
  AgentTask,
  AgentMessage,
  AgentMemory,
  AgentWorkload,
  TaskDetail,
  Page,
} from "../../server/src/contracts";

interface AgentState {
  agents: Record<string, Agent>;
  clusters: Record<string, Cluster>;
  deletions: Record<string, DeletionOperation[]>;
  locations: Record<string, ManagedLocation>;
  dropTarget: string | null;
  canvasInteracting: boolean;
  canvasGeneration: number;
  beginCanvasInteraction: () => number;
  endCanvasInteraction: (generation: number) => void;
  createClusterIn: string | null;
  selectedCluster: string | null;
  createCluster: (
    workspaceId: string,
    input: { name: string; description: string; x: number; y: number },
  ) => Promise<Cluster>;
  updateCluster: (id: string, input: Partial<Cluster>) => Promise<void>;
  removeCluster: (id: string) => Promise<void>;
  moveAgent: (
    id: string,
    x: number,
    y: number,
    clusterId: string | null,
  ) => Promise<void>;
  nodes: Record<string, WorkspaceFlowNode[]>;
  tasks: Record<string, AgentTask[]>;
  taskTotals: Record<string, number>;
  details: Record<string, TaskDetail>;
  messages: Record<string, AgentMessage[]>;
  messageTotals: Record<string, number>;
  memories: Record<string, AgentMemory[]>;
  memoryTotals: Record<string, number>;
  workloads: Record<string, AgentWorkload>;
  selected: Record<string, string | null>;
  drafts: Record<string, string>;
  createIn: string | null;
  positionError: string;
  submissionIds: Record<string, { content: string; id: string }>;
  submissionId: (key: string, content: string) => string;
  eventVersion: number;
  error: string;
  connected: boolean;
  loadWorkspace: (id: string, layoutMutation?: boolean) => Promise<void>;
  refreshAgent: (id: string) => Promise<void>;
  loadMessages: (
    agentId: string,
    taskId: string | null,
    older?: boolean,
  ) => Promise<void>;
  loadTasks: (id: string, more?: boolean) => Promise<void>;
  loadMemories: (id: string, more?: boolean) => Promise<void>;
  select: (workspaceId: string, id: string | null) => void;
  create: (
    workspaceId: string,
    input: {
      name: string;
      instructions: string;
      presetId: string | null;
      x: number;
      y: number;
    },
  ) => Promise<Agent>;
  update: (id: string, input: Partial<Agent>) => Promise<Agent>;
  remove: (id: string) => Promise<void>;
  position: (
    id: string,
    x: number,
    y: number,
    clusterId?: string | null,
  ) => Promise<void>;
  retryPositions: () => Promise<void>;
  setDraft: (key: string, value: string) => void;
  submit: (
    id: string,
    taskId: string | null,
    content: string,
    requestId: string,
    newTask?: boolean,
  ) => Promise<string | null>;
}
const emptyNodes: WorkspaceFlowNode[] = [];
export const emptyList: never[] = [];
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function merge<T extends { id: string }>(before: T[], after: T[]) {
  const map = new Map(before.map((v) => [v.id, v]));
  for (const v of after)
    map.set(v.id, equal(map.get(v.id), v) ? map.get(v.id)! : v);
  return [...map.values()];
}
export function createAgentStore() {
  const loads = new Map<string, Promise<void>>(),
    positionWrites = new Map<string, Promise<void>>();
  const pendingPositions = new Map<
    string,
    { x: number; y: number; clusterId?: string | null }
  >();
  const clusterWrites = new Map<string, Promise<void>>();
  const pendingClusterLayouts = new Map<string, Partial<Cluster>>();
  const revisions = new Map<string, number>();
  return createStore<AgentState>((set, get) => {
    function put(agent: Agent) {
      const state = get(),
        existing = state.agents[agent.id];
      if (equal(existing, agent)) return;
      const agents = { ...state.agents, [agent.id]: agent };
      const old = state.nodes[agent.workspaceId] ?? emptyNodes;
      const nodes = workspaceNodes(
        Object.values(agents).filter(
          (a) => a.workspaceId === agent.workspaceId,
        ),
        Object.values(state.clusters).filter(
          (c) => c.workspaceId === agent.workspaceId,
        ),
        old,
      );
      set({
        agents,
        nodes:
          nodes === old
            ? state.nodes
            : { ...state.nodes, [agent.workspaceId]: nodes },
      });
    }
    async function single(key: string, action: () => Promise<void>) {
      const old = loads.get(key);
      if (old) return old;
      const promise = action().finally(() => loads.delete(key));
      loads.set(key, promise);
      return promise;
    }
    async function writeCluster(id: string, input: Partial<Cluster>) {
      const cluster = await request<Cluster>(`/clusters/${id}`, "PATCH", input);
      revisions.set(
        cluster.workspaceId,
        (revisions.get(cluster.workspaceId) ?? 0) + 1,
      );
      set((s) => ({ clusters: { ...s.clusters, [id]: cluster } }));
      await loads.get(`workspace:${cluster.workspaceId}`);
      await get().loadWorkspace(cluster.workspaceId, true);
    }
    return {
      agents: {},
      dropTarget: null,
      canvasInteracting: false,
      canvasGeneration: 0,
      beginCanvasInteraction() {
        const generation = get().canvasGeneration + 1;
        set({
          canvasGeneration: generation,
          canvasInteracting: true,
          dropTarget: null,
        });
        return generation;
      },
      endCanvasInteraction(generation) {
        if (get().canvasGeneration === generation)
          set({ canvasInteracting: false, dropTarget: null });
      },
      clusters: {},
      deletions: {},
      locations: {},
      createClusterIn: null,
      selectedCluster: null,
      async createCluster(workspaceId, input) {
        const cluster = await request<Cluster>(
          `/workspaces/${workspaceId}/clusters`,
          "POST",
          input,
        );
        revisions.set(workspaceId, (revisions.get(workspaceId) ?? 0) + 1);
        set((s) => ({ clusters: { ...s.clusters, [cluster.id]: cluster } }));
        await loads.get(`workspace:${workspaceId}`);
        await get().loadWorkspace(workspaceId);
        return cluster;
      },
      async updateCluster(id, input) {
        const layout =
          Object.keys(input).length > 0 &&
          Object.keys(input).every((key) =>
            ["x", "y", "width", "height"].includes(key),
          );
        if (!layout) {
          await clusterWrites.get(id)?.catch(() => {});
          return writeCluster(id, input);
        }
        pendingClusterLayouts.set(id, {
          ...pendingClusterLayouts.get(id),
          ...input,
        });
        const existing = clusterWrites.get(id);
        if (existing) return existing;
        const write = (async () => {
          while (pendingClusterLayouts.has(id)) {
            const patch = pendingClusterLayouts.get(id)!;
            pendingClusterLayouts.delete(id);
            try {
              await writeCluster(id, patch);
            } catch (e) {
              if (
                !(
                  e instanceof RequestError &&
                  e.status &&
                  e.status >= 400 &&
                  e.status < 500
                )
              )
                pendingClusterLayouts.set(id, {
                  ...patch,
                  ...pendingClusterLayouts.get(id),
                });
              set({ positionError: errorMessage(e) });
              throw e;
            }
          }
          if (!pendingPositions.size && !pendingClusterLayouts.size)
            set({ positionError: "" });
        })().finally(() => clusterWrites.delete(id));
        clusterWrites.set(id, write);
        return write;
      },
      async removeCluster(id) {
        const cluster = get().clusters[id];
        await deleteManaged(`/clusters/${id}`);
        pendingClusterLayouts.delete(id);
        if (cluster) {
          revisions.set(
            cluster.workspaceId,
            (revisions.get(cluster.workspaceId) ?? 0) + 1,
          );
          set({ selectedCluster: null });
          await loads.get(`workspace:${cluster.workspaceId}`);
          await get().loadWorkspace(cluster.workspaceId, true);
        }
      },
      async moveAgent(id, x, y, clusterId) {
        const agent = get().agents[id];
        if (!agent) return;
        try {
          await get().position(id, x, y, clusterId);
        } catch (e) {
          set({ positionError: errorMessage(e) });
          throw e;
        }
      },
      nodes: {},
      tasks: {},
      taskTotals: {},
      details: {},
      messages: {},
      messageTotals: {},
      memories: {},
      memoryTotals: {},
      workloads: {},
      selected: {},
      drafts: {},
      createIn: null,
      positionError: "",
      submissionIds: {},
      eventVersion: 0,
      error: "",
      connected: true,
      async loadWorkspace(id, layoutMutation = false) {
        return single(`workspace:${id}`, async () => {
          try {
            const version = revisions.get(id) ?? 0;
            async function all<T>(path: string) {
              const items: T[] = [];
              let offset = 0,
                total = 1;
              while (offset < total) {
                const page = await request<Page<T>>(
                  `${path}?limit=100&offset=${offset}`,
                );
                items.push(...page.items);
                total = page.total;
                offset += page.items.length;
                if (!page.items.length) break;
              }
              return items;
            }
            // Deletion progress remains readable even while owner mutations are fenced.
            const deletions = await all<DeletionOperation>(
              `/workspaces/${id}/deletions`,
            );
            set((s) => ({ deletions: { ...s.deletions, [id]: deletions } }));
            const [allAgents, allClusters] = await Promise.all([
              all<Agent>(`/workspaces/${id}/agents`),
              all<Cluster>(`/workspaces/${id}/clusters`),
            ]);
            if (
              (revisions.get(id) ?? 0) !== version ||
              (get().canvasInteracting && !layoutMutation)
            )
              return;
            set((state) => {
              const agents = { ...state.agents },
                clusters = { ...state.clusters };
              const ids = new Set(allAgents.map((a) => a.id)),
                cids = new Set(allClusters.map((c) => c.id));
              for (const a of Object.values(agents))
                if (a.workspaceId === id && !ids.has(a.id)) delete agents[a.id];
              for (const c of Object.values(clusters))
                if (c.workspaceId === id && !cids.has(c.id))
                  delete clusters[c.id];
              for (const a of allAgents)
                if (!pendingPositions.has(a.id) && !positionWrites.has(a.id))
                  agents[a.id] = equal(agents[a.id], a) ? agents[a.id]! : a;
              for (const c of allClusters)
                clusters[c.id] = equal(clusters[c.id], c) ? clusters[c.id]! : c;
              const old = state.nodes[id] ?? emptyNodes;
              const nodes = workspaceNodes(
                Object.values(agents).filter((a) => a.workspaceId === id),
                Object.values(clusters).filter((c) => c.workspaceId === id),
                old,
              );
              return {
                agents,
                clusters,
                nodes:
                  nodes === old ? state.nodes : { ...state.nodes, [id]: nodes },
                selected:
                  state.selected[id] && !ids.has(state.selected[id]!)
                    ? { ...state.selected, [id]: null }
                    : state.selected,
                selectedCluster:
                  state.selectedCluster && !clusters[state.selectedCluster]
                    ? null
                    : state.selectedCluster,
                error: "",
              };
            });
          } catch (e) {
            set({ error: errorMessage(e) });
          }
        });
      },
      async refreshAgent(id) {
        return single(`agent:${id}`, async () => {
          try {
            const [a, w] = await Promise.all([
              request<Agent>(`/agents/${id}`),
              request<AgentWorkload>(`/agents/${id}/status`),
            ]);
            if (!pendingPositions.has(id) && !positionWrites.has(id)) put(a);
            set((s) => ({ workloads: { ...s.workloads, [id]: w } }));
            await Promise.all([get().loadTasks(id), get().loadMemories(id)]);
          } catch (e) {
            set({ error: errorMessage(e) });
          }
        });
      },
      async loadTasks(id, more = false) {
        const offset = more ? (get().tasks[id]?.length ?? 0) : 0;
        const p = await request<Page<AgentTask>>(
          `/agents/${id}/tasks?limit=100&offset=${offset}`,
        );
        set((s) => ({
          tasks: {
            ...s.tasks,
            [id]: more ? merge(s.tasks[id] ?? [], p.items) : merge([], p.items),
          },
          taskTotals: { ...s.taskTotals, [id]: p.total },
        }));
      },
      async loadMemories(id, more = false) {
        const offset = more ? (get().memories[id]?.length ?? 0) : 0;
        const p = await request<Page<AgentMemory>>(
          `/agents/${id}/memories?limit=100&offset=${offset}`,
        );
        set((s) => ({
          memories: {
            ...s.memories,
            [id]: more
              ? merge(s.memories[id] ?? [], p.items)
              : merge([], p.items),
          },
          memoryTotals: { ...s.memoryTotals, [id]: p.total },
        }));
      },
      async loadMessages(agentId, taskId, older = false) {
        return single(`messages:${taskId ?? agentId}:${older}`, async () => {
          const key = taskId ?? `status:${agentId}`,
            prior = get().messages[key] ?? [];
          const path = taskId
            ? `/tasks/${taskId}/messages`
            : `/agents/${agentId}/status/messages`;
          const p = await request<Page<AgentMessage>>(
            `${path}${older && prior.length ? `?before=${prior[0]!.sequence}` : ""}`,
          );
          const detail = taskId
            ? await request<TaskDetail>(`/tasks/${taskId}`)
            : null;
          set((s) => ({
            messages: {
              ...s.messages,
              [key]: merge(s.messages[key] ?? [], p.items).sort(
                (a, b) => a.sequence - b.sequence,
              ),
            },
            messageTotals: { ...s.messageTotals, [key]: p.total },
            details: detail ? { ...s.details, [taskId!]: detail } : s.details,
          }));
        });
      },
      select(workspaceId, id) {
        set((s) => ({ selected: { ...s.selected, [workspaceId]: id } }));
        if (id) void get().refreshAgent(id);
      },
      async create(workspaceId, input) {
        const a = await request<Agent>(
          `/workspaces/${workspaceId}/agents`,
          "POST",
          input,
        );
        revisions.set(workspaceId, (revisions.get(workspaceId) ?? 0) + 1);
        put(a);
        set((s) => ({
          createIn: null,
          selected: { ...s.selected, [workspaceId]: a.id },
        }));
        return a;
      },
      async update(id, input) {
        const a = await request<Agent>(`/agents/${id}`, "PATCH", input);
        revisions.set(a.workspaceId, (revisions.get(a.workspaceId) ?? 0) + 1);
        put(a);
        return a;
      },
      async remove(id) {
        const a = get().agents[id];
        await deleteManaged(`/agents/${id}`);
        pendingPositions.delete(id);
        if (a) {
          revisions.set(a.workspaceId, (revisions.get(a.workspaceId) ?? 0) + 1);
          set((s) => ({
            nodes: {
              ...s.nodes,
              [a.workspaceId]: (s.nodes[a.workspaceId] ?? []).filter(
                (n) => n.id !== id,
              ),
            },
            selected: { ...s.selected, [a.workspaceId]: null },
          }));
        }
      },
      async position(id, x, y, clusterId) {
        const a = get().agents[id];
        if (!a) return;
        pendingPositions.set(id, {
          x,
          y,
          ...(clusterId === undefined ? {} : { clusterId }),
        });
        put({ ...a, x, y, ...(clusterId === undefined ? {} : { clusterId }) });
        const running = positionWrites.get(id);
        if (running) return running;
        const write = (async () => {
          while (pendingPositions.has(id)) {
            const value = pendingPositions.get(id)!;
            pendingPositions.delete(id);
            try {
              const saved = await request<Agent>(
                `/agents/${id}`,
                "PATCH",
                value,
              );
              revisions.set(
                a.workspaceId,
                (revisions.get(a.workspaceId) ?? 0) + 1,
              );
              if (!pendingPositions.has(id)) put(saved);
              if (!pendingPositions.size && !pendingClusterLayouts.size)
                set({ positionError: "" });
            } catch (e) {
              if (!pendingPositions.has(id)) pendingPositions.set(id, value);
              set({ positionError: errorMessage(e) });
              break;
            }
          }
        })().finally(() => positionWrites.delete(id));
        positionWrites.set(id, write);
        return write;
      },
      async retryPositions() {
        for (const [id, patch] of [...pendingClusterLayouts]) {
          try {
            await get().updateCluster(id, patch);
          } catch {
            /* Keep the retryable layout and visible error. */
          }
        }
        for (const [id, p] of [...pendingPositions])
          await get().position(id, p.x, p.y, p.clusterId);
      },
      submissionId(key, content) {
        const prior = get().submissionIds[key];
        if (prior?.content === content) return prior.id;
        const id = crypto.randomUUID();
        set((s) => ({
          submissionIds: { ...s.submissionIds, [key]: { content, id } },
        }));
        return id;
      },
      setDraft(key, value) {
        set((s) => ({ drafts: { ...s.drafts, [key]: value } }));
      },
      async submit(id, taskId, value, requestId, newTask = false) {
        const path = newTask
          ? `/agents/${id}/tasks`
          : taskId
            ? `/tasks/${taskId}/messages`
            : `/agents/${id}/status/messages`;
        const accepted = await request<{
          taskId: string | null;
          turnId: string;
        }>(path, "POST", { content: value, requestId });
        await get().refreshAgent(id);
        await get()
          .loadMessages(id, accepted.taskId)
          .catch((e) => set({ error: errorMessage(e) }));
        return accepted.taskId;
      },
    };
  });
}
export type AgentStore = ReturnType<typeof createAgentStore>;
export const AgentContext = createContext<AgentStore | null>(null);
export function useAgentStore() {
  const store = useContext(AgentContext);
  if (!store) throw new Error("Agent provider is missing.");
  return store;
}
export function useAgents<T>(selector: (s: AgentState) => T) {
  return useStore(useAgentStore(), selector);
}
export { emptyNodes };
