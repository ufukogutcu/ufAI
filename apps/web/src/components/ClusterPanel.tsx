import { useState, type FormEvent } from "react";
import { useAgents, useAgentStore } from "../agent-store";
import { useUnsavedChanges, useNavigationGuard } from "../navigation-guard";
import { errorMessage } from "../api";
import { Dialog } from "./Dialog";
import { FolderLocation } from "./FolderLocation";
import type { Cluster } from "../../../server/src/contracts";
import styles from "./Clusters.module.scss";

function ClusterEditor({
  cluster,
  onClose,
  workspaceId,
  position,
}: {
  cluster?: Cluster;
  onClose: () => void;
  workspaceId: string;
  position: { x: number; y: number };
}) {
  const store = useAgentStore(),
    guard = useNavigationGuard();
  const [draft, setDraft] = useState({
    name: cluster?.name ?? "",
    description: cluster?.description ?? "",
  });
  const [baseline, setBaseline] = useState(draft),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState(false);
  useUnsavedChanges(JSON.stringify(draft) !== JSON.stringify(baseline));
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (cluster) await store.getState().updateCluster(cluster.id, draft);
      else
        await store
          .getState()
          .createCluster(workspaceId, { ...draft, ...position });
      setBaseline(draft);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await store.getState().removeCluster(cluster!.id);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        deleting ? "Delete Cluster?" : cluster ? "Edit Cluster" : "New Cluster"
      }
      busy={busy}
      onClose={() => guard(onClose)}
    >
      {deleting ? (
        <>
          <p>
            Permanently delete <strong>{cluster?.name}</strong> and all files in
            its shared folder? Active member work and processes will stop.
            Its agents, their files, tasks, and histories
            will be kept outside the Cluster. This cannot be undone.
          </p>
          {busy && (
            <p role="status">
              Deleting shared files… Cleanup continues if this page closes.
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="dialogActions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "Deleting…" : "Delete Cluster and files"}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={save} className={styles.editor}>
          <label className="field">
            Cluster name
            <input
              name="clusterName"
              autoComplete="off"
              autoFocus
              required
              maxLength={120}
              value={draft.name}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="field">
            Description (optional)
            <textarea
              name="clusterDescription"
              rows={4}
              maxLength={4000}
              disabled={busy}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </label>
          {cluster && (
            <FolderLocation
              kind="cluster"
              ownerId={cluster.id}
              label="Cluster shared folder"
            />
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="dialogActions">
            {cluster && (
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                Delete Cluster…
              </button>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => guard(onClose)}
            >
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? "Saving…" : cluster ? "Save changes" : "Create Cluster"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
export function ClusterPanel({
  workspaceId,
  position,
}: {
  workspaceId: string;
  position: { x: number; y: number };
}) {
  const store = useAgentStore();
  const selected = useAgents((s) =>
    s.selectedCluster ? s.clusters[s.selectedCluster] : undefined,
  );
  const create = useAgents((s) => s.createClusterIn === workspaceId);
  if (!create && (!selected || selected.workspaceId !== workspaceId))
    return null;
  return (
    <ClusterEditor
      key={create ? "new" : selected!.id}
      workspaceId={workspaceId}
      cluster={create ? undefined : selected}
      position={position}
      onClose={() =>
        store.setState({ createClusterIn: null, selectedCluster: null })
      }
    />
  );
}
