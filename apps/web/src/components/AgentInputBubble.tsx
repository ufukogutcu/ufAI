import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import type { Page } from "../../../server/src/contracts";
import type { UserInputRequest } from "../../../server/src/vault-types";
import { useAgents } from "../agent-store";
import { errorMessage, request } from "../api";
import { useNavigationGuard } from "../navigation-guard";
import { Dialog } from "./Dialog";
import { Feedback, LoadingState } from "./Feedback";
import { Tooltip } from "./Tooltip";
import { UserInputCard } from "./UserInputCard";
import styles from "./AgentInputBubble.module.scss";

export function AgentInputBubble({ agentId, agentName, count, fallbackRef }: { agentId: string; agentName: string; count: number; fallbackRef: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page<UserInputRequest> & { offset: number | null }>({ items: [], total: 0, offset: null });
  const [offset, setOffset] = useState(0), [error, setError] = useState("");
  const loadingPage = page.offset !== offset && !error;
  const version = useAgents(s => open ? s.eventVersion : 0);
  const guard = useNavigationGuard(), pending = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const focusedRequest = useRef<HTMLElement | null>(null);
  const load = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    try {
      const result = await request<Page<UserInputRequest>>(`/user-input-requests?agentId=${encodeURIComponent(agentId)}&state=pending&limit=20&offset=${offset}`, "GET", undefined, controller.signal);
      if (!controller.signal.aborted) {
        setError("");
        if (!result.items.length && result.total && offset) setOffset(Math.max(0, offset - 20));
        else setPage({ ...result, offset });
      }
    } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
  }, [agentId, offset]);
  useEffect(() => {
    if (!open) return;
    void load();
    return () => pending.current?.abort();
  }, [open, load, version, count]);
  useLayoutEffect(() => {
    if (!open || !focusedRequest.current || focusedRequest.current.isConnected) return;
    focusedRequest.current = null;
    if (document.activeElement === document.body) list.current?.focus();
  }, [open, page]);
  function openDialog(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    guard(() => { setOffset(0); setError(""); setOpen(true); });
  }
  function changePage(nextOffset: number) {
    guard(() => { setOffset(nextOffset); setError(""); });
  }
  function close() { guard(() => setOpen(false)); }
  return <>
    {count > 0 && <Tooltip content="Awaiting your input" live><button type="button" className={`nodrag nopan ${styles.trigger}`} aria-label={`${count} pending input ${count === 1 ? "request" : "requests"} for ${agentName}: awaiting your input`} aria-haspopup="dialog" aria-expanded={open} onPointerDown={e => e.stopPropagation()} onClick={openDialog}><span className={styles.bubble} aria-hidden="true">{count}</span></button></Tooltip>}
    {open && createPortal(<Dialog title={`${agentName}: Awaiting Your Input`} onClose={close} returnFocusFallbackRef={fallbackRef} initialFocusSelector="[data-input-list]" className={styles.dialog}>
      <div ref={list} data-input-list tabIndex={-1} className={styles.list} aria-label="Pending input requests"
        onFocusCapture={event => { focusedRequest.current = (event.target as HTMLElement).closest("[data-input-request]"); }}
        onBlurCapture={event => {
          if (event.relatedTarget && !list.current?.contains(event.relatedTarget)) focusedRequest.current = null;
        }}>
        {page.items.map(item => <div key={item.id} data-input-request>
          {item.taskTitle && <p className={styles.task}>{item.taskTitle}</p>}
          <UserInputCard requestId={item.id} item={item} refreshKey={version} onChange={load} />
        </div>)}
        {!loadingPage && !error && !page.items.length && <p role="status">No pending requests.</p>}
        {loadingPage && <LoadingState>Loading requests…</LoadingState>}
        {error && <Feedback>{error} <button className="textButton" type="button" onClick={() => void load()}>Retry</button></Feedback>}
      </div>
      {(offset > 0 || offset + page.items.length < page.total) && <div className={styles.actions}>
        <button type="button" className="button secondary" disabled={loadingPage || !offset} onClick={() => changePage(Math.max(0, offset - 20))}>Previous</button>
        <button type="button" className="button secondary" disabled={loadingPage || offset + page.items.length >= page.total} onClick={() => changePage(offset + 20)}>Next</button>
      </div>}
    </Dialog>, document.body)}
  </>;
}
