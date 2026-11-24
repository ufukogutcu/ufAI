import { useState } from "react";
import { createPortal } from "react-dom";
import type { Agent } from "../../../server/src/contracts";
import { useAgentStore } from "../agent-store";
import { errorMessage } from "../api";
import { Dialog } from "./Dialog";
import { BusyButton, Feedback, LoadingState } from "./Feedback";
import styles from "./AgentPanel.module.scss";

export function AgentDeleteDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const store = useAgentStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await store.getState().remove(agent.id); onClose(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return createPortal(<Dialog title="Delete agent?" busy={busy} onClose={onClose} initialFocusSelector="button[data-keep-agent]">
    <p>
      Permanently delete {agent.name}, its conversations, memories, and
      all files in its agent and task folders? Its work will be cancelled.
      This cannot be undone. Published files remain in the workspace.
    </p>
    {error && <Feedback role="alert">{error}</Feedback>}
    {busy && <LoadingState>Cleaning up files… This continues if the page closes.</LoadingState>}
    <div className={styles.actions}>
      <button type="button" data-keep-agent className="button" disabled={busy} onClick={onClose}>Keep Agent</button>
      <BusyButton busy={busy} className="button danger" disabled={busy} onClick={() => void remove()}>
        {busy ? "Deleting files…" : "Delete Agent and files"}
      </BusyButton>
    </div>
  </Dialog>, document.body);
}
