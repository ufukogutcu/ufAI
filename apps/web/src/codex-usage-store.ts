import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
import { request, errorMessage, RequestError, type CodexUsageSnapshot, type CodexResetInput, type CodexResetOutcome } from "./api";

export interface UsageEntry {
  snapshot?: CodexUsageSnapshot;
  loading: boolean;
  error: string;
  disconnected: boolean;
  redeeming: boolean;
  attempt?: CodexResetInput;
  message: string;
}
const emptyEntry = (): UsageEntry => ({ loading: false, error: "", disconnected: false, redeeming: false, message: "" });
const outcomes: Record<CodexResetOutcome, string> = {
  reset: "Reset used.",
  alreadyRedeemed: "This reset was already used by this attempt.",
  nothingToReset: "There is no eligible usage window to reset right now.",
  noCredit: "There are no earned resets available for this account.",
};
export function createCodexUsageStore() {
  const active = new Set<string>();
  const revision = new Map<string, number>();
  let generation = 0;
  const reads = new Map<string, { details: boolean; promise: Promise<void>; controller: AbortController }>();
  const detailed = new Set<string>();
  let running = 0;
  const queue: (() => void)[] = [];
  const schedule = <T,>(job: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    const start = () => {
      running++;
      void job().then(resolve, reject).finally(() => { running--; queue.shift()?.(); });
    };
    if (running < 2) start(); else queue.push(start);
  });
  return createStore<{
    entries: Record<string, UsageEntry>;
    sync: (ids: string[]) => void;
    invalidate: (id: string, disconnected?: boolean) => void;
    setDetails: (id: string, enabled: boolean) => void;
    refresh: (id: string, details?: boolean, force?: boolean) => Promise<void>;
    refreshAll: () => Promise<void>;
    redeem: (id: string, creditId?: string) => Promise<void>;
    dispose: () => void;
  }>()((set, get) => {
    const patch = (id: string, value: Partial<UsageEntry>) => {
      if (active.has(id)) set((state) => ({ entries: { ...state.entries, [id]: { ...state.entries[id]!, ...value } } }));
    };
    return {
      entries: {},
      setDetails(id, enabled) { if (enabled) detailed.add(id); else detailed.delete(id); },
      sync(ids) {
        const wanted = new Set(ids);
        for (const id of active) if (!wanted.has(id)) {
          active.delete(id); detailed.delete(id); revision.delete(id); reads.get(id)?.controller.abort(); reads.delete(id);
        }
        const entries: Record<string, UsageEntry> = {};
        for (const id of ids) { if (!active.has(id)) revision.set(id, ++generation); active.add(id); entries[id] = get().entries[id] ?? emptyEntry(); }
        set({ entries });
      },
      invalidate(id, disconnected = false) {
        if (!active.has(id)) return;
        revision.set(id, ++generation);
        reads.get(id)?.controller.abort();
        patch(id, { snapshot: undefined, disconnected, loading: false, error: disconnected ? "Sign in with ChatGPT in Providers to view usage." : "", attempt: undefined, message: "" });
      },
      refresh(id, details = false, force = false) {
        details ||= detailed.has(id);
        if (!active.has(id) || get().entries[id]?.redeeming) return Promise.resolve();
        const current = reads.get(id);
        if (current) return details && !current.details ? current.promise.then(() => get().refresh(id, true, force)) : current.promise;
        const started = revision.get(id) ?? 0;
        const controller = new AbortController();
        patch(id, { loading: true, error: "" });
        const promise = schedule(async () => {
          if (controller.signal.aborted || !active.has(id)) return;
          try {
            const snapshot = await request<CodexUsageSnapshot>(`/connections/${encodeURIComponent(id)}/usage?details=${details}&refresh=${force}`, "GET", undefined, controller.signal);
            if ((revision.get(id) ?? 0) === started && !controller.signal.aborted)
              patch(id, { snapshot, disconnected: false, loading: false, error: "" });
          } catch (error) {
            if ((revision.get(id) ?? 0) !== started || controller.signal.aborted) return;
            const disconnected = error instanceof RequestError && error.status === 401;
            patch(id, { loading: false, error: errorMessage(error), disconnected,
              ...(disconnected ? { snapshot: undefined, attempt: undefined } : {}) });
          }
        }).finally(() => {
          if (reads.get(id)?.controller === controller) reads.delete(id);
        });
        reads.set(id, { details, promise, controller });
        return promise;
      },
      async refreshAll() {
        const ids = [...active][Symbol.iterator]();
        const worker = async () => { for (let next = ids.next(); !next.done; next = ids.next()) await get().refresh(next.value); };
        await Promise.all([worker(), worker()]);
      },
      async redeem(id, creditId) {
        const entry = get().entries[id];
        if (!entry || entry.redeeming || entry.disconnected || !entry.snapshot) return;
        // Keep the logical attempt through errors and modal dismissal. A retry must not spend a second credit.
        const attempt = entry.attempt ?? { idempotencyKey: crypto.randomUUID(), ...(creditId ? { creditId } : {}) };
        patch(id, { attempt, redeeming: true, message: "", error: "" });
        revision.set(id, ++generation);
        reads.get(id)?.controller.abort();
        await reads.get(id)?.promise;
        try {
          const result = await request<{ outcome: CodexResetOutcome }>(`/connections/${encodeURIComponent(id)}/usage/resets/consume`, "POST", attempt);
          patch(id, { attempt: undefined, message: outcomes[result.outcome] ?? "The reset result was unavailable. Refresh usage to check." });
        } catch (error) {
          patch(id, { message: `${errorMessage(error)} Retry this same reset attempt to check its outcome.` });
        } finally {
          patch(id, { redeeming: false });
          await get().refresh(id, true, true);
        }
      },
      dispose() {
        revision.clear();
        active.clear();
        for (const read of reads.values()) read.controller.abort();
        reads.clear();
        detailed.clear();
      },
    };
  });
}
export type CodexUsageStore = ReturnType<typeof createCodexUsageStore>;
export const CodexUsageContext = createContext<CodexUsageStore | null>(null);
export function useCodexUsage<T>(selector: (state: ReturnType<CodexUsageStore["getState"]>) => T): T {
  const store = useContext(CodexUsageContext);
  if (!store) throw new Error("CodexUsageContext is missing.");
  return useStore(store, selector);
}
