import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { X } from "lucide-react";
import { activeFeedbackHost, createFeedbackStore, type FeedbackStore, type NoticeInput } from "../feedback-store";
import { Feedback } from "./Feedback";
import { Appearance } from "./Appearance";
import styles from "./FeedbackProvider.module.scss";

export const FeedbackContext = createContext<FeedbackStore | null>(null);

export function useFeedbackStore() { return useContext(FeedbackContext); }

// The source owns resolution. A retry never assumes that a swallowed request
// error means success, and changing an action does not replay an announcement.
export function useNotice(input: NoticeInput | null, sourceId: string) {
  const store = useFeedbackStore();
  const actionRef = useRef(input?.action);
  useEffect(() => { actionRef.current = input?.action; });
  const action = useCallback(() => actionRef.current?.(), []);
  const title = input?.title, message = input?.message, tone = input?.tone;
  const actionLabel = input?.actionLabel, dismissible = input?.dismissible;
  const details = input?.details, episode = input?.episode;
  const enabled = input !== null, hasAction = !!input?.action;
  useEffect(() => {
    if (!store) return;
    if (!enabled) { store.getState().resolve(sourceId); return; }
    store.getState().publish({ id: sourceId, title: title!, message: message!, tone, actionLabel, dismissible, details, episode,
      action: hasAction ? action : undefined });
  }, [store, sourceId, enabled, title, message, tone, actionLabel, dismissible, details, episode, hasAction, action]);
  useEffect(() => () => store?.getState().remove(sourceId), [store, sourceId]);
}

export function FeedbackHost({ busy = false, kind = "dialog" }: { busy?: boolean; kind?: "dialog" | "panel" }) {
  const store = useFeedbackStore();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!store || !ref.current) return;
    store.getState().registerHost({ id, element: ref.current, busy, kind });
  }, [store, id, busy, kind]);
  useEffect(() => () => store?.getState().removeHost(id), [store, id]);
  return <div ref={ref} className={kind === "panel" ? styles.panelHost : undefined} />;
}

function NoticeViewport({ store }: { store: FeedbackStore }) {
  const notices = useStore(store, state => state.notices);
  const host = useStore(store, state => activeFeedbackHost(state.hosts));
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef(new Map<string, string>());
  const viewport = useRef<HTMLElement>(null);
  const lastContentFocus = useRef<HTMLElement | null>(null);
  const noticeHadFocus = useRef(false);
  useEffect(() => {
    function rememberFocus(event: FocusEvent) {
      if (!(event.target instanceof HTMLElement)) return;
      noticeHadFocus.current = !!viewport.current?.contains(event.target);
      if (!noticeHadFocus.current) lastContentFocus.current = event.target;
    }
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, []);
  useLayoutEffect(() => {
    if (!noticeHadFocus.current || document.activeElement !== document.body) return;
    const previous = lastContentFocus.current;
    if (previous?.isConnected && (!host || host.kind === "panel" || host.element.closest("dialog")?.contains(previous))) previous.focus();
    else viewport.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [notices, host, expanded]);
  useEffect(() => {
    const next = new Map<string, string>();
    const changes: string[] = [];
    for (const notice of notices) {
      if (notice.dismissed) continue;
      const message = `${notice.title}. ${notice.busy ? "Retrying…" : notice.message}`;
      next.set(notice.id, message);
      if (announced.current.get(notice.id) !== message) changes.push(message);
    }
    announced.current = next;
    if (changes.length) setAnnouncement(changes.join(" "));
    else if (!next.size) setAnnouncement("");
  }, [notices]);
  const visible = notices.filter(notice => !notice.dismissed);
  const displayed = expanded ? visible : visible.slice(0, 3);
  if (!visible.length) return null;
  return createPortal(<section ref={viewport} aria-label="Application notices" className={host?.kind === "panel" ? styles.inPanel : host ? styles.inDialog : styles.viewport}>
    <div className={styles.announcer} role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    <div className={styles.list}>
      {displayed.map(notice => <Appearance key={notice.id} kind="fade">
        <div className={styles.card} data-notice-id={notice.id}>
          <Feedback tone={notice.tone} title={notice.title} busy={notice.busy} details={notice.details} role="group" aria-label={notice.title}>
            {notice.message}
            {notice.action && <div className={styles.actions}><button type="button" className="textButton"
              disabled={notice.busy || host?.busy} onClick={() => void store.getState().run(notice.id)}>
              {notice.busy ? "Retrying…" : notice.actionLabel ?? "Try again"}
            </button></div>}
          </Feedback>
          {notice.dismissible !== false && <button type="button" className={`iconButton ${styles.close}`}
            aria-label={`Dismiss ${notice.title}`} disabled={notice.busy} onClick={() => store.getState().dismiss(notice.id)}>
            <X size={16} aria-hidden="true" />
          </button>}
        </div>
      </Appearance>)}
    </div>
    {visible.length > 3 && <button type="button" className={`button secondary ${styles.more}`} aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? "Show fewer notices" : `View ${visible.length - 3} more notices`}</button>}
  </section>, host?.element ?? document.body);
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createFeedbackStore);
  return <FeedbackContext.Provider value={store}>{children}<NoticeViewport store={store} /></FeedbackContext.Provider>;
}
