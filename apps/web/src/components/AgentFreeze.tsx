import { useCallback, useState } from "react";
import { Snowflake } from "lucide-react";
import type { Agent, FreezePolicy } from "../../../server/src/contracts";
import { useAgentStore } from "../agent-store";
import { errorMessage } from "../api";
import { Dialog } from "./Dialog";
import { BusyButton, Feedback } from "./Feedback";
import { Tooltip } from "./Tooltip";
import styles from "./AgentFreeze.module.scss";

export function freezeLabel(agent: Agent) {
  switch (agent.executionControl?.state) {
    case "freezing": return "Freezing…";
    case "frozen": return "Frozen";
    case "resuming": return "Preparing resume…";
    default: return "";
  }
}
export function FrozenIndicator({agent}: {agent:Agent}) {
  const label = freezeLabel(agent);
  if (!label) return null;
  return <Tooltip content={label}><span className={styles.indicator} role="img" aria-label={label}><Snowflake size={14} aria-hidden="true" /></span></Tooltip>;
}

const choices: {value:FreezePolicy;label:string;description:string}[] = [
  {value:"all",label:"Run all",description:"Run every queued occurrence, one at a time."},
  {value:"skip",label:"Skip all",description:"Skip queued triggers and continue interrupted work."},
  {value:"latest_per_trigger",label:"Latest per trigger",description:"Keep only the newest queued occurrence of each trigger."},
];

export function useAgentFreeze(agent: Agent | undefined) {
  const store = useAgentStore();
  const [open,setOpen] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [policy,setPolicy] = useState<FreezePolicy>("all");
  const close = useCallback(() => { setOpen(false); setError(""); },[]);
  const state = agent?.executionControl?.state ?? "active";
  const pending = busy || state === "freezing" || state === "resuming";
  const submit = useCallback(async (action:"freeze"|"resume",selection?:FreezePolicy) => {
    if (!agent) return;
    setBusy(true); setError("");
    try {
      await store.getState().freezeControl(agent.id,action,selection);
      setOpen(false);
    } catch (failure) {
      setError(errorMessage(failure)); setOpen(true);
      void store.getState().refreshAgent(agent.id);
    } finally { setBusy(false); }
  },[agent,store]);
  const activate = useCallback(() => {
    if (!agent || pending) return;
    if (state === "active") { void submit("freeze"); return; }
    // Always refresh before making a queue decision; the final cutoff is server-owned.
    setBusy(true);
    void store.getState().refreshAgent(agent.id).then(async () => {
      const current = store.getState().agents[agent.id];
      if (current?.executionControl?.state !== "frozen") return;
      if (current.executionControl.queuedTriggerCount || current.executionControl.backlogPending) {
        setPolicy("all"); setError(""); setOpen(true);
      } else await submit("resume","all");
    }).catch(failure => { setError(errorMessage(failure)); setOpen(true); }).finally(()=>setBusy(false));
  },[agent,pending,state,store,submit]);
  const dialog = open && agent ? <Dialog title={`Unfreeze ${agent.name}`} onClose={close} busy={busy}>
    <div className={styles.content}>
      {error && <Feedback>{error}</Feedback>}
      {state === "frozen" && <>
        <p>{agent.executionControl?.queuedTriggerCount ?? 0} queued trigger occurrences{agent.executionControl?.backlogPending ? "; additional occurrences are still being collected" : ""}.</p>
        <p>Interrupted work resumes first. New messages stay queued. Choose how to handle triggers pending when you confirm.</p>
        <fieldset className={styles.choices}><legend>Queued triggers</legend>{choices.map(choice => <label key={choice.value}>
          <input type="radio" name={`freeze-policy-${agent.id}`} value={choice.value} checked={policy === choice.value} onChange={()=>setPolicy(choice.value)} disabled={busy} />
          <span><strong>{choice.label}</strong><small>{choice.description}</small></span>
        </label>)}</fieldset>
      </>}
      <div className={styles.actions}><button className="button" onClick={close} disabled={busy}>Cancel</button>
        {state === "frozen" && <BusyButton className="button primary" busy={busy} onClick={()=>void submit("resume",policy)}>Unfreeze</BusyButton>}
      </div>
    </div>
  </Dialog> : null;
  return {activate,dialog,pending,label:state === "active" ? "Freeze Agent" : state === "frozen" ? "Unfreeze Agent…" : freezeLabel(agent!)};
}
