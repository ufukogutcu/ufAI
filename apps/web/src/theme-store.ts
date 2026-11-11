import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import { errorMessage, getPage, request, RequestError } from "./api";
import {
  cacheTheme,
  defaultThemes,
  systemTheme,
  type Theme,
  type ThemeInput,
} from "./themes";

interface ThemeState {
  active: Theme;
  themes: Theme[];
  total: number;
  offset: number;
  loading: boolean;
  error: string;
  activeError: string;
  select: (theme: Theme) => void;
  refreshActive: () => Promise<void>;
  load: (more?: boolean) => Promise<void>;
  save: (id: string | null, input: ThemeInput) => Promise<Theme>;
  remove: (id: string) => Promise<void>;
}
function merge(themes: Theme[], theme: Theme) {
  return themes.some((item) => item.id === theme.id)
    ? themes.map((item) => (item.id === theme.id ? theme : item))
    : [...themes, theme];
}
export function createThemeStore(initial: Theme) {
  return createStore<ThemeState>()((set, get) => ({
    active: initial,
    themes: [...defaultThemes],
    total: 2,
    offset: 0,
    loading: false,
    error: "",
    activeError: "",
    select: (theme) => {
      cacheTheme(theme);
      set({ active: theme, activeError: "" });
    },
    refreshActive: async () => {
      const previous = get().active;
      if (previous.builtIn) return;
      try {
        const theme = await request<Theme>(
          `/themes/${encodeURIComponent(previous.id)}`,
        );
        if (get().active === previous) get().select(theme);
      } catch (error) {
        if (get().active !== previous) return;
        if (error instanceof RequestError && error.status === 404)
          get().select(systemTheme());
        else
          set({
            activeError:
              "Could not refresh the active theme. Your cached colors are still in use.",
          });
      }
    },
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
      const theme = await request<Theme>(
        id ? `/themes/${id}` : "/themes",
        id ? "PATCH" : "POST",
        input,
      );
      set((state) => ({
        themes: merge(state.themes, theme),
        total: state.total + (id ? 0 : 1),
        offset:
          !id && state.offset === state.total ? state.offset + 1 : state.offset,
      }));
      if (get().active.id === theme.id) get().select(theme);
      return theme;
    },
    remove: async (id) => {
      await request(`/themes/${id}`, "DELETE");
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
      if (get().active.id === id) get().select(systemTheme());
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
