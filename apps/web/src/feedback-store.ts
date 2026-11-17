import { createStore } from "zustand";
import { errorMessage } from "./api";

export type FeedbackTone = "error" | "loading" | "info" | "success";
export interface NoticeInput {
  id: string;
  title: string;
  message: string;
  tone?: FeedbackTone;
  actionLabel?: string;
  action?: () => Promise<unknown> | unknown;
  dismissible?: boolean;
  details?: string;
}
export interface Notice extends NoticeInput {
  busy: boolean;
  dismissed: boolean;
  resolved: boolean;
}
export interface FeedbackHost { id: string; element: HTMLElement; busy: boolean; kind: "dialog" | "panel" }
export function activeFeedbackHost(hosts: FeedbackHost[]) {
  for (let i = hosts.length - 1; i >= 0; i--) if (hosts[i]!.kind === "dialog") return hosts[i];
  return hosts.at(-1);
}

export function createFeedbackStore() {
  const attempts = new Map<string, symbol>();
  return createStore<{
    notices: Notice[];
    hosts: FeedbackHost[];
    publish: (notice: NoticeInput) => void;
    remove: (id: string) => void;
    resolve: (id: string) => void;
    dismiss: (id: string) => void;
    run: (id: string) => Promise<void>;
    registerHost: (host: FeedbackHost) => void;
    removeHost: (id: string) => void;
  }>()((set, get) => ({
    notices: [], hosts: [],
    publish(input) {
      set(state => {
        const previous = state.notices.find(notice => notice.id === input.id);
        // Polling the same failure must not reopen a dismissed notice.
        const sameEpisode = previous?.message === input.message && previous.title === input.title && previous.tone === input.tone;
        const notice: Notice = { ...input, busy: previous?.busy ?? false, dismissed: sameEpisode ? previous.dismissed : false, resolved: false };
        return { notices: previous
          ? state.notices.map(item => item === previous ? notice : item)
          : [...state.notices, notice] };
      });
    },
    remove(id) {
      attempts.delete(id);
      set(state => state.notices.some(notice => notice.id === id)
        ? { notices: state.notices.filter(notice => notice.id !== id) } : state);
    },
    resolve(id) {
      const notice = get().notices.find(item => item.id === id);
      if (!notice) return;
      if (!notice.busy) { get().remove(id); return; }
      set(state => ({ notices: state.notices.map(item => item === notice ? { ...item, resolved: true } : item) }));
    },
    dismiss(id) {
      set(state => ({ notices: state.notices.map(notice => notice.id === id && !notice.busy && notice.dismissible !== false
        ? { ...notice, dismissed: true } : notice) }));
    },
    async run(id) {
      const notice = get().notices.find(item => item.id === id);
      if (!notice?.action || notice.busy || activeFeedbackHost(get().hosts)?.busy) return;
      const attempt = Symbol(id);
      attempts.set(id, attempt);
      set(state => ({ notices: state.notices.map(item => item === notice ? { ...item, busy: true } : item) }));
      try { await notice.action(); }
      catch (error) {
        if (attempts.get(id) !== attempt) return;
        set(state => ({ notices: state.notices.map(item => item.id === id && item.title === notice.title && item.message === notice.message
          ? { ...item, tone: "error", message: errorMessage(error), dismissed: false, resolved: false } : item) }));
      } finally {
        if (attempts.get(id) !== attempt) return;
        attempts.delete(id);
        set(state => ({ notices: state.notices.flatMap(item => item.id === id
          ? item.resolved ? [] : [{ ...item, busy: false }] : [item]) }));
      }
    },
    registerHost(host) {
      set(state => ({ hosts: state.hosts.some(item => item.id === host.id)
        ? state.hosts.map(item => item.id === host.id ? host : item)
        : [...state.hosts, host] }));
    },
    removeHost(id) { set(state => ({ hosts: state.hosts.filter(host => host.id !== id) })); },
  }));
}
export type FeedbackStore = ReturnType<typeof createFeedbackStore>;
