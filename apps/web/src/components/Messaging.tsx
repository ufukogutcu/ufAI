import { useInboxNotifications, useInboxNotificationStore } from "./InboxNotifications";
import { UserInputCard } from "./UserInputCard";
import { Feedback } from "./Feedback";
import { useNavigationGuard } from "../navigation-guard";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type FormEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { Inbox } from "lucide-react";
import { useAgents, useAgentStore, emptyList } from "../agent-store";
import { request, errorMessage } from "../api";
import type {
  InboxEntry,
  CommunicationAnchors,
  CommunicationLink,
  MessagingOperation,
  Page,
  RevocationImpact,
} from "../../../server/src/contracts";
import { TaskComposer } from "./TaskComposer";
import { Dialog } from "./Dialog";
import { MessageAttachments } from "./MessageAttachments";
import { Tooltip } from "./Tooltip";
import styles from "./Messaging.module.scss";
import { RichText } from "./RichText";
function ConnectionAngles({ link, sourceName, targetName }: { link: CommunicationLink; sourceName: string; targetName: string }) {
  const store = useAgentStore();
  const savedDraft = useAgents(s => s.anchorDrafts[link.id]);
  const [patch, setPatch] = useState<Partial<Record<keyof CommunicationAnchors, string>>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setSaved(false);
    try {
      const angles = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, Number(value)]));
      await store.getState().saveCommunicationAnchors(link.workspaceId, link.id, angles);
      setPatch({}); setSaved(true);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <form className={styles.form} onSubmit={event => void submit(event)}>
    <p>Connection points run clockwise from 0° on the right.</p>
    {([["sourceAnchorAngle", sourceName], ["targetAnchorAngle", targetName]] as const).map(([key, name]) =>
      <label key={key}>{name} connection angle
        <input type="number" name={key} min="0" max="359.99999999999994" step="any" required
          value={patch[key] ?? savedDraft?.[key] ?? link[key]} disabled={busy || link.state !== "active"}
          onChange={event => { setPatch(previous => ({ ...previous, [key]: event.target.value })); setSaved(false); }} />
      </label>)}
    <button type="submit" className="button secondary" disabled={busy || link.state !== "active" || !Object.keys(patch).length}>Apply connection points</button>
    {error && <Feedback role="alert">{error}</Feedback>}
    {saved && <p role="status">Connection points saved.</p>}
  </form>;
}
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
      title={link ? "Agent connection" : "Connect agents"}
      onClose={close}
      busy={working}
    >
      <div className={styles.panel}>
        <p>
          A connection lets both agents discover and message each other, including
          initiating requests and notifications.
        </p>
        {link ? (
          <>
            <p>
              <strong>
                {agents.find((a) => a.id === link.sourceAgentId)?.name ??
                  link.sourceAgentId}
              </strong>{" "}
              and{" "}
              <strong>
                {agents.find((a) => a.id === link.targetAgentId)?.name ??
                  link.targetAgentId}
              </strong>
            </p>
            <ConnectionAngles key={link.id} link={link}
              sourceName={agents.find(agent => agent.id === link.sourceAgentId)?.name ?? "First agent"}
              targetName={agents.find(agent => agent.id === link.targetAgentId)?.name ?? "Second agent"} />
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
                  Messages, working files, and attachments will be
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
              Agent
              <select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  if (target === e.target.value) setTarget("");
                }}
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
              Connect with
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
              Connect agents
            </button>
          </form>
        )}
        {error && (
          <Feedback role="alert">
            {error}
          </Feedback>
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
  const target = useInboxNotifications(state => state.target);
  const notifications = useInboxNotificationStore();
  const targetRef = useRef<HTMLLIElement>(null);
  const [targetEntry, setTargetEntry] = useState<InboxEntry | null>(null);
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
  useEffect(() => {
    if (!target || target.workspaceId !== workspaceId) return;
    const controller = new AbortController();
    setOpen(true); setError(""); setTargetEntry(null);
    // Reveal only after the first page settles; inserting that page afterward
    // can otherwise move an older target out of view again.
    void Promise.all([
      request<InboxEntry>(`/inbox/${encodeURIComponent(target.id)}`, "GET", undefined, controller.signal),
      store.getState().loadCommunication(workspaceId),
    ]).then(([entry]) => {
      if (!controller.signal.aborted && entry.workspaceId === workspaceId) setTargetEntry(entry);
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [target, workspaceId, store]);
  useEffect(() => {
    if (open && targetEntry?.id === target?.id) {
      targetRef.current?.scrollIntoView({ block: "center", behavior: "instant" });
      targetRef.current?.focus({ preventScroll: true });
    }
  }, [open, target?.id, targetEntry]);
  function closeInbox() {
    setOpen(false);
    if (notifications?.getState().target?.workspaceId === workspaceId) notifications.setState({ target: null });
  }
  const pageEntries = [
    ...(data?.inbox ?? []),
    ...older.filter((e) => !data?.inbox.some((n) => n.id === e.id)),
  ];
  const entries = targetEntry && !pageEntries.some(entry => entry.id === targetEntry.id) ? [...pageEntries, targetEntry] : pageEntries;
  async function mark(entry: InboxEntry) {
    try {
      const updated = await request<InboxEntry>(`/inbox/${entry.id}`, "PATCH", {
        read: !entry.readAt,
      });
      setTargetEntry(previous => previous?.id === entry.id ? { ...previous, readAt: updated.readAt } : previous);
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
        `/workspaces/${workspaceId}/inbox?limit=50&offset=${pageEntries.length}`,
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
        <Dialog title="Workspace Inbox" onClose={() => { guard(closeInbox); }}>
          <div className={styles.panel}>
            <p>
              Deliberate messages from your agents. Normal task answers remain
              in their conversations.
            </p>
            {!entries.length && <p>No messages yet.</p>}
            <ul className={styles.list}>
              {entries.map((entry) => (
                <li key={entry.id} className={entry.userInputRequestId ? styles.requestEntry : styles.item} tabIndex={entry.id === target?.id ? -1 : undefined} ref={entry.id === target?.id ? targetRef : undefined}>
                  <strong>
                    {entry.agentName}
                    {entry.readAt ? "" : " · Unread"}
                  </strong>
                  <span className={styles.meta}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  {!entry.userInputRequestId && <RichText content={entry.content} instanceId={`inbox-${entry.id}`} />}
                  <AttachedFiles ids={entry.attachments} />
                  {entry.userInputRequestId && <UserInputCard requestId={entry.userInputRequestId} refreshKey={data?.inbox} onChange={refresh} />}
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
                            closeInbox();
                          })
                        }
                      >
                        Open source agent · Task {entry.taskId.slice(0, 8)}
                      </button>
                    )}
                    {!entry.userInputRequestId && <button
                      className="textButton"
                      disabled={!entry.taskId}
                      onClick={() =>
                        setReply(reply === entry.id ? null : entry.id)
                      }
                    >
                      Reply
                    </button>}
                  </div>
                  {reply === entry.id && (
                    <InboxReply entry={entry} onSent={refresh} />
                  )}
                </li>
              ))}
            </ul>
            {pageEntries.length < (data?.total ?? 0) && (
              <button className="button" onClick={() => void more()}>
                Load earlier messages
              </button>
            )}
            {(error || data?.error) && (
              <Feedback role="alert">
                {error || data?.error}
              </Feedback>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
