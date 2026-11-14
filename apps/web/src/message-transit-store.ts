import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import type { MessageTransit } from "../../server/src/contracts";
import { request } from "./api";

export interface VisualTransit extends MessageTransit {
  localStartedAt: number;
  localArrivesAt: number;
}
interface TransitPage {
  items: MessageTransit[];
  serverNow: string;
  nextCursor: number | null;
}
interface TransitState {
  byLink: Record<string, VisualTransit[]>;
  refresh: (workspaceId: string) => Promise<void>;
  clear: () => void;
}
export const emptyTransits: VisualTransit[] = [];

export function createMessageTransitStore(now = () => performance.now()) {
  let generation = 0;
  let controller: AbortController | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  return createStore<TransitState>((set, get) => {
    function replace(items: VisualTransit[]) {
      const before = get().byLink;
      const previousItems = new Map(Object.values(before).flat().map(item => [item.messageId, item]));
      const byLink: Record<string, VisualTransit[]> = {};
      for (const item of items) {
        if (item.localArrivesAt <= now()) continue;
        const previous = previousItems.get(item.messageId);
        (byLink[item.linkId] ??= []).push(previous && previous.arrivesAt === item.arrivesAt ? previous : item);
      }
      for (const id of Object.keys(byLink)) {
        const old = before[id], next = byLink[id]!;
        if (old?.length === next.length && next.every((row, i) => row === old[i])) byLink[id] = old;
      }
      if (Object.keys(before).length !== Object.keys(byLink).length || Object.keys(byLink).some(id => before[id] !== byLink[id])) set({ byLink });
      clearTimeout(expiry);
      const deadlines = items.filter(item => item.localArrivesAt > now()).map(item => item.localArrivesAt);
      if (deadlines.length) expiry = setTimeout(() => replace(Object.values(get().byLink).flat()), Math.max(1, deadlines.reduce((earliest, deadline) => Math.min(earliest, deadline), Infinity) - now()));
    }
    return {
      byLink: {},
      async refresh(workspaceId) {
        const version = ++generation;
        controller?.abort();
        controller = new AbortController();
        const signal = controller.signal;
        const items = new Map<string, VisualTransit>();
        let after = 0;
        try {
          do {
            const started = now();
            const page = await request<TransitPage>(`/workspaces/${encodeURIComponent(workspaceId)}/message-transits?limit=100&after=${after}`, "GET", undefined, signal);
            if (version !== generation) return;
            const offset = Date.parse(page.serverNow) - (started + now()) / 2;
            for (const item of page.items) {
              if (item.workspaceId !== workspaceId || item.state !== "in_flight") continue;
              items.set(item.messageId, { ...item, localStartedAt: Date.parse(item.startedAt) - offset, localArrivesAt: Date.parse(item.arrivesAt) - offset });
            }
            if (page.nextCursor === null || page.nextCursor <= after) break;
            after = page.nextCursor;
          } while (version === generation);
          if (version === generation) replace([...items.values()]);
        } catch {
          // Existing flights expire locally; the next SSE/focus refresh repairs the snapshot.
        }
      },
      clear() {
        generation++;
        controller?.abort();
        clearTimeout(expiry);
        set({ byLink: {} });
      },
    };
  });
}
export type MessageTransitStore = ReturnType<typeof createMessageTransitStore>;
export const MessageTransitContext = createContext<MessageTransitStore | null>(null);
export function useMessageTransits(linkId: string) {
  const store = useContext(MessageTransitContext);
  if (!store) throw new Error("Missing message transmission store.");
  return useStore(store, state => state.byLink[linkId] ?? emptyTransits);
}
