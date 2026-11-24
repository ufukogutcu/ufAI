import { deleteManaged } from "./managed-files";
import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import {
  errorMessage,
  getPage,
  request,
  type Workspace,
  type ModelPreset,
  type PresetInput,
} from "./api";
import type {
  WorkspaceInput,
  SettingsResponse,
  Page,
  WorkspaceViewport as Viewport,
} from "../../server/src/contracts";
import type { SettingsStore } from "./settings-store";

type Status = "idle" | "loading" | "ready" | "error";
interface DashboardState {
  workspaces: Workspace[];
  presets: ModelPreset[];
  defaultPreset: ModelPreset | null;
  loadDefaultPreset: () => Promise<ModelPreset | null>;
  lastOpenedPresetId: string | null;
  rememberOpenedPreset: (id: string | null) => void;
  workspaceStatus: Status;
  presetStatus: Status;
  workspaceError: string;
  workspaceOrderSaving: boolean;
  workspaceOrderError: string;
  reorderWorkspace: (id: string, relativeToId: string, placement: "before" | "after") => Promise<boolean>;
  retryWorkspaceOrder: () => Promise<void>;
  presetError: string;
  workspaceTotal: number;
  presetTotal: number;
  workspaceOffset: number;
  presetOffset: number;
  viewports: Record<string, Viewport>;
  loadWorkspaces: (more?: boolean) => Promise<void>;
  loadPresets: (more?: boolean) => Promise<void>;
  clearPresetModels: (connectionId: string, modelIds: string[]) => void;
  viewportErrors: Record<string, string>;
  beginViewportInteraction: (id: string) => void;
  endViewportInteraction: (id: string) => void;
  retryViewport: (id: string) => Promise<void>;
  loadViewport: (id: string) => Promise<void>;
  saveViewport: (id: string, viewport: Viewport) => Promise<void>;
  createWorkspace: (name: string, description?: string) => Promise<void>;
  openDuplicatedWorkspace: (id: string) => Promise<void>;
  updateWorkspace: (id: string, input: WorkspaceInput) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  savePreset: (id: string | null, input: PresetInput) => Promise<ModelPreset>;
  deletePreset: (id: string) => Promise<void>;
}

function merge<T extends { id: string; createdAt: string }>(
  old: T[],
  items: T[],
): T[] {
  const records = new Map(old.map((item) => [item.id, item]));
  for (const item of items) records.set(item.id, item);
  return [...records.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function mergeWorkspaces(old: Workspace[], items: Workspace[]): Workspace[] {
  const records = new Map(old.map(item => [item.id, item]));
  for (const item of items) records.set(item.id, item);
  return [...records.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

async function workspaceRange(target: number, retainedIds: string[] = []) {
  const items: Workspace[] = [];
  const missing = new Set(retainedIds);
  let total = 0;
  do {
    const page = await getPage<Workspace>("/workspaces", items.length);
    total = page.total;
    items.push(...page.items);
    for (const item of page.items) missing.delete(item.id);
    if (!page.items.length) break;
  } while (items.length < total && (items.length < target || missing.size > 0));
  return { items, total };
}

function refreshedWorkspaces(current: Workspace[], items: Workspace[]) {
  const previous = new Map(current.map(item => [item.id, item]));
  return items.map(item => {
    const saved = previous.get(item.id);
    if (saved && saved.updatedAt > item.updatedAt) return { ...saved, sortOrder: item.sortOrder };
    return saved && JSON.stringify(saved) === JSON.stringify(item) ? saved : item;
  });
}

export function createDashboardStore(settings: SettingsStore) {
  let workspaceRevision = 0;
  let orderWrite: Promise<boolean> | undefined;
  let retryOrder: (() => Promise<void>) | undefined;
  let presetRevision = 0;
  let defaultLoad:
    | { revision: number; promise: Promise<ModelPreset | null> }
    | undefined;
  const viewportLoads = new Map<string, Promise<void>>();
  const viewportWrites = new Map<string, Promise<void>>();
  const viewportRevisions = new Map<string, number>();
  const viewportInteractions = new Set<string>();
  const pendingViewports = new Map<string, Viewport>();
  const viewportRetries = new Map<string, () => Promise<void>>();
  const unsavedViewports = new Set<string>();
  return createStore<DashboardState>()((set, get) => ({
    workspaces: [],
    presets: [],
    defaultPreset: null,
    lastOpenedPresetId: null,
    rememberOpenedPreset: (id) => set({ lastOpenedPresetId: id }),
    workspaceStatus: "idle",
    presetStatus: "idle",
    workspaceError: "",
    workspaceOrderSaving: false,
    workspaceOrderError: "",
    presetError: "",
    workspaceTotal: 0,
    presetTotal: 0,
    workspaceOffset: 0,
    presetOffset: 0,
    viewports: {},
    viewportErrors: {},
    loadWorkspaces: async (more = false) => {
      if (get().workspaceStatus === "loading" || get().workspaceOrderSaving) return;
      const revision = workspaceRevision;
      set({ workspaceStatus: "loading", workspaceError: "" });
      const offset = more ? get().workspaceOffset : 0;
      try {
        const page = more ? await getPage<Workspace>("/workspaces", offset)
          : await workspaceRange(Math.max(1, get().workspaceOffset));
        if (revision !== workspaceRevision) return;
        set(state => ({
          workspaces: more ? mergeWorkspaces(state.workspaces, refreshedWorkspaces(state.workspaces, page.items))
            : refreshedWorkspaces(state.workspaces, page.items),
          workspaceTotal: page.total,
          workspaceOffset: offset + page.items.length,
          workspaceStatus: "ready",
        }));
      } catch (error) {
        if (revision === workspaceRevision) set({ workspaceStatus: "error", workspaceError: errorMessage(error) });
      }
    },
    reorderWorkspace: (id, relativeToId, placement) => {
      if (orderWrite) return Promise.resolve(false);
      const state = get();
      const selected = settings.getState().snapshot.activeWorkspace;
      const previous = selected && !state.workspaces.some(item => item.id === selected.id)
        ? mergeWorkspaces(state.workspaces, [selected]) : state.workspaces;
      const source = previous.find(item => item.id === id);
      const target = previous.find(item => item.id === relativeToId);
      if (!source || !target || id === relativeToId) return Promise.resolve(false);
      const reordered = previous.filter(item => item.id !== id);
      reordered.splice(reordered.findIndex(item => item.id === relativeToId) + (placement === "after" ? 1 : 0), 0, source);
      if (reordered.every((item, index) => item.id === previous[index]?.id)) return Promise.resolve(false);
      let revision = ++workspaceRevision;
      const retainedIds = previous.map(item => item.id);
      async function reconcile() {
        const page = await workspaceRange(Math.max(state.workspaceOffset, previous.length), retainedIds);
        if (workspaceRevision !== revision) return;
        set(current => ({ workspaces: refreshedWorkspaces(current.workspaces, page.items), workspaceTotal: page.total,
          workspaceOffset: page.items.length, workspaceStatus: "ready", workspaceError: "" }));
      }
      set({ workspaces: reordered, workspaceOrderSaving: true, workspaceOrderError: "", workspaceStatus: "ready" });
      const save = async () => {
        await request(`/workspaces/${encodeURIComponent(id)}/order`, "PATCH", { relativeToId, placement });
      };
      // A confirmed write only needs a refresh on retry; an uncertain write is safe to repeat.
      let confirmed = false;
      const run = async (): Promise<boolean> => {
        try {
          if (!confirmed) { await save(); confirmed = true; }
          await reconcile();
          retryOrder = undefined;
          set({ workspaceOrderError: "" });
          return true;
        } catch (error) {
          if (!confirmed) {
            const order = new Map(previous.map((item, index) => [item.id, index]));
            set(current => ({ workspaces: [...current.workspaces].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)) }));
            try { await reconcile(); } catch { /* Keep the latest records available until explicit retry. */ }
          }
          set({ workspaceOrderError: errorMessage(error) });
          retryOrder = async () => {
            if (orderWrite) return;
            revision = ++workspaceRevision;
            set({ workspaceOrderSaving: true });
            orderWrite = run();
            try { await orderWrite; } finally { orderWrite = undefined; set({ workspaceOrderSaving: false }); }
          };
          return false;
        }
      };
      orderWrite = run();
      return orderWrite.finally(() => { orderWrite = undefined; set({ workspaceOrderSaving: false }); });
    },
    retryWorkspaceOrder: async () => { await retryOrder?.(); },
    loadDefaultPreset: () => {
      if (defaultLoad?.revision === presetRevision) return defaultLoad.promise;
      const started = presetRevision;
      let promise!: Promise<ModelPreset | null>;
      promise = (async () => {
        try {
          const { preset } = await request<{ preset: ModelPreset | null }>(
            "/model-presets/default",
          );
          if (started !== presetRevision) return get().defaultPreset;
          set((state) => ({
            defaultPreset:
              state.defaultPreset &&
              JSON.stringify(state.defaultPreset) === JSON.stringify(preset)
                ? state.defaultPreset
                : preset,
            presets: state.presets.map((item) => {
              const isDefault = item.id === preset?.id;
              return item.isDefault === isDefault ? item : { ...item, isDefault };
            }),
          }));
          return preset;
        } catch (error) {
          if (started !== presetRevision) return get().defaultPreset;
          throw error;
        } finally {
          if (defaultLoad?.promise === promise) defaultLoad = undefined;
        }
      })();
      defaultLoad = { revision: started, promise };
      return promise;
    },
    loadPresets: async (more = false) => {
      if (get().presetStatus === "loading") return;
      const started = presetRevision;
      const offset = more ? get().presetOffset : 0;
      const target = more ? offset + 100 : Math.max(100, get().presetOffset);
      const rememberedId = more ? null : get().lastOpenedPresetId;
      set({ presetStatus: "loading", presetError: "" });
      try {
        await get().loadDefaultPreset();
        if (started !== presetRevision) return;
        const items: ModelPreset[] = [];
        let nextOffset = offset;
        let total = 0;
        let foundRemembered = rememberedId === null;
        do {
          const page = await getPage<ModelPreset>("/model-presets", nextOffset);
          if (started !== presetRevision) return;
          items.push(...page.items);
          foundRemembered ||= page.items.some(
            (preset) => preset.id === rememberedId,
          );
          total = page.total;
          nextOffset += page.items.length;
          if (!page.items.length) break;
        } while (nextOffset < total && (nextOffset < target || !foundRemembered));
        set((state) => {
          const previous = new Map(
            state.presets.map((preset) => [preset.id, preset]),
          );
          const refreshed = items.map((item) => {
            const preset = {
              ...item,
              isDefault: item.id === state.defaultPreset?.id,
            };
            const saved = previous.get(preset.id);
            return saved && JSON.stringify(saved) === JSON.stringify(preset)
              ? saved
              : preset;
          });
          return {
            presets: more ? merge(state.presets, refreshed) : refreshed,
            presetTotal: total,
            presetOffset: nextOffset,
            presetStatus: "ready",
          };
        });
      } catch (error) {
        if (started === presetRevision)
          set({ presetStatus: "error", presetError: errorMessage(error) });
      } finally {
        if (started !== presetRevision) set({ presetStatus: "ready" });
      }
    },
    beginViewportInteraction: (id) => {
      viewportInteractions.add(id);
      viewportRevisions.set(id, (viewportRevisions.get(id) ?? 0) + 1);
    },
    endViewportInteraction: (id) => {
      viewportInteractions.delete(id);
    },
    retryViewport: async (id) => {
      await viewportRetries.get(id)?.();
    },
    loadViewport: async (id) => {
      if (viewportLoads.has(id)) return viewportLoads.get(id);
      if (
        viewportWrites.has(id) ||
        viewportInteractions.has(id) ||
        unsavedViewports.has(id)
      )
        return;
      const revision = viewportRevisions.get(id);
      const loading = (async () => {
        try {
          const viewport = await request<Viewport>(
            `/workspaces/${encodeURIComponent(id)}/viewport`,
          );
          if (viewportRevisions.get(id) === revision) {
            viewportRetries.delete(id);
            set((state) => ({
              viewports: { ...state.viewports, [id]: viewport },
              viewportErrors: { ...state.viewportErrors, [id]: "" },
            }));
          }
        } catch (error) {
          if (viewportRevisions.get(id) === revision) {
            viewportRetries.set(id, () => get().loadViewport(id));
            set((state) => ({
              viewportErrors: {
                ...state.viewportErrors,
                [id]: errorMessage(error),
              },
            }));
          }
        }
      })();
      viewportLoads.set(id, loading);
      try {
        await loading;
      } finally {
        viewportLoads.delete(id);
      }
    },
    saveViewport: async (id, viewport) => {
      viewportInteractions.delete(id);
      unsavedViewports.add(id);
      viewportRevisions.set(id, (viewportRevisions.get(id) ?? 0) + 1);
      // Keep one in-flight write and the latest completed view, never a pointer-event queue.
      set((state) => ({ viewports: { ...state.viewports, [id]: viewport } }));
      pendingViewports.set(id, viewport);
      if (viewportWrites.has(id)) return viewportWrites.get(id);
      const saving = (async () => {
        while (pendingViewports.has(id)) {
          const next = pendingViewports.get(id)!;
          pendingViewports.delete(id);
          try {
            await request(
              `/workspaces/${encodeURIComponent(id)}/viewport`,
              "PATCH",
              next,
            );
            if (get().viewports[id] === next) {
              unsavedViewports.delete(id);
              viewportRetries.delete(id);
              set((state) => ({
                viewportErrors: { ...state.viewportErrors, [id]: "" },
              }));
            }
          } catch (error) {
            if (get().viewports[id] === next) {
              viewportRetries.set(id, () =>
                get().saveViewport(id, get().viewports[id]!),
              );
              set((state) => ({
                viewportErrors: {
                  ...state.viewportErrors,
                  [id]: errorMessage(error),
                },
              }));
            }
          }
        }
      })();
      viewportWrites.set(id, saving);
      try {
        await saving;
      } finally {
        viewportWrites.delete(id);
      }
    },
    createWorkspace: async (name, description = "") => {
      await orderWrite;
      const workspace = await settings
        .getState()
        .mutate(() =>
          request<Workspace>("/workspaces", "POST", { name, description }),
        );
      workspaceRevision++;
      set((state) => ({
        workspaceStatus: "ready",
        workspaces: mergeWorkspaces(state.workspaces, [workspace]),
        workspaceTotal: state.workspaceTotal + 1,
        workspaceOffset:
          state.workspaceOffset === state.workspaceTotal
            ? state.workspaceOffset + 1
            : state.workspaceOffset,
      }));
    },
    openDuplicatedWorkspace: async (id) => {
      await orderWrite;
      const { total } = await request<Page<Workspace>>("/workspaces?limit=1&offset=0");
      const response = await settings.getState().mutate(() => request<SettingsResponse>("/settings", "PATCH", { activeWorkspaceId: id }));
      const workspace = response.activeWorkspace;
      workspaceRevision++;
      if (workspace) set(state => {
        const added = !state.workspaces.some(item => item.id === workspace.id);
        return { workspaceStatus: "ready", workspaces: mergeWorkspaces(state.workspaces, [workspace]),
          workspaceTotal: total,
          workspaceOffset: added && state.workspaceOffset === state.workspaceTotal && total === state.workspaceTotal + 1 ? state.workspaceOffset + 1 : state.workspaceOffset };
      });
    },
    updateWorkspace: async (id, input) => {
      const workspace = await settings
        .getState()
        .mutate(() => request<Workspace>(`/workspaces/${id}`, "PATCH", input));
      set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === id ? workspace : w)),
      }));
    },
    deleteWorkspace: async (id) => {
      await orderWrite;
      await settings
        .getState()
        .mutate(() => deleteManaged(`/workspaces/${id}`));
      workspaceRevision++;
      viewportRevisions.set(id, (viewportRevisions.get(id) ?? 0) + 1);
      await Promise.all([viewportLoads.get(id), viewportWrites.get(id)]);
      viewportRevisions.delete(id);
      viewportInteractions.delete(id);
      pendingViewports.delete(id);
      viewportRetries.delete(id);
      unsavedViewports.delete(id);
      set((state) => {
        const index = state.workspaces.findIndex((w) => w.id === id);
        const workspaces = state.workspaces.filter((w) => w.id !== id);
        const viewports = { ...state.viewports };
        const viewportErrors = { ...state.viewportErrors };
        delete viewports[id];
        delete viewportErrors[id];
        return {
          workspaces,
          workspaceStatus: "ready",
          viewports,
          viewportErrors,
          workspaceTotal: state.workspaceTotal - 1,
          workspaceOffset: Math.max(
            0,
            state.workspaceOffset -
              (index >= 0 && index < state.workspaceOffset ? 1 : 0),
          ),
        };
      });
    },
    clearPresetModels: (connectionId, modelIds) => {
      const disabled = new Set(modelIds);
      presetRevision++;
      set(state => ({
        defaultPreset:
          state.defaultPreset?.connectionId === connectionId &&
          state.defaultPreset.modelId &&
          disabled.has(state.defaultPreset.modelId)
            ? { ...state.defaultPreset, modelId: null, contextWindow: null, providerOptions: null }
            : state.defaultPreset,
        presets: state.presets.map(preset =>
          preset.connectionId === connectionId && preset.modelId && disabled.has(preset.modelId)
            ? { ...preset, modelId: null, contextWindow: null, providerOptions: null }
            : preset),
      }));
    },
    savePreset: async (id, input) => {
      const preset = await request<ModelPreset>(
        id ? `/model-presets/${id}` : "/model-presets",
        id ? "PATCH" : "POST",
        input,
      );
      presetRevision++;
      set((state) => ({
        presetError: "",
        defaultPreset: preset.isDefault
          ? preset
          : state.defaultPreset?.id === preset.id
            ? null
            : state.defaultPreset,
        presets: merge(
          state.presets.map((item) =>
            preset.isDefault && item.isDefault && item.id !== preset.id
              ? { ...item, isDefault: false, updatedAt: preset.updatedAt }
              : item,
          ),
          [preset],
        ),
        presetTotal: state.presetTotal + (id ? 0 : 1),
        presetOffset:
          !id && state.presetOffset === state.presetTotal
            ? state.presetOffset + 1
            : state.presetOffset,
      }));
      return preset;
    },
    deletePreset: async (id) => {
      await request(`/model-presets/${id}`, "DELETE");
      presetRevision++;
      set((state) => ({
        defaultPreset: state.defaultPreset?.id === id ? null : state.defaultPreset,
        presets: state.presets.filter((p) => p.id !== id),
        lastOpenedPresetId:
          state.lastOpenedPresetId === id ? null : state.lastOpenedPresetId,
        presetTotal: state.presetTotal - 1,
        presetOffset: Math.max(
          0,
          state.presetOffset -
            (state.presets.findIndex((p) => p.id === id) < state.presetOffset
              ? 1
              : 0),
        ),
      }));
    },
  }));
}

export const DashboardContext = createContext<ReturnType<
  typeof createDashboardStore
> | null>(null);
export function useDashboard<T>(selector: (state: DashboardState) => T): T {
  const store = useContext(DashboardContext);
  if (!store) throw new Error("DashboardProvider is missing.");
  return useStore(store, selector);
}
