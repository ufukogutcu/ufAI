import { useNavigationGuard } from "../navigation-guard";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { Inbox, Link as LinkIcon } from "lucide-react";
import { useAgents, useAgentStore, emptyList } from "../agent-store";
import { request, errorMessage } from "../api";
import type {
  AgentRequest,
  CommunicationMessage,
  InboxEntry,
  MessagingOperation,
  Page,
  RevocationImpact,
} from "../../../server/src/contracts";
import { TaskComposer } from "./TaskComposer";
import { Dialog } from "./Dialog";
import { MessageAttachments } from "./MessageAttachments";
import { Tooltip } from "./Tooltip";
import styles from "./Messaging.module.scss";

function AttachedFiles({ ids }: { ids: string[] }) {
  return (
    <MessageAttachments
      parts={ids.map((versionId) => ({
        type: "artifact" as const,
        versionId,
        name: `File ${versionId.slice(0, 8)}`,
        mode: "file" as const,
      }))}
    />
  );
}
export function PermissionEditor({ workspaceId }: { workspaceId: string }) {
  const store = useAgentStore(),
    editor = useAgents((s) => s.communicationEditor);
  const agents = useAgents(
    useShallow((s) =>
      Object.values(s.agents).filter((a) => a.workspaceId === workspaceId),
    ),
  );
  const links = useAgents(
    (s) => s.communication[workspaceId]?.links ?? emptyList,
  );
  const [source, setSource] = useState(
      editor?.sourceAgentId ?? agents[0]?.id ?? "",
    ),
    [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [impact, setImpact] = useState<RevocationImpact | null>(null),
    [operation, setOperation] = useState<MessagingOperation | null>(null);
  const link = links.find((l) => l.id === editor?.linkId);
  useEffect(() => {
    if (link?.state !== "revoking") return;
    const c = new AbortController();
    void request<{ operation: MessagingOperation | null }>(
      `/communication-links/${link.id}`,
      "GET",
      undefined,
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setOperation(v.operation);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [link?.id, link?.state]);
  const close = useCallback(
    () => store.setState({ communicationEditor: null }),
    [store],
  );
  useEffect(() => {
    if (!operation || !["pending", "running"].includes(operation.state)) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const op = await request<MessagingOperation>(
          `/messaging-operations/${operation.id}`,
          "GET",
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setOperation(op);
        if (op.state === "completed") {
          await store.getState().loadCommunication(workspaceId);
          close();
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e));
      }
    };
    const timer = setInterval(() => void poll(), 1000);
    void poll();
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [operation?.id, operation?.state, store, workspaceId, close]);
  if (!editor || editor.workspaceId !== workspaceId) return null;
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await store
        .getState()
        .createCommunicationLink(workspaceId, source, target);
      close();
    });
  }
  const working =
    busy || (!!operation && ["pending", "running"].includes(operation.state));
  return (
    <Dialog
      title={link ? "Communication permission" : "Allow agent communication"}
      onClose={close}
      busy={working}
    >
      <div className={styles.panel}>
        <p>
          A directed link allows the source agent to initiate requests and
          notifications. Accepted requests allow replies in both directions.
        </p>
        {link ? (
          <>
            <p>
              <strong>
                {agents.find((a) => a.id === link.sourceAgentId)?.name ??
                  link.sourceAgentId}
              </strong>{" "}
              →{" "}
              <strong>
                {agents.find((a) => a.id === link.targetAgentId)?.name ??
                  link.targetAgentId}
              </strong>
            </p>
            {!impact && !operation && (
              <button
                className="button danger"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setImpact(
                      await request<RevocationImpact>(
                        `/communication-links/${link.id}/revocation-preview`,
                        "POST",
                        {},
                      ),
                    ),
                  )
                }
              >
                Review removal
              </button>
            )}
            {impact && !operation && (
              <>
                <p>
                  Removing this link interrupts {impact.requests.length} helper
                  requests and {impact.processes.length} running processes,
                  including affected delegated descendants. Their callers will
                  receive a permission-revoked result. Unrelated work continues.
                </p>
                <p>
                  Messages, working files, and published artifacts will be
                  retained. No files will be deleted.
                </p>
                <ul className={styles.list}>
                  {impact.requests.map((r) => (
                    <li key={r.id} className={styles.item}>
                      {r.sourceName} → {r.targetName}
                      <span className={styles.meta}>
                        Task {r.targetTaskId} · {r.state}
                      </span>
                    </li>
                  ))}
                </ul>
                {impact.processes.map((p) => (
                  <p className={styles.content} key={p.id}>
                    Stop: {p.command}
                  </p>
                ))}
                <div className={styles.actions}>
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () =>
                        setOperation(
                          await request<MessagingOperation>(
                            `/communication-links/${link.id}`,
                            "DELETE",
                            {
                              confirmInterruption: true,
                              revision: impact.revision,
                            },
                          ),
                        ),
                      )
                    }
                  >
                    Remove link and stop affected work
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () =>
                        setImpact(
                          await request<RevocationImpact>(
                            `/communication-links/${link.id}/revocation-preview`,
                            "POST",
                            {},
                          ),
                        ),
                      )
                    }
                  >
                    Refresh impact
                  </button>
                </div>
              </>
            )}
            {operation && (
              <p role="status">
                {operation.state === "failed"
                  ? operation.error
                  : "Stopping affected work…"}
              </p>
            )}
            {operation?.state === "failed" && (
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setOperation(
                      await request<MessagingOperation>(
                        `/messaging-operations/${operation.id}/retry`,
                        "POST",
                        {},
                      ),
                    ),
                  )
                }
              >
                Retry removal
              </button>
            )}
          </>
        ) : (
          <form className={styles.form} onSubmit={submit}>
            <label>
              From agent
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                required
                disabled={busy}
              >
                <option value="">Choose agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              May contact
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                required
                disabled={busy}
              >
                <option value="">Choose agent</option>
                {agents
                  .filter((a) => a.id !== source)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
            <button className="button primary" disabled={busy}>
              Allow communication
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
function InboxReply({
  entry,
  onSent,
}: {
  entry: InboxEntry;
  onSent: () => void;
}) {
  if (!entry.agentId || !entry.taskId)
    return <p>The source task is no longer available.</p>;
  return (
    <TaskComposer
      agentId={entry.agentId}
      taskId={entry.taskId}
      onCreated={onSent}
      draftKey={`inbox:${entry.id}`}
      submissionPath={`/inbox/${entry.id}/reply`}
    />
  );
}
export function WorkspaceInboxButton({ workspaceId }: { workspaceId: string }) {
  const guard = useNavigationGuard();
  const store = useAgentStore(),
    data = useAgents((s) => s.communication[workspaceId]);
  const [open, setOpen] = useState(false),
    [reply, setReply] = useState<string | null>(null),
    [older, setOlder] = useState<InboxEntry[]>([]),
    [error, setError] = useState("");
  const refresh = useCallback(() => {
    void store.getState().loadCommunication(workspaceId);
  }, [store, workspaceId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const entries = [
    ...(data?.inbox ?? []),
    ...older.filter((e) => !data?.inbox.some((n) => n.id === e.id)),
  ];
  async function mark(entry: InboxEntry) {
    try {
      const updated = await request<InboxEntry>(`/inbox/${entry.id}`, "PATCH", {
        read: !entry.readAt,
      });
      setOlder((previous) =>
        previous.map((item) =>
          item.id === entry.id ? { ...item, readAt: updated.readAt } : item,
        ),
      );
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function more() {
    try {
      const p = await request<Page<InboxEntry>>(
        `/workspaces/${workspaceId}/inbox?limit=50&offset=${entries.length}`,
      );
      setOlder((previous) => [
        ...previous,
        ...p.items.filter((n) => !previous.some((o) => o.id === n.id)),
      ]);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <>
      <Tooltip content="Workspace Inbox">
        <button
          className="iconButton"
          aria-label={`Workspace Inbox, ${data?.unread ?? 0} unread`}
          onClick={() => {
            setOpen(true);
            refresh();
          }}
        >
          <Inbox size={14} />
          {!!data?.unread && (
            <span className={styles.badge}>
              {data.unread > 99 ? "99+" : data.unread}
            </span>
          )}
        </button>
      </Tooltip>
      {open && (
        <Dialog title="Workspace Inbox" onClose={() => setOpen(false)}>
          <div className={styles.panel}>
            <p>
              Deliberate messages from your agents. Normal task answers remain
              in their conversations.
            </p>
            {!entries.length && <p>No messages yet.</p>}
            <ul className={styles.list}>
              {entries.map((entry) => (
                <li key={entry.id} className={styles.item}>
                  <strong>
                    {entry.agentName}
                    {entry.readAt ? "" : " · Unread"}
                  </strong>
                  <span className={styles.meta}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  <p className={styles.content}>{entry.content}</p>
                  <AttachedFiles ids={entry.attachments} />
                  <div className={styles.actions}>
                    <button
                      className="textButton"
                      onClick={() => void mark(entry)}
                    >
                      {entry.readAt ? "Mark unread" : "Mark read"}
                    </button>
                    {entry.taskId && entry.agentId && (
                      <button
                        className="textButton"
                        onClick={() =>
                          guard(() => {
                            store
                              .getState()
                              .select(workspaceId, entry.agentId!);
                            store.setState({
                              requestedTask: {
                                agentId: entry.agentId!,
                                taskId: entry.taskId!,
                              },
                            });
                            setOpen(false);
                          })
                        }
                      >
                        Open source agent · Task {entry.taskId.slice(0, 8)}
                      </button>
                    )}
                    <button
                      className="textButton"
                      disabled={!entry.taskId}
                      onClick={() =>
                        setReply(reply === entry.id ? null : entry.id)
                      }
                    >
                      Reply
                    </button>
                  </div>
                  {reply === entry.id && (
                    <InboxReply entry={entry} onSent={refresh} />
                  )}
                </li>
              ))}
            </ul>
            {entries.length < (data?.total ?? 0) && (
              <button className="button" onClick={() => void more()}>
                Load earlier messages
              </button>
            )}
            {(error || data?.error) && (
              <p className="error" role="alert">
                {error || data?.error}
              </p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
function RequestThread({ item }: { item: AgentRequest }) {
  const guard = useNavigationGuard();
  const store = useAgentStore();
  function openTask(agentId: string, taskId: string) {
    guard(() => {
      store.getState().select(item.workspaceId, agentId);
      store.setState({ requestedTask: { agentId, taskId } });
    });
  }
  const [messages, setMessages] = useState<CommunicationMessage[]>([]),
    [total, setTotal] = useState(0),
    [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const version = useAgents((s) => s.eventVersion);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    void request<Page<CommunicationMessage>>(
      `/agent-requests/${item.id}/messages?limit=25`,
      "GET",
      undefined,
      c.signal,
    )
      .then((p) => {
        if (!c.signal.aborted) {
          setMessages(p.items);
          setTotal(p.total);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [open, item.id, version]);
  async function more() {
    try {
      const p = await request<Page<CommunicationMessage>>(
        `/agent-requests/${item.id}/messages?limit=25&offset=${messages.length}`,
      );
      setMessages((m) => [
        ...m,
        ...p.items.filter((n) => !m.some((o) => o.id === n.id)),
      ]);
      setTotal(p.total);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <details
      className={styles.item}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        {item.sourceName} → {item.targetName} · {item.state}
        {item.executionState ? ` · ${item.executionState}` : ""}
      </summary>
      <div className={styles.actions}>
        {item.sourceTaskId && item.sourceAgentId && (
          <button
            type="button"
            className="textButton"
            onClick={() => openTask(item.sourceAgentId!, item.sourceTaskId!)}
          >
            Open requester task
          </button>
        )}
        {item.targetTaskId && item.targetAgentId && (
          <button
            type="button"
            className="textButton"
            onClick={() => openTask(item.targetAgentId!, item.targetTaskId!)}
          >
            Open helper task
          </button>
        )}
      </div>
      <span className={styles.meta}>
        {item.kind} · Deadline {new Date(item.deadline).toLocaleString()}
      </span>
      {(item.error || item.executionError) && (
        <p role="status">{item.error || item.executionError}</p>
      )}
      <ul className={styles.list}>
        {messages.map((m) => (
          <li key={m.id}>
            <strong>
              {m.senderName} · {m.kind}
            </strong>
            <p className={styles.content}>{m.content}</p>
            <AttachedFiles ids={m.attachments} />
          </li>
        ))}
      </ul>
      {messages.length < total && (
        <button className="textButton" onClick={() => void more()}>
          Load more messages
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
export function TaskCommunications({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<AgentRequest[]>([]),
    [total, setTotal] = useState(0),
    [error, setError] = useState("");
  const version = useAgents((s) => s.eventVersion);
  useEffect(() => {
    const c = new AbortController();
    void request<Page<AgentRequest>>(
      `/tasks/${taskId}/communications?limit=25`,
      "GET",
      undefined,
      c.signal,
    )
      .then((p) => {
        if (!c.signal.aborted) {
          setItems(p.items);
          setTotal(p.total);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [taskId, version]);
  async function more() {
    try {
      const p = await request<Page<AgentRequest>>(
        `/tasks/${taskId}/communications?limit=25&offset=${items.length}`,
      );
      setItems((m) => [
        ...m,
        ...p.items.filter((n) => !m.some((o) => o.id === n.id)),
      ]);
      setTotal(p.total);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  if (!items.length && !error) return null;
  return (
    <section className={styles.section} aria-label="Agent communications">
      <h3>Agent communications</h3>
      <div className={styles.panel}>
        {items.map((item) => (
          <RequestThread key={item.id} item={item} />
        ))}
        {items.length < total && (
          <button className="textButton" onClick={() => void more()}>
            Load more requests
          </button>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
export function CommunicationMenuAction({
  workspaceId,
  sourceAgentId,
  onDone,
}: {
  workspaceId: string;
  sourceAgentId: string;
  onDone: () => void;
}) {
  const store = useAgentStore();
  const links = useAgents(
    useShallow((s) =>
      (s.communication[workspaceId]?.links ?? []).filter(
        (l) =>
          l.sourceAgentId === sourceAgentId ||
          l.targetAgentId === sourceAgentId,
      ),
    ),
  );
  const names = useAgents(
    useShallow((s) =>
      Object.fromEntries(
        Object.values(s.agents)
          .filter((a) => a.workspaceId === workspaceId)
          .map((a) => [a.id, a.name]),
      ),
    ),
  );
  function edit(linkId?: string) {
    store.setState({
      communicationEditor: { workspaceId, sourceAgentId, linkId },
    });
    onDone();
  }
  return (
    <>
      <button type="button" className="button secondary" onClick={() => edit()}>
        <LinkIcon size={14} />
        Allow communication
      </button>
      {links.map((link) => (
        <button
          type="button"
          className="textButton"
          key={link.id}
          onClick={() => edit(link.id)}
        >
          {names[link.sourceAgentId]} → {names[link.targetAgentId]} ·{" "}
          {link.state === "active" ? "Edit permission" : "Removal in progress"}
        </button>
      ))}
    </>
  );
}
