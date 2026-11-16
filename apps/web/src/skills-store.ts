import { createContext, useContext } from "react";
import { createStore } from "zustand";
import { request } from "./api";
import type { SkillSummary, SkillPage } from "../../server/src/skill-types";
export interface SkillFilters {
  query: string;
  status: "all" | "enabled" | "disabled";
  origin: "all" | "builtin" | "custom";
}
export const defaultSkillFilters: SkillFilters = {
  query: "",
  status: "all",
  origin: "all",
};
export const skillPageKey = (agentId: string, filters: SkillFilters) =>
  JSON.stringify([agentId, filters.query, filters.status, filters.origin]);
type LibrarySkill = Omit<SkillSummary, "enabled">;
interface SkillsState {
  library: Record<string, LibrarySkill>;
  enabled: Record<string, Record<string, boolean>>;
  pages: Record<string, { ids: string[]; total: number; path: string }>;
  load: (
    agentId: string,
    filters: SkillFilters,
    more?: boolean,
  ) => Promise<void>;
  toggle: (agentId: string, id: string, enabled: boolean) => Promise<void>;
  invalidate: () => void;
}
export function createSkillsStore() {
  let epoch = 0,
    serial = 0;
  const applied = new Map<string, number>();
  const sequences = new Map<string, number>();
  return createStore<SkillsState>()((set, get) => ({
    library: {},
    enabled: {},
    pages: {},
    invalidate() {
      epoch++;
    },
    async load(agentId, filters, more = false) {
      const key = skillPageKey(agentId, filters),
        sequence = ++serial,
        generation = epoch;
      sequences.set(key, sequence);
      const offset = more ? (get().pages[key]?.ids.length ?? 0) : 0;
      const desired = more
        ? 50
        : Math.max(50, get().pages[key]?.ids.length ?? 0);
      let page: SkillPage = { items: [], total: 0, path: "" };
      do {
        const query = new URLSearchParams({
          ...filters,
          limit: String(Math.min(100, desired - page.items.length)),
          offset: String(offset + page.items.length),
        });
        const result = await request<SkillPage>(
          `/agents/${encodeURIComponent(agentId)}/skills?${query}`,
        );
        page = { ...result, items: [...page.items, ...result.items] };
        if (
          !result.items.length ||
          generation !== epoch ||
          sequences.get(key) !== sequence
        )
          break;
      } while (
        page.items.length < desired &&
        offset + page.items.length < page.total
      );
      if (
        generation !== epoch ||
        sequences.get(key) !== sequence ||
        sequence < (applied.get(agentId) ?? 0)
      )
        return;
      applied.set(agentId, sequence);
      set((state) => {
        const library = { ...state.library },
          enabled = { ...state.enabled[agentId] };
        for (const item of page.items) {
          const { enabled: active, ...skill } = item;
          const old = library[skill.id];
          if (!old || old.revision < skill.revision) library[skill.id] = skill;
          enabled[skill.id] = active;
        }
        const ids = more
          ? [
              ...new Set([
                ...(state.pages[key]?.ids ?? []),
                ...page.items.map((i) => i.id),
              ]),
            ]
          : page.items.map((i) => i.id);
        return {
          library,
          enabled: { ...state.enabled, [agentId]: enabled },
          pages: {
            ...state.pages,
            [key]: { ids, total: page.total, path: page.path },
          },
        };
      });
    },
    async toggle(agentId, id, enabled) {
      epoch++;
      const result = await request<SkillSummary>(
        `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(id)}`,
        "PUT",
        { enabled },
      );
      epoch++;
      set((state) => ({
        enabled: {
          ...state.enabled,
          [agentId]: { ...state.enabled[agentId], [id]: result.enabled },
        },
      }));
    },
  }));
}
export const SkillsContext = createContext<ReturnType<
  typeof createSkillsStore
> | null>(null);
export function useSkillsStore() {
  const store = useContext(SkillsContext);
  if (!store) throw new Error("SkillsContext is missing.");
  return store;
}
