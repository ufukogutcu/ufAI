import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronRight,
  Cpu,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  errorMessage,
  RequestError,
  type ModelPreset,
  type ConnectionProvider,
  type DiscoveredModel,
} from "../api";
import {
  createConnectionStore,
  ConnectionContext,
  useConnections,
} from "../connection-store";
import { refreshOnFocus } from "../focus-refresh";
import { Field } from "../components/FormField";
import { PresetModelPicker } from "../components/PresetModelPicker";
import { PresetConnectionDialog } from "../components/PresetConnectionDialog";
import { useDashboard } from "../store";
import {
  changeCompactionMode,
  compactionThreshold,
  draftFromPreset,
  draftToInput,
  providerLabel,
  providerOptions,
  validateDraft,
  selectProvider,
  selectModel,
  type PresetDraft,
} from "../preset-form";
import { Dialog } from "../components/Dialog";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import styles from "./Presets.module.scss";

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
  const connections = useConnections((state) => state.connections);
  const connectionStatus = useConnections((state) => state.status);
  const connectionError = useConnections((state) => state.error);
  const loadConnections = useConnections((state) => state.load);
  const [connectionDialog, setConnectionDialog] = useState<{
    provider: ConnectionProvider;
    edit: boolean;
  } | null>(null);
  const [modelRevision, setModelRevision] = useState(0);
  const pendingDefault = useRef<string | null>(null);
  const selectedConnection = connections.find(
    (connection) => connection.id === draft.connectionId,
  );
  const providerConnections = connections.filter(
    (connection) => connection.provider === draft.provider,
  );
  const connectable = providerOptions.some(
    (option) => option.id === draft.provider,
  );
  useEffect(() => {
    if (
      connectionStatus !== "ready" ||
      pendingDefault.current !== draft.provider
    )
      return;
    pendingDefault.current = null;
    const selected = connections.find(
      (connection) =>
        connection.provider === draft.provider && connection.isDefault,
    );
    if (selected)
      setDraft((current) =>
        current.provider === selected.provider && !current.connectionId
          ? { ...current, connectionId: selected.id }
          : current,
      );
  }, [connectionStatus, connections, draft.provider]);
  function handleKind(kind: PresetDraft["integrationKind"]) {
    pendingDefault.current = null;
    setDraft((current) => selectProvider(current, "", kind, connections));
    setErrors({});
    setError("");
  }
  function handleProvider(value: string) {
    pendingDefault.current = connectionStatus === "ready" ? null : value;
    setDraft((current) =>
      selectProvider(
        current,
        value as PresetDraft["provider"],
        current.integrationKind,
        connections,
      ),
    );
    setErrors({});
    setError("");
  }
  function handleConnection(id: string | null) {
    pendingDefault.current = null;
    update("connectionId", id);
    setModelRevision((revision) => revision + 1);
  }
  function handleModel(id: string, models: DiscoveredModel[]) {
    setDraft((current) => selectModel(current, id, models));
    setErrors({});
    setError("");
  }
  function handleConnectionClose() {
    setConnectionDialog(null);
    setModelRevision((revision) => revision + 1);
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
    <>
      <form
        ref={formRef}
        className={styles.editor}
        onSubmit={handleSave}
        noValidate
        aria-label="Model preset editor"
      >
        <div className={styles.editorHeading}>
          <h2>{preset ? "Edit preset" : "New preset"}</h2>
          <span className={dirty ? styles.unsaved : styles.saved}>
            <span />
            {dirty ? "Unsaved changes" : preset ? "Saved locally" : "Draft"}
          </span>
        </div>
        <fieldset disabled={busy} className={styles.fields}>
          <section className={styles.formSection} aria-label="Preset details">
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
          <section
            className={styles.formSection}
            aria-label="Provider and model"
          >
            <div className={styles.providerCategory}>
              <div
                className={styles.segmented}
                role="group"
                aria-label="Provider category"
              >
                <button
                  type="button"
                  aria-pressed={draft.integrationKind === "provider"}
                  className={
                    draft.integrationKind === "provider"
                      ? styles.segmentActive
                      : ""
                  }
                  onClick={() => {
                    if (draft.integrationKind !== "provider")
                      handleKind("provider");
                  }}
                >
                  API
                </button>
                <button
                  type="button"
                  aria-pressed={draft.integrationKind === "runtime"}
                  className={
                    draft.integrationKind === "runtime"
                      ? styles.segmentActive
                      : ""
                  }
                  onClick={() => {
                    if (draft.integrationKind !== "runtime")
                      handleKind("runtime");
                  }}
                >
                  Subscription
                </button>
              </div>
            </div>
            <div className={styles.providerRow}>
              <Field
                label="Provider"
                error={errors.provider ?? errors.integrationKind}
              >
                {(props) => (
                  <select
                    {...props}
                    value={draft.provider}
                    onChange={(event) => handleProvider(event.target.value)}
                  >
                    <option value="">Choose a provider…</option>
                    {providerOptions
                      .filter((option) => option.kind === draft.integrationKind)
                      .map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    {preset &&
                      draft.provider === preset.provider &&
                      !connectable && (
                        <option value={preset.provider}>
                          {providerLabel(preset)} (legacy)
                        </option>
                      )}
                  </select>
                )}
              </Field>
              {draft.provider && connectable && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    setConnectionDialog({
                      provider: draft.provider as ConnectionProvider,
                      edit: !!selectedConnection,
                    })
                  }
                >
                  {selectedConnection ? "Manage" : "Connect"}
                </button>
              )}
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
                  />
                )}
              </Field>
            )}
            {draft.provider && connectable && (
              <div className={styles.connectionSummary}>
                <span>
                  {selectedConnection
                    ? selectedConnection.name
                    : "No saved connection selected"}
                </span>
                <details className={styles.connectionOptions}>
                  <summary>Connection options</summary>
                  <Field label="Saved connection" error={errors.connectionId}>
                    {(props) => (
                      <select
                        {...props}
                        value={draft.connectionId ?? ""}
                        onChange={(event) =>
                          handleConnection(event.target.value || null)
                        }
                      >
                        <option value="">Unlinked · manual model ID</option>
                        {draft.connectionId && !selectedConnection && (
                          <option value={draft.connectionId}>
                            Unavailable connection · choose another or unlink
                          </option>
                        )}
                        {providerConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name}
                            {connection.isDefault ? " (default)" : ""}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <button
                    type="button"
                    className="textButton"
                    onClick={() =>
                      setConnectionDialog({
                        provider: draft.provider as ConnectionProvider,
                        edit: false,
                      })
                    }
                  >
                    Add another connection
                  </button>
                </details>
              </div>
            )}
            {errors.connectionId && (
              <p className="fieldError" role="alert">
                {errors.connectionId}
              </p>
            )}
            {connectionError && (
              <p className="fieldError" role="status">
                {connectionError}{" "}
                <button
                  type="button"
                  className="textButton"
                  onClick={() => void loadConnections()}
                >
                  Retry connections
                </button>
              </p>
            )}
            {draft.provider && (
              <PresetModelPicker
                key={`${draft.integrationKind}-${draft.provider}`}
                connectionId={selectedConnection?.id ?? null}
                value={draft.modelId}
                error={errors.modelId}
                onSelect={handleModel}
                refreshKey={modelRevision}
              />
            )}
          </section>
          <section
            className={styles.formSection}
            aria-labelledby="preset-context"
          >
            <h3 id="preset-context" className={styles.sectionTitle}>
              Context & compaction
            </h3>
            <div className={styles.twoColumns}>
              <Field
                label="Context window"
                error={errors.contextWindow ?? liveErrors.contextWindow}
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
            <div className={styles.compactionControls}>
              <Field
                label="Compact at"
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
              <Field label="Threshold unit">
                {(props) => (
                  <select
                    {...props}
                    value={draft.compactionMode}
                    onChange={(event) =>
                      handleMode(
                        event.target.value as PresetDraft["compactionMode"],
                      )
                    }
                  >
                    <option value="percentage">Percentage of context</option>
                    <option value="tokens">Token limit</option>
                  </select>
                )}
              </Field>
            </div>
            <p className={styles.threshold}>
              Effective threshold{" "}
              <strong>
                {threshold === null
                  ? "Unknown"
                  : `${threshold.toLocaleString()} tokens`}
              </strong>
            </p>
            <p className={styles.compactionHelp}>
              Configuration only. Compaction is not executed yet.
            </p>
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
      {connectionDialog && (
        <PresetConnectionDialog
          provider={connectionDialog.provider}
          connection={connectionDialog.edit ? selectedConnection : undefined}
          onSelected={handleConnection}
          onClose={handleConnectionClose}
        />
      )}
    </>
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
  const [connections] = useState(createConnectionStore);
  useEffect(() => {
    void connections.getState().load();
    return refreshOnFocus(() => connections.getState().load());
  }, [connections]);
  return (
    <ConnectionContext.Provider value={connections}>
      <PresetLibrary />
    </ConnectionContext.Provider>
  );
}

function PresetLibrary() {
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
