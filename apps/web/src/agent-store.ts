import {
  sendTaskFiles,
  type DraftAttachment,
  type FileSubmission,
} from "./task-attachments";
import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import { workspaceNodes } from "./canvas-layout";
import type { WorkspaceFlowNode } from "./canvas-layout";
export type {
  AgentFlowNode,
  WorkspaceFlowNode,
} from "./canvas-layout";
import { deleteManaged } from "./managed-files";
import { readAgentPanelTabs, saveAgentPanelTabs, type AgentPanelTab, type AgentPanelTabs } from "./agent-panel-tabs";
import { request, errorMessage, RequestError } from "./api";
import type {
  Agent,
  AgentAppearance,
  ArtifactVersion,
  OwnedProcess,
  ExecutionItem,
  DeletionOperation,
  ManagedLocation,
  AgentTask,
  AgentChat,
  AgentMessage,
  AgentMemory,
  AgentWorkload,
  TaskDetail,
  Page,
  CommunicationLink,
  CommunicationAnchors,
  InboxEntry,
} from "../../server/src/contracts";

interface AppearanceSuggestion {
  appearance: AgentAppearance | null;
  error: string;
  loading: boolean;
}

interface AgentState {
  communication: Record<
    string,
    {
      links: CommunicationLink[];
      inbox: InboxEntry[];
      unread: number;
      total: number;
      error: string;
    }
  >;
  requestedTask: { agentId: string; taskId: string } | null;
  communicationEditor: {
    workspaceId: string;
    sourceAgentId?: string;
    linkId?: string;
  } | null;
  loadCommunication: (workspaceId: string) => Promise<void>;
  createCommunicationLink: (
    workspaceId: string,
    sourceAgentId: string,
    targetAgentId: string,
    anchors?: Partial<CommunicationAnchors>,
  ) => Promise<void>;
  anchorDrafts: Record<string, Partial<CommunicationAnchors>>;
  saveCommunicationAnchors: (workspaceId: string, linkId: string, anchors: Partial<CommunicationAnchors>) => Promise<void>;
  toolData: Record<
    string,
    {
      activity: ExecutionItem[];
      activityTotal: number;
      processTotal: number;
      artifactTotal: number;
      processes: OwnedProcess[];
      artifacts: ArtifactVersion[];
    }
  >;
  loadToolData: (taskId: string, more?: boolean) => Promise<void>;
  loadMoreToolData: (
    taskId: string,
    kind: "processes" | "artifacts",
  ) => Promise<void>;
  agents: Record<string, Agent>;
  deletions: Record<string, DeletionOperation[]>;
  locations: Record<string, ManagedLocation>;
  canvasInteracting: boolean;
  canvasGeneration: number;
  beginCanvasInteraction: () => number;
  endCanvasInteraction: (generation: number) => void;
  moveAgent: (
    id: string,
    x: number,
    y: number,
  ) => Promise<void>;
  nodes: Record<string, WorkspaceFlowNode[]>;
  tasks: Record<string, AgentTask[]>;
  chats: Record<string, AgentChat>;
  taskTotals: Record<string, number>;
  details: Record<string, TaskDetail>;
  messages: Record<string, AgentMessage[]>;
  messageTotals: Record<string, number>;
  memories: Record<string, AgentMemory[]>;
  memoryTotals: Record<string, number>;
  workloads: Record<string, AgentWorkload>;
  selected: Record<string, string | null>;
  panelTabs: AgentPanelTabs;
  setPanelTab: (agentId: string, tab: AgentPanelTab) => void;
  drafts: Record<string, string>;
  fileDrafts: Record<string, DraftAttachment[]>;
  setFileDraft: (key: string, files: DraftAttachment[]) => void;
  createIn: string | null;
  appearanceSuggestions: Record<string, AppearanceSuggestion>;
  loadAppearanceSuggestion: (workspaceId: string, retry?: boolean) => Promise<AgentAppearance>;
  positionError: string;
  submissionIds: Record<string, { content: string; id: string }>;
  submissionId: (key: string, content: string) => string;
  eventVersion: number;
  timelineVersion: number;
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
      appearance?: AgentAppearance;
      presetId?: string | null;
      x?: number;
      y?: number;
    },
  ) => Promise<Agent>;
  update: (id: string, input: Partial<Agent> & { expectedRevision?: number }) => Promise<Agent>;
  remove: (id: string) => Promise<void>;
  position: (
    id: string,
    x: number,
    y: number,
  ) => Promise<void>;
  retryPositions: () => Promise<void>;
  setDraft: (key: string, value: string) => void;
  submit: (
    id: string,
    taskId: string | null,
    content: string,
    requestId: string,
    newTask?: boolean,
    files?: FileSubmission,
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
  const appearanceRequests = new Map<string, { promise: Promise<AgentAppearance>; controller: AbortController }>();
  const toolRefresh = new Set<string>();
  const communicationRefresh = new Set<string>();
  const anchorWrites = new Map<string, Promise<void>>();
  const pendingAnchors = new Map<string, { workspaceId: string; anchors: Partial<CommunicationAnchors> }>();
  let anchorRevision = 0;
  const anchorRevisions = new Map<string, number>();
  const pendingRefresh = new Set<string>();
  // Execution changes do not increment the saved agent revision. Order runtime
  // snapshots independently so a slower read or position save cannot rewind them.
  let snapshotSequence = 0;
  const activitySequences = new Map<string, number>();
  const loads = new Map<string, Promise<void>>(),
    positionWrites = new Map<string, Promise<void>>();
  const pendingPositions = new Map<
    string,
    { x: number; y: number }
  >();
  const revisions = new Map<string, number>();
  return createStore<AgentState>((set, get) => {
    function forgetPanelTabs(ids: string[]) {
      if (!ids.some(id => Object.hasOwn(get().panelTabs, id))) return;
      const panelTabs = { ...get().panelTabs };
      for (const id of ids) delete panelTabs[id];
      set({ panelTabs });
      saveAgentPanelTabs(panelTabs);
    }
    function forgetAppearanceSuggestion(workspaceId: string) {
      const pending = appearanceRequests.get(workspaceId);
      appearanceRequests.delete(workspaceId);
      pending?.controller.abort();
      set(s => {
        const { [workspaceId]: removed, ...appearanceSuggestions } = s.appearanceSuggestions;
        return { appearanceSuggestions };
      });
    }
    function reconcileAgent(
      existing: Agent | undefined,
      agent: Agent,
      sequence?: number,
      preserveLayout = false,
      preserveSaved = false,
    ) {
      let next = existing && (preserveSaved || existing.revision > agent.revision)
        ? {
            ...existing,
            state: agent.state,
            queuedCount: agent.queuedCount,
            runningTaskCount: agent.runningTaskCount,
            issueCounts: agent.issueCounts,
          }
        : agent;
      if (sequence !== undefined) {
        if (existing && sequence < (activitySequences.get(agent.id) ?? 0)) {
          next = {
            ...next,
            state: existing.state,
            queuedCount: existing.queuedCount,
            runningTaskCount: existing.runningTaskCount,
            issueCounts: existing.issueCounts,
          };
        } else {
          activitySequences.set(agent.id, sequence);
        }
      }
      if (existing && preserveLayout)
        next = {
          ...next,
          x: existing.x,
          y: existing.y,
        };
      return equal(existing, next) ? existing! : next;
    }
    function layoutPending(id: string) {
      return pendingPositions.has(id) || positionWrites.has(id);
    }
    function put(agent: Agent, sequence?: number, preserveLayout = false) {
      const state = get(),
        existing = state.agents[agent.id];
      const next = reconcileAgent(existing, agent, sequence, preserveLayout);
      if (next === existing) return;
      const agents = { ...state.agents, [agent.id]: next };
      const old = state.nodes[agent.workspaceId] ?? emptyNodes;
      const nodes = workspaceNodes(
        Object.values(agents).filter(
          (a) => a.workspaceId === agent.workspaceId,
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
    async function refresh(key: string, action: () => Promise<void>) {
      const running = loads.get(key);
      if (running) {
        pendingRefresh.add(key);
        return running;
      }
      return single(key, async () => {
        do {
          pendingRefresh.delete(key);
          await action();
        } while (pendingRefresh.has(key));
      });
    }
    return {
      agents: {},
      chats: {},
      fileDrafts: {},
      setFileDraft(key, files) {
        set((s) => {
          const drafts = { ...s.fileDrafts };
          if (files.length) drafts[key] = files;
          else delete drafts[key];
          return { fileDrafts: drafts };
        });
      },
      canvasInteracting: false,
      canvasGeneration: 0,
      beginCanvasInteraction() {
        const generation = get().canvasGeneration + 1;
        set({
          canvasGeneration: generation,
          canvasInteracting: true,
        });
        return generation;
      },
      endCanvasInteraction(generation) {
        if (get().canvasGeneration === generation)
          set({ canvasInteracting: false });
      },
      deletions: {},
      locations: {},
      async moveAgent(id, x, y) {
        const agent = get().agents[id];
        if (!agent) return;
        try {
          await get().position(id, x, y);
        } catch (e) {
          set({ positionError: errorMessage(e) });
          throw e;
        }
      },
      toolData: {},
      async loadMoreToolData(taskId, kind) {
        const offset = get().toolData[taskId]?.[kind].length ?? 0;
        if (kind === "processes") {
          const page = await request<Page<OwnedProcess>>(
            `/tasks/${taskId}/processes?limit=100&offset=${offset}`,
          );
          set((s) => {
            const old = s.toolData[taskId];
            return old
              ? {
                  toolData: {
                    ...s.toolData,
                    [taskId]: {
                      ...old,
                      processes: merge(old.processes, page.items),
                      processTotal: page.total,
                    },
                  },
                }
              : {};
          });
        } else {
          const page = await request<Page<ArtifactVersion>>(
            `/tasks/${taskId}/artifacts?limit=100&offset=${offset}`,
          );
          set((s) => {
            const old = s.toolData[taskId];
            return old
              ? {
                  toolData: {
                    ...s.toolData,
                    [taskId]: {
                      ...old,
                      artifacts: merge(old.artifacts, page.items),
                      artifactTotal: page.total,
                    },
                  },
                }
              : {};
          });
        }
      },
      async loadToolData(taskId, more = false) {
        const key = `tools:${taskId}`,
          running = loads.get(key);
        if (running) {
          toolRefresh.add(taskId);
          return running;
        }
        return single(key, async () => {
          do {
            toolRefresh.delete(taskId);
            const previous = get().toolData[taskId];
            const after = !more
              ? previous?.activity.at(-1)?.sequence
              : undefined;
            const [activity, processes, artifacts] = await Promise.all([
              request<Page<ExecutionItem>>(
                `/tasks/${taskId}/activity?limit=100&offset=${more ? (previous?.activity.length ?? 0) : 0}${after ? `&after=${after}` : ""}`,
              ),
              request<Page<OwnedProcess>>(
                `/tasks/${taskId}/processes?limit=100`,
              ),
              request<Page<ArtifactVersion>>(
                `/tasks/${taskId}/artifacts?limit=100`,
              ),
            ]);
            set((s) => ({
              toolData: {
                ...s.toolData,
                [taskId]: {
                  activity: merge(
                    s.toolData[taskId]?.activity ?? [],
                    activity.items,
                  ).sort((a, b) => a.sequence - b.sequence),
                  activityTotal: activity.total,
                  processTotal: processes.total,
                  artifactTotal: artifacts.total,
                  processes: merge(
                    s.toolData[taskId]?.processes ?? [],
                    processes.items,
                  ),
                  artifacts: merge(
                    s.toolData[taskId]?.artifacts ?? [],
                    artifacts.items,
                  ),
                },
              },
            }));
            if (after && activity.items.length === 100) toolRefresh.add(taskId);
            more = false;
          } while (toolRefresh.has(taskId));
        });
      },
      communication: {},
      anchorDrafts: {},
      async saveCommunicationAnchors(workspaceId, id, anchors) {
        anchorRevisions.set(id, ++anchorRevision);
        pendingAnchors.set(id, { workspaceId, anchors: { ...pendingAnchors.get(id)?.anchors, ...anchors } });
        set(s => ({ anchorDrafts: { ...s.anchorDrafts, [id]: { ...s.anchorDrafts[id], ...anchors } } }));
        const running = anchorWrites.get(id);
        if (running) return running;
        const write = (async () => {
          while (pendingAnchors.has(id)) {
            const patch = pendingAnchors.get(id)!;
            pendingAnchors.delete(id);
            try {
              const saved = await request<CommunicationLink>(`/communication-links/${id}/anchors`, "PATCH", patch.anchors);
              anchorRevisions.set(id, ++anchorRevision);
              set(s => {
                const workspace = s.communication[workspaceId];
                const drafts = { ...s.anchorDrafts };
                const next = pendingAnchors.get(id);
                if (next) drafts[id] = next.anchors;
                else delete drafts[id];
                return {
                  anchorDrafts: drafts,
                  ...(workspace ? { communication: { ...s.communication, [workspaceId]: {
                    ...workspace, links: workspace.links.map(link => link.id === id ? {
                      ...link, sourceAnchorAngle: saved.sourceAnchorAngle, targetAnchorAngle: saved.targetAnchorAngle,
                    } : link),
                  } } } : {}),
                };
              });
            } catch (e) {
              const permanent = e instanceof RequestError && e.status !== undefined && e.status >= 400 && e.status < 500;
              const active = get().communication[workspaceId]?.links.some(link => link.id === id && link.state === "active");
              if (!permanent && active) pendingAnchors.set(id, {
                workspaceId, anchors: { ...patch.anchors, ...pendingAnchors.get(id)?.anchors },
              });
              else {
                pendingAnchors.delete(id);
                set(s => { const drafts = { ...s.anchorDrafts }; delete drafts[id]; return { anchorDrafts: drafts }; });
              }
              set({ positionError: errorMessage(e) });
              throw e;
            }
          }
          if (!pendingPositions.size && !pendingAnchors.size)
            set({ positionError: "" });
        })().finally(() => {
          anchorWrites.delete(id);
          if (!get().communication[workspaceId]?.links.some(link => link.id === id)) anchorRevisions.delete(id);
        });
        anchorWrites.set(id, write);
        return write;
      },
      requestedTask: null,
      communicationEditor: null,
      async loadCommunication(id) {
        const key = `communication:${id}`;
        const running = loads.get(key);
        if (running) {
          communicationRefresh.add(id);
          return running;
        }
        return single(key, async () => {
          do {
            communicationRefresh.delete(id);
            const readRevision = anchorRevision;
            try {
              const links: CommunicationLink[] = [];
              let offset = 0,
                total = 1;
              while (offset < total) {
                const p = await request<Page<CommunicationLink>>(
                  `/workspaces/${id}/communication-links?limit=100&offset=${offset}`,
                );
                links.push(...p.items);
                total = p.total;
                offset += p.items.length;
                if (!p.items.length) break;
              }
              const inbox = await request<
                Page<InboxEntry> & { unread: number }
              >(`/workspaces/${id}/inbox?limit=50`);
              set((s) => {
                const old = s.communication[id];
                const linkIds = new Set(links.map(link => link.id));
                for (const link of old?.links ?? [])
                  if (!linkIds.has(link.id) && !anchorWrites.has(link.id)) anchorRevisions.delete(link.id);
                // A read started before a completed anchor save cannot rewind it.
                for (let i = 0; i < links.length; i++) {
                  const link = links[i]!;
                  if ((anchorRevisions.get(link.id) ?? 0) <= readRevision) continue;
                  const current = old?.links.find(item => item.id === link.id);
                  if (current) links[i] = { ...link, sourceAnchorAngle: current.sourceAnchorAngle, targetAnchorAngle: current.targetAnchorAngle };
                }
                for (const [linkId, patch] of pendingAnchors) {
                  if (patch.workspaceId === id && !links.some(link => link.id === linkId && link.state === "active")) {
                    pendingAnchors.delete(linkId);
                  }
                }
                const anchorDrafts = Object.fromEntries(Object.entries(s.anchorDrafts).filter(([linkId]) =>
                  !old?.links.some(link => link.id === linkId) || links.some(link => link.id === linkId && link.state === "active")));
                if (
                  old &&
                  !old.error &&
                  old.unread === inbox.unread &&
                  old.total === inbox.total &&
                  equal(old.links, links) &&
                  equal(old.inbox, inbox.items)
                )
                  return s;
                return {
                  communication: {
                    ...s.communication,
                    [id]: {
                      links: equal(old?.links, links) ? old!.links : links,
                      inbox: equal(old?.inbox, inbox.items)
                        ? old!.inbox
                        : inbox.items,
                      unread: inbox.unread,
                      total: inbox.total,
                      error: "",
                    },
                  },
                  ...(equal(s.anchorDrafts, anchorDrafts) ? {} : { anchorDrafts }),
                };
              });
            } catch (e) {
              set((s) => ({
                communication: {
                  ...s.communication,
                  [id]: {
                    links: [],
                    inbox: [],
                    unread: 0,
                    total: 0,
                    ...s.communication[id],
                    error: errorMessage(e),
                  },
                },
              }));
            }
          } while (communicationRefresh.has(id));
        });
      },
      async createCommunicationLink(workspaceId, sourceAgentId, targetAgentId, anchors) {
        await request(
          `/workspaces/${workspaceId}/communication-links`,
          "POST",
          { sourceAgentId, targetAgentId, ...anchors },
        );
        await get().loadCommunication(workspaceId);
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
      panelTabs: readAgentPanelTabs(),
      setPanelTab(agentId, tab) {
        if (get().panelTabs[agentId] === tab) return;
        const panelTabs = { ...get().panelTabs, [agentId]: tab };
        set({ panelTabs });
        saveAgentPanelTabs(panelTabs);
      },
      drafts: {},
      createIn: null,
      appearanceSuggestions: {},
      loadAppearanceSuggestion(workspaceId, retry = false) {
        const pending = appearanceRequests.get(workspaceId);
        if (pending) return pending.promise;
        const cached = get().appearanceSuggestions[workspaceId];
        if (!retry && cached?.appearance) return Promise.resolve(cached.appearance);
        if (!retry && cached?.error) return Promise.reject(new Error(cached.error));
        // Bound the temporary cache, retaining the open creation dialog's draft source.
        if (!cached && Object.keys(get().appearanceSuggestions).length >= 16) {
          const oldest = Object.keys(get().appearanceSuggestions).find(id => id !== get().createIn);
          if (oldest) forgetAppearanceSuggestion(oldest);
        }
        const controller = new AbortController();
        const promise = request<{ appearance: AgentAppearance }>(
          `/workspaces/${workspaceId}/agents/appearance-suggestion`, "GET", undefined, controller.signal,
        ).then(result => {
          if (appearanceRequests.get(workspaceId)?.promise === promise) {
            set(s => ({ appearanceSuggestions: { ...s.appearanceSuggestions,
              [workspaceId]: { appearance: result.appearance, loading: false, error: "" } } }));
          }
          return result.appearance;
        }).catch(error => {
          if (appearanceRequests.get(workspaceId)?.promise === promise) {
            set(s => ({ appearanceSuggestions: { ...s.appearanceSuggestions,
              [workspaceId]: { appearance: null, loading: false, error: errorMessage(error) } } }));
          }
          throw error;
        }).finally(() => {
          if (appearanceRequests.get(workspaceId)?.promise === promise) appearanceRequests.delete(workspaceId);
        });
        appearanceRequests.set(workspaceId, { promise, controller });
        set(s => ({ appearanceSuggestions: { ...s.appearanceSuggestions,
          [workspaceId]: { appearance: null, loading: true, error: "" } } }));
        return promise;
      },
      positionError: "",
      submissionIds: {},
      eventVersion: 0,
      timelineVersion: 0,
      error: "",
      connected: true,
      async loadWorkspace(id) {
        return refresh(`workspace:${id}`, async () => {
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
            const sequence = ++snapshotSequence;
            const allAgents = await all<Agent>(`/workspaces/${id}/agents`);
            const removedIds: string[] = [];
            set((state) => {
              const invalidated = (revisions.get(id) ?? 0) !== version;
              const preserveLayout =
                invalidated ||
                state.canvasInteracting;
              const agents = { ...state.agents };
              const ids = new Set(allAgents.map((a) => a.id));
              for (const a of Object.values(agents))
                if (
                  !preserveLayout &&
                  a.workspaceId === id &&
                  !ids.has(a.id) &&
                  sequence >= (activitySequences.get(a.id) ?? 0)
                ) {
                  delete agents[a.id];
                  removedIds.push(a.id);
                }
              for (const a of allAgents)
                if (!preserveLayout || agents[a.id])
                  agents[a.id] = reconcileAgent(
                    agents[a.id], a, sequence,
                    preserveLayout || layoutPending(a.id), invalidated,
                  );
              const old = state.nodes[id] ?? emptyNodes;
              const nodes = workspaceNodes(
                Object.values(agents).filter((a) => a.workspaceId === id),
                old,
              );
              return {
                agents,
                nodes:
                  nodes === old ? state.nodes : { ...state.nodes, [id]: nodes },
                selected:
                  state.selected[id] && !agents[state.selected[id]!]
                    ? { ...state.selected, [id]: null }
                    : state.selected,
                error: "",
              };
            });
            forgetPanelTabs(removedIds);
          } catch (e) {
            set({ error: errorMessage(e) });
          }
        });
      },
      async refreshAgent(id) {
        return refresh(`agent:${id}`, async () => {
          try {
            const sequence = ++snapshotSequence;
            const [a, w, chat] = await Promise.all([
              request<Agent>(`/agents/${id}`),
              request<AgentWorkload>(`/agents/${id}/status`),
              request<AgentChat>(`/agents/${id}/chat`),
            ]);
            put(a, sequence, get().canvasInteracting || layoutPending(id));
            set((s) => ({
              workloads: { ...s.workloads, [id]: w },
              chats: { ...s.chats, [id]: chat },
              details: chat.task
                ? {
                    ...s.details,
                    [chat.task.id]: { task: chat.task, turns: chat.turns },
                  }
                : s.details,
            }));
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
          const key = taskId ?? `chat:${agentId}`,
            prior = get().messages[key] ?? [];
          const path = taskId
            ? `/tasks/${taskId}/messages`
            : `/agents/${agentId}/chat/messages`;
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
        const sequence = ++snapshotSequence;
        const a = await request<Agent>(
          `/workspaces/${workspaceId}/agents`,
          "POST",
          input,
        );
        revisions.set(workspaceId, (revisions.get(workspaceId) ?? 0) + 1);
        put(a, sequence);
        set((s) => ({
          createIn: null,
          selected: { ...s.selected, [workspaceId]: a.id },
        }));
        forgetAppearanceSuggestion(workspaceId);
        void get().loadAppearanceSuggestion(workspaceId).catch(() => {});
        return a;
      },
      async update(id, input) {
        const sequence = ++snapshotSequence;
        const a = await request<Agent>(`/agents/${id}`, "PATCH", input);
        revisions.set(a.workspaceId, (revisions.get(a.workspaceId) ?? 0) + 1);
        put(a, sequence, get().canvasInteracting || layoutPending(id));
        return a;
      },
      async remove(id) {
        const a = get().agents[id];
        await deleteManaged(`/agents/${id}`);
        forgetPanelTabs([id]);
        pendingPositions.delete(id);
        const owned = new Set((get().tasks[id] ?? []).map((t) => t.id));
        const chatId = get().chats[id]?.task?.id;
        if (chatId) owned.add(chatId);
        set((s) => ({
          fileDrafts: Object.fromEntries(
            Object.entries(s.fileDrafts).filter(
              ([key]) =>
                key !== `new:${id}` && key !== `chat:${id}` && !owned.has(key),
            ),
          ),
        }));
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
        pendingPositions.set(id, {
          x,
          y,
        });
        put({ ...a, x, y });
        const running = positionWrites.get(id);
        if (running) return running;
        const write = (async () => {
          while (pendingPositions.has(id)) {
            const value = pendingPositions.get(id)!;
            pendingPositions.delete(id);
            try {
              const sequence = ++snapshotSequence;
              const saved = await request<Agent>(
                `/agents/${id}`,
                "PATCH",
                value,
              );
              revisions.set(
                a.workspaceId,
                (revisions.get(a.workspaceId) ?? 0) + 1,
              );
              put(saved, sequence, pendingPositions.has(id));
              if (!pendingPositions.size && !pendingAnchors.size)
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
        for (const [id, patch] of [...pendingAnchors]) {
          try { await get().saveCommunicationAnchors(patch.workspaceId, id, patch.anchors); }
          catch { /* Retain retryable angles and the visible error. */ }
        }
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
      async submit(id, taskId, value, requestId, newTask = false, files) {
        const path = newTask
          ? `/agents/${id}/tasks`
          : taskId
            ? `/tasks/${taskId}/messages`
            : `/agents/${id}/chat/messages`;
        const send = files?.attachments.length
          ? () =>
              sendTaskFiles<{ taskId: string | null; turnId: string }>(
                path,
                value,
                requestId,
                files,
              )
          : () =>
              request<{
                taskId: string | null;
                turnId: string;
              }>(path, "POST", { content: value, requestId });
        const accepted = await send();
        await get().refreshAgent(id);
        await get()
          .loadMessages(id, !taskId && !newTask ? null : accepted.taskId)
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
