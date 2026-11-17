import { useEffect, useRef } from "react";
import { useAgents, useAgentStore } from "../agent-store";
import { useFeedbackStore, useNotice } from "./FeedbackProvider";

export function LiveConnectionFeedback({ workspaceId, connected }: { workspaceId: string; connected: boolean }) {
  const store = useFeedbackStore();
  const shown = useRef(false);
  const everConnected = useRef(false);
  const sourceId = `live-updates:${workspaceId}`;
  useEffect(() => {
    if (!store) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!connected) {
      store.getState().remove(sourceId);
      timer = setTimeout(() => {
        shown.current = true;
        store.getState().publish({ id: sourceId, title: everConnected.current ? "Reconnecting to live updates…" : "Connecting to live updates…",
          message: "Updates may be delayed. ufAI will reconnect automatically.", tone: "loading", dismissible: false });
      }, 1000);
    } else {
      everConnected.current = true;
      if (shown.current) {
        shown.current = false;
        store.getState().publish({ id: sourceId, title: "Live updates restored", message: "Your workspace is connected again.", tone: "success" });
        timer = setTimeout(() => store.getState().remove(sourceId), 3000);
      }
    }
    return () => clearTimeout(timer);
  }, [store, sourceId, connected]);
  useEffect(() => () => store?.getState().remove(sourceId), [store, sourceId]);
  return null;
}

export function WorkspaceFeedback({ workspaceId }: { workspaceId: string }) {
  const store = useAgentStore();
  const connected = useAgents(state => state.connectionWorkspaceId === workspaceId && state.connected);
  const error = useAgents(state => state.errorWorkspaceId === workspaceId ? state.error : "");
  const actionLabel = useAgents(state => state.errorActionLabel);
  const sourceId = `agents:${workspaceId}`;
  useNotice(error ? { id: sourceId, title: "Agent updates could not load", message: error, actionLabel,
    action: async () => {
      const retry = store.getState().retryError;
      if (retry) await retry();
      else await store.getState().loadWorkspace(workspaceId);
    } } : null, sourceId);
  return <LiveConnectionFeedback workspaceId={workspaceId} connected={connected} />;
}
