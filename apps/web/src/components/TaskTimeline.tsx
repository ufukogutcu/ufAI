import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  ArrowDown,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  LoaderCircle,
  MessageSquare,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { TimelineEntry, TaskCheckIn } from "../../../server/src/contracts";
import { useAgents, useAgentStore } from "../agent-store";
import { createTimelineStore, actionLabel, messageActionLabel } from "../task-timeline";
import { request, errorMessage } from "../api";
import { MessageAttachments } from "./MessageAttachments";
import { ArtifactCard, ProcessActivity } from "./TaskTools";
import { AgentCharacter } from "./AgentCharacter";
import styles from "./TaskTimeline.module.scss";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const statusLabels = {
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};
function CheckIn({
  item,
  onChange,
}: {
  item: TaskCheckIn;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) feedback.current?.focus();
  }, [notice]);
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await request(`/tasks/${item.taskId}/check-ins/${item.id}`, "DELETE");
      setNotice("Check-in cancelled.");
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.checkin}>
      <p>{item.reason}</p>
      <p className={styles.meta}>
        <time dateTime={item.dueAt}>
          {dateFormatter.format(new Date(item.dueAt))}
        </time>{" "}
        ·{" "}
        {item.state === "fired"
          ? item.deliveredTurnId
            ? "Delivered"
            : "Ready to resume"
          : item.state === "scheduled"
            ? "Scheduled"
            : "Cancelled"}
      </p>
      {(item.state === "scheduled" ||
        (item.state === "fired" && !item.deliveredTurnId)) && (
        <button
          type="button"
          className="textButton"
          disabled={busy}
          onClick={() => void cancel()}
        >
          {busy ? "Cancelling…" : "Cancel check-in"}
        </button>
      )}
      <p ref={feedback} tabIndex={-1} role="status" className={styles.meta}>
        {notice}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
function TimelineRow({
  item,
  taskId,
  onChange,
  onInspect,
}: {
  item: TimelineEntry;
  taskId: string;
  onChange: () => void;
  onInspect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const store = useAgentStore();
  const messageLabel = messageActionLabel(item, taskId);
  const appearance = useAgents(s => messageLabel?.agentId ? s.agents[messageLabel.agentId]?.appearance : undefined);
  const nameBreak = messageLabel?.name.search(/\s/) ?? -1;
  const nameStart = nameBreak < 0 ? messageLabel?.name : messageLabel?.name.slice(0, nameBreak);
  const nameRest = nameBreak < 0 ? "" : messageLabel?.name.slice(nameBreak);
  const m = item.message;
  if (m) {
    const own = m.role === "user" && (!m.authorType || m.authorType === "user");
    return (
      <article
        className={`${styles.message} ${own ? styles.user : styles.agent}`}
      >
        {!own && (
          <div className={styles.author}>
            {m.role === "assistant"
              ? "Agent"
              : m.authorType === "system"
                ? "System"
                : (m.authorName ?? "Collaborator")}
            {m.state === "streaming" && (
              <span className={styles.meta}> · Writing…</span>
            )}
            {m.state === "incomplete" && (
              <span className={styles.failure}> · Incomplete reply</span>
            )}
          </div>
        )}
        {own && <span className={styles.srOnly}>You: </span>}
        {m.content && <div className={styles.text}>{m.content}</div>}
        <MessageAttachments parts={m.parts} />
      </article>
    );
  }
  const active = item.status === "running" || item.status === "waiting";
  const communication = item.communication;
  const label =
    messageLabel
      ? messageLabel.label
      : item.kind === "checkin"
        ? "Scheduled check-in"
        : item.kind === "file"
          ? `Published ${item.file?.name ?? "file"}`
          : actionLabel(item);
  const Icon = active
    ? item.status === "waiting"
      ? Clock3
      : LoaderCircle
    : item.status === "failed" ||
        item.status === "cancelled" ||
        item.status === "interrupted"
      ? X
      : item.kind === "communication" ||
          item.name?.startsWith("agent_send") ||
          item.name === "agent_message"
        ? MessageSquare
        : item.name?.startsWith("files_") || item.kind === "file"
          ? FileText
          : item.name?.startsWith("process_")
            ? Terminal
            : item.kind === "checkin"
              ? Clock3
              : item.status === "completed"
                ? Check
                : Wrench;
  const req = item.request;
  function navigate(agentId: string, taskId: string) {
    store.setState({ requestedTask: { agentId, taskId } });
  }
  const fileResult = item.result?.version as TimelineEntry["file"];
  return (
    <div className={styles.activity}>
      <button
        type="button"
        className={styles.action}
        aria-expanded={open}
        onClick={() => {
          if (!open) onInspect();
          setOpen((v) => !v);
        }}
      >
        <Icon
          size={15}
          aria-hidden="true"
          className={
            active && item.status === "running" ? styles.spinner : undefined
          }
        />
        <span className={styles.actionLabel} title={label}>
          {messageLabel ? <>
            {messageLabel.prefix}
            <span className={styles.peerNameStart}>
              {appearance && <span className={styles.portrait} aria-hidden="true"><AgentCharacter appearance={appearance} portrait decorative /></span>}
              {nameStart}
            </span>{nameRest}{messageLabel.suffix}
          </> : label}
        </span>
        {item.status && (
          <span
            className={`${styles.state} ${item.status === "failed" || item.status === "interrupted" ? styles.failure : ""}`}
          >
            {statusLabels[item.status]}
          </span>
        )}
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={open ? styles.chevronOpen : styles.chevron}
        />
      </button>
      {item.process && (
        <p className={styles.processState}>
          Process {item.process.state}
          {item.process.exitCode !== null
            ? ` · exit ${item.process.exitCode}`
            : ""}
        </p>
      )}
      {(item.error || req?.error || req?.executionError) && (
        <p className={styles.failure}>
          {item.error || req?.error || req?.executionError}
        </p>
      )}
      {open && (
        <div className={styles.details}>
          <time className={styles.meta} dateTime={item.createdAt}>
            {dateFormatter.format(new Date(item.createdAt))}
          </time>
          {typeof item.arguments?.content === "string" &&
            ["agent_send", "agent_message", "user_notify"].includes(
              item.name ?? "",
            ) && <p className={styles.text}>{item.arguments.content}</p>}
          {Array.isArray(item.arguments?.versionIds) && (
            <MessageAttachments
              parts={item.arguments.versionIds
                .filter((id): id is string => typeof id === "string")
                .map((versionId) => ({
                  type: "artifact",
                  versionId,
                  name: "Attachment",
                }))}
            />
          )}
          {communication && (
            <>
              <p className={styles.text}>{communication.content}</p>
              <MessageAttachments
                parts={communication.attachments.map((versionId) => ({
                  type: "artifact",
                  versionId,
                  name: "Attachment",
                }))}
              />
            </>
          )}
          {req && (
            <>
              <p className={styles.meta}>
                {req.sourceName} → {req.targetName} · {req.state}
                {req.executionState ? ` · ${req.executionState}` : ""}
              </p>
              {(req.error || req.executionError) && (
                <p className={styles.failure}>
                  {req.error || req.executionError}
                </p>
              )}
              <div className={styles.controls}>
                {req.sourceAgentId && req.sourceTaskId && (
                  <button
                    type="button"
                    className="textButton"
                    onClick={() =>
                      navigate(req.sourceAgentId!, req.sourceTaskId!)
                    }
                  >
                    Open requester task
                  </button>
                )}
                {req.targetAgentId && req.targetTaskId && (
                  <button
                    type="button"
                    className="textButton"
                    onClick={() =>
                      navigate(req.targetAgentId!, req.targetTaskId!)
                    }
                  >
                    Open helper task
                  </button>
                )}
              </div>
            </>
          )}
          {item.process && (
            <ProcessActivity process={item.process} onChange={onChange} />
          )}
          {item.checkin && <CheckIn item={item.checkin} onChange={onChange} />}
          {item.file && <ArtifactCard version={item.file} />}
          {fileResult?.id && <ArtifactCard version={fileResult} />}
          {item.arguments && (
            <details>
              <summary>Arguments</summary>
              <pre className={styles.output}>
                {JSON.stringify(item.arguments, null, 2)}
              </pre>
            </details>
          )}
          {item.result && Object.keys(item.result).length > 0 && (
            <details>
              <summary>Result</summary>
              <pre className={styles.output}>
                {JSON.stringify(item.result, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineContent({
  store,
  taskId,
}: {
  store: ReturnType<typeof createTimelineStore>;
  taskId: string;
}) {
  const items = useStore(store, (s) => s.items),
    before = useStore(store, (s) => s.before),
    loading = useStore(store, (s) => s.loading),
    error = useStore(store, (s) => s.error);
  const refresh = useStore(store, (s) => s.refresh),
    more = useStore(store, (s) => s.more);
  const version = useAgents((s) => s.timelineVersion);
  const viewport = useRef<HTMLDivElement>(null),
    nearEnd = useRef(true),
    anchor = useRef<{ id: string; top: number } | null>(null);
  const [unseen, setUnseen] = useState(false);
  const previousItems = useRef(items);
  function scrollViewport() {
    const el = viewport.current;
    if (!el) return null;
    return getComputedStyle(el).overflowY === "visible"
      ? (el.closest<HTMLElement>("[data-agent-panel]") ?? el)
      : el;
  }
  useEffect(() => {
    const el = scrollViewport();
    if (!el) return;
    const update = () => {
      nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      if (nearEnd.current) setUnseen(false);
    };
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  });
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      void refresh();
    }, 80);
  }, [refresh, version]);
  useEffect(
    () => () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = undefined;
    },
    [refresh],
  );
  useLayoutEffect(() => {
    const el = scrollViewport();
    if (!el) return;
    if (anchor.current) {
      const row = Array.from(
        viewport.current!.querySelectorAll<HTMLElement>("[data-timeline-id]"),
      ).find((n) => n.dataset.timelineId === anchor.current?.id);
      if (row) {
        el.scrollTop += row.getBoundingClientRect().top - anchor.current.top;
        if (!before && document.activeElement === document.body)
          row.focus({ preventScroll: true });
      }
      anchor.current = null;
    } else if (nearEnd.current) el.scrollTop = el.scrollHeight;
    else if (previousItems.current !== items) setUnseen(true);
    previousItems.current = items;
  }, [items, before]);
  useEffect(() => {
    if (error) anchor.current = null;
  }, [error]);
  function loadEarlier() {
    const el = scrollViewport();
    if (el) {
      const first = Array.from(
        viewport.current!.querySelectorAll<HTMLElement>("[data-timeline-id]"),
      ).find(
        (n) =>
          n.getBoundingClientRect().bottom >= el.getBoundingClientRect().top,
      );
      if (first)
        anchor.current = {
          id: first.dataset.timelineId!,
          top: first.getBoundingClientRect().top,
        };
    }
    nearEnd.current = false;
    void more();
  }
  function inspect() {
    nearEnd.current = false;
  }
  function jump() {
    nearEnd.current = true;
    setUnseen(false);
    const el = scrollViewport();
    if (el) el.scrollTop = el.scrollHeight;
  }
  const live = items.filter(
    (i) => i.status === "running" || i.status === "waiting",
  );
  const streaming = items.some((i) => i.message?.state === "streaming");
  const announcement = live.length
    ? `${live.length} ${live.length === 1 ? "action" : "actions"} in progress. ${actionLabel(live.at(-1)!)}`
    : streaming
      ? "Agent is responding."
      : items.length
        ? "Conversation updated."
        : "";
  return (
    <div className={styles.container}>
      <div
        ref={viewport}
        className={styles.transcript}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearEnd.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          if (nearEnd.current) setUnseen(false);
        }}
      >
        {before && (
          <button
            type="button"
            className="textButton"
            disabled={loading}
            onClick={loadEarlier}
          >
            {loading ? "Loading…" : "Load earlier conversation"}
          </button>
        )}
        {!items.length && !loading && !error && (
          <p className={styles.meta}>Your conversation appears here.</p>
        )}
        {items.map((item) => (
          <div key={item.id} data-timeline-id={item.id} tabIndex={-1}>
            <TimelineRow item={item} taskId={taskId} onChange={refresh} onInspect={inspect} />
          </div>
        ))}
        {error && (
          <p className="errorBanner" role="alert">
            {error}
            <button
              type="button"
              className="textButton"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </p>
        )}
        {loading && !items.length && (
          <p className={styles.meta}>Loading conversation…</p>
        )}
      </div>
      <p
        className={styles.srOnly}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      {unseen && (
        <div className={styles.jump}>
          <button type="button" className="button" onClick={jump}>
            <ArrowDown size={14} aria-hidden="true" />
            Jump to latest
          </button>
        </div>
      )}
    </div>
  );
}
export function TaskTimeline({ taskId }: { taskId: string }) {
  const [store, setStore] = useState<ReturnType<
    typeof createTimelineStore
  > | null>(null);
  useEffect(() => {
    const instance = createTimelineStore(taskId);
    setStore(instance);
    return () => instance.getState().dispose();
  }, [taskId]);
  return store ? <TimelineContent key={taskId} store={store} taskId={taskId} /> : null;
}
