import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Cpu,
  Info,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { errorMessage, RequestError, type ModelPreset } from "../api";
import { useDashboard } from "../store";
import {
  changeCompactionMode,
  compactionThreshold,
  draftFromPreset,
  draftToInput,
  providerLabel,
  providerOptions,
  validateDraft,
  type PresetDraft,
} from "../preset-form";
import { Dialog } from "../components/Dialog";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import styles from "./Presets.module.scss";

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby"?: string;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-invalid": !!error,
        "aria-describedby": error || hint ? `${id}-help` : undefined,
      })}
      {(error || hint) && (
        <span id={`${id}-help`} className={error ? "fieldError" : "fieldHint"}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

function PresetEditor({
  preset,
  onSaved,
  onCancel,
  onDelete,
}: {
  preset?: ModelPreset;
  onSaved: (id: string) => void;
  onCancel: () => void;
  onDelete: (preset: ModelPreset) => void;
}) {
  const [baseline] = useState(() => draftFromPreset(preset));
  const [draft, setDraft] = useState(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = useDashboard((state) => state.savePreset);
  const dirty = JSON.stringify(baseline) !== JSON.stringify(draft);
  const formRef = useRef<HTMLFormElement>(null);
  useUnsavedChanges(dirty);
  function update<K extends keyof PresetDraft>(key: K, value: PresetDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors({});
    setError("");
  }
  function handleKind(kind: PresetDraft["integrationKind"]) {
    setDraft((current) => ({
      ...current,
      integrationKind: kind,
      provider: kind === "runtime" ? "codex" : "openai",
      customProviderName: "",
      modelId: "",
      contextWindow: "",
      maxOutputTokens: "",
    }));
    setErrors({});
    setError("");
  }
  function handleProvider(value: string) {
    setDraft((current) => ({
      ...current,
      provider: value as PresetDraft["provider"],
      customProviderName: "",
      modelId: "",
      contextWindow: "",
      maxOutputTokens: "",
    }));
    setErrors({});
    setError("");
  }
  function handleMode(mode: PresetDraft["compactionMode"]) {
    setDraft((current) => changeCompactionMode(current, mode));
    setErrors({});
    setError("");
  }
  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const validation = validateDraft(draft);
    setErrors(validation);
    setError("");
    if (Object.keys(validation).length) {
      setError("Please correct the highlighted fields.");
      requestAnimationFrame(() =>
        formRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    setBusy(true);
    try {
      const saved = await save(preset?.id ?? null, draftToInput(draft));
      onSaved(saved.id);
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof RequestError) setErrors(error.fields);
      setBusy(false);
    }
  }
  function handleDelete() {
    if (preset) onDelete(preset);
  }
  const liveErrors = validateDraft(draft);
  const input = draftToInput(draft);
  const threshold = compactionThreshold(input.contextWindow, input.compaction);
  return (
    <form
      ref={formRef}
      className={styles.editor}
      onSubmit={handleSave}
      noValidate
      aria-label="Model preset editor"
    >
      <div className={styles.editorHeading}>
        <div className={styles.editorTitle}>
          <div className={styles.presetIcon}>
            <SlidersHorizontal size={20} />
          </div>
          <div>
            <h2>{preset ? preset.name : "New model preset"}</h2>
            <p>
              {preset
                ? "Fine-tune your model configuration."
                : "A reusable starting point for your agents."}
            </p>
          </div>
        </div>
        <span className={dirty ? styles.unsaved : styles.saved}>
          <span />
          {dirty ? "Unsaved changes" : preset ? "Saved locally" : "Draft"}
        </span>
      </div>
      <fieldset disabled={busy} className={styles.fields}>
        <section className={styles.formSection} aria-labelledby="preset-basics">
          <div className={styles.sectionHeading}>
            <span>01</span>
            <div>
              <h3 id="preset-basics">The basics</h3>
              <p>Give this configuration a name you’ll recognize.</p>
            </div>
          </div>
          <Field label="Preset name" error={errors.name}>
            {(props) => (
              <input
                {...props}
                name="name"
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
                maxLength={120}
                placeholder="e.g. Everyday coding"
                autoComplete="off"
              />
            )}
          </Field>
        </section>
        <section className={styles.formSection} aria-labelledby="preset-model">
          <div className={styles.sectionHeading}>
            <span>02</span>
            <div>
              <h3 id="preset-model">Provider & model</h3>
              <p>Choose where the intelligence comes from.</p>
            </div>
          </div>
          <div
            className={styles.kindPicker}
            role="group"
            aria-label="Integration kind"
          >
            <button
              type="button"
              aria-pressed={draft.integrationKind === "provider"}
              className={
                draft.integrationKind === "provider" ? styles.kindActive : ""
              }
              onClick={() => {
                if (draft.integrationKind !== "provider")
                  handleKind("provider");
              }}
            >
              <Cpu size={17} />
              <span>
                Model provider<small>APIs & local endpoints</small>
              </span>
              {draft.integrationKind === "provider" && <Check size={15} />}
            </button>
            <button
              type="button"
              aria-pressed={draft.integrationKind === "runtime"}
              className={
                draft.integrationKind === "runtime" ? styles.kindActive : ""
              }
              onClick={() => {
                if (draft.integrationKind !== "runtime") handleKind("runtime");
              }}
            >
              <Bot size={17} />
              <span>
                Agent runtime<small>Existing agent systems</small>
              </span>
              {draft.integrationKind === "runtime" && <Check size={15} />}
            </button>
          </div>
          {errors.integrationKind && (
            <p className="fieldError">{errors.integrationKind}</p>
          )}
          <div className={styles.twoColumns}>
            <Field
              label={
                draft.integrationKind === "provider" ? "Provider" : "Runtime"
              }
              error={errors.provider}
            >
              {(props) => (
                <select
                  {...props}
                  value={draft.provider}
                  onChange={(event) => handleProvider(event.target.value)}
                >
                  {providerOptions
                    .filter((option) => option.kind === draft.integrationKind)
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <Field
              label="Model identifier"
              error={errors.modelId}
              hint="Enter the identifier used by your integration."
            >
              {(props) => (
                <input
                  {...props}
                  name="modelId"
                  value={draft.modelId}
                  onChange={(event) => update("modelId", event.target.value)}
                  maxLength={200}
                  placeholder="Enter model ID"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
          </div>
          {draft.provider === "custom" && (
            <Field
              label="Custom integration name"
              error={errors.customProviderName}
            >
              {(props) => (
                <input
                  {...props}
                  value={draft.customProviderName}
                  onChange={(event) =>
                    update("customProviderName", event.target.value)
                  }
                  maxLength={120}
                  placeholder="Name your provider or runtime"
                />
              )}
            </Field>
          )}
          <div className={styles.notice}>
            <Info size={15} />
            <p>
              {draft.integrationKind === "runtime"
                ? "Runtime connection and sign-in are coming later. "
                : "Provider connections and automatic model discovery are coming later. "}
              Enter model details manually for now.
            </p>
          </div>
        </section>
        <section
          className={styles.formSection}
          aria-labelledby="preset-context"
        >
          <div className={styles.sectionHeading}>
            <span>03</span>
            <div>
              <h3 id="preset-context">Context & compaction</h3>
              <p>Define the model’s limits and when to compact.</p>
            </div>
          </div>
          <div className={styles.twoColumns}>
            <Field
              label="Context window"
              error={errors.contextWindow ?? liveErrors.contextWindow}
              hint="Total tokens. Leave empty if unknown."
            >
              {(props) => (
                <div className="inputWithUnit">
                  <input
                    {...props}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={Number.MAX_SAFE_INTEGER}
                    step={1}
                    value={draft.contextWindow}
                    onChange={(event) =>
                      update("contextWindow", event.target.value)
                    }
                    placeholder="Unknown"
                  />
                  <span>tokens</span>
                </div>
              )}
            </Field>
            <Field
              label="Maximum output"
              error={errors.maxOutputTokens ?? liveErrors.maxOutputTokens}
              hint="Optional maximum response length."
            >
              {(props) => (
                <div className="inputWithUnit">
                  <input
                    {...props}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={Number.MAX_SAFE_INTEGER}
                    step={1}
                    value={draft.maxOutputTokens}
                    onChange={(event) =>
                      update("maxOutputTokens", event.target.value)
                    }
                    placeholder="Unknown"
                  />
                  <span>tokens</span>
                </div>
              )}
            </Field>
          </div>
          <div className={styles.compaction}>
            <div className={styles.compactionHeading}>
              <div>
                <h4>
                  <ArrowDownToLine size={14} />
                  Auto-compaction threshold
                </h4>
                <p>Keep a little room for what comes next.</p>
              </div>
              <span className={styles.configBadge}>CONFIGURATION ONLY</span>
            </div>
            <div className={styles.compactionControls}>
              <div
                className={styles.segmented}
                role="group"
                aria-label="Compaction mode"
              >
                <button
                  type="button"
                  aria-pressed={draft.compactionMode === "percentage"}
                  className={
                    draft.compactionMode === "percentage"
                      ? styles.segmentActive
                      : ""
                  }
                  onClick={() => {
                    if (draft.compactionMode !== "percentage")
                      handleMode("percentage");
                  }}
                >
                  Percentage
                </button>
                <button
                  type="button"
                  aria-pressed={draft.compactionMode === "tokens"}
                  className={
                    draft.compactionMode === "tokens"
                      ? styles.segmentActive
                      : ""
                  }
                  onClick={() => {
                    if (draft.compactionMode !== "tokens") handleMode("tokens");
                  }}
                >
                  Token limit
                </button>
              </div>
              <Field
                label={
                  draft.compactionMode === "percentage"
                    ? "Context percentage"
                    : "Token threshold"
                }
                error={
                  errors["compaction.value"] ??
                  errors.compaction ??
                  errors["compaction.mode"] ??
                  liveErrors["compaction.value"]
                }
              >
                {(props) => (
                  <div className="inputWithUnit">
                    <input
                      {...props}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={
                        draft.compactionMode === "percentage"
                          ? 100
                          : Number.MAX_SAFE_INTEGER
                      }
                      step={1}
                      value={draft.compactionValue}
                      onChange={(event) =>
                        update("compactionValue", event.target.value)
                      }
                    />
                    <span>
                      {draft.compactionMode === "percentage" ? "%" : "tokens"}
                    </span>
                  </div>
                )}
              </Field>
            </div>
            <div className={styles.threshold}>
              <span>Effective threshold</span>
              <strong>
                {threshold === null
                  ? "Unknown"
                  : `${threshold.toLocaleString()} tokens`}
              </strong>
            </div>
            <p className={styles.compactionHelp}>
              Defaults to 80% of the context window. Compaction is not executed
              yet.
            </p>
          </div>
        </section>
        <section className={styles.formSection} aria-labelledby="preset-notes">
          <div className={styles.sectionHeading}>
            <span>04</span>
            <div>
              <h3 id="preset-notes">
                Notes <small>OPTIONAL</small>
              </h3>
              <p>Anything useful to remember about this preset.</p>
            </div>
          </div>
          <Field label="Notes" error={errors.notes}>
            {(props) => (
              <textarea
                {...props}
                rows={3}
                maxLength={4000}
                value={draft.notes}
                onChange={(event) => update("notes", event.target.value)}
                placeholder="Best for, things to keep in mind…"
              />
            )}
          </Field>
        </section>
      </fieldset>
      <footer className={styles.editorFooter}>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className={styles.footerActions}>
          {preset && (
            <button
              type="button"
              className="button deleteButton"
              disabled={busy}
              onClick={handleDelete}
            >
              <Trash2 size={15} />
              <span>Delete</span>
            </button>
          )}
          <div />
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || (!!preset && !dirty)}
          >
            <Save size={14} />
            {busy ? "Saving…" : "Save preset"}
          </button>
        </div>
      </footer>
    </form>
  );
}

function DeletePresetDialog({
  preset,
  onClose,
  onDeleted,
}: {
  preset: ModelPreset;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = useDashboard((state) => state.deletePreset);
  async function handleDelete() {
    setBusy(true);
    setError("");
    try {
      await remove(preset.id);
      onDeleted();
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }
  return (
    <Dialog title="Delete model preset" onClose={onClose} busy={busy}>
      <p>
        Delete <strong>{preset.name}</strong>? This permanently removes the
        preset and cannot be undone.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialogActions">
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="button danger"
          disabled={busy}
          onClick={handleDelete}
        >
          {busy ? "Deleting…" : "Delete preset"}
        </button>
      </div>
    </Dialog>
  );
}

export default function Presets() {
  const presets = useDashboard((state) => state.presets);
  const status = useDashboard((state) => state.presetStatus);
  const error = useDashboard((state) => state.presetError);
  const total = useDashboard((state) => state.presetTotal);
  const offset = useDashboard((state) => state.presetOffset);
  const load = useDashboard((state) => state.loadPresets);
  const [selection, setSelection] = useState<{
    id: string;
    revision: number;
  } | null>(null);
  const [deleting, setDeleting] = useState<ModelPreset | null>(null);
  const attempt = useNavigationGuard();
  useEffect(() => {
    if (status === "idle") void load();
  }, [load, status]);
  const selected = presets.find((p) => p.id === selection?.id);
  function handleCreate() {
    attempt(() => setSelection({ id: "new", revision: 0 }));
  }
  function handleSaved(id: string) {
    setSelection((current) => ({ id, revision: (current?.revision ?? 0) + 1 }));
  }
  function handleCancel() {
    attempt(() => setSelection(null));
  }
  function handleDelete(preset: ModelPreset) {
    setDeleting(preset);
  }
  function handleDeleteClose() {
    setDeleting(null);
  }
  function handleDeleted() {
    setDeleting(null);
    setSelection(null);
  }
  function handleRetry() {
    void load(!!presets.length);
  }
  function handleMore() {
    void load(true);
  }
  return (
    <section className={styles.page} aria-label="Model presets">
      <header className="pageHeader">
        <div>
          <span className="eyebrow">SET ONCE. MAKE IT YOURS.</span>
          <h1>
            Model presets<span className="count">{total}</span>
          </h1>
          <p>Your go-to configurations, ready for any workspace.</p>
        </div>
        <button
          className="button primary"
          onClick={handleCreate}
          disabled={
            selection?.id === "new" ||
            status === "idle" ||
            status === "loading" ||
            (status === "error" && !presets.length)
          }
        >
          <Plus size={15} />
          New preset
        </button>
      </header>
      {error && (
        <div className="errorBanner" role="alert">
          {error}
          <button className="textButton" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
      <div
        className={`${styles.layout} ${selection ? styles.hasSelection : ""}`}
      >
        <aside className={styles.library} aria-label="Preset library">
          <div className={styles.libraryHeading}>
            <span>ALL PRESETS</span>
            <span>{total}</span>
          </div>
          {status === "idle" || (status === "loading" && !presets.length) ? (
            <p className={styles.listMessage} role="status">
              Loading presets…
            </p>
          ) : (
            !presets.length && (
              <div className={styles.libraryEmpty}>
                <SlidersHorizontal size={23} />
                <h3>A library of possibilities</h3>
                <p>Save your favorite model setups here.</p>
              </div>
            )
          )}
          <div className={styles.presetList}>
            {presets.map((preset) => (
              <button
                key={preset.id}
                className={`${styles.presetItem} ${selection?.id === preset.id ? styles.selected : ""}`}
                aria-current={selection?.id === preset.id ? "true" : undefined}
                onClick={() => {
                  if (selection?.id !== preset.id)
                    attempt(() => setSelection({ id: preset.id, revision: 0 }));
                }}
              >
                <div className={styles.listIcon}>
                  {preset.integrationKind === "runtime" ? (
                    <Bot size={17} />
                  ) : (
                    <Cpu size={17} />
                  )}
                </div>
                <span>
                  <strong>{preset.name}</strong>
                  <small>
                    {providerLabel(preset)} <span>·</span> {preset.modelId}
                  </small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
          {offset < total && (
            <button
              className={`button secondary ${styles.loadMore}`}
              disabled={status === "loading"}
              onClick={handleMore}
            >
              {status === "loading" ? "Loading…" : "Load more presets"}
            </button>
          )}
          <div className={styles.libraryFoot}>
            <span className={styles.miniDot} />
            Shared across all workspaces
          </div>
        </aside>
        <div className={styles.detail}>
          {selection && (selection.id === "new" || selected) ? (
            <>
              <button
                className={`textButton ${styles.backButton}`}
                onClick={handleCancel}
              >
                <ArrowLeft size={14} />
                Preset library
              </button>
              <PresetEditor
                key={`${selection.id}-${selection.revision}`}
                preset={selected}
                onSaved={handleSaved}
                onCancel={handleCancel}
                onDelete={handleDelete}
              />
            </>
          ) : (
            <div className="centerState">
              <div className="emptyIcon">
                <SlidersHorizontal size={28} strokeWidth={1.4} />
              </div>
              <span className="eyebrow">YOUR MODELS, YOUR DEFAULTS</span>
              <h2>
                {presets.length
                  ? "Find your starting point"
                  : "Good work starts with a good setup"}
              </h2>
              <p>
                {presets.length
                  ? "Select a preset to view and edit its configuration."
                  : "Create a model preset to keep your preferred configuration close."}
              </p>
              <button
                className="button primary"
                onClick={handleCreate}
                disabled={status !== "ready" && !presets.length}
              >
                Create a preset
                <ArrowRight size={15} />
              </button>
              <span className={styles.emptyFoot}>
                Saved locally. Available across your workspaces.
              </span>
            </div>
          )}
        </div>
      </div>
      {deleting && (
        <DeletePresetDialog
          preset={deleting}
          onClose={handleDeleteClose}
          onDeleted={handleDeleted}
        />
      )}
    </section>
  );
}
