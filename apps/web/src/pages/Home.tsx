import { WorkspaceInboxButton } from "../components/Messaging";
import { WorkspaceTriggersButton } from "../components/Triggers";
import { PublishedFiles } from "../components/TaskTools";
import { FolderLocation } from "../components/FolderLocation";
import { DeletionProgress } from "../components/DeletionProgress";
import { useNavigationGuard } from "../navigation-guard";
import { useSettings } from "../settings-store";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  Copy,
  Ellipsis,
  ArrowRight,
  ChevronDown,
  Pencil,
  Plus,
  Trash2,
  Workflow,
  FolderOpen,
} from "lucide-react";
import { useDashboard } from "../store";
import { errorMessage, request, RequestError } from "../api";
import { Dialog } from "../components/Dialog";
import { useAgentStore, useAgents } from "../agent-store";
import { Flowboard } from "../components/Flowboard";
import { Tooltip } from "../components/Tooltip";
import styles from "./Home.module.scss";
import { GlassMaterial } from "../components/GlassMaterial";
import { Appearance } from "../components/Appearance";
import { AddAgentButton } from "../components/AddAgentButton";
import { useNotice } from "../components/FeedbackProvider";
import { Feedback, BusyButton, LoadingState } from "../components/Feedback";

import { ContextMenu, type ContextMenuAnchor } from "../components/ContextMenu";
import { WorkspaceTab } from "../components/WorkspaceTab";
import { WorkspaceDuplicate } from "../components/WorkspaceDuplicate";
import { refreshOnFocus } from "../focus-refresh";
import type { Workspace, WorkspaceDuplication } from "../../../server/src/contracts";

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
    <Dialog title={title} onClose={onClose} busy={busy} initialFocusSelector={action.kind === "delete" ? ".dialogActions button" : "input"}>
      <form onSubmit={handleSubmit} className={styles.workspaceForm}>
        {action.kind === "delete" ? (
          <p>
            Delete <strong>{action.name}</strong>? This permanently removes the
            workspace, its agents, conversations, memories, and all files in its
            managed folders, including published outputs, and cancels its work. This cannot be undone.
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
        {action.kind === "edit" && (
          <FolderLocation
            kind="workspace"
            ownerId={action.id}
            label="Workspace shared folder"
          />
        )}
        {busy && action.kind === "delete" && (
          <LoadingState>
            Deleting managed files… Cleanup continues if this page closes.
          </LoadingState>
        )}
        {error && (
          <Appearance kind="fade">
            <Feedback role="alert">
              {error}
            </Feedback>
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
          <BusyButton busy={busy}
            className={`button ${action.kind === "delete" ? "danger" : "primary"}`}
            disabled={busy}
          >
            {busy ? "Saving…" : action.kind === "edit" ? "Save changes" : title}
          </BusyButton>
        </div>
      </form>
    </Dialog>
  );
}

export default function Home() {
  const [publishedIn, setPublishedIn] = useState<string | null>(null);
  const guard = useNavigationGuard();
  const agentStore = useAgentStore();
  const positionError = useAgents((s) => s.positionError);
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
  const [menu, setMenu] = useState<{ workspaceId: string; anchor: ContextMenuAnchor } | null>(null);
  const [duplicate, setDuplicate] = useState<{ source?: Workspace; operation?: WorkspaceDuplication } | null>(null);
  const [duplicateError, setDuplicateError] = useState("");
  const [recoverable, setRecoverable] = useState<WorkspaceDuplication | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const openDuplicate = useDashboard(state => state.openDuplicatedWorkspace);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback((workspace: Workspace, anchor: ContextMenuAnchor) => setMenu({ workspaceId: workspace.id, anchor }), []);
  const handleDuplicateCompleted = useCallback((id: string) => {
    guard(() => {
      void openDuplicate(id).then(() => { setDuplicate(null); setRecoverable(null); setDuplicateError(""); })
        .catch(failure => setDuplicateError(errorMessage(failure)));
    });
  }, [guard, openDuplicate]);
  useEffect(() => {
    const controller = new AbortController();
    async function discover() {
      try {
        const result = await request<{ items: WorkspaceDuplication[] }>("/workspace-duplications", "GET", undefined, controller.signal);
        if (!controller.signal.aborted) {
          setDiscoveryError("");
          setRecoverable(result.items.find(item => item.state === "pending" || item.state === "running" || item.state === "failed") ?? null);
        }
      } catch (failure) { if (!controller.signal.aborted) setDiscoveryError(errorMessage(failure)); }
    }
    void discover();
    const unlisten = refreshOnFocus(discover);
    return () => { controller.abort(); unlisten(); };
  }, [discoveryAttempt]);
  useNotice(discoveryError ? { id: "workspace-duplication-status", title: "Duplication progress could not load", message: discoveryError,
    actionLabel: "Reload duplication progress", action: () => setDiscoveryAttempt(attempt => attempt + 1) } : null, "workspace-duplication-status");
  useNotice(recoverable && !duplicate ? { id: "workspace-duplication", title: recoverable.state === "failed" ? "Workspace duplication failed" : "Workspace duplication in progress",
    message: recoverable.error ?? recoverable.name, actionLabel: "Review duplication", action: () => guard(() => setDuplicate({ operation: recoverable })) } : null, "workspace-duplication");
  const home = useRef<HTMLElement>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const active = selectedWorkspace;
  useNotice(positionError ? { id: "layout-save", title: "Layout could not save", message: positionError,
    actionLabel: "Retry layout save", action: () => agentStore.getState().retryPositions() } : null, "layout-save");
  useNotice(error && (!!active || workspaces.length > 0) ? { id: "workspaces", title: "Workspaces could not refresh", message: error,
    actionLabel: "Reload workspaces", action: () => load(!!workspaces.length) } : null, "workspaces");
  const tabs =
    active && !workspaces.some((workspace) => workspace.id === active.id)
      ? [...workspaces, active]
      : workspaces;
  const menuWorkspace = menu ? tabs.find(workspace => workspace.id === menu.workspaceId) : undefined;
  // Measure changed content before paint; observe later reflows without React state.
  useLayoutEffect(() => {
    const container = home.current;
    const header = chrome.current;
    if (!container || !header) return;
    let frame = 0;
    function measure() {
      const bottom = Math.ceil(
        header!.getBoundingClientRect().bottom - container!.getBoundingClientRect().top,
      );
      container!.style.setProperty("--workspace-chrome-bottom", `${bottom}px`);
    }
    function scheduleMeasure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    observer.observe(header);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      container.style.removeProperty("--workspace-chrome-bottom");
    };
  }, [active?.id, active?.name, active?.description]);
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
  function handleEdit(workspace = active) {
    if (workspace)
      guard(() =>
        setAction({
          kind: "edit",
          id: workspace.id,
          name: workspace.name,
          description: workspace.description,
        }),
      );
  }
  function handleDelete(workspace = active) {
    if (workspace)
      guard(() =>
        setAction({ kind: "delete", id: workspace.id, name: workspace.name }),
      );
  }
  function handleRetry() {
    void load(!!workspaces.length);
  }
  function handleMore() {
    void load(true);
  }
  function handleAddAgent() {
    if (active) guard(() => agentStore.setState({ createIn: active.id }));
  }
  return (
    <section ref={home} className={styles.home} aria-label="Home">
      <div ref={chrome} className={styles.workspaceChrome}>
        <div className={`${styles.workspaceBar} glassSurface`}>
          <GlassMaterial />
          <div
            ref={tabList}
            className={styles.tabs}
            role="tablist"
            aria-label="Workspaces"
          >
            {tabs.map(workspace => <WorkspaceTab key={workspace.id} workspace={workspace} activeId={activeId}
              tabs={tabs} onSelect={select} onMenu={openMenu} menuOpen={menu?.workspaceId === workspace.id} />)}
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
        </div>
        {active && <DeletionProgress workspaceId={active.id} />}
        {active && (
          <header className={`pageHeader ${styles.workspaceHeader}`}>
            <div className={styles.workspaceHeadingRow}>
              <div className={styles.workspaceIdentity}>
                <Appearance trigger={active.id}>
                  <h1>{active.name}</h1>
                </Appearance>
                <div className={styles.workspaceActions}>
                  <WorkspaceInboxButton key={active.id} workspaceId={active.id} />
                  <WorkspaceTriggersButton key={`triggers:${active.id}`} workspaceId={active.id} />
                  <Tooltip content="Published Files">
                    <button
                      className="iconButton"
                      aria-label="Published Files"
                      onClick={() => setPublishedIn(active.id)}
                    >
                      <FolderOpen size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip content="Edit workspace">
                    <button
                      className="iconButton"
                      aria-label="Edit workspace"
                      onClick={() => handleEdit()}
                    >
                      <Pencil size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip content="Delete workspace">
                    <button
                      className="iconButton"
                      aria-label="Delete workspace"
                      onClick={() => handleDelete()}
                    >
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip content="Workspace actions">
                    <button type="button" className="iconButton" aria-label="Workspace actions" aria-haspopup="menu"
                      aria-expanded={menu?.workspaceId === active.id || undefined}
                      onClick={event => {
                        const trigger = event.currentTarget, rect = trigger.getBoundingClientRect();
                        openMenu(active, { x: rect.left, y: rect.bottom, returnFocus: trigger });
                      }}><Ellipsis size={14} /></button>
                  </Tooltip>
                </div>
              </div>
              <div className={styles.creationActions}>
                <AddAgentButton workspaceId={active.id} onClick={handleAddAgent} />
              </div>
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
              <LoadingState className="centerState">
                Loading workspaces…
              </LoadingState>
            </Appearance>
          ) : (
            status === "error" ? <div className="centerState"><Feedback title="Workspaces could not load">{error}
              <button type="button" className="textButton" onClick={handleRetry}>Reload workspaces</button>
            </Feedback></div> : (
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
      {publishedIn === active?.id && publishedIn && (
        <PublishedFiles
          key={publishedIn}
          workspaceId={publishedIn}
          onClose={() => setPublishedIn(null)}
        />
      )}
      {menu && menuWorkspace && <ContextMenu anchor={menu.anchor}
        label={`Actions for ${menuWorkspace.name}`} onClose={closeMenu}
        items={[
          { id: "edit", label: "Edit…", icon: <Pencil size={16} />, onSelect: () => handleEdit(menuWorkspace) },
          { id: "duplicate", label: "Duplicate…", icon: <Copy size={16} />, onSelect: () => guard(() => {
            setDuplicateError(""); setDuplicate({ source: menuWorkspace });
          }) },
          { id: "separator", separator: true },
          { id: "delete", label: "Delete…", icon: <Trash2 size={16} />, destructive: true, onSelect: () => handleDelete(menuWorkspace) },
        ]} />}
      {action && <WorkspaceDialog action={action} onClose={handleClose} />}
      {duplicate && <WorkspaceDuplicate source={duplicate.source} initialOperation={duplicate.operation} openError={duplicateError}
        onClose={() => { setDuplicate(null); setDuplicateError(""); setDiscoveryAttempt(attempt => attempt + 1); }} onCompleted={handleDuplicateCompleted} />}
    </section>
  );
}
