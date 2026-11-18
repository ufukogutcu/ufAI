import { UserInputCard } from "./UserInputCard";
import { BusyButton, Feedback, LoadingState } from "./Feedback";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { RichText } from "./RichText";

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
        <BusyButton busy={busy}
          type="button"
          className="textButton"
          disabled={busy}
          onClick={() => void cancel()}
        >
          {busy ? "Cancelling…" : "Cancel check-in"}
        </BusyButton>
      )}
      <p ref={feedback} tabIndex={-1} role="status" className={styles.meta}>
        {notice}
      </p>
      {error && (
        <Feedback role="alert">
          {error}
        </Feedback>
      )}
    </div>
  );
}
function TimelineRow({
  frozen = false,
  item,
  taskId,
  onChange,
  onInspect,
}: {
  frozen?: boolean;
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
              <span className={styles.meta}> · {frozen ? "Frozen" : "Writing…"}</span>
            )}
            {m.state === "incomplete" && (
              <span className={styles.failure}> · Incomplete reply</span>
            )}
          </div>
        )}
        {own && <span className={styles.srOnly}>You: </span>}
        {m.content && <RichText content={m.content} instanceId={`timeline-${taskId}-${item.id}`} streaming={m.state === "streaming" && !frozen} />}
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
      {item.userInput && <UserInputCard requestId={item.userInput.id} item={item.userInput} onChange={onChange} />}
      <button
        type="button"
        className={item.userInput ? `${styles.action} ${styles.requestActivity}` : styles.action}
        aria-expanded={open}
        aria-label={item.userInput ? `Activity details for ${item.userInput.name}` : undefined}
        onClick={() => {
          if (!open) onInspect();
          setOpen((v) => !v);
        }}
      >
        <Icon
          size={15}
          aria-hidden="true"
          className={
            active && !frozen && item.status === "running" ? styles.spinner : undefined
          }
        />
        <span className={styles.actionLabel} title={item.userInput ? undefined : label}>
          {messageLabel ? <>
            {messageLabel.prefix}
            <span className={styles.peerNameStart}>
              {appearance && <span className={styles.portrait} aria-hidden="true"><AgentCharacter appearance={appearance} portrait decorative /></span>}
              {nameStart}
            </span>{nameRest}{messageLabel.suffix}
          </> : item.userInput ? "Activity details" : label}
        </span>
        {item.status && (!item.userInput || item.status !== "completed") && (
          <span
            className={`${styles.state} ${item.status === "failed" || item.status === "interrupted" ? styles.failure : ""}`}
          >
            {item.name === "process_output" && item.status === "failed" ? "Output read failed" : frozen && active ? "Frozen" : statusLabels[item.status]}
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
          {item.name === "process_output" ? "Underlying command" : "Process"} {item.process.state}
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
            ) && <RichText content={item.arguments.content} instanceId={`arguments-${taskId}-${item.id}`} />}
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
              <RichText content={communication.content} instanceId={`communication-${taskId}-${item.id}`} />
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
  frozen = false,
  store,
  taskId,
}: {
  frozen?: boolean;
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
    content = useRef<HTMLDivElement>(null),
    nearEnd = useRef(true),
    anchor = useRef<{ id: string; top: number } | null>(null);
  const [unseen, setUnseen] = useState(false);
  const previousItems = useRef(items);
  const scrollViewport = useCallback(() => {
    const el = viewport.current;
    if (!el) return null;
    return getComputedStyle(el).overflowY === "visible"
      ? (el.closest<HTMLElement>("[data-agent-panel]") ?? el)
      : el;
  }, []);
  useEffect(() => {
    const transcript = viewport.current;
    if (!transcript) return;
    const panel = transcript.closest<HTMLElement>("[data-agent-panel]");
    let reader: { row: HTMLElement; top: number } | null = null;
    let adjustedScroll: number | null = null;
    function rememberReader() {
      if (!viewport.current) return;
      const el = scrollViewport();
      if (!el) return;
      const bounds = el.getBoundingClientRect();
      const top = bounds.top;
      const row = Array.from(viewport.current!.querySelectorAll<HTMLElement>("[data-timeline-id]")).find((node) => node.getBoundingClientRect().bottom > top);
      // Anchor a visible block inside a long message, so an image earlier in that same
      // message cannot move the paragraph being read. Prefer a fully visible block.
      const blocks = row ? Array.from(row.querySelectorAll<HTMLElement>("[data-rich-text] p, [data-rich-text] h1, [data-rich-text] h2, [data-rich-text] h3, [data-rich-text] h4, [data-rich-text] h5, [data-rich-text] h6, [data-rich-text] pre, [data-rich-text] table, [data-rich-text] summary")) : [];
      const focused = document.activeElement instanceof HTMLElement && viewport.current.contains(document.activeElement) && document.activeElement.closest("[data-rich-text]") ? document.activeElement : null;
      const focusBounds = focused?.getBoundingClientRect();
      const visible = (focused && focusBounds!.bottom > top && focusBounds!.top < bounds.bottom ? focused : null) ?? blocks.find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top >= top && rect.top < bounds.bottom;
      }) ?? blocks.find((node) => node.getBoundingClientRect().bottom > top) ?? row;
      reader = visible ? { row: visible, top: visible.getBoundingClientRect().top } : null;
    }
    const update = () => {
      const el = scrollViewport();
      if (!el) return;
      nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      if (nearEnd.current) setUnseen(false);
      if (adjustedScroll === null || Math.abs(el.scrollTop - adjustedScroll) > 1) rememberReader();
      adjustedScroll = null;
    };
    // Images, fonts and diagrams can change height after a timeline refresh has settled.
    const observer = new ResizeObserver(() => {
      const el = scrollViewport();
      if (!el) return;
      if (nearEnd.current) el.scrollTop = el.scrollHeight;
      else if (reader?.row.isConnected) {
        el.scrollTop += reader.row.getBoundingClientRect().top - reader.top;
        reader.top = reader.row.getBoundingClientRect().top;
        adjustedScroll = el.scrollTop;
      } else rememberReader();
    });
    if (content.current) observer.observe(content.current);
    observer.observe(transcript);
    if (panel) observer.observe(panel);
    rememberReader();
    transcript.addEventListener("scroll", update, { passive: true });
    panel?.addEventListener("scroll", update, { passive: true });
    return () => {
      transcript.removeEventListener("scroll", update);
      panel?.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scrollViewport]);
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
  const announcement = frozen ? "Agent is frozen. New work will wait." : live.length
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
        <div ref={content}>
        {before && (
          <BusyButton busy={loading}
            type="button"
            className="textButton"
            disabled={loading}
            onClick={loadEarlier}
          >
            {loading ? "Loading…" : "Load earlier conversation"}
          </BusyButton>
        )}
        {!items.length && !loading && !error && (
          <p className={styles.meta}>Your conversation appears here.</p>
        )}
        {items.map((item) => (
          <div key={item.id} data-timeline-id={item.id} tabIndex={-1}>
            <TimelineRow frozen={frozen} item={item} taskId={taskId} onChange={refresh} onInspect={inspect} />
          </div>
        ))}
        {error && (
          <Feedback role="alert">
            {error}
            <button
              type="button"
              className="textButton"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </Feedback>
        )}
        {loading && !items.length && (
          <LoadingState className={styles.meta}>Loading conversation…</LoadingState>
        )}
        </div>
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
export function TaskTimeline({ taskId, frozen = false }: { taskId: string; frozen?: boolean }) {
  const [store, setStore] = useState<ReturnType<
    typeof createTimelineStore
  > | null>(null);
  useEffect(() => {
    const instance = createTimelineStore(taskId);
    setStore(instance);
    return () => instance.getState().dispose();
  }, [taskId]);
  return store ? <TimelineContent frozen={frozen} key={taskId} store={store} taskId={taskId} /> : null;
}
