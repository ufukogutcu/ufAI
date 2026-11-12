import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import {
  errorMessage,
  request,
  type ConnectionInput,
  type ProviderConnection,
} from "./api";
interface ConnectionState {
  // Setup drafts stay with their editor, outside the saved Provider library.
  connections: ProviderConnection[];
  lastOpenedId: string | null;
  rememberOpened: (id: string | null) => void;
  status: "idle" | "loading" | "ready" | "error";
  error: string;
  load: () => Promise<void>;
  save: (
    id: string | null,
    input: Partial<ConnectionInput>,
  ) => Promise<ProviderConnection>;
  remove: (id: string) => Promise<void>;
}
export function createConnectionStore() {
  let revision = 0;
  let inFlight: Promise<void> | undefined;
  return createStore<ConnectionState>()((set, get) => ({
    connections: [],
    lastOpenedId: null,
    rememberOpened: (id) => set({ lastOpenedId: id }),
    status: "idle",
    error: "",
    load: () => {
      if (inFlight) return inFlight;
      const started = revision;
      set({ status: "loading", error: "" });
      inFlight = request<{ items: ProviderConnection[] }>(
        "/connections?limit=100",
      )
        .then(({ items }) => {
          if (revision === started)
            set((state) => ({
              connections: items.filter((item) => !item.draft).map((item) => {
                const existing = state.connections.find(
                  (saved) => saved.id === item.id,
                );
                return existing &&
                  JSON.stringify(existing) === JSON.stringify(item)
                  ? existing
                  : item;
              }),
              status: "ready",
            }));
        })
        .catch((error) => {
          if (revision === started)
            set({ status: "error", error: errorMessage(error) });
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    save: async (id, input) => {
      const saved = await request<ProviderConnection>(
        id ? `/connections/${id}` : "/connections",
        id ? "PATCH" : "POST",
        input,
      );
      revision++;
      set((state) => ({
        connections: [
          ...state.connections.filter((item) => item.id !== saved.id),
          ...(saved.draft ? [] : [saved]),
        ],
        status: "ready",
        error: "",
      }));
      await inFlight;
      await get().load();
      return saved;
    },
    remove: async (id) => {
      await request(`/connections/${id}`, "DELETE");
      revision++;
      set((state) => ({
        connections: state.connections.filter((item) => item.id !== id),
        lastOpenedId: state.lastOpenedId === id ? null : state.lastOpenedId,
        status: "ready",
        error: "",
      }));
      await inFlight;
      await get().load();
    },
  }));
}
export type ConnectionStore = ReturnType<typeof createConnectionStore>;
export const ConnectionContext = createContext<ConnectionStore | null>(null);
export function useConnections<T>(selector: (state: ConnectionState) => T): T {
  const store = useContext(ConnectionContext);
  if (!store) throw new Error("ConnectionContext is missing.");
  return useStore(store, selector);
}
