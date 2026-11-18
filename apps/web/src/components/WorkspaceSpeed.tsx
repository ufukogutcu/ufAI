import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Gauge } from "lucide-react";
import { useAgents } from "../agent-store";
import { errorMessage } from "../api";
import { BusyButton, Feedback, LoadingState } from "./Feedback";
import { Tooltip } from "./Tooltip";
import styles from "./Flowboard.module.scss";

function delayLabel(ms: number) {
  return ms ? `+${ms / 1000} s` : "Normal";
}

function spokenDelay(ms: number) {
  return `${ms / 1000} ${ms === 1000 ? "second" : "seconds"} extra`;
}

export function WorkspaceSpeed({ workspaceId }: { workspaceId: string }) {
  const pacing = useAgents(s => s.workspacePacing[workspaceId]);
  const loadError = useAgents(s => s.workspacePacingErrors[workspaceId]);
  const load = useAgents(s => s.loadWorkspacePacing);
  const save = useAgents(s => s.saveWorkspacePacing);
  const [open, setOpen] = useState(false);
  const [bottom, setBottom] = useState(0);
  const [draft, setDraft] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const id = useId();
  const saved = pacing?.extraDelayMs ?? 0;
  const extraDelayMs = draft ?? saved;
  const label = saved ? `Workspace speed, ${spokenDelay(saved)}` : "Workspace speed";

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setDraft(null);
    setError("");
    if (returnFocus) button.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const anchor = button.current;
    if (!open || !anchor) return;
    const updatePosition = () => setBottom(window.innerHeight - anchor.getBoundingClientRect().top + 12);
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(anchor);
    window.addEventListener("resize", updatePosition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [open]);

  useEffect(() => {
    if (open) (range.current ?? popup.current)?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open || saving) return;
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && (popup.current?.contains(event.target) || button.current?.contains(event.target))) return;
      close(false);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close(true);
    }
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [close, open, saving]);

  function toggle() {
    if (saving) return;
    if (open) close(true);
    else {
      setOpen(true);
      if (loadError) void load(workspaceId);
    }
  }

  async function apply() {
    if (!pacing || saving || extraDelayMs === saved) return;
    setSaving(true);
    setError("");
    try {
      await save(workspaceId, extraDelayMs);
      close(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  return <>
    <Tooltip content={open ? "" : label}>
      <button ref={button} type="button" className={`iconButton ${styles.speedButton}`} aria-label={label}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        <Gauge size={16} aria-hidden="true" />
        {saved > 0 && <span aria-hidden="true">{delayLabel(saved)}</span>}
      </button>
    </Tooltip>
    {open && createPortal(<div ref={popup} id={id} tabIndex={-1} role="dialog" aria-labelledby={`${id}-heading`}
      className={styles.speedPopup} style={{ "--speed-popup-bottom": `${bottom}px` } as CSSProperties}>
      <h2 id={`${id}-heading`}>Workspace speed</h2>
      {!pacing && !loadError && <LoadingState>Loading workspace speed…</LoadingState>}
      {loadError && <Feedback title="Workspace speed could not sync">{loadError}
        <button type="button" className="textButton" onClick={() => void load(workspaceId)}>Retry</button>
      </Feedback>}
      {pacing && <>
        <div className={styles.speedValue}>
          <label htmlFor={`${id}-range`}>Extra delay</label>
          <span aria-hidden="true">{delayLabel(extraDelayMs)}</span>
        </div>
        <input ref={range} id={`${id}-range`} className={styles.speedRange} type="range"
          min={0} max={3000} step={500} value={extraDelayMs}
          aria-valuetext={extraDelayMs ? spokenDelay(extraDelayMs) : "Normal speed"}
          aria-describedby={`${id}-help`} disabled={saving}
          onChange={event => { setDraft(event.currentTarget.valueAsNumber); setError(""); }} />
        <p id={`${id}-help`}>Slows task rounds and agent messages. Chat stays at normal speed.</p>
      </>}
      {error && <Feedback>{error}</Feedback>}
      <div className={styles.speedActions}>
        <button type="button" className="button" disabled={saving} onClick={() => close(true)}>Cancel</button>
        <BusyButton type="button" className="button primary" busy={saving}
          disabled={!pacing || !!loadError || extraDelayMs === saved} onClick={() => void apply()}>Apply</BusyButton>
      </div>
    </div>, document.body)}
  </>;
}
