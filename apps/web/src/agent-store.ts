import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import type { Node } from "@xyflow/react";
import { request, errorMessage } from "./api";
import type {
  Agent,
  AgentTask,
  AgentMessage,
  AgentMemory,
  AgentWorkload,
  TaskDetail,
  Page,
} from "../../server/src/contracts";

export type AgentNodeData = { agentId: string };
export type AgentFlowNode = Node<AgentNodeData, "agent">;
interface AgentState {
  agents: Record<string, Agent>;
  nodes: Record<string, AgentFlowNode[]>;
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
  loadWorkspace: (id: string) => Promise<void>;
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
  position: (id: string, x: number, y: number) => Promise<void>;
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
const emptyNodes: AgentFlowNode[] = [];
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
  const pendingPositions = new Map<string, { x: number; y: number }>();
  const revisions = new Map<string, number>();
  return createStore<AgentState>((set, get) => {
    function put(agent: Agent) {
      const state = get(),
        existing = state.agents[agent.id];
      if (equal(existing, agent)) return;
      const agents = { ...state.agents, [agent.id]: agent };
      const old = state.nodes[agent.workspaceId] ?? emptyNodes;
      const item = old.find((n) => n.id === agent.id);
      const nodes =
        item && item.position.x === agent.x && item.position.y === agent.y
          ? old
          : item
            ? old.map((n) =>
                n.id === agent.id
                  ? { ...n, position: { x: agent.x, y: agent.y } }
                  : n,
              )
            : [
                ...old,
                {
                  id: agent.id,
                  type: "agent" as const,
                  position: { x: agent.x, y: agent.y },
                  data: { agentId: agent.id },
                },
              ];
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
    return {
      agents: {},
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
      async loadWorkspace(id) {
        return single(`workspace:${id}`, async () => {
          try {
            const version = revisions.get(id) ?? 0;
            const all: Agent[] = [];
            let offset = 0,
              total = 1;
            while (offset < total) {
              const page = await request<Page<Agent>>(
                `/workspaces/${id}/agents?limit=100&offset=${offset}`,
              );
              all.push(...page.items);
              total = page.total;
              offset += page.items.length;
              if (!page.items.length) break;
            }
            if ((revisions.get(id) ?? 0) !== version) return;
            all.forEach((a) => {
              if (!pendingPositions.has(a.id) && !positionWrites.has(a.id))
                put(a);
            });
            const ids = new Set(all.map((a) => a.id)),
              state = get();
            const old = state.nodes[id] ?? emptyNodes,
              newNodes = old.filter((n) => ids.has(n.id));
            set({
              nodes:
                newNodes.length === old.length
                  ? state.nodes
                  : { ...state.nodes, [id]: newNodes },
              selected:
                state.selected[id] && !ids.has(state.selected[id]!)
                  ? { ...state.selected, [id]: null }
                  : state.selected,
              error: "",
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
        await request(`/agents/${id}`, "DELETE");
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
      async position(id, x, y) {
        const a = get().agents[id];
        if (!a) return;
        pendingPositions.set(id, { x, y });
        put({ ...a, x, y });
        const running = positionWrites.get(id);
        if (running) return running;
        const write = (async () => {
          while (pendingPositions.has(id)) {
            const value = pendingPositions.get(id)!;
            pendingPositions.delete(id);
            try {
              await request<Agent>(`/agents/${id}`, "PATCH", value);
              if (!pendingPositions.size) set({ positionError: "" });
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
        for (const [id, p] of [...pendingPositions])
          await get().position(id, p.x, p.y);
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
