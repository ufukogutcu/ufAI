import { Feedback, BusyButton, LoadingState } from "./Feedback";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useStore } from "zustand";
import { ArrowLeft, Plus, RefreshCw, Timer, X } from "lucide-react";
import type {
  EventFilter,
  EventReceipt,
  EventSource,
  SkillAutomationSetup,
  SkillTriggerTemplate,
  Trigger,
  TriggerInput,
  TriggerOccurrence,
  TriggerPage,
  TriggerWhen,
} from "../../../server/src/trigger-types";
import type { SkillSummary } from "../../../server/src/skill-types";
import { errorMessage, request, RequestError } from "../api";
import { useAgents, useAgentStore } from "../agent-store";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import { useTriggerStore } from "../trigger-store";
import { refreshOnFocus } from "../focus-refresh";
import { Field } from "./FormField";
import { Dialog } from "./Dialog";
import { Tooltip } from "./Tooltip";
import { SkillSwitch } from "./SkillSwitch";
import styles from "./Triggers.module.scss";
const encode = encodeURIComponent;
const date = (v: string | null, zone?: string) =>
  v
    ? new Date(v).toLocaleString(
        undefined,
        zone ? { timeZone: zone } : undefined,
      )
    : "—";
const summary = (w: TriggerWhen) =>
  w.kind === "cron"
    ? `${w.expression} · ${w.timezone}`
    : w.kind === "every"
      ? `Every ${w.everyMs / 1000}s`
      : w.kind === "at"
        ? `${date(w.at, w.timezone)} · ${w.timezone}`
        : w.eventType;
function useRefresh(refresh: () => Promise<void>) {
  const version = useAgents((s) => s.eventVersion);
  useEffect(() => {
    void refresh();
  }, [refresh, version]);
  useEffect(() => refreshOnFocus(refresh), [refresh]);
}
function useReadSequence() {
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  return sequence;
}
function Pagination({
  offset,
  total,
  onPage,
}: {
  offset: number;
  total: number;
  onPage: (n: number) => void;
}) {
  return (
    <div className={styles.pagination}>
      <button
        type="button"
        className="textButton"
        disabled={!offset}
        onClick={() => onPage(Math.max(0, offset - 50))}
      >
        Previous
      </button>
      <span>
        {total
          ? `${offset + 1}–${Math.min(offset + 50, total)} of ${total}`
          : "No entries"}
      </span>
      <button
        type="button"
        className="textButton"
        disabled={offset + 50 >= total}
        onClick={() => onPage(offset + 50)}
      >
        Next
      </button>
    </div>
  );
}
const TriggerRow = memo(function TriggerRow({
  id,
  onOpen,
}: {
  id: string;
  onOpen: (id: string) => void;
}) {
  const store = useTriggerStore(),
    t = useStore(store, (s) => s.entities[id]);
  if (!t) return null;
  return (
    <div className={styles.row}>
      <button className={styles.identity} onClick={() => onOpen(id)}>
        <span className={styles.title}>{t.name}</span>
        <span className={styles.help}>{summary(t.when)}</span>
        <span className={styles.status}>
          {t.state.replaceAll("_", " ")} · {t.queued} queued
          {t.collectingBacklog ? " · collecting catch-up" : ""}
          {t.skillId ? " · From skill" : ""}
        </span>
      </button>
      {t.blocker && <span className={styles.help}>{t.blocker}</span>}
      {t.oldestPendingAt && (
        <span className={styles.status}>
          Oldest pending: {date(t.oldestPendingAt)}
        </span>
      )}
    </div>
  );
});
interface FilterDraft {
  id: string;
  path: string;
  operator: EventFilter["operator"];
  value: string;
}
interface Draft {
  name: string;
  instructions: string;
  kind: TriggerWhen["kind"];
  local: string;
  timezone: string;
  seconds: string;
  expression: string;
  eventType: string;
  sourceId: string;
  filters: FilterDraft[];
  requiredSkillIds: string[];
}
function localTime(at: string, zone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function draftFrom(t?: Trigger): Draft {
  const w = t?.when,
    zone =
      w && (w.kind === "cron" || w.kind === "at")
        ? w.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    name: t?.name ?? "",
    instructions: t?.instructions ?? "",
    kind: w?.kind ?? "cron",
    local: w?.kind === "at" ? localTime(w.at, zone) : "",
    timezone: zone,
    seconds: String(w?.kind === "every" ? w.everyMs / 1000 : 3600),
    expression: w?.kind === "cron" ? w.expression : "0 9 * * 1-5",
    eventType: w?.kind === "event" ? w.eventType : "",
    sourceId: w?.kind === "event" ? (w.sourceId ?? "") : "",
    filters:
      w?.kind === "event"
        ? (w.filters ?? []).map((f) => ({
            id: crypto.randomUUID(),
            path: f.path,
            operator: f.operator,
            value: JSON.stringify(f.value) ?? "",
          }))
        : [],
    requiredSkillIds: t?.requiredSkillIds ?? [],
  };
}
function TriggerEditor({
  workspaceId,
  agentId,
  existing,
  onBack,
  onSaved,
  onTaskOpen,
}: {
  workspaceId: string;
  agentId: string;
  existing?: Trigger;
  onBack: () => void;
  onSaved: (t: Trigger) => void;
  onTaskOpen?: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFrom(existing)),
    [savedDraft, setSavedDraft] = useState(() => JSON.stringify(draft));
  const [sources, setSources] = useState<EventSource[]>([]),
    [skills, setSkills] = useState<SkillSummary[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<string[]>([]),
    [sample, setSample] = useState('{"example":"value"}'),
    [sampleMatch, setSampleMatch] = useState<boolean | null>(null);
  const [current, setCurrent] = useState(existing),
    [confirm, setConfirm] = useState<"delete" | "queue" | null>(null),
    [activity, setActivity] = useState<TriggerPage<TriggerOccurrence>>({
      items: [],
      total: 0,
    }),
    [offset, setOffset] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null),
    store = useTriggerStore(),
    agents = useAgentStore(),
    guard = useNavigationGuard();
  const dirty = JSON.stringify(draft) !== savedDraft;
  useUnsavedChanges(dirty);
  const eventVersion = useAgents((s) => s.eventVersion);
  const latest = useStore(store, (s) =>
    existing ? s.entities[existing.id] : undefined,
  );
  const conflict =
    !!current && !!latest && current.revision !== latest.revision;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  useEffect(() => {
    const c = new AbortController();
    void Promise.all([
      request<TriggerPage<EventSource>>(
        `/workspaces/${encode(workspaceId)}/event-sources?limit=100`,
        "GET",
        undefined,
        c.signal,
      ).then((p) => setSources(p.items)),
      (async () => {
        const all: SkillSummary[] = [];
        for (let offset = 0; ; offset += 100) {
          const p = await request<{ items: SkillSummary[]; total: number }>(
            `/agents/${encode(agentId)}/skills?limit=100&offset=${offset}`,
            "GET",
            undefined,
            c.signal,
          );
          all.push(...p.items);
          if (all.length >= p.total) break;
        }
        setSkills(all);
      })(),
    ]).catch((e) => {
      if (!c.signal.aborted) setError(errorMessage(e));
    });
    return () => c.abort();
  }, [workspaceId, agentId, eventVersion]);
  const activityRead = useReadSequence();
  const loadActivity = useCallback(async () => {
    const sequence = ++activityRead.current;
    if (!current) return;
    try {
      const page = await request<TriggerPage<TriggerOccurrence>>(
        `/triggers/${encode(current.id)}/occurrences?limit=50&offset=${offset}`,
      );
      if (activityRead.current === sequence) setActivity(page);
    } catch (e) {
      if (activityRead.current === sequence) setError(errorMessage(e));
    }
  }, [current, offset, activityRead]);
  useRefresh(loadActivity);
  async function when(): Promise<TriggerWhen> {
    if (draft.kind === "at") {
      const { at } = await request<{ at: string }>(
        "/triggers/resolve-time",
        "POST",
        { local: draft.local, timezone: draft.timezone },
      );
      return { kind: "at", at, timezone: draft.timezone };
    }
    if (draft.kind === "every")
      return { kind: "every", everyMs: Number(draft.seconds) * 1000 };
    if (draft.kind === "cron")
      return {
        kind: "cron",
        expression: draft.expression,
        timezone: draft.timezone,
      };
    return {
      kind: "event",
      eventType: draft.eventType,
      ...(draft.sourceId ? { sourceId: draft.sourceId } : {}),
      filters: draft.filters.map((f) => ({
        path: f.path,
        operator: f.operator,
        ...(f.operator === "exists" ? {} : { value: JSON.parse(f.value) }),
      })),
    };
  }
  async function save(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      const input: TriggerInput = {
        name: draft.name,
        instructions: draft.instructions,
        when: await when(),
        enabled,
        paused: current?.paused ?? false,
        requiredSkillIds: draft.requiredSkillIds,
        ...(current?.skillId
          ? { skillId: current.skillId, templateId: current.templateId }
          : {}),
      };
      const t = await request<Trigger>(
        current
          ? `/triggers/${encode(current.id)}`
          : `/agents/${encode(agentId)}/triggers`,
        current ? "PATCH" : "POST",
        { trigger: input, expectedRevision: current?.revision },
      );
      store.getState().put(t);
      setCurrent(t);
      setSavedDraft(JSON.stringify(draft));
      onSaved(t);
    } catch (e) {
      setError(errorMessage(e));
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }
  async function action(kind: "pause" | "enable" | "run" | "delete" | "queue") {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      if (kind === "pause" || kind === "enable") {
        const t = await request<Trigger>(
          `/triggers/${encode(current.id)}`,
          "PATCH",
          {
            expectedRevision: current.revision,
            trigger: {
              ...current,
              ...(kind === "pause"
                ? { paused: !current.paused }
                : { enabled: !current.enabled }),
            },
          },
        );
        store.getState().put(t);
        setCurrent(t);
        onSaved(t);
      } else if (kind === "delete") {
        await request(`/triggers/${encode(current.id)}`, "DELETE", {
          expectedRevision: current.revision,
          confirmed: true,
        });
        store.getState().invalidate();
        onBack();
      } else if (kind === "queue") {
        await request(`/triggers/${encode(current.id)}/cancel-queued`, "POST", {
          confirmed: true,
        });
        await loadActivity();
      } else {
        await request(`/triggers/${encode(current.id)}/run`, "POST", {
          requestId: crypto.randomUUID(),
          ...(draft.kind === "event"
            ? {
                event: {
                  eventId: crypto.randomUUID(),
                  eventType: draft.eventType,
                  data: JSON.parse(sample),
                },
              }
            : {}),
        });
        await loadActivity();
      }
      setConfirm(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function showPreview() {
    setError("");
    try {
      const p = await request<{ times: string[]; matches?: boolean }>(
        "/triggers/preview",
        "POST",
        {
          when: await when(),
          ...(draft.kind === "event" ? { sample: JSON.parse(sample) } : {}),
        },
      );
      setPreview(p.times);
      setSampleMatch(p.matches ?? null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const button = (e.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    void save(button?.value === "enable" ? true : (current?.enabled ?? false));
  }
  return (
    <form className={styles.editor} onSubmit={submit}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className="textButton"
          onClick={() => guard(onBack)}
        >
          <ArrowLeft size={14} aria-hidden />
          All triggers
        </button>
        <strong>{current ? current.name : "New trigger"}</strong>
      </div>
      <div className={styles.fields}>
        {error && (
          <Feedback role="alert" tabIndex={-1} ref={errorRef}>
            {error}
          </Feedback>
        )}
        {conflict && (
          <Feedback role="alert">
            This trigger changed elsewhere. Your draft is preserved.{" "}
            <button
              type="button"
              className="textButton"
              onClick={() =>
                guard(() => {
                  setCurrent(latest);
                  const d = draftFrom(latest);
                  setDraft(d);
                  setSavedDraft(JSON.stringify(d));
                })
              }
            >
              Reload saved version
            </button>
          </Feedback>
        )}
        {current && (
          <>
            <p className={styles.status}>
              {latest?.state ?? current.state} ·{" "}
              {latest?.queued ?? current.queued} queued · Next:{" "}
              {date(latest?.nextAt ?? current.nextAt)}
            </p>
            {(latest?.blocker ?? current.blocker) && (
              <Feedback>
                {latest?.blocker ?? current.blocker}
              </Feedback>
            )}
            <div className={styles.actions}>
              <button
                type="button"
                className="button"
                disabled={busy || dirty || conflict}
                onClick={() => void action("enable")}
              >
                {current.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy || dirty || conflict}
                onClick={() => void action("pause")}
              >
                {current.paused ? "Resume processing" : "Pause processing"}
              </button>
              <button
                type="button"
                className="button"
                disabled={
                  busy ||
                  dirty ||
                  conflict ||
                  (latest ?? current).state !== "active"
                }
                onClick={() => void action("run")}
              >
                {draft.kind === "event" ? "Run sample event" : "Run now"}
              </button>
            </div>
          </>
        )}
        <Field label="Name">
          {(p) => (
            <input
              {...p}
              name="trigger-name"
              value={draft.name}
              required
              maxLength={160}
              onChange={(e) => set("name", e.target.value)}
            />
          )}
        </Field>
        <Field label="Task instructions">
          {(p) => (
            <textarea
              {...p}
              name="trigger-instructions"
              rows={5}
              value={draft.instructions}
              required
              maxLength={12000}
              onChange={(e) => set("instructions", e.target.value)}
            />
          )}
        </Field>
        <Field label="When">
          {(p) => (
            <select
              {...p}
              value={draft.kind}
              onChange={(e) => {
                set("kind", e.target.value as Draft["kind"]);
                setPreview([]);
                setSampleMatch(null);
              }}
            >
              <option value="at">Once</option>
              <option value="every">Interval</option>
              <option value="cron">Cron</option>
              <option value="event">Event</option>
            </select>
          )}
        </Field>
        {draft.kind === "at" && (
          <Field label="Local date and time">
            {(p) => (
              <input
                {...p}
                type="datetime-local"
                value={draft.local}
                required
                onChange={(e) => set("local", e.target.value)}
              />
            )}
          </Field>
        )}
        {(draft.kind === "at" || draft.kind === "cron") && (
          <Field
            label="Timezone"
            hint="An explicit IANA timezone, such as Europe/London."
          >
            {(p) => (
              <input
                {...p}
                value={draft.timezone}
                required
                spellCheck={false}
                onChange={(e) => set("timezone", e.target.value)}
              />
            )}
          </Field>
        )}
        {draft.kind === "every" && (
          <Field
            label="Interval in seconds"
            hint="Elapsed time, independent of daylight-saving changes."
          >
            {(p) => (
              <input
                {...p}
                type="number"
                min={1}
                step={1}
                value={draft.seconds}
                required
                onChange={(e) => set("seconds", e.target.value)}
              />
            )}
          </Field>
        )}
        {draft.kind === "cron" && (
          <>
            <Field
              label="Cron expression"
              hint="Five fields, or six including seconds. Day-of-month and weekday use OR matching."
            >
              {(p) => (
                <input
                  {...p}
                  value={draft.expression}
                  required
                  spellCheck={false}
                  onChange={(e) => set("expression", e.target.value)}
                />
              )}
            </Field>
            <p className={styles.help}>
              Fixed-time schedules run at the end of a skipped daylight-saving
              hour and once in a repeated hour. Interval expressions run through
              both repeated hours.
            </p>
          </>
        )}
        {draft.kind === "event" && (
          <>
            <Field label="Event source">
              {(p) => (
                <select
                  {...p}
                  value={draft.sourceId}
                  onChange={(e) => set("sourceId", e.target.value)}
                >
                  <option value="">Any source in this workspace</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.enabled ? "" : " (disabled)"}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Event type">
              {(p) => (
                <input
                  {...p}
                  required
                  value={draft.eventType}
                  list="ufai-event-types"
                  onChange={(e) => set("eventType", e.target.value)}
                />
              )}
            </Field>
            <datalist id="ufai-event-types">
              {[
                "ufai.task.completed",
                "ufai.task.failed",
                "ufai.artifact.published",
              ].map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <h3>Filters</h3>
            <p className={styles.help}>
              All filters must match. Paths select fields in event data. Values
              are JSON: use quotes around strings.
            </p>
            {draft.filters.map((f, i) => (
              <div className={styles.filter} key={f.id}>
                <Field label={`Field path ${i + 1}`}>
                  {(p) => (
                    <input
                      {...p}
                      value={f.path}
                      placeholder="amount"
                      onChange={(e) =>
                        set(
                          "filters",
                          draft.filters.map((x) =>
                            x.id === f.id ? { ...x, path: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
                <Field label={`Operator ${i + 1}`}>
                  {(p) => (
                    <select
                      {...p}
                      value={f.operator}
                      onChange={(e) =>
                        set(
                          "filters",
                          draft.filters.map((x) =>
                            x.id === f.id
                              ? {
                                  ...x,
                                  operator: e.target
                                    .value as EventFilter["operator"],
                                }
                              : x,
                          ),
                        )
                      }
                    >
                      {[
                        "exists",
                        "eq",
                        "ne",
                        "gt",
                        "gte",
                        "lt",
                        "lte",
                        "in",
                      ].map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  )}
                </Field>
                {f.operator !== "exists" && (
                  <Field label={`JSON value ${i + 1}`}>
                    {(p) => (
                      <input
                        {...p}
                        value={f.value}
                        onChange={(e) =>
                          set(
                            "filters",
                            draft.filters.map((x) =>
                              x.id === f.id
                                ? { ...x, value: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                    )}
                  </Field>
                )}
                <button
                  className="iconButton"
                  type="button"
                  aria-label={`Remove filter ${i + 1}`}
                  onClick={() =>
                    set(
                      "filters",
                      draft.filters.filter((x) => x.id !== f.id),
                    )
                  }
                >
                  <X size={16} aria-hidden />
                </button>
              </div>
            ))}
            <button
              className="textButton"
              type="button"
              disabled={draft.filters.length >= 32}
              onClick={() =>
                set("filters", [
                  ...draft.filters,
                  {
                    id: crypto.randomUUID(),
                    path: "",
                    operator: "eq",
                    value: '"value"',
                  },
                ])
              }
            >
              Add filter
            </button>
            <Field
              label="Sample event data"
              hint="Preview checks filters only. Run sample event creates a task and can use tools."
            >
              {(p) => (
                <textarea
                  {...p}
                  rows={4}
                  value={sample}
                  spellCheck={false}
                  onChange={(e) => setSample(e.target.value)}
                />
              )}
            </Field>
          </>
        )}
        <div>
          <button
            type="button"
            className="button"
            onClick={() => void showPreview()}
          >
            {draft.kind === "event"
              ? "Test filters"
              : "Preview next occurrences"}
          </button>
          {sampleMatch !== null && (
            <p role="status">
              {sampleMatch ? "Sample matches" : "Sample does not match"}
            </p>
          )}
          {preview.length > 0 && (
            <ol className={styles.help}>
              {preview.map((v) => (
                <li key={v}>
                  {date(
                    v,
                    draft.kind === "cron" || draft.kind === "at"
                      ? draft.timezone
                      : undefined,
                  )}{" "}
                  <span className={styles.status}>({v})</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <fieldset>
          <legend>Required skills</legend>
          {skills.map((s) => (
            <label className={`${styles.row} ${styles.skillChoice}`} key={s.id}>
              <span>
                <input
                  type="checkbox"
                  checked={draft.requiredSkillIds.includes(s.id)}
                  disabled={current?.skillId === s.id}
                  onChange={(e) =>
                    set(
                      "requiredSkillIds",
                      e.target.checked
                        ? [...draft.requiredSkillIds, s.id]
                        : draft.requiredSkillIds.filter((id) => id !== s.id),
                    )
                  }
                />{" "}
                {s.name}
                {s.enabled ? "" : " · disabled"}
              </span>
            </label>
          ))}
          {!skills.length && (
            <p className={styles.help}>No skills available.</p>
          )}
        </fieldset>
        <p className={styles.help}>
          Every occurrence is retained. Missed schedules replay in order; the
          next occurrence waits until this trigger’s current task finishes.
          Pause keeps collecting. Disable stops collecting. Only failures
          automatically reach Inbox.
        </p>
        {current && (
          <>
            <div className={styles.actions}>
              <button
                type="button"
                className="textButton"
                onClick={() => setConfirm("queue")}
              >
                Cancel queued work ({latest?.queued ?? current.queued}
                {latest?.collectingBacklog ? " + catch-up" : ""})
              </button>
              <button
                type="button"
                className="textButton"
                onClick={() => setConfirm("delete")}
              >
                Delete trigger
              </button>
            </div>
            <h3>Activity</h3>
            <ActivityRows
              items={activity.items}
              onTask={(o) => {
                guard(() => {
                  agents.getState().select(workspaceId, agentId);
                  agents.setState({
                    requestedTask: { agentId, taskId: o.taskId! },
                  });
                  onTaskOpen?.();
                });
              }}
            />
            <Pagination
              offset={offset}
              total={activity.total}
              onPage={setOffset}
            />
          </>
        )}
      </div>
      <div className={styles.footer}>
        <button
          type="button"
          className="textButton"
          disabled={busy}
          onClick={() => guard(onBack)}
        >
          Cancel
        </button>
        <BusyButton busy={busy} className="button" disabled={busy || conflict}>
          {busy ? "Saving…" : "Save"}
        </BusyButton>
        {!current && (
          <button
            type="submit"
            name="action"
            value="enable"
            className="button primary"
            disabled={busy}
          >
            Save and enable
          </button>
        )}
      </div>
      {confirm && (
        <Dialog
          title={
            confirm === "delete" ? "Delete trigger?" : "Cancel queued work?"
          }
          busy={busy}
          onClose={() => setConfirm(null)}
          initialFocusSelector="button"
        >
          <p>
            {confirm === "delete"
              ? "Delete this trigger and cancel queued work, including submitted tasks that have never started? Tasks that have started continue until separately stopped."
              : "Cancel all queued work and unenumerated catch-up due now? The current submitted task continues. Later occurrences will still be collected."}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className="button"
              onClick={() => setConfirm(null)}
            >
              Keep work
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => void action(confirm)}
            >
              {confirm === "delete" ? "Delete trigger" : "Cancel queued work"}
            </button>
          </div>
        </Dialog>
      )}
    </form>
  );
}
function ActivityRows({
  items,
  onTrigger,
  onTask,
}: {
  items: TriggerOccurrence[];
  onTrigger?: (id: string) => void;
  onTask: (o: TriggerOccurrence) => void;
}) {
  return (
    <>
      {items.map((o) => (
        <div className={styles.row} key={o.id}>
          {onTrigger ? (
            <button
              className="textButton"
              onClick={() => onTrigger(o.triggerId)}
              type="button"
            >
              {o.triggerName}
            </button>
          ) : (
            <strong>{o.triggerName}</strong>
          )}
          <span className={styles.status}>
            {o.state} · {date(o.scheduledAt)}
            {o.taskStatus ? ` · Task ${o.taskStatus}` : ""}
          </span>
          {o.error && <p className={styles.help}>{o.error}</p>}
          {o.taskId && (
            <button
              className="textButton"
              type="button"
              onClick={() => onTask(o)}
            >
              Open task
            </button>
          )}
        </div>
      ))}
      {!items.length && <p className={styles.help}>No trigger activity yet.</p>}
    </>
  );
}
export function TriggersView({
  workspaceId,
  agentId,
  onTaskOpen,
}: {
  workspaceId: string;
  agentId?: string;
  onTaskOpen?: () => void;
}) {
  const store = useTriggerStore(),
    guard = useNavigationGuard(),
    agents = useAgentStore(),
    allAgents = useAgents((s) => s.agents);
  const [section, setSection] = useState<"triggers" | "activity" | "sources">(
      "triggers",
    ),
    [selected, setSelected] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [target, setTarget] = useState(agentId ?? ""),
    [offset, setOffset] = useState(0),
    [agentFilter, setAgentFilter] = useState(""),
    [kind, setKind] = useState(""),
    [state, setState] = useState(""),
    [error, setError] = useState("");
  const [activity, setActivity] = useState<TriggerPage<TriggerOccurrence>>({
    items: [],
    total: 0,
  });
  const path = agentId
    ? `/agents/${encode(agentId)}/triggers?limit=50&offset=${offset}&kind=${kind}&state=${state}`
    : `/workspaces/${encode(workspaceId)}/triggers?limit=50&offset=${offset}&agentId=${encode(agentFilter)}&kind=${kind}&state=${state}`;
  const requestedId = useStore(store, (s) => s.requestedId);
  useEffect(
    () => (selected ? store.getState().retain(selected) : undefined),
    [store, selected],
  );
  const page = useStore(store, (s) => s.pages[path]),
    detail = useStore(store, (s) =>
      selected ? s.entities[selected] : undefined,
    );
  const workspaceAgents = Object.values(allAgents).filter(
    (a) => a.workspaceId === workspaceId,
  );
  const overviewRead = useReadSequence();
  const refresh = useCallback(async () => {
    const sequence = ++overviewRead.current;
    try {
      await store.getState().load(path);
      if (section === "activity") {
        const page = await request<TriggerPage<TriggerOccurrence>>(
          `/workspaces/${encode(workspaceId)}/trigger-activity?limit=50&offset=${offset}`,
        );
        if (overviewRead.current === sequence) setActivity(page);
      }
      if (overviewRead.current === sequence) setError("");
    } catch (e) {
      if (overviewRead.current === sequence) setError(errorMessage(e));
    }
  }, [store, path, workspaceId, section, offset, overviewRead]);
  useRefresh(refresh);
  const open = useCallback(
    (id: string) => {
      guard(() => {
        void request<Trigger>(`/triggers/${encode(id)}`)
          .then((t) => {
            store.getState().put(t);
            setSelected(id);
            setCreating(false);
          })
          .catch((e) => setError(errorMessage(e)));
      });
    },
    [guard, store],
  );
  useEffect(() => {
    if (requestedId) {
      open(requestedId);
      store.setState({ requestedId: null });
    }
  }, [requestedId, open, store]);
  const back = useCallback(() => {
    setSelected(null);
    setCreating(false);
    void refresh();
  }, [refresh]);
  const saved = useCallback(
    (t: Trigger) => {
      store.getState().put(t);
      setSelected(t.id);
      setCreating(false);
      void refresh();
    },
    [store, refresh],
  );
  function openTask(o: TriggerOccurrence) {
    guard(() => {
      agents.getState().select(workspaceId, o.agentId);
      agents.setState({
        requestedTask: { agentId: o.agentId, taskId: o.taskId! },
      });
      onTaskOpen?.();
    });
  }
  return (
    <div className={styles.panel}>
      {(selected && detail) || creating ? (
        <TriggerEditor
          key={selected ?? `new:${target}`}
          workspaceId={workspaceId}
          agentId={detail?.agentId ?? target ?? agentId ?? ""}
          existing={selected ? detail : undefined}
          onBack={back}
          onSaved={saved}
          onTaskOpen={onTaskOpen}
        />
      ) : (
        <>
          {!agentId && (
            <nav
              className={styles.toolbar}
              aria-label="Workspace trigger views"
            >
              {(["triggers", "activity", "sources"] as const).map((s) => (
                <button
                  type="button"
                  key={s}
                  className="textButton"
                  aria-current={section === s ? "page" : undefined}
                  onClick={() => {
                    guard(() => {
                      setSection(s);
                      setOffset(0);
                    });
                  }}
                >
                  {s === "sources"
                    ? "Event sources"
                    : s === "activity"
                      ? "Activity"
                      : "Triggers"}
                </button>
              ))}
            </nav>
          )}
          {error && (
            <Feedback className={`${styles.feedback}`} role="alert">
              {error}
            </Feedback>
          )}
          {section === "sources" ? (
            <EventSources workspaceId={workspaceId} />
          ) : (
            <>
              {section === "triggers" && (
                <div className={styles.toolbar}>
                  {!agentId && (
                    <Field label="Target agent">
                      {(p) => (
                        <select
                          {...p}
                          value={target}
                          onChange={(e) => setTarget(e.target.value)}
                        >
                          <option value="">Choose an agent</option>
                          {workspaceAgents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  )}
                  <button
                    className="button"
                    type="button"
                    disabled={!agentId && !target}
                    onClick={() => setCreating(true)}
                  >
                    <Plus size={14} aria-hidden />
                    New trigger
                  </button>
                  <button
                    className="iconButton"
                    type="button"
                    aria-label="Refresh triggers"
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={16} aria-hidden />
                  </button>
                  {!agentId && (
                    <Field label="Filter agent">
                      {(p) => (
                        <select
                          {...p}
                          value={agentFilter}
                          onChange={(e) => {
                            setAgentFilter(e.target.value);
                            setOffset(0);
                          }}
                        >
                          <option value="">All agents</option>
                          {workspaceAgents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  )}
                  <Field label="Kind">
                    {(p) => (
                      <select
                        {...p}
                        value={kind}
                        onChange={(e) => {
                          setKind(e.target.value);
                          setOffset(0);
                        }}
                      >
                        <option value="">All kinds</option>
                        {["at", "every", "cron", "event"].map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field label="State">
                    {(p) => (
                      <select
                        {...p}
                        value={state}
                        onChange={(e) => {
                          setState(e.target.value);
                          setOffset(0);
                        }}
                      >
                        <option value="">All states</option>
                        {[
                          "active",
                          "paused",
                          "disabled",
                          "blocked",
                          "review_required",
                        ].map((s) => (
                          <option key={s} value={s}>
                            {s.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                </div>
              )}
              <div className={styles.content}>
                {section === "activity" ? (
                  <ActivityRows
                    items={activity.items}
                    onTrigger={open}
                    onTask={openTask}
                  />
                ) : (
                  <>
                    {page?.ids.map((id) => (
                      <TriggerRow key={id} id={id} onOpen={open} />
                    ))}
                    {page && !page.ids.length && (
                      <p className={styles.help}>
                        Create a schedule or event trigger to start work
                        automatically. Every occurrence remains queued until
                        handled.
                      </p>
                    )}
                    {!page && !error && <LoadingState role="status">Loading triggers…</LoadingState>}
                  </>
                )}
                <Pagination
                  offset={offset}
                  total={
                    section === "activity" ? activity.total : (page?.total ?? 0)
                  }
                  onPage={setOffset}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
export function WorkspaceTriggersButton({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false),
    guard = useNavigationGuard(),
    agents = useAgentStore();
  return (
    <>
      <Tooltip content="Triggers">
        <button
          className="iconButton"
          aria-label="Workspace triggers"
          onClick={() =>
            guard(() => {
              agents.getState().select(workspaceId, null);
              setOpen(true);
            })
          }
        >
          <Timer size={14} aria-hidden />
        </button>
      </Tooltip>
      {open && (
        <Dialog
          title="Workspace triggers"
          className={styles.dialog}
          contentClassName={styles.dialogContent}
          onClose={() => guard(() => setOpen(false))}
        >
          <TriggersView
            workspaceId={workspaceId}
            onTaskOpen={() => setOpen(false)}
          />
        </Dialog>
      )}
    </>
  );
}
function EventSources({ workspaceId }: { workspaceId: string }) {
  const [page, setPage] = useState<TriggerPage<EventSource>>({
      items: [],
      total: 0,
    }),
    [offset, setOffset] = useState(0),
    [name, setName] = useState(""),
    [token, setToken] = useState<{ id: string; value: string } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<EventSource | null>(null),
    [receipts, setReceipts] = useState<TriggerPage<EventReceipt>>({
      items: [],
      total: 0,
    }),
    [receiptOffset, setReceiptOffset] = useState(0),
    [rotate, setRotate] = useState<EventSource | null>(null),
    [copied, setCopied] = useState(false);
  useUnsavedChanges(!!name.trim());
  const sourceRead = useReadSequence();
  const refresh = useCallback(async () => {
    const sequence = ++sourceRead.current;
    try {
      const page = await request<TriggerPage<EventSource>>(
        `/workspaces/${encode(workspaceId)}/event-sources?limit=50&offset=${offset}`,
      );
      if (sourceRead.current !== sequence) return;
      setPage(page);
      if (selected) {
        const receipts = await request<TriggerPage<EventReceipt>>(
          `/workspaces/${encode(workspaceId)}/event-receipts?sourceId=${encode(selected.id)}&limit=50&offset=${receiptOffset}`,
        );
        if (sourceRead.current === sequence) setReceipts(receipts);
      }
    } catch (e) {
      if (sourceRead.current === sequence) setError(errorMessage(e));
    }
  }, [workspaceId, offset, selected, receiptOffset, sourceRead]);
  useRefresh(refresh);
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await request<{ source: EventSource; token: string }>(
        `/workspaces/${encode(workspaceId)}/event-sources`,
        "POST",
        { name },
      );
      setToken({ id: r.source.id, value: r.token });
      setCopied(false);
      setName("");
      setSelected(r.source);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function change(s: EventSource, rotateToken = false) {
    setBusy(true);
    setError("");
    try {
      const r = await request<{ source: EventSource; token?: string }>(
        `/event-sources/${encode(s.id)}${rotateToken ? "/rotate" : ""}`,
        rotateToken ? "POST" : "PATCH",
        { name: s.name, enabled: !s.enabled, expectedRevision: s.revision },
      );
      if (r.token) {
        setToken({ id: s.id, value: r.token });
        setCopied(false);
      }
      if (selected?.id === s.id) setSelected(r.source);
      setRotate(null);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const endpoint = selected
    ? `${window.location.origin}/api/event-sources/${selected.id}/events`
    : "";
  const example = selected
    ? `curl '${endpoint}' \\\n  -H 'Authorization: Bearer <source-token>' \\\n  -H 'Content-Type: application/json' \\\n  --data '{"eventId":"invoice-001","eventType":"invoice.received","data":{"amount":1200}}'`
    : "";
  const multipart = selected
    ? `curl '${endpoint}' \\\n  -H 'Authorization: Bearer <source-token>' \\\n  -F 'event={"eventId":"invoice-file-001","eventType":"invoice.received","data":{"amount":1200},"attachments":[{"name":"invoice.pdf","size":1234,"mode":"file"}]}' \\\n  -F 'file0=@invoice.pdf'`
    : "";
  return (
    <div className={styles.content}>
      {error && (
        <Feedback role="alert">
          {error}
        </Feedback>
      )}
      <form onSubmit={create} className={styles.actions}>
        <Field label="New event source name">
          {(p) => (
            <input
              {...p}
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <button className="button" disabled={busy}>
          Create source
        </button>
      </form>
      <p className={styles.help}>
        A source token authorizes event ingestion only. Local callers can use
        this address. Remote services need a separately configured proxy or
        relay exposing only the event endpoint.
      </p>
      {token && (
        <div className={styles.section}>
          <p>
            Copy this credential now. It is shown once and will not be returned
            again.
          </p>
          <code className={styles.token}>{token.value}</code>
          <div className={styles.actions}>
            <button
              className="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(token.value)
                  .then(() => setCopied(true))
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              {copied ? "Copied" : "Copy credential"}
            </button>
            <button
              className="textButton"
              onClick={() => {
                setToken(null);
                setCopied(false);
              }}
            >
              Dismiss credential
            </button>
          </div>
        </div>
      )}
      {page.items.map((s) => (
        <div className={styles.row} key={s.id}>
          <button
            className={styles.identity}
            onClick={() => {
              setSelected(s);
              setReceiptOffset(0);
              setReceipts({ items: [], total: 0 });
            }}
          >
            <span className={styles.title}>{s.name}</span>
            <span className={styles.status}>
              {s.enabled ? "Enabled" : "Disabled"}
            </span>
          </button>
          <div className={styles.actions}>
            <button
              className="textButton"
              disabled={busy}
              onClick={() => void change(s)}
            >
              {s.enabled ? "Disable" : "Enable"}
            </button>
            <button
              className="textButton"
              disabled={busy}
              onClick={() => setRotate(s)}
            >
              Rotate credential
            </button>
          </div>
        </div>
      ))}
      <Pagination offset={offset} total={page.total} onPage={setOffset} />
      {selected && (
        <section className={styles.section}>
          <h3>{selected.name}</h3>
          <code className={styles.code}>{endpoint}</code>
          <h4>JSON event</h4>
          <pre className={styles.code}>{example}</pre>
          <h4>Multipart event</h4>
          <p className={styles.help}>
            Use the exact byte size and filename; send the event manifest before
            ordered file0, file1… parts. Reuse the same event ID and bytes when
            retrying.
          </p>
          <pre className={styles.code}>{multipart}</pre>
          <h4>Recent receipts</h4>
          {receipts.items.map((r) => (
            <details className={styles.row} key={r.id}>
              <summary>
                {r.eventType} · {r.eventId}
              </summary>
              <span className={styles.status}>
                {date(r.receivedAt)} ·{" "}
                {r.processed ? `${r.matched} matches` : "Matching queued"} ·{" "}
                {r.attachments.length} files
              </span>
              <pre className={styles.code}>
                {JSON.stringify(r.data, null, 2)}
              </pre>
            </details>
          ))}
          <Pagination
            offset={receiptOffset}
            total={receipts.total}
            onPage={setReceiptOffset}
          />
        </section>
      )}
      {rotate && (
        <Dialog
          title="Rotate source credential?"
          onClose={() => setRotate(null)}
          busy={busy}
          initialFocusSelector="button"
        >
          <p>
            The previous credential for {rotate.name} will stop accepting
            events. Existing receipts and queued tasks remain.
          </p>
          <div className={styles.actions}>
            <button className="button" onClick={() => setRotate(null)}>
              Keep credential
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => void change(rotate, true)}
            >
              Rotate credential
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
interface SkillInfo {
  fingerprint: string;
  templates: SkillTriggerTemplate[];
  error: string | null;
  setups: SkillAutomationSetup[];
  instances: { id: string; input: string }[];
  snapshot: SkillAutomationSetup["snapshot"];
  compatibility: string;
}
export function SkillAutomationsPanel({
  agentId,
  skillId,
}: {
  agentId: string;
  skillId: string;
}) {
  const [info, setInfo] = useState<SkillInfo | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [template, setTemplate] = useState<SkillTriggerTemplate | null>(null),
    [templateFingerprint, setTemplateFingerprint] = useState(""),
    [enabled, setEnabled] = useState(false),
    [zone, setZone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [sourceId, setSourceId] = useState(""),
    [instructions, setInstructions] = useState(""),
    [expression, setExpression] = useState(""),
    [local, setLocal] = useState(""),
    [seconds, setSeconds] = useState(""),
    [sources, setSources] = useState<EventSource[]>([]),
    [message, setMessage] = useState("");
  const agent = useAgents((s) => s.agents[agentId]),
    agents = useAgentStore(),
    guard = useNavigationGuard();
  const skillRead = useReadSequence();
  useUnsavedChanges(!!template);
  const refresh = useCallback(async () => {
    const sequence = ++skillRead.current;
    try {
      const info = await request<SkillInfo>(
        `/agents/${encode(agentId)}/skill-automations/${encode(skillId)}`,
      );
      if (skillRead.current === sequence) setInfo(info);
    } catch (e) {
      if (skillRead.current === sequence) setError(errorMessage(e));
    }
  }, [agentId, skillId, skillRead]);
  useRefresh(refresh);
  useEffect(() => {
    if (!agent) return;
    const c = new AbortController();
    void request<TriggerPage<EventSource>>(
      `/workspaces/${encode(agent.workspaceId)}/event-sources?limit=100`,
      "GET",
      undefined,
      c.signal,
    )
      .then((p) => setSources(p.items))
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [agent]);
  async function review(
    s: SkillAutomationSetup,
    state: "approved" | "declined",
  ) {
    setBusy(true);
    try {
      await request(`/skill-automations/${encode(s.id)}/review`, "POST", {
        fingerprint: s.fingerprint,
        state,
      });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    if (!template) return;
    setBusy(true);
    try {
      const w = template.when;
      const when =
        w.kind === "at"
          ? {
              kind: "at",
              timezone: zone,
              ...(await request<{ at: string }>(
                "/triggers/resolve-time",
                "POST",
                { local, timezone: zone },
              )),
            }
          : w.kind === "cron"
            ? { ...w, expression, timezone: zone }
            : w.kind === "every"
              ? { kind: "every", everyMs: Number(seconds) * 1000 }
              : w.kind === "event"
                ? { ...w, ...(sourceId ? { sourceId } : {}) }
                : w;
      await request(
        `/agents/${encode(agentId)}/skill-automations/${encode(skillId)}/templates`,
        "POST",
        {
          templateId: template.id,
          fingerprint: templateFingerprint,
          overrides: { enabled, when, instructions },
        },
      );
      setTemplate(null);
      setMessage(
        "Trigger created. Open this agent’s Triggers tab to inspect or customize it.",
      );
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof RequestError && e.status === 409) await refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.section}>
      <h4>Automation</h4>
      {error && (
        <Feedback role="alert">
          {error}
        </Feedback>
      )}
      {message && <p role="status">{message}</p>}
      {info?.error && (
        <Feedback>
          {info.error} The instruction skill remains available.
        </Feedback>
      )}
      {info && !info.templates.length && (
        <p className={styles.help}>
          No native trigger templates. The agent’s installation review can still
          identify scheduling instructions that need setup.
        </p>
      )}
      {info?.templates.map((t) => (
        <div className={styles.row} key={t.id}>
          <strong>{t.name}</strong>
          <p className={styles.help}>
            {t.description} · {summary(t.when)}
          </p>
          <button
            className="button"
            onClick={() => {
              setTemplate(t);
              setTemplateFingerprint(info!.fingerprint);
              setEnabled(false);
              setInstructions(t.instructions);
              setZone(
                !t.timezoneRequired &&
                  (t.when.kind === "cron" || t.when.kind === "at")
                  ? t.when.timezone
                  : Intl.DateTimeFormat().resolvedOptions().timeZone,
              );
              setExpression(t.when.kind === "cron" ? t.when.expression : "");
              setLocal(
                t.when.kind === "at"
                  ? localTime(t.when.at, t.when.timezone)
                  : "",
              );
              setSeconds(
                t.when.kind === "every" ? String(t.when.everyMs / 1000) : "",
              );
              setSourceId(
                t.when.kind === "event" ? (t.when.sourceId ?? "") : "",
              );
              setError("");
            }}
          >
            Set up trigger
          </button>
        </div>
      ))}
      {info?.instances.length ? (
        <p className={styles.help}>
          {info.instances.length} configured trigger instance(s). Review them in
          Triggers before adding another.
        </p>
      ) : null}
      {info?.setups.map((s) => (
        <div className={styles.row} key={s.id}>
          <strong>
            {s.kind === "review"
              ? "Package update review"
              : "Installation setup"}
          </strong>
          <span className={styles.status}>{s.state.replaceAll("_", " ")}</span>
          {s.error && <p className={styles.help}>{s.error}</p>}
          {s.taskId && agent && (
            <button
              className="textButton"
              onClick={() =>
                guard(() => {
                  agents.getState().select(agent.workspaceId, agentId);
                  agents.setState({
                    requestedTask: { agentId, taskId: s.taskId! },
                  });
                })
              }
            >
              Open review task
            </button>
          )}
          {s.previousSnapshot && (
            <details>
              <summary>Package changes</summary>
              <pre className={styles.code}>
                {JSON.stringify(
                  {
                    previousInstructions: s.previousSnapshot.instructions,
                    currentInstructions: info.snapshot.instructions,
                    changedFiles: info.snapshot.files
                      .filter(
                        (f) =>
                          s.previousSnapshot!.files.find(
                            (p) => p.path === f.path,
                          )?.hash !== f.hash,
                      )
                      .map((f) => f.path),
                    removedFiles: s.previousSnapshot.files
                      .filter(
                        (f) =>
                          !info.snapshot.files.some((p) => p.path === f.path),
                      )
                      .map((f) => f.path),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          )}
          {s.fingerprint === info.fingerprint &&
            !["approved", "declined"].includes(s.state) && (
              <div className={styles.actions}>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void review(s, "approved")}
                >
                  {s.kind === "review" ? "Approve update" : "Approve setup"}
                </button>
                <button
                  className="textButton"
                  disabled={busy}
                  onClick={() => void review(s, "declined")}
                >
                  Decline
                </button>
              </div>
            )}
        </div>
      ))}
      {info && <p className={styles.help}>{info.compatibility}</p>}
      {template && (
        <Dialog
          title={`Set up ${template.name}`}
          onClose={() => guard(() => setTemplate(null))}
          busy={busy}
        >
          <Field label="Task instructions">
            {(p) => (
              <textarea
                {...p}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
              />
            )}
          </Field>
          {template.when.kind === "at" && (
            <Field label="Date and time">
              {(p) => (
                <input
                  {...p}
                  type="datetime-local"
                  value={local}
                  onChange={(e) => setLocal(e.target.value)}
                />
              )}
            </Field>
          )}
          {template.when.kind === "cron" && (
            <Field label="Cron expression">
              {(p) => (
                <input
                  {...p}
                  value={expression}
                  onChange={(e) => setExpression(e.target.value)}
                  spellCheck={false}
                />
              )}
            </Field>
          )}
          {template.when.kind === "every" && (
            <Field label="Interval in seconds">
              {(p) => (
                <input
                  {...p}
                  type="number"
                  min="1"
                  value={seconds}
                  onChange={(e) => setSeconds(e.target.value)}
                />
              )}
            </Field>
          )}
          {error && (
            <Feedback role="alert">
              {error}
            </Feedback>
          )}
          {(template.when.kind === "cron" || template.when.kind === "at") && (
            <Field label="Timezone">
              {(p) => (
                <input
                  {...p}
                  value={zone}
                  onChange={(e) => setZone(e.target.value)}
                />
              )}
            </Field>
          )}
          {template.when.kind === "event" && (
            <Field label="Event source">
              {(p) => (
                <select
                  {...p}
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                >
                  <option value="">Any workspace source</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <SkillSwitch
            label="Enable automation"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <p className={styles.help}>
            This explicitly creates a persistent trigger for this agent.
            Installation alone does not start it.
          </p>
          <div className={styles.actions}>
            <button
              className="button"
              disabled={busy}
              onClick={() => setTemplate(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void create()}
            >
              {enabled ? "Create and enable" : "Create disabled trigger"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
