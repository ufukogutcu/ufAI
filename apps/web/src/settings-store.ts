import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import type { AppSettings, SettingsResponse } from "../../server/src/contracts";
import { errorMessage, request } from "./api";
import { resolveTheme } from "./themes";

function resolveSnapshot(snapshot: SettingsResponse): SettingsResponse {
  const activeTheme = resolveTheme(snapshot.activeTheme);
  return activeTheme === snapshot.activeTheme
    ? snapshot
    : { ...snapshot, activeTheme };
}

type Retry = () => Promise<unknown>;
interface SettingsState {
  snapshot: SettingsResponse;
  error: string;
  retry: Retry;
  refresh: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  mutate: <T>(action: () => Promise<T>) => Promise<T>;
}

export function createSettingsStore(initial: SettingsResponse) {
  // All state belongs to this application instance. Writes run in user-action order.
  let revision = 0;
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let refreshing: Promise<void> | undefined;
  return createStore<SettingsState>()((set) => {
    async function refresh() {
      if (refreshing) return refreshing;
      if (pending) return;
      const started = revision;
      refreshing = (async () => {
        try {
          const snapshot = await request<SettingsResponse>("/settings");
          if (started === revision)
            set({ snapshot: resolveSnapshot(snapshot), error: "" });
        } catch (error) {
          if (started === revision)
            set({ error: errorMessage(error), retry: refresh });
        }
      })();
      try {
        await refreshing;
      } finally {
        refreshing = undefined;
      }
    }
    function enqueue<T>(action: () => Promise<T>) {
      revision += 1;
      pending += 1;
      const task = queue.then(action);
      queue = task
        .catch(() => {})
        .finally(() => {
          pending -= 1;
        });
      return task;
    }
    async function update(patch: Partial<AppSettings>) {
      // Handled here because UI event handlers deliberately do not throw.
      try {
        await enqueue(async () => {
          const snapshot = await request<SettingsResponse>(
            "/settings",
            "PATCH",
            patch,
          );
          set({ snapshot: resolveSnapshot(snapshot), error: "" });
        });
      } catch (error) {
        set({ error: errorMessage(error), retry: () => update(patch) });
      }
    }
    async function mutate<T>(action: () => Promise<T>): Promise<T> {
      return enqueue(async () => {
        const result = await action();
        // A completed CRUD action must not be reported as failed if this read fails.
        try {
          const snapshot = await request<SettingsResponse>("/settings");
          set({ snapshot: resolveSnapshot(snapshot), error: "" });
        } catch (error) {
          set({ error: errorMessage(error), retry: refresh });
        }
        return result;
      });
    }
    return {
      snapshot: resolveSnapshot(initial),
      error: "",
      retry: refresh,
      refresh,
      update,
      mutate,
    };
  });
}
export type SettingsStore = ReturnType<typeof createSettingsStore>;
export const SettingsContext = createContext<SettingsStore | null>(null);
export function useSettingsStore() {
  const store = useContext(SettingsContext);
  if (!store) throw new Error("SettingsProvider is missing.");
  return store;
}
export function useSettings<T>(selector: (state: SettingsState) => T): T {
  return useStore(useSettingsStore(), selector);
}
