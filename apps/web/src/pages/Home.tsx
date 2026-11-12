import { useNavigationGuard } from "../navigation-guard";
import { useSettings } from "../settings-store";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
import { useAgentStore, useAgents } from "../agent-store";
import { Flowboard } from "../components/Flowboard";
import { Tooltip } from "../components/Tooltip";
import styles from "./Home.module.scss";
import { GlassMaterial } from "../components/GlassMaterial";
import { Appearance } from "../components/Appearance";

type WorkspaceAction =
  | { kind: "create" }
  | { kind: "edit"; id: string; name: string; description: string }
  | { kind: "delete"; id: string; name: string };

function WorkspaceDialog({
  action,
  onClose,
}: {
  action: WorkspaceAction;
  onClose: () => void;
}) {
  const [name, setName] = useState(action.kind === "edit" ? action.name : "");
  const [description, setDescription] = useState(
    action.kind === "edit" ? action.description : "",
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const fieldId = useId();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const createWorkspace = useDashboard((state) => state.createWorkspace);
  const updateWorkspace = useDashboard((state) => state.updateWorkspace);
  const deleteWorkspace = useDashboard((state) => state.deleteWorkspace);
  const title =
    action.kind === "create"
      ? "Create workspace"
      : action.kind === "edit"
        ? "Edit workspace"
        : "Delete workspace";
  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setFields({});
    try {
      if (action.kind === "create") await createWorkspace(name, description);
      else if (action.kind === "edit")
        await updateWorkspace(action.id, { name, description });
      else await deleteWorkspace(action.id);
      onClose();
    } catch (error) {
      if (error instanceof RequestError) setFields(error.fields);
      setError(errorMessage(error));
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <form onSubmit={handleSubmit} className={styles.workspaceForm}>
        {action.kind === "delete" ? (
          <p>
            Delete <strong>{action.name}</strong>? This permanently removes the
            workspace, its agents, conversations, and memories, and cancels its
            work. This cannot be undone.
          </p>
        ) : (
          <>
            <label className="field">
              Workspace name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
                placeholder="e.g. Product studio"
                disabled={busy}
                aria-invalid={!!fields.name}
                aria-describedby={
                  fields.name ? `${fieldId}-name-error` : undefined
                }
              />
              {fields.name && (
                <Appearance kind="fade">
                  <span className="fieldError" id={`${fieldId}-name-error`}>
                    {fields.name}
                  </span>
                </Appearance>
              )}
            </label>
            <label className="field">
              Description (optional)
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4000}
                rows={4}
                disabled={busy}
                aria-invalid={!!fields.description}
                aria-describedby={`${fieldId}-description-hint${fields.description ? ` ${fieldId}-description-error` : ""}`}
              />
              <span className="fieldHint" id={`${fieldId}-description-hint`}>
                Describe the main goal of this workspace. You can leave this
                empty.
              </span>
              {fields.description && (
                <Appearance kind="fade">
                  <span
                    className="fieldError"
                    id={`${fieldId}-description-error`}
                  >
                    {fields.description}
                  </span>
                </Appearance>
              )}
            </label>
          </>
        )}
        {error && (
          <Appearance kind="fade">
            <p className="error" role="alert">
              {error}
            </p>
          </Appearance>
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
            {busy ? "Saving…" : action.kind === "edit" ? "Save changes" : title}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export default function Home() {
  const guard = useNavigationGuard();
  const agentStore = useAgentStore();
  const agentError = useAgents((s) => s.positionError || s.error);
  const agentConnected = useAgents((s) => s.connected);
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
  const tabList = useRef<HTMLDivElement>(null);
  const active = selectedWorkspace;
  const tabs =
    active && !workspaces.some((workspace) => workspace.id === active.id)
      ? [...workspaces, active]
      : workspaces;
  useEffect(() => {
    const list = tabList.current;
    if (!list) return;
    const selected = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!selected) return;
    let frame = 0;
    function revealSelection() {
      const bounds = list!.getBoundingClientRect();
      const tab = selected!.getBoundingClientRect();
      if (tab.left < bounds.left) list!.scrollLeft -= bounds.left - tab.left;
      else if (tab.right > bounds.right)
        list!.scrollLeft += tab.right - bounds.right;
    }
    function scheduleReveal() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(revealSelection);
    }
    const observer = new ResizeObserver(scheduleReveal);
    observer.observe(list);
    observer.observe(selected);
    scheduleReveal();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeId, tabs.length]);
  function select(id: string) {
    if (id !== activeId)
      guard(() => void updateSettings({ activeWorkspaceId: id }));
  }
  useEffect(() => {
    if (status === "idle") void load();
  }, [load, status]);
  function handleCreate() {
    guard(() => setAction({ kind: "create" }));
  }
  function handleClose() {
    setAction(null);
  }
  function handleEdit() {
    if (active)
      guard(() =>
        setAction({
          kind: "edit",
          id: active.id,
          name: active.name,
          description: active.description,
        }),
      );
  }
  function handleDelete() {
    if (active)
      guard(() =>
        setAction({ kind: "delete", id: active.id, name: active.name }),
      );
  }
  function handleRetry() {
    void load(!!workspaces.length);
  }
  function handleMore() {
    void load(true);
  }
  return (
    <section className={styles.home} aria-label="Home">
      <div className={styles.workspaceChrome}>
        <div className={`${styles.workspaceBar} glassSurface`}>
          <GlassMaterial />
          <div
            ref={tabList}
            className={styles.tabs}
            role="tablist"
            aria-label="Workspaces"
          >
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
              <Tooltip content="Edit workspace">
                <button
                  className="iconButton"
                  aria-label="Edit workspace"
                  onClick={handleEdit}
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
        {agentError && (
          <div className="errorBanner" role="alert">
            {agentError}{" "}
            <button
              className="textButton"
              onClick={() => void agentStore.getState().retryPositions()}
            >
              Retry saves
            </button>
          </div>
        )}
        {!agentConnected && (
          <p role="status">Live updates disconnected. Reconnecting…</p>
        )}
        {error && (
          <Appearance kind="fade">
            <div className="errorBanner" role="alert">
              {error}
              <button className="textButton" onClick={handleRetry}>
                Retry
              </button>
            </div>
          </Appearance>
        )}
        {active && (
          <header className={`pageHeader ${styles.workspaceHeader}`}>
            <div className={styles.workspaceHeadingRow}>
              <Appearance trigger={active.id}>
                <h1>{active.name}</h1>
              </Appearance>
              <button
                className={`button ${styles.addAgent}`}
                onClick={() =>
                  guard(() => agentStore.setState({ createIn: active.id }))
                }
              >
                <Plus size={15} aria-hidden="true" />
                Add Agent
              </button>
            </div>
            {active.description && (
              <Appearance trigger={active.id}>
                <p>{active.description}</p>
              </Appearance>
            )}
          </header>
        )}
      </div>
      <div
        id="workspace-panel"
        role={active ? "tabpanel" : undefined}
        aria-labelledby={active ? `tab-${active.id}` : undefined}
        className={styles.workspacePanel}
      >
        <div className={styles.canvas}>
          {active ? (
            <Flowboard key={active.id} workspaceId={active.id} />
          ) : status === "loading" || status === "idle" ? (
            <Appearance>
              <div className="centerState" role="status">
                Loading workspaces…
              </div>
            </Appearance>
          ) : (
            status !== "error" && (
              <Appearance>
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
              </Appearance>
            )
          )}
        </div>
      </div>
      {action && <WorkspaceDialog action={action} onClose={handleClose} />}
    </section>
  );
}
