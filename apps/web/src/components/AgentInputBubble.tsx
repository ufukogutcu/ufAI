import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
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
  const [page, setPage] = useState<Page<UserInputRequest>>({ items: [], total: count });
  const [offset, setOffset] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const version = useAgents(s => open ? s.eventVersion : 0);
  const guard = useNavigationGuard(), pending = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError("");
    try {
      const result = await request<Page<UserInputRequest>>(`/user-input-requests?agentId=${encodeURIComponent(agentId)}&state=pending&limit=20&offset=${offset}`, "GET", undefined, controller.signal);
      if (!controller.signal.aborted) {
        if (!result.items.length && result.total && offset) setOffset(Math.max(0, offset - 20));
        else setPage(result);
      }
    } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [agentId, offset]);
  useEffect(() => {
    if (!open) return;
    void load();
    return () => pending.current?.abort();
  }, [open, load, version, count]);
  function close() { guard(() => setOpen(false)); }
  return <>
    {count > 0 && <Tooltip content="Awaiting your input" live><button type="button" className={`nodrag nopan ${styles.trigger}`} aria-label={`${count} pending input ${count === 1 ? "request" : "requests"} for ${agentName}: awaiting your input`} aria-haspopup="dialog" aria-expanded={open} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); guard(() => { setOffset(0); setOpen(true); }); }}><span className={styles.bubble} aria-hidden="true">{count}</span></button></Tooltip>}
    {open && createPortal(<Dialog title={`${agentName}: Awaiting Your Input`} onClose={close} returnFocusFallbackRef={fallbackRef} initialFocusSelector="[data-input-list]" className={styles.dialog}>
      <div data-input-list tabIndex={-1} className={styles.list} aria-label="Pending input requests">
        {page.items.map(item => <div key={item.id}><p className={styles.task}>{item.taskTitle}</p><UserInputCard requestId={item.id} item={item} refreshKey={version} onChange={load} /></div>)}
        {!loading && !error && !page.items.length && <p role="status">No pending requests.</p>}
        {loading && <LoadingState>Loading requests…</LoadingState>}
        {error && <Feedback>{error} <button className="textButton" type="button" onClick={() => void load()}>Retry</button></Feedback>}
      </div>
      {(offset > 0 || offset + page.items.length < page.total) && <div className={styles.actions}><button type="button" className="button secondary" disabled={loading || !offset} onClick={() => guard(() => setOffset(Math.max(0, offset - 20)))}>Previous</button><button type="button" className="button secondary" disabled={loading || offset + page.items.length >= page.total} onClick={() => guard(() => setOffset(offset + 20))}>Next</button></div>}
    </Dialog>, document.body)}
  </>;
}
