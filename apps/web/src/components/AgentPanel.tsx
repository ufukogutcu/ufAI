import { configurationValues, refreshConfiguration, type ConfigurationValues } from "../agent-configuration";
import type { AgentAppearance } from "../../../server/src/contracts";
import { defaultAppearance } from "../agent-appearance";
import { AgentCharacter } from "./AgentCharacter";
import { LiveAgentCharacter } from "./LiveAgentCharacter";
import { CharacterEditor } from "./CharacterEditor";
import { useSettings } from "../settings-store";
import { TaskTimeline } from "./TaskTimeline";
import { TaskComposer as Composer } from "./TaskComposer";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Pencil,
  ArrowLeft,
  Plus,
  Send,
  Square,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useAgents, useAgentStore, emptyList } from "../agent-store";
import { useDashboard } from "../store";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import { request, errorMessage } from "../api";
import type {
  Agent,
  AgentMemory,
  AgentMessage,
  AgentTask,
  ModelPreset,
  TaskDetail,
} from "../../../server/src/contracts";
import { FolderLocation } from "./FolderLocation";
import { Field } from "./FormField";
import { Dialog } from "./Dialog";
import styles from "./AgentPanel.module.scss";

export function AgentForm({
  agent,
  workspaceId,
  onBusyChange,
  onSave,
}: {
  agent?: Agent;
  workspaceId?: string;
  onBusyChange?: (busy: boolean) => void;
  onSave: (values: {
    name: string;
    presetId: string | null;
    appearance?: AgentAppearance;
    instructions?: string;
    expectedRevision?: number;
  }) => Promise<Agent | void>;
}) {
  const [appearance, setAppearance] = useState<AgentAppearance | null>(null);
  const [appearanceError, setAppearanceError] = useState("");
  const [appearanceAttempt, setAppearanceAttempt] = useState(0);
  const [editingCharacter, setEditingCharacter] = useState(false);
  const appearanceTouched = useRef(false);
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  useEffect(() => {
    if (agent || !workspaceId || appearanceTouched.current) return;
    let alive = true;
    setAppearanceError("");
    void request<{ appearance: AgentAppearance }>(`/workspaces/${workspaceId}/agents/appearance-suggestion`)
      .then(result => { if (alive && !appearanceTouched.current) setAppearance(result.appearance); })
      .catch(failure => { if (alive && !appearanceTouched.current) setAppearanceError(errorMessage(failure)); });
    return () => { alive = false; };
  }, [agent, workspaceId, appearanceAttempt]);
  const presets = useDashboard((s) => s.presets),
    load = useDashboard((s) => s.loadPresets),
    presetTotal = useDashboard((s) => s.presetTotal),
    loadDefault = useDashboard((s) => s.loadDefaultPreset);
  const presetTouched = useRef(false);
  const [defaultReady, setDefaultReady] = useState(!!agent);
  const [defaultError, setDefaultError] = useState("");
  const [defaultAttempt, setDefaultAttempt] = useState(0);
  const [initialPreset, setInitialPreset] = useState<ModelPreset | null>(null);
  const initial = configurationValues(agent);
  const [configuration, setConfiguration] = useState({ draft: initial, baseline: initial, revision: agent?.revision ?? 1 });
  const { draft, baseline } = configuration;
  const setDraft = useCallback((next: ConfigurationValues | ((value: ConfigurationValues) => ConfigurationValues)) => {
    setConfiguration(current => ({ ...current, draft: typeof next === "function" ? next(current.draft) : next }));
  }, []);
  const setBaseline = useCallback((next: ConfigurationValues | ((value: ConfigurationValues) => ConfigurationValues)) => {
    setConfiguration(current => ({ ...current, baseline: typeof next === "function" ? next(current.baseline) : next }));
  }, []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || (!agent && appearanceTouched.current);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useUnsavedChanges(dirty);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);
  useEffect(() => {
    if (agent) return;
    let alive = true;
    setDefaultError("");
    void loadDefault()
      .then((preset) => {
        if (!alive) return;
        setInitialPreset(preset);
        if (!presetTouched.current) {
          setDraft((value) => ({ ...value, presetId: preset?.id ?? null }));
          setBaseline((value) => ({ ...value, presetId: preset?.id ?? null }));
        }
        setDefaultReady(true);
      })
      .catch((err) => {
        if (alive) setDefaultError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [agent, loadDefault, defaultAttempt, setDraft, setBaseline]);
  useEffect(() => {
    if (agent) setConfiguration(current => refreshConfiguration(current, agent));
  }, [agent, dirty]);
  const stale = !!agent && dirty && configuration.revision !== agent.revision;
  function reloadConfiguration() {
    if (!agent) return;
    const saved = configurationValues(agent);
    setConfiguration({ draft: saved, baseline: saved, revision: agent.revision });
    setError("");
  }
  function retryDefault() {
    setDefaultAttempt((value) => value + 1);
    void load().catch(() => {});
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || stale || !defaultReady || (!agent && !appearance)) return;
    setBusy(true);
    setError("");
    try {
      const saved = await onSave({ name: draft.name, presetId: draft.presetId,
        ...(agent ? { instructions: draft.instructions, expectedRevision: configuration.revision } : {}),
        ...(!agent && appearance ? { appearance } : {}) });
      const next = saved ? configurationValues(saved) : draft;
      setConfiguration({ draft: next, baseline: next, revision: saved?.revision ?? configuration.revision });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className={styles.form}>
      {!agent && <div className={styles.creationCharacter}>
        <div className={styles.creationCharacterPreview}>{appearance ? <AgentCharacter appearance={appearance} paused={paused} /> : <span role="status">{appearanceError ? "Choose a character" : "Choosing character…"}</span>}</div>
        <button type="button" className="button secondary" disabled={busy} onClick={() => setEditingCharacter(true)}><Pencil size={14} aria-hidden /> Edit character</button>
        {appearanceError && <p role="alert" className="errorBanner">{appearanceError}<button type="button" className="textButton" disabled={busy} onClick={() => setAppearanceAttempt(value => value + 1)}>Retry character</button></p>}
      </div>}
      {editingCharacter && <CharacterEditor initial={appearance ?? defaultAppearance} creating onClose={() => setEditingCharacter(false)} onSave={async value => { appearanceTouched.current = true; setAppearance(value); setAppearanceError(""); }} />}

      <Field label="Agent name">
        {(p) => (
          <input
            {...p}
            disabled={busy}
            name="agentName"
            autoComplete="off"
            maxLength={120}
            required
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        )}
      </Field>
      <Field
        label="Agent Preset (optional)"
        hint="You can leave this empty and choose later. A complete preset and known context window are required to run tasks."
      >
        {(p) => (
          <select
            {...p}
            disabled={busy}
            name="presetId"
            value={draft.presetId ?? ""}
            onChange={(e) => {
              presetTouched.current = true;
              setDraft({ ...draft, presetId: e.target.value || null });
            }}
          >
            <option value="">No preset — choose later</option>
            {draft.presetId &&
              !presets.some((preset) => preset.id === draft.presetId) && (
                <option value={draft.presetId}>
                  {initialPreset?.id === draft.presetId
                    ? initialPreset.name
                    : "Selected preset"}
                </option>
              )}
            {presets.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      {agent && <Field label="Instructions" hint="Define this agent’s role and lasting guidance. You can also ask it to update these in Chat. Saved changes apply to subsequent turns; running turns keep their starting instructions.">
        {p => <textarea {...p} name="instructions" autoComplete="off" rows={6} maxLength={8000} disabled={busy} value={draft.instructions} onChange={e => setDraft({ ...draft, instructions: e.target.value })} />}
      </Field>}
      {stale && <p className="errorBanner" role="alert">Saved configuration changed while you were editing. Your draft has been kept. Copy any changes you want to keep, then reload before saving.
        <button type="button" className="textButton" disabled={busy} onClick={reloadConfiguration}>Reload saved configuration</button>
      </p>}
      {!defaultReady && !defaultError && (
        <p role="status">Loading default preset…</p>
      )}
      {defaultError && (
        <p role="alert" className="errorBanner">
          {defaultError}
          <button
            type="button"
            className="textButton"
            onClick={retryDefault}
          >
            Retry
          </button>
        </p>
      )}
      {presets.length < presetTotal && (
        <button
          type="button"
          className="textButton"
          onClick={() => void load(true)}
        >
          Load more presets
        </button>
      )}
      {error && (
        <p role="alert" className="errorBanner">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button className="button primary" disabled={busy || stale || !defaultReady || (!agent && !appearance)}>
          {busy ? "Saving…" : agent ? "Save Agent" : "Create Agent"}
        </button>
      </div>
    </form>
  );
}
function Transcript({ agentId, taskId }: { agentId: string; taskId: string | null }) {
  const executionId = useAgents(s => taskId ?? s.chats[agentId]?.task?.id);
  return executionId ? (
    <TaskTimeline key={executionId} taskId={executionId} />
  ) : (
    <div className={styles.transcript}>
      <p className={styles.muted}>
        Talk with this agent, ask it to do something, or describe the role you want it to take.
      </p>
    </div>
  );
}
function MemoryCard({
  memory,
  onSource,
}: {
  memory: AgentMemory;
  onSource: (id: string) => void;
}) {
  const [confirmForget, setConfirmForget] = useState(false);
  const store = useAgentStore(),
    [editing, setEditing] = useState(false),
    [text, setText] = useState(memory.content),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await request(
        `/agents/${memory.agentId}/memories/${memory.id}`,
        "PATCH",
        { content: text, revision: memory.revision },
      );
      setEditing(false);
      await store.getState().loadMemories(memory.agentId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await request(
        `/agents/${memory.agentId}/memories/${memory.id}`,
        "DELETE",
      );
      await store.getState().loadMemories(memory.agentId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={styles.memory}>
      <h3>{memory.key}</h3>
      <p className={styles.muted}>
        {memory.kind === "preference"
          ? "Learned preference"
          : "Task finding · not independently verified"}
      </p>
      {editing ? (
        <>
          <label htmlFor={`memory-${memory.id}`}>Memory text</label>
          <textarea
            id={`memory-${memory.id}`}
            rows={4}
            maxLength={1200}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </>
      ) : (
        <p className={styles.messageText}>{memory.content}</p>
      )}
      <div className={styles.actions}>
        {editing ? (
          <>
            <button
              className="button"
              disabled={busy}
              onClick={() => void save()}
            >
              Save Memory
            </button>
            <button className="textButton" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            className="textButton"
            onClick={() => {
              setText(memory.content);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
        <button
          className="textButton"
          disabled={busy}
          onClick={() => setConfirmForget(true)}
        >
          Forget
        </button>
        {memory.sources.map((source, i) => (
          <button
            className="textButton"
            key={source}
            onClick={() => onSource(source)}
          >
            Source {i + 1}
          </button>
        ))}
      </div>
      {confirmForget && (
        <Dialog
          title="Forget memory?"
          busy={busy}
          onClose={() => setConfirmForget(false)}
        >
          <p>
            Forget this learned entry? Its original conversation stays
            available.
          </p>
          <div className={styles.actions}>
            <button
              className="button"
              disabled={busy}
              onClick={() => setConfirmForget(false)}
            >
              Keep Memory
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              Forget Memory
            </button>
          </div>
        </Dialog>
      )}
      {error && (
        <p role="alert" className="errorBanner">
          {error}
        </p>
      )}
    </article>
  );
}

export function AgentPanel({
  agent,
  onClose,
}: {
  agent: Agent;
  onClose: () => void;
}) {
  const store = useAgentStore(),
    guard = useNavigationGuard();
  const [editingCharacter, setEditingCharacter] = useState(false);
  const [tab, setTab] = useState("Chat"),
    [taskId, setTaskId] = useState<string | null>(null),
    [newTask, setNewTask] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState(false),
    [deleteBusy, setDeleteBusy] = useState(false),
    [source, setSource] = useState<{
      message: AgentMessage;
      taskId: string;
    } | null>(null);
  const requestedTask=useAgents(s=>s.requestedTask?.agentId===agent.id?s.requestedTask:null);
  const openConversation = useCallback(async (id: string, signal?: AbortSignal) => {
    const detail = await request<TaskDetail>(`/tasks/${id}`, "GET", undefined, signal);
    if (detail.task.agentId !== agent.id) return;
    if (detail.task.kind === "chat") {
      await store.getState().refreshAgent(agent.id);
      if (!signal?.aborted) setTab("Chat");
    } else { setTab("Tasks"); setTaskId(id); setNewTask(false); }
  }, [agent.id, store]);
  useEffect(() => {
    if (!requestedTask) return;
    const controller = new AbortController();
    void openConversation(requestedTask.taskId, controller.signal)
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); })
      .finally(() => {
        if (!controller.signal.aborted) store.setState({ requestedTask: null });
      });
    return () => controller.abort();
  }, [requestedTask, store, openConversation]);
  const hasProcesses = useAgents((s) =>
    taskId
      ? (s.toolData[taskId]?.processes.some((p) =>
          ["starting", "running"].includes(p.state),
        ) ?? false)
      : false,
  );
  const tasks = useAgents((s) => s.tasks[agent.id] ?? emptyList),
    memories = useAgents((s) => s.memories[agent.id] ?? emptyList),
    chat = useAgents((s) => s.chats[agent.id]),
    details = useAgents((s) => (taskId ? s.details[taskId] : undefined));
  const chatHasProcesses = useAgents(s => chat?.task ? (s.toolData[chat.task.id]?.processes.some(p => ["starting", "running"].includes(p.state)) ?? false) : false);
  const taskTotal = useAgents((s) => s.taskTotals[agent.id] ?? 0),
    memoryTotal = useAgents((s) => s.memoryTotals[agent.id] ?? 0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    heading.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const created = useCallback((id: string) => {
    setTaskId(id);
    setNewTask(false);
  }, []);
  async function action(kind: "cancel" | "retry", id = taskId) {
    if (!id) return;
    try {
      await request(`/tasks/${id}/${kind}`, "POST", {});
      await store.getState().refreshAgent(agent.id);
      await store.getState().loadMessages(agent.id, tab === "Chat" ? null : id);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function showSource(id: string) {
    try {
      setSource(await request(`/agents/${agent.id}/sources/${id}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const current = tasks.find((t) => t.id === taskId) ?? details?.task;
  async function save(values: {
    name: string;
    presetId: string | null;
    instructions?: string;
    expectedRevision?: number;
  }) {
    try { return await store.getState().update(agent.id, values); }
    catch (failure) { await store.getState().refreshAgent(agent.id); throw failure; }
  }
  return createPortal(
    <section
      className={styles.panel}
      data-agent-panel
      aria-labelledby="agent-panel-heading"
      onKeyDown={(e) => {
        if (
          e.key === "Escape" &&
          !deleting &&
          !source &&
          !(e.target instanceof HTMLElement && e.target.closest("dialog"))
        ) {
          e.stopPropagation();
          guard(onClose);
        }
      }}
    >
      <header className={styles.header}>
        <div className={styles.panelCharacter}>
          <LiveAgentCharacter agent={agent} />
          <button className="iconButton" aria-label="Edit character" title="Edit character" onClick={() => setEditingCharacter(true)}><Pencil size={14} aria-hidden /></button>
        </div>
        <div className={styles.agentIdentity}>
          <h2 ref={heading} tabIndex={-1} id="agent-panel-heading" title={agent.name}>
            {agent.name}
          </h2>
          <p>
            {agent.state === "running"
              ? "Working"
              : agent.state === "queued"
                ? "Work queued"
                : agent.state === "waiting"
                  ? "Waiting"
                  : "Ready"}{" "}
            · {agent.queuedCount} queued
          </p>
        </div>
        <button
          className="iconButton"
          aria-label="Close agent panel"
          onClick={() => guard(onClose)}
        >
          <X size={18} />
        </button>
      </header>
      <nav className={styles.tabs} aria-label="Agent sections">
        {["Chat", "Tasks", "Memory", "Configuration"].map((v) => (
          <button
            key={v}
            aria-current={tab === v ? "page" : undefined}
            onClick={() => guard(() => setTab(v))}
          >
            {v}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="errorBanner">
          {error}
        </p>
      )}
      {tab === "Chat" && (
        <>
          {chat?.task && <div className={styles.chatStatus}>
            <div className={styles.actions}>
              <span role="status">{chat.task.status.replaceAll("_", " ")}{chat.turns.find(t => t.status === "running") ? ` · ${chat.turns.find(t => t.status === "running")!.phase}` : ""}</span>
              {(["running", "waiting", "queued", "blocked", "failed"].includes(chat.task.status) || chatHasProcesses) && <button className="textButton" onClick={() => void action("cancel", chat.task!.id)}><Square size={13} aria-hidden />Stop</button>}
              {["failed", "blocked"].includes(chat.task.status) && <button className="textButton" onClick={() => void action("retry", chat.task!.id)}><RotateCcw size={13} aria-hidden />Retry</button>}
            </div>
            {chat.task.error && <p className="errorBanner" role="alert">{chat.task.error} <a href="#/providers">Providers</a> · <a href="#/agent-presets">Presets</a></p>}
            {chat.turns[0]?.status === "completed" && chat.turns[0].error && !chat.task.error && <p className={styles.muted}>{chat.turns[0].error}</p>}
          </div>}
          <Transcript key={`chat:${agent.id}`} agentId={agent.id} taskId={null} />
          <Composer agentId={agent.id} taskId={null} onCreated={created} />
        </>
      )}
      {tab === "Tasks" &&
        (newTask ? (
          <>
            <div className={styles.taskHeading}>
              <button className="textButton" onClick={() => setNewTask(false)}>
                <ArrowLeft size={14} />
                All tasks
              </button>
              <h3>New task</h3>
            </div>
            <p className={styles.help}>
              A separate conversation with access to this agent’s shared memory
              and past work.
            </p>
            <Composer agentId={agent.id} taskId="new" onCreated={created} />
          </>
        ) : taskId ? (
          <>
            <div className={styles.taskHeading}>
              <button className="textButton" onClick={() => setTaskId(null)}>
                <ArrowLeft size={14} />
                All tasks
              </button>
              <h3>{current?.title ?? "Task"}</h3>
              <details>
                <summary>Working folder</summary>
                <FolderLocation
                  kind="task"
                  ownerId={taskId}
                  label="Task working folder"
                />
              </details>
              <div className={styles.actions}>
                <span>
                  {current?.status.replaceAll("_", " ")}
                  {details?.turns.find((t) => t.status === "running")
                    ? ` · ${details.turns.find((t) => t.status === "running")!.phase}`
                    : ""}
                </span>
                {([
                  "running",
                  "waiting",
                  "queued",
                  "blocked",
                  "failed",
                ].includes(current?.status ?? "") ||
                  hasProcesses) && (
                  <button
                    className="textButton"
                    onClick={() => void action("cancel")}
                  >
                    <Square size={13} aria-hidden />
                    Stop
                  </button>
                )}
                {["failed", "blocked"].includes(current?.status ?? "") && (
                  <button
                    className="textButton"
                    onClick={() => void action("retry")}
                  >
                    <RotateCcw size={13} aria-hidden />
                    Retry
                  </button>
                )}
              </div>
              {current?.error && (
                <p className="errorBanner" role="alert">
                  {current.error} <a href="#/providers">Providers</a> ·{" "}
                  <a href="#/agent-presets">Presets</a>
                </p>
              )}
              {details?.turns[0]?.status === "completed" &&
                details.turns[0].error &&
                !current?.error && (
                  <p className={styles.muted}>{details.turns[0]!.error}</p>
                )}
            </div>
            <Transcript key={`transcript:${taskId}`} agentId={agent.id} taskId={taskId} />

            <Composer
              key={`composer:${taskId}`}
              agentId={agent.id}
              taskId={taskId}
              onCreated={created}
            />
          </>
        ) : (
          <div className={styles.scroll}>
            <button className="button primary" onClick={() => setNewTask(true)}>
              <Plus size={15} />
              New Task
            </button>
            {tasks.map((t) => (
              <button
                key={t.id}
                className={styles.taskLink}
                onClick={() => setTaskId(t.id)}
              >
                <span>{t.title}</span>
                <small>{t.status.replaceAll("_", " ")}</small>
              </button>
            ))}
            {!tasks.length && (
              <p className={styles.muted}>Start this agent’s first task.</p>
            )}
            {tasks.length < taskTotal && (
              <button
                className="textButton"
                onClick={() =>
                  void store
                    .getState()
                    .loadTasks(agent.id, true)
                    .catch((e) => setError(errorMessage(e)))
                }
              >
                Load more tasks
              </button>
            )}
          </div>
        ))}
      {tab === "Memory" && (
        <div className={styles.scroll}>
          <p className={styles.muted}>
            Learned preferences and findings are shared across this agent’s
            tasks. Forgetting a memory leaves its original transcript intact.
          </p>
          {memories.map((m) => (
            <MemoryCard key={m.id} memory={m} onSource={showSource} />
          ))}
          {!memories.length && <p>No memories yet.</p>}
          {memories.length < memoryTotal && (
            <button
              className="textButton"
              onClick={() =>
                void store
                  .getState()
                  .loadMemories(agent.id, true)
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              Load more memories
            </button>
          )}
        </div>
      )}
      {tab === "Configuration" && (
        <div className={styles.scroll}>
          <AgentForm agent={agent} onSave={save} />
          <FolderLocation kind="agent" ownerId={agent.id} label="Agent files" />
          <hr />
          <p className={styles.muted}>
            Deleting this agent removes its conversations and memories, and
            cancels its work and permanently deletes its working files and
            history. Published files remain in the workspace.
          </p>
          <button
            className="button"
            onClick={() => guard(() => setDeleting(true))}
          >
            <Trash2 size={15} />
            Delete Agent
          </button>
        </div>
      )}
      {editingCharacter && <CharacterEditor initial={agent.appearance} onClose={() => setEditingCharacter(false)} onSave={async appearance => { await store.getState().update(agent.id, { appearance }); }} />}
      {deleting && (
        <Dialog
          title="Delete agent?"
          busy={deleteBusy}
          onClose={() => setDeleting(false)}
        >
          <p>
            Permanently delete {agent.name}, its conversations, memories, and
            all files in its agent and task folders? Its work will be cancelled.
            This cannot be undone.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {deleteBusy && (
            <p role="status">
              Cleaning up files… This continues if the page closes.
            </p>
          )}
          <div className={styles.actions}>
            <button
              className="button"
              disabled={deleteBusy}
              onClick={() => setDeleting(false)}
            >
              Keep Agent
            </button>
            <button
              className="button danger"
              disabled={deleteBusy}
              onClick={() => {
                setDeleteBusy(true);
                void store
                  .getState()
                  .remove(agent.id)
                  .catch((e) => setError(errorMessage(e)))
                  .finally(() => setDeleteBusy(false));
              }}
            >
              {deleteBusy ? "Deleting files…" : "Delete Agent and files"}
            </button>
          </div>
        </Dialog>
      )}
      {source && (
        <Dialog title="Memory source" onClose={() => setSource(null)}>
          <p className={styles.messageText}>{source.message.content}</p>
          <button
            className="button"
            onClick={() => {
              void openConversation(source.taskId).catch(e => setError(errorMessage(e)));
              setSource(null);
            }}
          >
            Open conversation
          </button>
        </Dialog>
      )}
    </section>,
    document.body,
  );
}
