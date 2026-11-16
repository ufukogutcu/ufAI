import { createStore } from "zustand/vanilla";
import { request } from "./api";
import type {
  McpServerPage,
  McpServerSummary,
} from "../../server/src/mcp-types";
interface McpState {
  items: McpServerSummary[];
  total: number;
  loading: boolean;
  load: (query: string, more?: boolean) => Promise<void>;
  invalidate: () => void;
  dispose: () => void;
}
/** A panel-scoped server cache; editor drafts never enter the cache. */
export function createMcpStore(agentId: string) {
  let sequence = 0,
    controller: AbortController | undefined;
  return createStore<McpState>()((set, get) => ({
    items: [],
    total: 0,
    loading: true,
    invalidate() {
      sequence++;
      controller?.abort();
    },
    dispose() {
      sequence++;
      controller?.abort();
    },
    async load(query, more = false) {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal,
        current = ++sequence;
      const previous = get().items;
      const offset = more ? previous.length : 0;
      // Keep previously loaded pages on a refresh.
      const count = more ? 50 : Math.max(50, previous.length);
      set({ loading: true });
      try {
        const items: McpServerSummary[] = [];
        let total = 0;
        for (let start = offset; start < offset + count; start += 50) {
          const page = await request<McpServerPage>(
            `/mcp/servers?agentId=${encodeURIComponent(agentId)}&query=${encodeURIComponent(query)}&offset=${start}&limit=50`,
            "GET",
            undefined,
            signal,
          );
          if (current !== sequence) return;
          items.push(...page.items);
          total = page.total;
          if (start + page.items.length >= total || page.items.length === 0)
            break;
        }
        const merged = more ? [...previous, ...items] : items;
        const prior = new Map(previous.map((v) => [v.id, v]));
        set({
          items: merged.map((v) => {
            const old = prior.get(v.id);
            return old && JSON.stringify(old) === JSON.stringify(v) ? old : v;
          }),
          total,
        });
      } catch (error) {
        if (!signal.aborted && current === sequence) throw error;
      } finally {
        if (current === sequence) set({ loading: false });
      }
    },
  }));
}
