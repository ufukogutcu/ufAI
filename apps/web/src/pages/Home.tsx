import { useSettings } from "../settings-store";
import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowRight,
  ChevronDown,
  Pencil,
  Plus,
  Trash2,
  Workflow,
} from "lucide-react";
import { useDashboard } from "../store";
import { errorMessage, RequestError } from "../api";
import { Dialog } from "../components/Dialog";
import { Flowboard } from "../components/Flowboard";
import { Tooltip } from "../components/Tooltip";
import styles from "./Home.module.scss";

type WorkspaceAction =
  { kind: "create" } | { kind: "rename" | "delete"; id: string; name: string };

function WorkspaceDialog({
  action,
  onClose,
}: {
  action: WorkspaceAction;
  onClose: () => void;
}) {
  const [name, setName] = useState(action.kind === "rename" ? action.name : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const createWorkspace = useDashboard((state) => state.createWorkspace);
  const renameWorkspace = useDashboard((state) => state.renameWorkspace);
  const deleteWorkspace = useDashboard((state) => state.deleteWorkspace);
  const title =
    action.kind === "create"
      ? "Create workspace"
      : action.kind === "rename"
        ? "Rename workspace"
        : "Delete workspace";
  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (action.kind === "create") await createWorkspace(name);
      else if (action.kind === "rename") await renameWorkspace(action.id, name);
      else await deleteWorkspace(action.id);
      onClose();
    } catch (error) {
      setError(
        error instanceof RequestError
          ? (error.fields.name ?? error.message)
          : errorMessage(error),
      );
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <form onSubmit={handleSubmit}>
        {action.kind === "delete" ? (
          <p>
            Delete <strong>{action.name}</strong>? This permanently removes the
            workspace and cannot be undone.
          </p>
        ) : (
          <label className="field">
            Workspace name
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
              placeholder="e.g. Product studio"
            />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialogActions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`button ${action.kind === "delete" ? "danger" : "primary"}`}
            disabled={busy}
          >
            {busy ? "Saving…" : title}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export default function Home() {
  const workspaces = useDashboard((state) => state.workspaces);
  const activeId = useSettings(
    (state) => state.snapshot.settings.activeWorkspaceId,
  );
  const selectedWorkspace = useSettings(
    (state) => state.snapshot.activeWorkspace,
  );
  const status = useDashboard((state) => state.workspaceStatus);
  const error = useDashboard((state) => state.workspaceError);
  const total = useDashboard((state) => state.workspaceTotal);
  const offset = useDashboard((state) => state.workspaceOffset);
  const load = useDashboard((state) => state.loadWorkspaces);
  const updateSettings = useSettings((state) => state.update);
  const [action, setAction] = useState<WorkspaceAction | null>(null);
  const active = selectedWorkspace;
  const tabs =
    active && !workspaces.some((workspace) => workspace.id === active.id)
      ? [...workspaces, active]
      : workspaces;
  function select(id: string) {
    void updateSettings({ activeWorkspaceId: id });
  }
  useEffect(() => {
    if (status === "idle") void load();
  }, [load, status]);
  function handleCreate() {
    setAction({ kind: "create" });
  }
  function handleClose() {
    setAction(null);
  }
  function handleRename() {
    if (active) setAction({ kind: "rename", id: active.id, name: active.name });
  }
  function handleDelete() {
    if (active) setAction({ kind: "delete", id: active.id, name: active.name });
  }
  function handleRetry() {
    void load(!!workspaces.length);
  }
  function handleMore() {
    void load(true);
  }
  return (
    <section className={styles.home} aria-label="Home">
      <header className="pageHeader">
        <div>
          <span className="eyebrow">YOUR WORK, CONNECTED</span>
          <h1>
            Workspaces<span className="count">{total}</span>
          </h1>
          <p>A place to bring your agents together.</p>
        </div>
        <span className="localBadge">
          <span />
          Local workspace
        </span>
      </header>
      <div className={styles.workspaceBar}>
        <div className={styles.tabs} role="tablist" aria-label="Workspaces">
          {tabs.map((workspace, index) => (
            <button
              key={workspace.id}
              role="tab"
              id={`tab-${workspace.id}`}
              aria-selected={workspace.id === activeId}
              aria-controls="workspace-panel"
              tabIndex={workspace.id === activeId ? 0 : -1}
              className={`${styles.tab} ${workspace.id === activeId ? styles.active : ""}`}
              onClick={() => select(workspace.id)}
              onKeyDown={(event) => {
                let next: number | undefined;
                if (event.key === "ArrowRight")
                  next = (index + 1) % tabs.length;
                if (event.key === "ArrowLeft")
                  next = (index - 1 + tabs.length) % tabs.length;
                if (event.key === "Home") next = 0;
                if (event.key === "End") next = tabs.length - 1;
                const target = next === undefined ? undefined : tabs[next];
                if (target) {
                  event.preventDefault();
                  select(target.id);
                  document.getElementById(`tab-${target.id}`)?.focus();
                }
              }}
            >
              <Workflow size={14} />
              <span>{workspace.name}</span>
            </button>
          ))}
        </div>
        {offset < total && (
          <Tooltip content="Load more workspaces">
            <button
              className="iconButton"
              aria-label="Load more workspaces"
              disabled={status === "loading"}
              onClick={handleMore}
            >
              <ChevronDown size={17} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="Create workspace">
          <button
            className="iconButton"
            aria-label="Create workspace"
            onClick={handleCreate}
            disabled={
              status === "idle" ||
              status === "loading" ||
              (status === "error" && !workspaces.length)
            }
          >
            <Plus size={17} />
          </button>
        </Tooltip>
        {active && (
          <div className={styles.workspaceActions}>
            <Tooltip content="Rename workspace">
              <button
                className="iconButton"
                aria-label="Rename workspace"
                onClick={handleRename}
              >
                <Pencil size={14} />
              </button>
            </Tooltip>
            <Tooltip content="Delete workspace">
              <button
                className="iconButton"
                aria-label="Delete workspace"
                onClick={handleDelete}
              >
                <Trash2 size={14} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      {error && (
        <div className="errorBanner" role="alert">
          {error}
          <button className="textButton" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
      <div
        id="workspace-panel"
        role={active ? "tabpanel" : undefined}
        aria-labelledby={active ? `tab-${active.id}` : undefined}
        className={styles.canvas}
      >
        {active ? (
          <Flowboard key={active.id} workspaceId={active.id} />
        ) : status === "loading" || status === "idle" ? (
          <div className="centerState" role="status">
            Loading workspaces…
          </div>
        ) : (
          status !== "error" && (
            <div className="centerState">
              <div className="emptyIcon">
                <Workflow size={28} />
              </div>
              <h2>Make room for an idea</h2>
              <p>Create your first workspace to open a flowboard.</p>
              <button className="button primary" onClick={handleCreate}>
                Create workspace
                <ArrowRight size={15} />
              </button>
            </div>
          )
        )}
      </div>
      {action && <WorkspaceDialog action={action} onClose={handleClose} />}
    </section>
  );
}
