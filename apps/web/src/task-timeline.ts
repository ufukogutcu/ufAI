import { createStore } from "zustand";
import type { TimelineEntry, TimelinePage } from "../../server/src/contracts";
import { request, errorMessage } from "./api";

export type TimelineReader = (
  before: string | null,
  watch: string[],
  signal: AbortSignal,
) => Promise<TimelinePage>;
interface TimelineState {
  items: TimelineEntry[];
  before: string | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  more: () => Promise<void>;
  dispose: () => void;
}
// Tool arguments/results and communication bodies are immutable once committed.
// Compare the mutable presentation fields so unrelated workspace events retain
// row references without deep-comparing potentially large tool outputs.
function sameEntry(a: TimelineEntry | undefined, b: TimelineEntry): boolean {
  if (!a) return false;
  return (
    a.order === b.order &&
    a.status === b.status &&
    a.error === b.error &&
    a.contextName === b.contextName &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.message?.content === b.message?.content &&
    a.message?.state === b.message?.state &&
    a.message?.authorName === b.message?.authorName &&
    (a.message?.parts
      ?.map((p) =>
        p.type === "artifact" ? p.versionId + p.name + p.mode : p.text,
      )
      .join("\n") ?? "") ===
      (b.message?.parts
        ?.map((p) =>
          p.type === "artifact" ? p.versionId + p.name + p.mode : p.text,
        )
        .join("\n") ?? "") &&
    a.process?.id === b.process?.id &&
    a.process?.state === b.process?.state &&
    a.process?.exitCode === b.process?.exitCode &&
    a.process?.error === b.process?.error &&
    a.request?.id === b.request?.id &&
    a.request?.state === b.request?.state &&
    a.request?.executionState === b.request?.executionState &&
    a.request?.executionError === b.request?.executionError &&
    a.request?.error === b.request?.error &&
    a.checkin?.id === b.checkin?.id &&
    a.checkin?.state === b.checkin?.state &&
    a.checkin?.deliveredTurnId === b.checkin?.deliveredTurnId &&
    a.file?.state === b.file?.state &&
    a.file?.error === b.file?.error
  );
}
export function createTimelineStore(
  taskId: string,
  read: TimelineReader = (before, watch, signal) => {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    if (watch.length) query.set("watch", watch.join(","));
    return request<TimelinePage>(
      `/tasks/${encodeURIComponent(taskId)}/timeline?${query}`,
      "GET",
      undefined,
      signal,
    );
  },
) {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  let pending = false;
  const store = createStore<TimelineState>((set, get) => {
    async function load(older: boolean) {
      if (controller.signal.aborted) return;
      if (running) {
        if (!older) pending = true;
        return running;
      }
      if (older && !get().before) return;
      const perform = async () => {
        let history = older;
        do {
          pending = false;
          set({ loading: true });
          const previous = get().items;
          const watch = previous
            .filter(
              (i) =>
                i.status === "running" ||
                i.status === "waiting" ||
                (i.process &&
                  ["starting", "running"].includes(i.process.state)) ||
                (i.checkin &&
                  (i.checkin.state === "scheduled" ||
                    (i.checkin.state === "fired" &&
                      !i.checkin.deliveredTurnId))) ||
                i.request?.state === "open" ||
                i.message?.state === "streaming",
            )
            .map((i) => i.id);
          try {
            let page = await read(
              history ? get().before : null,
              watch.slice(0, 100),
              controller.signal,
            );
            if (controller.signal.aborted) return;
            const updates = page.updates;
            const removed = page.removed;
            for (let start = 100; start < watch.length; start += 100) {
              const watched = await read(
                null,
                watch.slice(start, start + 100),
                controller.signal,
              );
              if (controller.signal.aborted) return;
              updates.push(...watched.updates);
              removed.push(...watched.removed);
            }
            const items = [...page.items];
            // A burst may exceed one page. Close the gap before merging so no
            // actions silently disappear between two invalidations.
            if (!history && previous.length) {
              const known = new Set(previous.map((i) => i.id));
              while (page.before && !page.items.some((i) => known.has(i.id))) {
                page = await read(page.before, [], controller.signal);
                if (controller.signal.aborted) return;
                items.unshift(...page.items);
              }
            }
            const merged = new Map(previous.map((i) => [i.id, i]));
            for (const id of removed) merged.delete(id);
            for (const item of [...items, ...updates])
              if (!sameEntry(merged.get(item.id), item))
                merged.set(item.id, item);
            const sorted = [...merged.values()].sort((a, b) =>
              a.order.localeCompare(b.order),
            );
            set({
              items:
                sorted.length === previous.length &&
                sorted.every((item, index) => item === previous[index])
                  ? previous
                  : sorted,
              before: history || !previous.length ? page.before : get().before,
              error: "",
            });
          } catch (e) {
            if (!controller.signal.aborted) set({ error: errorMessage(e) });
          }
          history = false;
        } while (pending && !controller.signal.aborted);
      };
      running = perform().finally(() => {
        running = undefined;
        if (!controller.signal.aborted) set({ loading: false });
      });
      return running;
    }
    return {
      items: [],
      before: null,
      loading: false,
      error: "",
      refresh: () => load(false),
      more: () => load(true),
      dispose: () => controller.abort(),
    };
  });
  return store;
}

type ActionCopy = readonly [string, string];
export const toolLabels: Record<string, ActionCopy> = {
  agent_update_instructions: ["Updating instructions", "Updated instructions"],
  agent_inspect: ["Checking agent status", "Checked agent status"],
  agent_task_read: ["Reading task conversation", "Read task conversation"],
  agents_find: ["Finding connected agents", "Found connected agents"],
  agent_send: ["Sending a message", "Sent a message"],
  agent_message: ["Sending a reply", "Sent a reply"],
  agent_request_status: ["Checking request status", "Checked request status"],
  agent_wait: [
    "Waiting for agent replies",
    "Finished waiting for agent replies",
  ],
  task_schedule_checkin: ["Scheduling a check-in", "Scheduled a check-in"],
  task_cancel_checkin: ["Cancelling a check-in", "Cancelled a check-in"],
  task_yield: ["Saving progress and waiting", "Saved progress and yielded"],
  task_set_outputs: [
    "Selecting reply attachments",
    "Selected reply attachments",
  ],
  user_notify: ["Sending a message to Inbox", "Sent a message to Inbox"],
  media_open: ["Opening media", "Opened media"],
  files_list: ["Listing files", "Listed files"],
  files_read: ["Reading file", "Read file"],
  files_write: ["Writing file", "Wrote file"],
  process_start: ["Starting command", "Started command"],
  process_output: ["Reading command output", "Read command output"],
  process_input: ["Sending process input", "Sent process input"],
  process_resize: ["Resizing terminal", "Resized terminal"],
  process_stop: ["Stopping process", "Stopped process"],
  process_wait: ["Waiting for process", "Finished waiting for process"],
  artifacts_list: ["Listing published files", "Listed published files"],
  artifact_inspect: ["Checking file details", "Checked file details"],
  artifact_publish: ["Publishing file", "Published file"],
  artifact_materialize: ["Copying published file", "Copied published file"],
};
export function actionLabel(item: TimelineEntry) {
  const labels = toolLabels[item.name ?? ""] ?? [
    "Running action",
    "Finished action",
  ];
  const active = item.status === "running" || item.status === "waiting";
  const label = labels[item.status === "completed" ? 1 : 0];
  const a = item.arguments ?? {};
  const context = item.contextName
    ? ["agent_send", "agent_message"].includes(item.name ?? "")
      ? `to ${item.contextName}`
      : item.contextName
    : (a.path ??
      a.command ??
      item.process?.command ??
      (item.name === "agents_find" ? a.query : undefined));
  const readable =
    typeof context === "string" ? context.replace(/\s+/g, " ").trim() : "";
  const excerpt =
    readable.length > 160 ? readable.slice(0, 160) + "…" : readable;
  return `${label}${excerpt ? ` · ${excerpt}` : ""}${active ? "…" : ""}`;
}
