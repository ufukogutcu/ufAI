import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStoreApi as useFlowStoreApi } from "@xyflow/react";
import { CircleAlert, TriangleAlert, X } from "lucide-react";
import type { AgentIssue, Page } from "../../../server/src/contracts";
import { errorMessage, request } from "../api";
import { useAgents } from "../agent-store";
import { Appearance } from "./Appearance";
import styles from "./AgentIssues.module.scss";

function IssueList({ agentId, severity, count }: { agentId: string; severity: AgentIssue["severity"]; count: number }) {
  const version = useAgents(s => s.eventVersion);
  const [page, setPage] = useState<Page<AgentIssue>>({ items: [], total: count });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const nextOffset = useRef(0);
  const loading = useRef(false);

  const load = useCallback(async (offset: number) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    nextOffset.current = offset;
    loading.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request<Page<AgentIssue>>(
        `/agents/${encodeURIComponent(agentId)}/issues?severity=${severity}&limit=20&offset=${offset}`,
        "GET", undefined, controller.signal,
      );
      if (controller.signal.aborted) return;
      setPage(previous => ({
        total: result.total,
        items: offset ? [...new Map([...previous.items, ...result.items].map(item => [item.id, item])).values()] : result.items,
      }));
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) {
        loading.current = false;
        setBusy(false);
      }
    }
  }, [agentId, severity]);

  useEffect(() => {
    void load(0);
    return () => pending.current?.abort();
  }, [load, version, count, retry]);

  function more() {
    if (!loading.current) void load(page.items.length);
  }
  function tryAgain() {
    if (nextOffset.current) void load(nextOffset.current);
    else setRetry(value => value + 1);
  }
  return <>
    <div className={styles.scroll} tabIndex={0} aria-label={`${severity === "warning" ? "Warning" : "Error"} details`}>
      <ul className={styles.list}>
        {page.items.map(issue => <li key={issue.id}>
          {issue.taskTitle && <strong>{issue.taskTitle}</strong>}
          <p>{issue.message}</p>
        </li>)}
      </ul>
      {!busy && !error && !page.items.length && <p>No current {severity === "warning" ? "warnings" : "errors"}.</p>}
    </div>
    <div className={styles.feedback} role="status" aria-live="polite">
      {busy && <p>Loading issues…</p>}
      {error && <p className="error">{error}</p>}
    </div>
    {error ? <button type="button" className={`button secondary ${styles.action}`} onClick={tryAgain}>Retry</button>
      : page.items.length < page.total && <button type="button" className={`button secondary ${styles.action}`} disabled={busy} onClick={more}>Load more</button>}
  </>;
}

export function AgentIssueBubble({ agentId, agentName, severity, count }: {
  agentId: string; agentName: string; severity: AgentIssue["severity"]; count: number;
}) {
  const id = useId();
  const flow = useFlowStoreApi();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const opening = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const hovered = useRef(false);
  const restoringFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const plural = severity === "warning" ? "warnings" : "errors";
  const Icon = severity === "warning" ? TriangleAlert : CircleAlert;

  const close = useCallback(() => {
    clearTimeout(opening.current);
    clearTimeout(closing.current);
    pinned.current = false;
    setOpen(false);
    setPosition(null);
    if (popup.current?.contains(document.activeElement)) {
      restoringFocus.current = true;
      trigger.current?.focus();
      restoringFocus.current = false;
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    return flow.subscribe((next, previous) => {
      if (next.transform !== previous.transform) close();
    });
  }, [flow, open, close]);
  useEffect(() => () => {
    clearTimeout(opening.current);
    clearTimeout(closing.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }
    function outside(event: PointerEvent) {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    }
    function scroll(event: Event) {
      if (!popup.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const anchor = trigger.current;
    const bubble = popup.current;
    function place() {
      const rect = anchor.getBoundingClientRect();
      const { width, height } = bubble.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const above = rect.top - height - 8;
      setPosition({
        left: Math.max(8, Math.min(rect.left + (rect.width - width) / 2, viewportWidth - width - 8)),
        top: Math.max(8, Math.min(above >= 8 ? above : rect.bottom + 8, viewportHeight - height - 8)),
      });
    }
    place();
    const observer = new ResizeObserver(place);
    observer.observe(bubble);
    return () => observer.disconnect();
  }, [open]);

  function enter() {
    hovered.current = true;
    clearTimeout(closing.current);
  }
  function leave() {
    hovered.current = false;
    clearTimeout(opening.current);
    clearTimeout(closing.current);
    closing.current = setTimeout(() => {
      if (!pinned.current && !hovered.current && document.activeElement !== trigger.current && !popup.current?.contains(document.activeElement)) close();
    }, 120);
  }
  return <>
    <button type="button" ref={trigger}
      className={`nodrag nopan ${styles.trigger}`}
      aria-label={`${count} ${count === 1 ? severity : plural} for ${agentName}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onPointerDown={event => event.stopPropagation()}
      onPointerEnter={event => {
        if (event.pointerType !== "mouse") return;
        enter();
        opening.current = setTimeout(() => setOpen(true), 400);
      }}
      onPointerLeave={event => { if (event.pointerType === "mouse") leave(); }}
      onFocus={event => {
        if (event.currentTarget.matches(":focus-visible") && !restoringFocus.current) {
          clearTimeout(opening.current);
          clearTimeout(closing.current);
          setOpen(true);
        }
      }}
      onBlur={event => { if (!popup.current?.contains(event.relatedTarget)) leave(); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" && open) {
          event.preventDefault();
          popup.current?.focus();
        }
      }}
      onClick={event => {
        event.stopPropagation();
        clearTimeout(opening.current);
        if (open && pinned.current) close();
        else { pinned.current = true; setOpen(true); }
      }}>
      <span className={`${styles.bubble} ${styles[severity]}`} aria-hidden="true">{count}</span>
    </button>
    {open && createPortal(<Appearance kind="fade" ready={!!position}>
      <div ref={popup} id={id} role="dialog" tabIndex={-1} aria-label={`${agentName}: ${plural}`}
        className={`${styles.popover} nodrag nopan nowheel ${position ? "" : styles.measuring}`}
        style={position ?? undefined}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
        onPointerEnter={event => { if (event.pointerType === "mouse") enter(); }}
        onPointerLeave={event => { if (event.pointerType === "mouse") leave(); }}
        onFocus={() => clearTimeout(closing.current)}
        onBlur={event => { if (!popup.current?.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) leave(); }}>
        <header><Icon size={12} aria-hidden="true" /><h3>{severity === "warning" ? "Warnings" : "Errors"} ({count})</h3>
          <button type="button" className={`iconButton ${styles.close}`} aria-label="Close issues" onClick={close}><X size={14} aria-hidden="true" /></button>
        </header>
        <IssueList agentId={agentId} severity={severity} count={count} />
      </div>
    </Appearance>, document.body)}
  </>;
}
