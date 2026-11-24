import { Tooltip } from "./Tooltip";
import { FrozenIndicator, freezeLabel, useAgentFreeze } from "./AgentFreeze";
import freezeStyles from "./AgentFreeze.module.scss";
import { Feedback, LoadingState, LoadingIndicator, BusyButton } from "./Feedback";
import { FeedbackHost } from "./FeedbackProvider";
import { useTriggerStore } from "../trigger-store";
import { AgentBrowser } from "./AgentBrowser";
import { useStore } from "zustand";
import { useSkillsStore } from "../skills-store";
import { AgentMcp } from "./AgentMcp";
import { AgentSkills } from "./AgentSkills";
import { configurationChanged, customizeDetails, detailsValues, refreshDetails, type DetailsValues } from "../agent-details";
import { modelConfigurationDraft, modelConfigurationInput, validateModelConfiguration } from "../preset-form";
import type { AgentAppearance } from "../../../server/src/contracts";
import { defaultAppearance } from "../agent-appearance";
import { AgentCharacter } from "./AgentCharacter";
import { LiveAgentCharacter } from "./LiveAgentCharacter";
import { CharacterEditor } from "./CharacterEditor";
import { useSettings } from "../settings-store";
import { TaskTimeline } from "./TaskTimeline";
import { RichText } from "./RichText";
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
  Snowflake,
  Play,
  ArrowLeft,
  Plus,
  Send,
  Square,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useAgents, useAgentStore, emptyList } from "../agent-store";
import { useDashboard } from "../store";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import { request, errorMessage, RequestError } from "../api";
import type {
  Agent,
  AgentModelConfiguration,
  AgentMemory,
  AgentMessage,
  AgentTask,
  ModelPreset,
  TaskDetail,
} from "../../../server/src/contracts";
import { FolderLocation } from "./FolderLocation";
import { AgentFiles } from "./AgentFiles";
import { agentPanelTabs, type AgentPanelTab } from "../agent-panel-tabs";
import { TriggersView } from "./Triggers";
import { Field } from "./FormField";
import { Dialog } from "./Dialog";
import { AgentDeleteDialog } from "./AgentDeleteDialog";
import { ModelConfigurationFields } from "./LazyModelConfigurationFields";
import styles from "./AgentPanel.module.scss";

type AgentFormValues = {
  name: string;
  presetId?: string | null;
  customConfiguration?: AgentModelConfiguration | null;
  appearance?: AgentAppearance;
  instructions?: string;
  expectedRevision?: number;
};
const customPresetOption = "__custom__";

export function AgentForm({
  agent,
  workspaceId,
  onBusyChange,
  onDelete,
  onSave,
}: {
  agent?: Agent;
  workspaceId?: string;
  onBusyChange?: (busy: boolean) => void;
  onDelete?: () => void;
  onSave: (values: AgentFormValues) => Promise<Agent | void>;
}) {
  const suggestion = useAgents(s => workspaceId ? s.appearanceSuggestions[workspaceId] : undefined);
  const loadAppearance = useAgents(s => s.loadAppearanceSuggestion);
  const [appearance, setAppearance] = useState<AgentAppearance | null>(suggestion?.appearance ?? null);
  const [appearanceError, setAppearanceError] = useState("");
  const [appearanceAttempt, setAppearanceAttempt] = useState(0);
  const [editingCharacter, setEditingCharacter] = useState(false);
  const appearanceTouched = useRef(false);
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  useEffect(() => {
    if (agent || !workspaceId || appearanceTouched.current) return;
    let alive = true;
    setAppearanceError("");
    void loadAppearance(workspaceId, appearanceAttempt > 0)
      .then(result => { if (alive && !appearanceTouched.current) setAppearance(result); })
      .catch(failure => { if (alive && !appearanceTouched.current) setAppearanceError(errorMessage(failure)); });
    return () => { alive = false; };
  }, [agent, workspaceId, appearanceAttempt, loadAppearance]);
  const presets = useDashboard((s) => s.presets),
    load = useDashboard((s) => s.loadPresets),
    presetTotal = useDashboard((s) => s.presetTotal),
    presetError = useDashboard((s) => s.presetError),
    loadDefault = useDashboard((s) => s.loadDefaultPreset);
  const configurationVersion = useAgents(s => agent ? s.configurationVersion : 0);
  const presetTouched = useRef(false);
  const [defaultReady, setDefaultReady] = useState(!!agent);
  const [defaultError, setDefaultError] = useState("");
  const [defaultAttempt, setDefaultAttempt] = useState(0);
  const [initialPreset, setInitialPreset] = useState<ModelPreset | null>(null);
  const initial = detailsValues(agent);
  const [details, setDetails] = useState({ draft: initial, baseline: initial, revision: agent?.revision ?? 1 });
  const nameTouched = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameRequest = useRef<{ workspaceId: string; attempt: number; promise: Promise<{ name: string }> } | null>(null);
  const [nameAttempt, setNameAttempt] = useState(0);
  const [nameSuggestionError, setNameSuggestionError] = useState("");
  const [nameError, setNameError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const focusInvalid = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (agent || !workspaceId || nameTouched.current) return;
    let alive = true;
    setNameSuggestionError("");
    // Reuse the request when Strict Mode replays this effect.
    if (nameRequest.current?.workspaceId !== workspaceId || nameRequest.current.attempt !== nameAttempt) {
      nameRequest.current = { workspaceId, attempt: nameAttempt,
        promise: request<{ name: string }>(`/workspaces/${workspaceId}/agents/name-suggestion`) };
    }
    void nameRequest.current.promise.then(result => {
      if (!alive || nameTouched.current) return;
      setDetails(current => ({ ...current,
        draft: { ...current.draft, name: result.name },
        baseline: { ...current.baseline, name: result.name },
      }));
    }).catch(failure => {
      if (alive && !nameTouched.current) setNameSuggestionError(errorMessage(failure));
    });
    return () => { alive = false; };
  }, [agent, workspaceId, nameAttempt]);
  const { draft, baseline } = details;
  const selectedPresetId = agent ? draft.presetId : null;
  const [presetResult, setPresetResult] = useState<{ id: string; preset?: ModelPreset; error?: string }>();
  const [presetAttempt, setPresetAttempt] = useState(0);
  const linkedResult = presetResult?.id === selectedPresetId ? presetResult : undefined;
  const linkedPreset = linkedResult?.preset;
  const displayedConfiguration = draft.customConfiguration ?? modelConfigurationDraft(linkedPreset);
  const configurationDirty = configurationChanged(draft, baseline);
  const isEditing = !!agent;
  useEffect(() => {
    if (!selectedPresetId) return;
    const controller = new AbortController();
    void request<ModelPreset>(`/model-presets/${encodeURIComponent(selectedPresetId)}`, "GET", undefined, controller.signal)
      .then(preset => {
        if (!controller.signal.aborted) setPresetResult({ id: selectedPresetId, preset });
      })
      .catch(failure => {
        if (!controller.signal.aborted) setPresetResult(current => ({
          id: selectedPresetId,
          preset: current?.id === selectedPresetId && !(failure instanceof RequestError && failure.status === 404)
            ? current.preset : undefined,
          error: errorMessage(failure),
        }));
      });
    return () => controller.abort();
  }, [selectedPresetId, presetAttempt, configurationVersion]);
  const setDraft = useCallback((next: DetailsValues | ((value: DetailsValues) => DetailsValues)) => {
    setDetails(current => ({ ...current, draft: typeof next === "function" ? next(current.draft) : next }));
  }, []);
  const setBaseline = useCallback((next: DetailsValues | ((value: DetailsValues) => DetailsValues)) => {
    setDetails(current => ({ ...current, baseline: typeof next === "function" ? next(current.baseline) : next }));
  }, []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (busy || !focusInvalid.current) return;
    focusInvalid.current = false;
    if (nameError) nameInput.current?.focus();
    else if (Object.keys(fieldErrors).length)
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [nameError, fieldErrors, busy]);
  const dirty = configurationDirty || draft.name !== baseline.name || draft.instructions !== baseline.instructions ||
    (!agent && appearanceTouched.current);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useUnsavedChanges(dirty);
  useEffect(() => { void load(); }, [load, configurationVersion]);
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
    if (agent) setDetails(current => refreshDetails(current, agent));
  }, [agent, dirty]);
  const stale = !!agent && dirty && details.revision < agent.revision;
  function reloadDetails() {
    if (!agent) return;
    const saved = detailsValues(agent);
    setDetails({ draft: saved, baseline: saved, revision: agent.revision });
    setError("");
    setNameError("");
    setFieldErrors({});
  }
  function clearConfigurationErrors(...keys: string[]) {
    setFieldErrors(current => {
      if (!Object.keys(current).length) return current;
      return Object.fromEntries(Object.entries(current)
        .filter(([key]) => !keys.some(field => key === field || key.startsWith(`${field}.`))));
    });
  }
  function switchPreset(value: string) {
    if (draft.presetId && value !== draft.presetId) setPresetResult(undefined);
    presetTouched.current = true;
    setFieldErrors({});
    if (value === customPresetOption)
      setDraft(current => customizeDetails(current, displayedConfiguration));
    else
      setDraft(current => ({ ...current, presetId: value || null, customConfiguration: null }));
  }
  function retryDefault() {
    setDefaultAttempt((value) => value + 1);
    void load().catch(() => {});
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || stale || !defaultReady || (!agent && !appearance)) return;
    if (!draft.name.trim()) {
      setNameError("Enter an agent name.");
      nameInput.current?.focus();
      return;
    }
    const errors = draft.customConfiguration ? validateModelConfiguration(draft.customConfiguration) : {};
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      focusInvalid.current = true;
      return;
    }
    setBusy(true);
    setError("");
    setNameError("");
    try {
      const saved = await onSave({ name: draft.name,
        ...(!agent || configurationDirty ? { presetId: draft.presetId } : {}),
        ...(agent && configurationDirty ? { customConfiguration: draft.customConfiguration
          ? modelConfigurationInput(draft.customConfiguration) : null } : {}),
        ...(agent ? { instructions: draft.instructions, expectedRevision: details.revision } : {}),
        ...(!agent && appearance ? { appearance } : {}) });
      const next = saved ? detailsValues(saved) : draft;
      setDetails({ draft: next, baseline: next, revision: saved?.revision ?? details.revision });
    } catch (err) {
      if (err instanceof RequestError && err.fields.name) {
        focusInvalid.current = true;
        setNameError(err.fields.name);
      } else if (err instanceof RequestError && Object.keys(err.fields).length) {
        focusInvalid.current = true;
        setFieldErrors(Object.fromEntries(Object.entries(err.fields).map(([key, message]) =>
          [key.replace(/^customConfiguration\./, ""), message])));
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form ref={formRef} onSubmit={submit} noValidate={isEditing} className={isEditing ? styles.detailsForm : styles.form}>
      <div className={isEditing ? `${styles.scroll} ${styles.form} ${styles.detailsFields}` : styles.form}>
      {!agent && <div className={styles.creationCharacter}>
        <div className={styles.creationCharacterPreview}>{appearance ? <AgentCharacter appearance={appearance} paused={paused} /> : <span role="status">{!appearanceError && <LoadingIndicator />}{appearanceError ? "Choose a character" : "Choosing character…"}</span>}</div>
        <button type="button" className="button secondary" disabled={busy} onClick={() => setEditingCharacter(true)}><Pencil size={14} aria-hidden /> Edit character</button>
        {appearanceError && <Feedback role="alert">{appearanceError}<button type="button" className="textButton" disabled={busy} onClick={() => setAppearanceAttempt(value => value + 1)}>Retry character</button></Feedback>}
      </div>}
      {editingCharacter && <CharacterEditor initial={appearance ?? defaultAppearance} creating onClose={() => setEditingCharacter(false)} onSave={async value => { appearanceTouched.current = true; setAppearance(value); setAppearanceError(""); }} />}

      <Field label="Agent name" error={nameError || undefined}
        hint={!agent && !draft.name && !nameTouched.current && !nameSuggestionError ? "Choosing a name…" : "Names must be unique within this workspace."}>
        {(p) => (
          <input
            {...p}
            ref={nameInput}
            disabled={busy}
            name="agentName"
            autoComplete="off"
            maxLength={120}
            required
            value={draft.name}
            onChange={(e) => {
              nameTouched.current = true;
              setNameError("");
              setNameSuggestionError("");
              setDraft({ ...draft, name: e.target.value });
            }}
          />
        )}
      </Field>
      {nameSuggestionError && <Feedback role="alert">
        Could not suggest a name: {nameSuggestionError} Enter a name or try again.
        <button type="button" className="textButton" disabled={busy} onClick={() => setNameAttempt(value => value + 1)}>Retry name</button>
      </Feedback>}
      {agent && <Field label="Instructions" error={fieldErrors.instructions} hint="Sets lasting guidance for future turns. You can also ask the agent to update it in Chat.">
        {p => <textarea {...p} name="instructions" autoComplete="off" rows={4} maxLength={8000} disabled={busy} value={draft.instructions} onChange={e => {
          clearConfigurationErrors("instructions");
          setDraft({ ...draft, instructions: e.target.value });
        }} />}
      </Field>}
      {agent && <h3 className={styles.detailsHeading}>Model settings</h3>}
      <Field
        label="Agent Preset (optional)"
        error={fieldErrors.presetId}
        hint={agent ? undefined : "You can leave this empty and choose later. A complete preset and known context window are required to run tasks."}
      >
        {(p) => (
          <select
            {...p}
            disabled={busy}
            name="presetId"
            value={draft.customConfiguration ? customPresetOption : draft.presetId ?? ""}
            onChange={(e) => switchPreset(e.target.value)}
            aria-describedby={agent ? [p["aria-describedby"], "agent-configuration-source"].filter(Boolean).join(" ") : p["aria-describedby"]}
          >
            <option value="">No preset — choose later</option>
            {agent && <option value={customPresetOption} disabled={!!selectedPresetId && !linkedPreset}>Custom settings</option>}
            {draft.presetId &&
              !presets.some((preset) => preset.id === draft.presetId) && (
                <option value={draft.presetId}>
                  {linkedPreset?.name ?? (initialPreset?.id === draft.presetId
                    ? initialPreset.name
                    : "Selected preset")}
                </option>
              )}
            {presets.map((v) => (
              <option key={v.id} value={v.id}>
                {linkedPreset?.id === v.id ? linkedPreset.name : v.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      {agent && <p className={styles.configurationSource} id="agent-configuration-source" aria-live="polite">
        {draft.presetId
          ? "Follows the selected preset. Editing a setting switches this agent to custom settings."
          : draft.customConfiguration
            ? configurationDirty ? "Save to use custom settings for this agent." : "These custom settings apply only to this agent."
            : "Choose a preset or configure this agent below."}
      </p>}
      {stale && <Feedback role="alert">Saved details changed while you were editing. Your draft has been kept. Copy any changes you want to keep, then reload before saving.
        <button type="button" className="textButton" disabled={busy} onClick={reloadDetails}>Reload saved details</button>
      </Feedback>}
      {!defaultReady && !defaultError && (
        <LoadingState role="status">Loading default preset…</LoadingState>
      )}
      {defaultError && (
        <Feedback role="alert">
          {defaultError}
          <button
            type="button"
            className="textButton"
            onClick={retryDefault}
          >
            Retry
          </button>
        </Feedback>
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
      {agent && <>
        {presetError && <Feedback role="alert">
          {presetError} <button type="button" className="textButton" onClick={() => void load()}>Retry presets</button>
        </Feedback>}
        {linkedResult?.error && <Feedback role="alert">
          {linkedResult.error} <button type="button" className="textButton" onClick={() => {
            setPresetAttempt(value => value + 1);
          }}>Retry selected preset</button>
        </Feedback>}
        {selectedPresetId && !linkedResult && <LoadingState role="status">Loading preset settings…</LoadingState>}
        {(!selectedPresetId || linkedPreset) && <fieldset className={styles.configurationFields} disabled={busy}>
          <ModelConfigurationFields
            draft={displayedConfiguration}
            fields={fieldErrors}
            onChange={changes => {
              if (selectedPresetId) setPresetResult(undefined);
              setDraft(current => customizeDetails(current, { ...(current.customConfiguration ?? displayedConfiguration), ...changes }));
            }}
            clearErrors={clearConfigurationErrors}
            incompleteHint="An enabled model and a known context window are required to run tasks."
            presetContext={linkedPreset?.contextWindow}
            refreshVersion={configurationVersion}
          />
        </fieldset>}
      </>}
      {error && (
        <Feedback role="alert">
          {error}
        </Feedback>
      )}
      {fieldErrors.customConfiguration && <Feedback role="alert">{fieldErrors.customConfiguration}</Feedback>}
      </div>
      <footer className={agent ? styles.detailsFooter : styles.actions}>
        {agent && onDelete && <button type="button" className="button danger" onClick={onDelete} disabled={busy}>
          <Trash2 size={15} aria-hidden="true" /> Delete Agent
        </button>}
        <BusyButton busy={busy} className="button primary" disabled={busy || stale || !defaultReady || (!agent && !appearance)}>
          {agent && !busy && <Save size={15} aria-hidden="true" />}
          {busy ? "Saving…" : agent ? "Save Agent" : "Create Agent"}
        </BusyButton>
      </footer>
    </form>
  );
}
function Transcript({ agentId, taskId }: { agentId: string; taskId: string | null }) {
  const frozen = useAgents(s => ["frozen","resuming"].includes(s.agents[agentId]?.executionControl?.state ?? "active"));
  const executionId = useAgents(s => taskId ?? s.chats[agentId]?.task?.id);
  return executionId ? (
    <TaskTimeline frozen={frozen} key={executionId} taskId={executionId} />
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
        <RichText content={memory.content} instanceId={`memory-${memory.id}`} />
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
        <Feedback role="alert">
          {error}
        </Feedback>
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
  const freeze = useAgentFreeze(agent);
  const store = useAgentStore(),
    guard = useNavigationGuard();
  const [editingCharacter, setEditingCharacter] = useState(false);
  const skillsStore = useSkillsStore();
  const triggerStore = useTriggerStore();
  const eventVersion = useAgents(s => s.eventVersion);
  const browserEnabled = useStore(skillsStore, s => s.enabled[agent.id]?.["builtin-browser"]);
  const refreshBrowserSkill = useCallback(() => {
    void skillsStore.getState().load(agent.id, { query: "browser", status: "all", origin: "builtin" }).catch(() => {});
  }, [agent.id, skillsStore]);
  useEffect(() => { refreshBrowserSkill(); }, [refreshBrowserSkill, eventVersion]);
  useEffect(() => {
    const focus = () => { if (document.visibilityState !== "hidden") refreshBrowserSkill(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => { window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
  }, [refreshBrowserSkill]);
  const tab = useAgents(s => s.panelTabs[agent.id] ?? "Chat");
  const setTab = useCallback((value: AgentPanelTab) => {
    store.getState().setPanelTab(agent.id, value);
  }, [agent.id, store]);
  useEffect(() => {
    if (tab === "Browser" && browserEnabled === false) store.getState().setPanelTab(agent.id, "Chat");
  }, [tab, browserEnabled, agent.id, store]);
  const [taskId, setTaskId] = useState<string | null>(null),
    [newTask, setNewTask] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState(false),
    [source, setSource] = useState<{
      message: AgentMessage;
      taskId: string;
    } | null>(null);
  const requestedTask=useAgents(s=>s.requestedTask?.agentId===agent.id?s.requestedTask:null);
  const openConversation = useCallback(async (id: string, signal?: AbortSignal) => {
    const detail = await request<TaskDetail>(`/tasks/${id}`, "GET", undefined, signal);
    if (signal?.aborted || detail.task.agentId !== agent.id) return;
    if (detail.task.kind === "chat") {
      await store.getState().refreshAgent(agent.id);
      if (!signal?.aborted) setTab("Chat");
    } else { setTab("Tasks"); setTaskId(id); setNewTask(false); }
  }, [agent.id, store, setTab]);
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
  async function save(values: AgentFormValues) {
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
            <FrozenIndicator agent={agent} />{agent.name}
          </h2>
          <p>
            {freezeLabel(agent) || (agent.state === "running"
              ? "Working"
              : agent.state === "queued"
                ? "Work queued"
                : agent.state === "waiting"
                  ? "Waiting"
                  : "Ready")}{" "}
            · {agent.queuedCount} queued
          </p>
        </div>
        <Tooltip content={freeze.label}><button className="iconButton" aria-label={freeze.label} onClick={freeze.activate} disabled={freeze.pending}>{agent.executionControl?.state === "frozen" ? <Play size={18} aria-hidden /> : <Snowflake size={18} aria-hidden />}</button></Tooltip>
        <button
          className="iconButton"
          aria-label="Close agent panel"
          onClick={() => guard(onClose)}
        >
          <X size={18} />
        </button>
      </header>
      <nav className={styles.tabs} aria-label="Agent sections">
        {agentPanelTabs.filter(v => v !== "Browser" || browserEnabled).map((v) => (
          <button
            key={v}
            aria-current={tab === v ? "page" : undefined}
            onClick={() => guard(() => setTab(v))}
          >
            {v === "Tasks" && taskTotal > 0 ? `Tasks (${taskTotal})` : v}
          </button>
        ))}
      </nav>
      {freeze.dialog}
      {agent.executionControl?.state !== undefined && agent.executionControl.state !== "active" && <p className={freezeStyles.waiting} role="status">{freezeLabel(agent)} · {agent.executionControl.workspaceHeld ? "Resume the workspace before unfreezing this agent. " : ""}New messages will wait until the agent resumes. Background commands continue.</p>}
      <FeedbackHost kind="panel" />
      {error && (
        <Feedback role="alert">
          {error}
        </Feedback>
      )}
      {tab === "Chat" && (
        <>
          {chat?.task && <div className={styles.chatStatus}>
            <div className={styles.actions}>
              <span role="status">{chat.task.status.replaceAll("_", " ")}{chat.turns.find(t => t.status === "running") ? ` · ${chat.turns.find(t => t.status === "running")!.phase}` : ""}</span>
              {(["running", "waiting", "queued", "blocked", "failed"].includes(chat.task.status) || chatHasProcesses) && <button className="textButton" onClick={() => void action("cancel", chat.task!.id)}><Square size={13} aria-hidden />Stop</button>}
              {["failed", "blocked"].includes(chat.task.status) && <button className="textButton" onClick={() => void action("retry", chat.task!.id)}><RotateCcw size={13} aria-hidden />Retry</button>}
            </div>
            {chat.task.error && <Feedback role="alert">{chat.task.error} <a href="#/providers">Providers</a> · <a href="#/agent-presets">Presets</a></Feedback>}
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
              {current?.trigger && <div className={styles.help}><button className="textButton" onClick={() => guard(() => {triggerStore.setState({requestedId:current.trigger!.id});setTab("Triggers");})}>Trigger: {current.trigger.name}</button><p>Originally triggered: {new Date(current.trigger.scheduledAt).toLocaleString()} · Occurrence {current.trigger.occurrenceId}</p></div>}
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
                <Feedback role="alert">
                  {current.error} <a href="#/providers">Providers</a> ·{" "}
                  <a href="#/agent-presets">Presets</a>
                </Feedback>
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
                <span>{t.title}{t.trigger && <small> · Trigger: {t.trigger.name}</small>}</span>
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
      {tab === "Browser" && browserEnabled && <AgentBrowser key={agent.id} agentId={agent.id} onDisabled={refreshBrowserSkill} />}
      {tab === "Skills" && <AgentSkills key={agent.id} agentId={agent.id} />}
      {tab === "MCP" && <AgentMcp key={agent.id} agentId={agent.id} />}
      {tab === "Triggers" && <TriggersView key={agent.id} agentId={agent.id} workspaceId={agent.workspaceId} />}
      {tab === "Files" && <AgentFiles key={agent.id} agentId={agent.id} />}
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
      {tab === "Details" && (
        <AgentForm agent={agent} onSave={save} onDelete={() => guard(() => setDeleting(true))} />
      )}
      {editingCharacter && <CharacterEditor initial={agent.appearance} onClose={() => setEditingCharacter(false)} onSave={async appearance => { await store.getState().update(agent.id, { appearance }); }} />}
      {deleting && <AgentDeleteDialog agent={agent} onClose={() => setDeleting(false)} />}
      {source && (
        <Dialog title="Memory source" onClose={() => setSource(null)}>
          <RichText content={source.message.content} instanceId={`memory-source-${source.message.id}`} streaming={source.message.state === "streaming"} />
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
