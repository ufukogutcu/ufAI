import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import {
  errorMessage,
  getPage,
  readPreference,
  request,
  writePreference,
  type Workspace,
  type ModelPreset,
  type PresetInput,
} from "./api";
import type { Viewport } from "@xyflow/react";

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
  activeWorkspaceId: string | null;
  viewports: Record<string, Viewport>;
  loadWorkspaces: (more?: boolean) => Promise<void>;
  loadPresets: (more?: boolean) => Promise<void>;
  selectWorkspace: (id: string) => void;
  saveViewport: (id: string, viewport: Viewport) => void;
  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
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

export function createDashboardStore() {
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
    activeWorkspaceId: readPreference("workspace"),
    viewports: {},
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
          const activeWorkspaceId = workspaces.some(
            (w) => w.id === state.activeWorkspaceId,
          )
            ? state.activeWorkspaceId
            : (workspaces[0]?.id ?? null);
          if (activeWorkspaceId)
            writePreference("workspace", activeWorkspaceId);
          return {
            workspaces,
            workspaceTotal: page.total,
            workspaceOffset: offset + page.items.length,
            workspaceStatus: "ready",
            activeWorkspaceId,
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
    selectWorkspace: (id) => {
      writePreference("workspace", id);
      set({ activeWorkspaceId: id });
    },
    saveViewport: (id, viewport) =>
      set((state) => ({ viewports: { ...state.viewports, [id]: viewport } })),
    createWorkspace: async (name) => {
      const workspace = await request<Workspace>("/workspaces", "POST", {
        name,
      });
      set((state) => ({
        workspaces: merge(state.workspaces, [workspace]),
        workspaceTotal: state.workspaceTotal + 1,
        workspaceOffset:
          state.workspaceOffset === state.workspaceTotal
            ? state.workspaceOffset + 1
            : state.workspaceOffset,
      }));
      get().selectWorkspace(workspace.id);
    },
    renameWorkspace: async (id, name) => {
      const workspace = await request<Workspace>(`/workspaces/${id}`, "PATCH", {
        name,
      });
      set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === id ? workspace : w)),
      }));
    },
    deleteWorkspace: async (id) => {
      await request(`/workspaces/${id}`, "DELETE");
      set((state) => {
        const index = state.workspaces.findIndex((w) => w.id === id);
        const workspaces = state.workspaces.filter((w) => w.id !== id);
        const viewports = { ...state.viewports };
        delete viewports[id];
        const activeWorkspaceId =
          state.activeWorkspaceId === id
            ? (workspaces[Math.min(index, workspaces.length - 1)]?.id ?? null)
            : state.activeWorkspaceId;
        writePreference("workspace", activeWorkspaceId ?? "");
        return {
          workspaces,
          viewports,
          activeWorkspaceId,
          workspaceTotal: state.workspaceTotal - 1,
          workspaceOffset: Math.max(
            0,
            state.workspaceOffset - (index < state.workspaceOffset ? 1 : 0),
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
