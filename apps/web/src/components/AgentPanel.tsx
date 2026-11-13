import { TaskComposer as Composer } from "./TaskComposer";
import { MessageAttachments } from "./MessageAttachments";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import {
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
} from "../../../server/src/contracts";
import { TaskTools } from "./TaskTools";
import { FolderLocation } from "./FolderLocation";
import { Field } from "./FormField";
import { Dialog } from "./Dialog";
import styles from "./AgentPanel.module.scss";

export function AgentForm({
  agent,
  onSave,
}: {
  agent?: Agent;
  onSave: (values: {
    name: string;
    instructions: string;
    presetId: string | null;
  }) => Promise<void>;
}) {
  const presets = useDashboard((s) => s.presets),
    load = useDashboard((s) => s.loadPresets),
    presetTotal = useDashboard((s) => s.presetTotal);
  const initial = {
    name: agent?.name ?? "",
    instructions: agent?.instructions ?? "",
    presetId: agent?.presetId ?? null,
  };
  const [draft, setDraft] = useState(initial),
    [baseline, setBaseline] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);
  useEffect(() => {
    if (!dirty && agent) {
      const next = {
        name: agent.name,
        instructions: agent.instructions,
        presetId: agent.presetId,
      };
      setDraft(next);
      setBaseline(next);
    }
  }, [agent, dirty]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
      setBaseline(draft);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className={styles.form}>
      <Field label="Agent name">
        {(p) => (
          <input
            {...p}
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
        label="Instructions"
        hint="Describe the agent’s role and how it should respond."
      >
        {(p) => (
          <textarea
            {...p}
            name="instructions"
            autoComplete="off"
            rows={7}
            maxLength={8000}
            value={draft.instructions}
            onChange={(e) =>
              setDraft({ ...draft, instructions: e.target.value })
            }
          />
        )}
      </Field>
      <Field
        label="Agent Preset"
        hint="Changes to this preset apply to future turns. A complete preset and known context window are required to run."
      >
        {(p) => (
          <select
            {...p}
            name="presetId"
            value={draft.presetId ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, presetId: e.target.value || null })
            }
          >
            <option value="">Choose later</option>
            {presets.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </Field>
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
        <button className="button primary" disabled={busy}>
          {busy ? "Saving…" : agent ? "Save Agent" : "Create Agent"}
        </button>
      </div>
    </form>
  );
}
function Transcript({
  agentId,
  taskId,
}: {
  agentId: string;
  taskId: string | null;
}) {
  const store = useAgentStore(),
    key = taskId ?? `status:${agentId}`;
  const messages = useAgents((s) => s.messages[key] ?? emptyList),
    total = useAgents((s) => s.messageTotals[key] ?? 0);
  const version = useAgents((s) => s.eventVersion);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null),
    nearEnd = useRef(true);
  useEffect(() => {
    let alive = true;
    void store
      .getState()
      .loadMessages(agentId, taskId)
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [agentId, taskId, store, version]);
  useEffect(() => {
    if (nearEnd.current && end.current?.parentElement) {
      const viewport = end.current.parentElement;
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages]);
  return (
    <div
      className={styles.transcript}
      onScroll={(e) => {
        const el = e.currentTarget;
        nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      }}
    >
      {messages.length < total && (
        <button
          type="button"
          className="textButton"
          onClick={() => {
            nearEnd.current = false;
            void store
              .getState()
              .loadMessages(agentId, taskId, true)
              .catch((e) => setError(errorMessage(e)));
          }}
        >
          Load earlier messages
        </button>
      )}
      <p className={styles.srStatus} role="status" aria-live="polite">
        {messages.at(-1)?.role === "assistant"
          ? messages.at(-1)?.state === "streaming"
            ? "Agent is responding."
            : "Agent reply ready."
          : ""}
      </p>
      {!messages.length && (
        <p className={styles.muted}>
          {taskId
            ? "Your task conversation appears here."
            : "Ask about this agent’s workload without interrupting its tasks."}
        </p>
      )}
      {messages.map((m) => (
        <article key={m.id} className={styles.message} data-role={m.role}>
          <div className={styles.messageLabel}>
            {m.role === "user" ? "You" : "Agent"}{" "}
            <span>
              {m.state === "incomplete"
                ? "· Incomplete reply"
                : m.state === "streaming"
                  ? "· Writing…"
                  : ""}
            </span>
          </div>
          <div className={styles.messageText}>{m.content || (m.parts?.some(p=>p.type==="artifact") ? "" : "…")}</div>
          <MessageAttachments parts={m.parts} />
        </article>
      ))}
      {error && (
        <p role="alert" className="errorBanner">
          {error}
        </p>
      )}
      {taskId && <TaskTools key={`tools:${taskId}`} taskId={taskId} />}
      <div ref={end} />
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
  const [tab, setTab] = useState("Overview"),
    [taskId, setTaskId] = useState<string | null>(null),
    [newTask, setNewTask] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState(false),
    [deleteBusy, setDeleteBusy] = useState(false),
    [source, setSource] = useState<{
      message: AgentMessage;
      taskId: string;
    } | null>(null);
  const hasProcesses = useAgents((s) =>
    taskId
      ? (s.toolData[taskId]?.processes.some((p) =>
          ["starting", "running"].includes(p.state),
        ) ?? false)
      : false,
  );
  const tasks = useAgents((s) => s.tasks[agent.id] ?? emptyList),
    memories = useAgents((s) => s.memories[agent.id] ?? emptyList),
    workload = useAgents((s) => s.workloads[agent.id]),
    details = useAgents((s) => (taskId ? s.details[taskId] : undefined));
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
  async function action(kind: "cancel" | "retry") {
    if (!taskId) return;
    try {
      await request(`/tasks/${taskId}/${kind}`, "POST", {});
      await store.getState().refreshAgent(agent.id);
      await store.getState().loadMessages(agent.id, taskId);
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
    instructions: string;
    presetId: string | null;
  }) {
    await store.getState().update(agent.id, values);
  }
  return createPortal(
    <section
      className={styles.panel}
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
        <div>
          <h2 ref={heading} tabIndex={-1} id="agent-panel-heading">
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
        {["Overview", "Tasks", "Memory", "Configuration"].map((v) => (
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
      {tab === "Overview" && (
        <>
          <div className={styles.workload}>
            <p className={styles.muted}>
              Live workload ·{" "}
              {workload
                ? new Date(workload.capturedAt).toLocaleTimeString()
                : "Loading…"}
            </p>
            {workload?.processes?.map((p) => (
              <button
                className={styles.taskLink}
                key={p.id}
                onClick={() => {
                  setTab("Tasks");
                  setTaskId(p.taskId);
                }}
              >
                <span>{p.command}</span>
                <small>{p.state}</small>
              </button>
            ))}
            {workload?.tasks
              .filter((t) =>
                ["running", "waiting", "queued", "blocked", "failed"].includes(
                  t.status,
                ),
              )
              .map((t) => (
                <button
                  key={t.id}
                  className={styles.taskLink}
                  onClick={() => {
                    setTaskId(t.id);
                    setNewTask(false);
                    setTab("Tasks");
                  }}
                >
                  <span>{t.title}</span>
                  <small>{t.status.replaceAll("_", " ")}</small>
                </button>
              ))}
            {workload &&
              !workload.processes?.length &&
              !workload.tasks.some((t) =>
                ["running", "waiting", "queued", "blocked", "failed"].includes(
                  t.status,
                ),
              ) && <p>No active tasks.</p>}
          </div>
          {workload?.statusTurn?.error && (
            <p className="errorBanner" role="alert">
              {workload.statusTurn.error} Check Configuration and ask again.
            </p>
          )}
          <Transcript agentId={agent.id} taskId={null} />
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
                    <Square size={13} />
                    Stop
                  </button>
                )}
                {["failed", "blocked"].includes(current?.status ?? "") && (
                  <button
                    className="textButton"
                    onClick={() => void action("retry")}
                  >
                    <RotateCcw size={13} />
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
            <Transcript key={taskId} agentId={agent.id} taskId={taskId} />

            <Composer
              key={taskId}
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
              setTaskId(source.taskId);
              setNewTask(false);
              setTab("Tasks");
              setSource(null);
            }}
          >
            Open Task
          </button>
        </Dialog>
      )}
    </section>,
    document.body,
  );
}
