import { createContext, useContext } from "react";
import { createStore } from "zustand";
import { request } from "./api";
import type { Trigger, TriggerPage } from "../../server/src/trigger-types";
interface State {
  requestedId: string | null;
  entities: Record<string, Trigger>;
  pages: Record<string, { ids: string[]; total: number }>;
  load: (path: string) => Promise<void>;
  put: (trigger: Trigger) => void;
  retain: (id: string) => () => void;
  invalidate: () => void;
}
export function createTriggerStore() {
  const reads = new Map<string, number>(),
    pageOrder = new Map<string, true>(),
    held = new Map<string, number>();
  const entityReads = new Map<string, number>();
  const recent: string[] = [];
  let epoch = 0,
    readSequence = 0;
  function trim(
    entities: State["entities"],
    pages: State["pages"],
    requestedId: string | null,
  ) {
    const keep = new Set([
      ...Object.values(pages).flatMap((p) => p.ids),
      ...held.keys(),
      ...recent,
      ...(requestedId ? [requestedId] : []),
    ]);
    const keys = Object.keys(entities);
    for (const id of entityReads.keys())
      if (!keep.has(id)) entityReads.delete(id);
    return keys.every((id) => keep.has(id))
      ? entities
      : Object.fromEntries(
          keys.filter((id) => keep.has(id)).map((id) => [id, entities[id]!]),
        );
  }
  return createStore<State>((set, get) => ({
    requestedId: null,
    entities: {},
    pages: {},
    async load(path) {
      const seq = ++readSequence,
        started = epoch;
      reads.set(path, seq);
      try {
        const page = await request<TriggerPage<Trigger>>(path);
        if (reads.get(path) !== seq || epoch !== started) return;
        pageOrder.delete(path);
        pageOrder.set(path, true);
        while (pageOrder.size > 20)
          pageOrder.delete(pageOrder.keys().next().value!);
        set((state) => {
          let entities = state.entities;
          for (const t of page.items)
            if (
              (entities[t.id]?.revision ?? 0) > t.revision ||
              (entityReads.get(t.id) ?? 0) > seq
            )
              continue;
            else {
              entityReads.set(t.id, seq);
              if (JSON.stringify(entities[t.id]) !== JSON.stringify(t)) {
                if (entities === state.entities) entities = { ...entities };
                entities[t.id] = t;
              }
            }
          const value = { ids: page.items.map((t) => t.id), total: page.total };
          let pages =
            JSON.stringify(state.pages[path]) === JSON.stringify(value)
              ? state.pages
              : { ...state.pages, [path]: value };
          if (Object.keys(pages).some((key) => !pageOrder.has(key)))
            pages = Object.fromEntries(
              Object.entries(pages).filter(([key]) => pageOrder.has(key)),
            );
          return { entities: trim(entities, pages, state.requestedId), pages };
        });
      } finally {
        if (reads.get(path) === seq) reads.delete(path);
      }
    },
    put(trigger) {
      epoch++;
      const index = recent.indexOf(trigger.id);
      if (index >= 0) recent.splice(index, 1);
      recent.push(trigger.id);
      if (recent.length > 50) recent.shift();
      set((state) => ({
        entities: trim(
          { ...state.entities, [trigger.id]: trigger },
          state.pages,
          state.requestedId,
        ),
      }));
    },
    retain(id) {
      held.set(id, (held.get(id) ?? 0) + 1);
      return () => {
        const n = (held.get(id) ?? 1) - 1;
        if (n) held.set(id, n);
        else held.delete(id);
      };
    },
    invalidate() {
      epoch++;
    },
  }));
}
export type TriggerStore = ReturnType<typeof createTriggerStore>;
export const TriggerContext = createContext<TriggerStore | null>(null);
export function useTriggerStore() {
  const s = useContext(TriggerContext);
  if (!s) throw new Error("Trigger provider is missing.");
  return s;
}
