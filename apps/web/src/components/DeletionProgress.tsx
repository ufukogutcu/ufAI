import { useEffect, useState } from "react";
import { useAgents, useAgentStore, emptyList } from "../agent-store";
import { useSettings } from "../settings-store";
import { request, errorMessage } from "../api";
import { finishDeletion } from "../managed-files";
import type { DeletionOperation } from "../../../server/src/contracts";
import styles from "./Clusters.module.scss";
export function DeletionProgress({ workspaceId }: { workspaceId: string }) {
  const store = useAgentStore(),
    operations = useAgents((s) => s.deletions[workspaceId] ?? emptyList);
  const refreshSettings = useSettings((s) => s.refresh);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const running = operations.some(
    (op) => op.state === "pending" || op.state === "running",
  );
  useEffect(() => {
    if (!running) return;
    let stopped = false,
      pending = false;
    const timer = setInterval(() => {
      if (stopped || pending) return;
      pending = true;
      void Promise.all(
        operations.map((op) =>
          request<DeletionOperation>(`/deletions/${op.id}`),
        ),
      )
        .then(async (values) => {
          if (stopped) return;
          store.setState((s) => ({
            deletions: {
              ...s.deletions,
              [workspaceId]: values.filter((op) => op.state !== "completed"),
            },
          }));
          if (values.some((op) => op.state === "completed")) {
            await refreshSettings();
            void store.getState().loadWorkspace(workspaceId);
          }
        })
        .catch((e) => {
          if (!stopped) setError(errorMessage(e));
        })
        .finally(() => {
          pending = false;
        });
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running, operations, store, workspaceId, refreshSettings]);
  async function retry(id: string) {
    setBusy(true);
    setError("");
    try {
      await finishDeletion(
        await request<DeletionOperation>(`/deletions/${id}/retry`, "POST"),
      );
      await refreshSettings();
      await store.getState().loadWorkspace(workspaceId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!operations.length && !error) return null;
  return (
    <div aria-live="polite">
      {operations.map((op) => (
        <div className={styles.progress} key={op.id}>
          {op.kind === "workspace"
            ? "Workspace"
            : op.kind === "cluster"
              ? "Cluster"
              : "Agent"}{" "}
          file deletion: {op.state === "failed" ? op.error : "Cleaning up…"}
          {op.state === "failed" && (
            <button
              className="textButton"
              disabled={busy}
              onClick={() => void retry(op.id)}
            >
              Retry deletion
            </button>
          )}
        </div>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
