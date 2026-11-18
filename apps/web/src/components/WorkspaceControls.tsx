import { useCallback, useEffect, useRef, useState } from "react";
import { Panel } from "@xyflow/react";
import { Pause, Play } from "lucide-react";
import type { FreezePolicy } from "../../../server/src/contracts";
import { useAgents, useAgentStore } from "../agent-store";
import { errorMessage } from "../api";
import { Dialog } from "./Dialog";
import { BusyButton, Feedback } from "./Feedback";
import { useNotice } from "./FeedbackProvider";
import { freezeChoices } from "./AgentFreeze";
import { GlassMaterial } from "./GlassMaterial";
import { Tooltip } from "./Tooltip";
import { WorkspaceSpeed } from "./WorkspaceSpeed";
import freezeStyles from "./AgentFreeze.module.scss";
import styles from "./Flowboard.module.scss";

export function useWorkspacePause(workspaceId: string) {
  const store = useAgentStore();
  const control = useAgents(s => s.workspaceControls[workspaceId]);
  const loadError = useAgents(s => s.workspaceControlErrors[workspaceId]);
  const [open,setOpen] = useState(false);
  const [busy,setBusy] = useState(false);
  const [checkingWorkspace,setCheckingWorkspace] = useState<string | null>(null);
  const [error,setError] = useState("");
  const [policy,setPolicy] = useState<FreezePolicy>("all");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const state = control?.state;
  const checking = checkingWorkspace === workspaceId;
  const pending = busy || checking || !control || !!loadError || state === "freezing" || state === "resuming";
  const label = loadError ? "Workspace pause state unavailable" : !control ? "Loading workspace controls…"
    : checking ? "Checking queued triggers…"
    : state === "freezing" ? "Pausing workspace…" : state === "resuming" ? "Preparing resume…"
    : state === "frozen" ? "Resume workspace…" : "Pause workspace";
  const close = useCallback(() => { setOpen(false); setError(""); },[]);
  const submit = useCallback(async (action:"pause"|"resume", selection?:FreezePolicy) => {
    setBusy(true); setError("");
    try {
      await store.getState().controlWorkspace(workspaceId,action,selection);
      setOpen(false);
    } catch (failure) {
      setError(errorMessage(failure));
      await store.getState().loadWorkspaceControl(workspaceId).catch(() => {});
    } finally { setBusy(false); }
  },[store,workspaceId]);
  useEffect(() => {
    if (!checking) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        await store.getState().loadWorkspaceControl(workspaceId);
        if (cancelled) return;
        const current = store.getState().workspaceControls[workspaceId];
        if (current?.state === "frozen") {
          if (current.queuedTriggerCount > 0) {
            setPolicy("all"); setError(""); setOpen(true);
          } else if (current.backlogPending) {
            // An incomplete count of zero does not establish an empty queue.
            timer = setTimeout(() => void check(),500);
            return;
          } else await submit("resume","all");
        }
      } catch (failure) {
        if (!cancelled) setError(errorMessage(failure));
      }
      if (!cancelled) setCheckingWorkspace(null);
    }
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  },[checking,store,submit,workspaceId]);
  const activate = useCallback(() => {
    if (pending) return;
    if (state === "active") { void submit("pause"); return; }
    setError(""); setCheckingWorkspace(workspaceId);
  },[pending,state,submit,workspaceId]);
  const retryLoad = useCallback(() => { setError(""); void store.getState().loadWorkspaceControl(workspaceId).catch(() => {}); },[store,workspaceId]);
  const dialog = open ? <Dialog title={state === "active" ? "Pause workspace" : "Resume workspace"} onClose={close} busy={busy} returnFocusFallbackRef={triggerRef}>
    <div className={freezeStyles.content}>
      {error && <Feedback>{error}</Feedback>}
      {loadError && <Feedback title="Workspace pause state could not load">{loadError}
        <button className="textButton" onClick={retryLoad} disabled={busy}>Retry workspace controls</button>
      </Feedback>}
      {control && state === "frozen" && <>
        <p>{control.queuedTriggerCount} queued trigger occurrences{control.backlogPending ? "; additional occurrences are still being collected" : ""} for {control.resumeAgentCount} agents to resume.</p>
        <p>Interrupted work resumes first. Choose how to handle triggers pending when you confirm. Triggers replay one at a time per agent.</p>
        <p>Individually frozen agents stay frozen. This choice does not change their queued triggers.</p>
        <fieldset className={freezeStyles.choices}><legend>Queued triggers</legend>{freezeChoices.map(choice => <label key={choice.value}>
          <input type="radio" name={`workspace-freeze-policy-${workspaceId}`} value={choice.value} checked={policy === choice.value} onChange={() => setPolicy(choice.value)} disabled={busy} />
          <span><strong>{choice.label}</strong><small>{choice.description}</small></span>
        </label>)}</fieldset>
      </>}
      <div className={freezeStyles.actions}>
        <button className="button" onClick={close} disabled={busy}>Cancel</button>
        {(state === "active" || state === "frozen") && <BusyButton className="button primary" busy={busy} disabled={!!loadError}
          onClick={() => void submit(state === "active" ? "pause" : "resume",policy)}>{state === "active" ? "Pause workspace" : "Resume workspace"}</BusyButton>}
      </div>
    </div>
  </Dialog> : null;
  return {activate,dialog,pending,label,state,loadError,retryLoad,triggerRef,actionError:open ? "" : error};
}

export function WorkspaceControls({ workspaceId }: { workspaceId: string }) {
  const pause = useWorkspacePause(workspaceId);
  const sourceId = `workspace-control:${workspaceId}`;
  useNotice(pause.loadError ? {id:sourceId,title:"Workspace controls could not sync",message:pause.loadError,
    actionLabel:"Retry workspace controls",action:pause.retryLoad} : pause.actionError ? {
      id:sourceId,title:"Workspace control failed",message:pause.actionError,
      actionLabel:"Try again",action:pause.activate,
    } : null,sourceId);
  return <>
    <Panel position="bottom-center" className={`${styles.workspaceControls} glassSurface`} aria-label="Workspace controls" role="group">
      <GlassMaterial />
      <Tooltip content={pause.label}><button ref={pause.triggerRef} className="iconButton" aria-label={pause.label}
        aria-pressed={pause.state === "frozen" || pause.state === "resuming"} disabled={pause.pending} onClick={pause.activate}>
        {pause.state === "frozen" || pause.state === "resuming" ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
      </button></Tooltip>
      <WorkspaceSpeed key={workspaceId} workspaceId={workspaceId} />
      <span className={styles.controlStatus} role="status">{pause.pending ? pause.label : pause.state === "frozen" ? "Workspace paused" : ""}</span>
    </Panel>
    {pause.dialog}
  </>;
}
