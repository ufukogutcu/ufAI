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
  WorkspaceViewport as Viewport,
} from "../../server/src/contracts";
import type { SettingsStore } from "./settings-store";

type Status = "idle" | "loading" | "ready" | "error";
interface DashboardState {
  workspaces: Workspace[];
  presets: ModelPreset[];
  workspaceStatus: Status;
  presetStatus: Status;
  workspaceError: string;
  presetError: string;
  workspaceTotal: number;
  presetTotal: number;
  workspaceOffset: number;
  presetOffset: number;
  viewports: Record<string, Viewport>;
  loadWorkspaces: (more?: boolean) => Promise<void>;
  loadPresets: (more?: boolean) => Promise<void>;
  viewportErrors: Record<string, string>;
  beginViewportInteraction: (id: string) => void;
  endViewportInteraction: (id: string) => void;
  retryViewport: (id: string) => Promise<void>;
  loadViewport: (id: string) => Promise<void>;
  saveViewport: (id: string, viewport: Viewport) => Promise<void>;
  createWorkspace: (name: string, description?: string) => Promise<void>;
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

export function createDashboardStore(settings: SettingsStore) {
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
    workspaceStatus: "idle",
    presetStatus: "idle",
    workspaceError: "",
    presetError: "",
    workspaceTotal: 0,
    presetTotal: 0,
    workspaceOffset: 0,
    presetOffset: 0,
    viewports: {},
    viewportErrors: {},
    loadWorkspaces: async (more = false) => {
      if (get().workspaceStatus === "loading") return;
      set({ workspaceStatus: "loading", workspaceError: "" });
      const offset = more ? get().workspaceOffset : 0;
      try {
        const page = await getPage<Workspace>("/workspaces", offset);
        set((state) => {
          const workspaces = more
            ? merge(state.workspaces, page.items)
            : page.items;
          return {
            workspaces,
            workspaceTotal: page.total,
            workspaceOffset: offset + page.items.length,
            workspaceStatus: "ready",
          };
        });
      } catch (error) {
        set({ workspaceStatus: "error", workspaceError: errorMessage(error) });
      }
    },
    loadPresets: async (more = false) => {
      if (get().presetStatus === "loading") return;
      set({ presetStatus: "loading", presetError: "" });
      const offset = more ? get().presetOffset : 0;
      try {
        const page = await getPage<ModelPreset>("/model-presets", offset);
        set((state) => ({
          presets: more ? merge(state.presets, page.items) : page.items,
          presetTotal: page.total,
          presetOffset: offset + page.items.length,
          presetStatus: "ready",
        }));
      } catch (error) {
        set({ presetStatus: "error", presetError: errorMessage(error) });
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
      const workspace = await settings
        .getState()
        .mutate(() =>
          request<Workspace>("/workspaces", "POST", { name, description }),
        );
      set((state) => ({
        workspaces: merge(state.workspaces, [workspace]),
        workspaceTotal: state.workspaceTotal + 1,
        workspaceOffset:
          state.workspaceOffset === state.workspaceTotal
            ? state.workspaceOffset + 1
            : state.workspaceOffset,
      }));
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
      await settings
        .getState()
        .mutate(() => request(`/workspaces/${id}`, "DELETE"));
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
    savePreset: async (id, input) => {
      const preset = await request<ModelPreset>(
        id ? `/model-presets/${id}` : "/model-presets",
        id ? "PATCH" : "POST",
        input,
      );
      set((state) => ({
        presets: merge(state.presets, [preset]),
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
      set((state) => ({
        presets: state.presets.filter((p) => p.id !== id),
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
