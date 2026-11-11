import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import type { SettingsStore } from "./settings-store";
import { errorMessage, getPage, request } from "./api";
import { defaultThemes, type Theme, type ThemeInput } from "./themes";

interface ThemeState {
  themes: Theme[];
  total: number;
  offset: number;
  loading: boolean;
  error: string;
  load: (more?: boolean) => Promise<void>;
  save: (id: string | null, input: ThemeInput) => Promise<Theme>;
  remove: (id: string) => Promise<void>;
}
function merge(themes: Theme[], theme: Theme) {
  return themes.some((item) => item.id === theme.id)
    ? themes.map((item) => (item.id === theme.id ? theme : item))
    : [...themes, theme];
}
export function createThemeStore(settings: SettingsStore) {
  return createStore<ThemeState>()((set, get) => ({
    themes: [...defaultThemes],
    total: 2,
    offset: 0,
    loading: false,
    error: "",
    load: async (more = false) => {
      if (get().loading) return;
      set({ loading: true, error: "" });
      const offset = more ? get().offset : 0;
      try {
        const page = await getPage<Theme>("/themes", offset);
        set((state) => ({
          themes: page.items.reduce(
            merge,
            more ? state.themes : [...defaultThemes],
          ),
          total: page.total,
          offset: offset + page.items.length,
          loading: false,
        }));
      } catch (error) {
        set({ loading: false, error: errorMessage(error) });
      }
    },
    save: async (id, input) => {
      const theme = await settings
        .getState()
        .mutate(() =>
          request<Theme>(
            id ? `/themes/${id}` : "/themes",
            id ? "PATCH" : "POST",
            input,
          ),
        );
      set((state) => ({
        themes: merge(state.themes, theme),
        total: state.total + (id ? 0 : 1),
        offset:
          !id && state.offset === state.total ? state.offset + 1 : state.offset,
      }));
      return theme;
    },
    remove: async (id) => {
      await settings
        .getState()
        .mutate(() => request(`/themes/${id}`, "DELETE"));
      set((state) => ({
        themes: state.themes.filter((theme) => theme.id !== id),
        total: state.total - 1,
        offset: Math.max(
          0,
          state.offset -
            (state.themes.findIndex((theme) => theme.id === id) < state.offset
              ? 1
              : 0),
        ),
      }));
    },
  }));
}
export const ThemeContext = createContext<ReturnType<
  typeof createThemeStore
> | null>(null);
export function useTheme<T>(selector: (state: ThemeState) => T): T {
  const store = useContext(ThemeContext);
  if (!store) throw new Error("ThemeProvider is missing.");
  return useStore(store, selector);
}
