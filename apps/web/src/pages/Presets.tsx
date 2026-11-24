import { Feedback, BusyButton, LoadingState } from "../components/Feedback";
import { useNotice } from "../components/FeedbackProvider";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useDashboard } from "../store";
import { useConnections } from "../connection-store";
import {
  errorMessage,
  RequestError,
  type ModelPreset,
  type ProviderModel,
} from "../api";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import {
  compactionThreshold,
  draftFromPreset,
  draftToInput,
  setCodexPresetOption,
  validateDraft,
} from "../preset-form";
import { Field } from "../components/FormField";
import { Dialog } from "../components/Dialog";
import { ModelSelect } from "../components/ModelSelect";
import { CodexPresetFields } from "../components/CodexPresetFields";
import { refreshOnFocus } from "../focus-refresh";
import styles from "./Presets.module.scss";
import { Appearance, AppearanceGroup } from "../components/Appearance";

function PresetEditor({
  preset,
  onSaved,
  onCancel,
  onDelete,
}: {
  preset?: ModelPreset;
  onSaved: (preset: ModelPreset) => void;
  onCancel: () => void;
  onDelete: (preset: ModelPreset) => void;
}) {
  const [draft, setDraft] = useState(() => draftFromPreset(preset));
  const [baseline, setBaseline] = useState(() => JSON.stringify(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => {
    if (preset && JSON.stringify(draft) === baseline) {
      const next = draftFromPreset(preset);
      if (JSON.stringify(next) !== baseline) {
        setDraft(next);
        setBaseline(JSON.stringify(next));
      }
    }
  }, [preset, draft, baseline]);
  useEffect(() => {
    if (Object.keys(fields).length)
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fields]);
  const [model, setModel] = useState<ProviderModel | null>(null);
  const save = useDashboard((state) => state.savePreset);
  const connections = useConnections((state) => state.connections);
  const connectionError = useConnections((state) => state.error);
  useUnsavedChanges(JSON.stringify(draft) !== baseline);
  const handleModel = useCallback(
    (id: string, selected: ProviderModel | null) => {
      setDraft((current) => current.modelId === id
        ? current : { ...current, modelId: id, providerOptions: null });
      setFields({});
      setModel(selected);
    },
    [],
  );
  const handleResolvedModel = useCallback(
    (selected: ProviderModel | null) => setModel(selected),
    [],
  );
  function handleCodexOption(field: "reasoningEffort" | "serviceTier", value: string) {
    setDraft((current) => setCodexPresetOption(current, field, value));
    setFields((current) => {
      const key = `providerOptions.${field}`;
      if (!(key in current)) return current;
      const { [key]: _, ...remaining } = current;
      return remaining;
    });
  }
  const selectedConnection = connections.find((item) => item.id === draft.connectionId);
  const selectedModel = model?.id === draft.modelId && model.connectionId === draft.connectionId
    ? model : null;
  const input = draftToInput(draft);
  const threshold = compactionThreshold(
    selectedModel?.contextWindow ?? null,
    input.compaction,
  );
  const context = selectedModel?.contextWindow;
  const invalidThreshold =
    input.compaction?.mode === "tokens" &&
    context &&
    input.compaction.value > context;
  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const errors = validateDraft(draft);
    setFields(errors);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError("");
    try {
      const saved = await save(preset?.id ?? null, input);
      setBaseline(JSON.stringify(draft));
      onSaved(saved);
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof RequestError) setFields(error.fields);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppearanceGroup>
    <form className={styles.editor} onSubmit={handleSave} noValidate>
      <header className={styles.editorHeading} data-appearance-content>
        <h2>{preset ? "Edit agent preset" : "New agent preset"}</h2>
      </header>
      <fieldset className={styles.fields} disabled={busy} data-appearance-content>
        <section className={styles.formSection}>
          <Field label="Preset name" error={fields.name}>
            {(props) => (
              <input
                {...props}
                name="name"
                autoComplete="off"
                maxLength={120}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                required
              />
            )}
          </Field>
          <label className={styles.defaultOption}>
            <input
              name="isDefault"
              type="checkbox"
              checked={draft.isDefault}
              onChange={(event) =>
                setDraft({ ...draft, isDefault: event.target.checked })
              }
              aria-describedby="preset-default-hint"
            />
            Use as default for new agents
          </label>
          <p id="preset-default-hint" className={styles.modelStatus}>
            Saving this as the default replaces any previous default. New agents
            can still be created without a preset.
          </p>
        </section>
        <section className={styles.formSection}>
          <Field
            label="Provider"
            error={fields.connectionId}
            hint="Set up connections and models on the Providers page."
          >
            {(props) => (
              <select
                {...props}
                value={draft.connectionId ?? ""}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    connectionId: event.target.value || null,
                    modelId: "",
                    providerOptions: null,
                  });
                  setModel(null);
                  setFields({});
                }}
              >
                <option value="">None</option>
                {draft.connectionId &&
                  !connections.some(
                    (c) => c.id === draft.connectionId && !c.draft,
                  ) && (
                    <option value={draft.connectionId}>
                      Unavailable Provider
                    </option>
                  )}
                {connections
                  .filter((c) => !c.draft)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>
          {connectionError && (
            <Appearance kind="fade"><p className="fieldError" role="status">
              {connectionError}
            </p></Appearance>
          )}
          <ModelSelect
            connectionId={draft.connectionId}
            value={draft.modelId}
            onSelect={handleModel}
            onResolved={handleResolvedModel}
            error={fields.modelId}
          />
          <p className={styles.modelStatus}>
            Context window:{" "}
            {selectedModel?.contextWindow?.toLocaleString() ?? "Unknown"} tokens
          </p>
          {draft.modelId && (selectedConnection?.provider === "codex" || draft.providerOptions) && (
            <CodexPresetFields
              model={selectedModel}
              options={draft.providerOptions}
              fields={fields}
              onChange={handleCodexOption}
            />
          )}
          {(!draft.connectionId || !draft.modelId) && (
            <p className={styles.modelStatus}>
              You can save this preset now and choose a Provider and model
              later.
            </p>
          )}
        </section>
        <section className={styles.formSection}>
          <h3 className={styles.sectionTitle}>Compaction</h3>
          <div className={styles.compactionControls}>
            <Field
              label="Compact at (optional)"
              error={fields["compaction.value"] ?? fields.compaction}
            >
              {(props) => (
                <input
                  {...props}
                  name="compactionValue"
                  type="number"
                  min={1}
                  max={
                    draft.compactionMode === "percentage"
                      ? 100
                      : Number.MAX_SAFE_INTEGER
                  }
                  step={1}
                  inputMode="numeric"
                  placeholder="Not configured…"
                  value={draft.compactionValue}
                  onChange={(event) =>
                    setDraft({ ...draft, compactionValue: event.target.value })
                  }
                />
              )}
            </Field>
            <Field label="Threshold unit">
              {(props) => (
                <select
                  {...props}
                  value={draft.compactionMode}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      compactionMode: event.target.value as
                        | "percentage"
                        | "tokens",
                      compactionValue: "",
                    })
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
          {invalidThreshold ? (
            <Appearance kind="fade"><p className={styles.modelStatus} role="status">
              This threshold exceeds the model’s current context window. Adjust
              it before using the preset.
            </p></Appearance>
          ) : null}
          <p className={styles.compactionHelp}>
            Agents compact long task conversations automatically. Leave this empty
            to use an 80% threshold; execution may compact earlier to fit safely.
          </p>
        </section>
      </fieldset>
      <footer className={styles.editorFooter}>
        {error && (
          <Appearance kind="fade"><Feedback role="alert">
            {error}
          </Feedback></Appearance>
        )}
        <div className={styles.presetActions}>
          {preset && (
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => onDelete(preset)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete preset
            </button>
          )}
          <div className={styles.presetSaveActions}>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            <BusyButton busy={busy} className="button primary" disabled={busy}>
              {busy ? "Saving…" : "Save preset"}
            </BusyButton>
          </div>
        </div>
      </footer>
    </form>
    </AppearanceGroup>
  );
}
export default function Presets() {
  const presets = useDashboard((state) => state.presets);
  const status = useDashboard((state) => state.presetStatus);
  const total = useDashboard((state) => state.presetTotal);
  const offset = useDashboard((state) => state.presetOffset);
  const error = useDashboard((state) => state.presetError);
  const load = useDashboard((state) => state.loadPresets);
  useNotice(error && presets.length ? { id: "presets", title: "Presets could not refresh", message: error,
    actionLabel: "Reload presets", action: () => load() } : null, "presets");
  const remove = useDashboard((state) => state.deletePreset);
  const lastOpenedId = useDashboard((state) => state.lastOpenedPresetId);
  const rememberOpened = useDashboard((state) => state.rememberOpenedPreset);
  const loadConnections = useConnections((state) => state.load);
  const [snapshot, setSnapshot] = useState<ModelPreset | undefined>();
  // Undefined resolves the entry selection; null is an explicit library view.
  const [selection, setSelection] = useState<string | null>();
  const [opened, setOpened] = useState(false);
  const [revision, setRevision] = useState(0);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ModelPreset | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useNavigationGuard();
  useEffect(() => {
    let active = true;
    void load().then(() => {
      if (active) setOpened(true);
    });
    void loadConnections();
    const stopRefreshing = refreshOnFocus(async () => {
      await Promise.all([load(), loadConnections()]);
    });
    return () => {
      active = false;
      stopRefreshing();
    };
  }, [load, loadConnections]);
  useEffect(() => {
    if (!opened || status !== "ready") return;
    if (selection === undefined) {
      const next =
        presets.find((preset) => preset.id === lastOpenedId) ?? presets[0];
      setSnapshot(next);
      setSelection(next?.id ?? "new");
      rememberOpened(next?.id ?? null);
    } else if (total === 0 && selection === null) {
      setSelection("new");
    }
  }, [opened, status, total, selection, presets, lastOpenedId, rememberOpened]);
  function choose(id: string | null) {
    if (id === selection) return;
    attempt(() => {
      setSnapshot(presets.find((p) => p.id === id));
      setSelection(id);
      if (id && id !== "new") rememberOpened(id);
    });
  }
  function saved(preset: ModelPreset) {
    if (selection === "new") setCreatedId(preset.id);
    setSnapshot(preset);
    setSelection(preset.id);
    rememberOpened(preset.id);
    setRevision((value) => value + 1);
  }
  function handleLoadMore() {
    setCreatedId(null);
    void load(true);
  }
  function clearCreatedAppearance() {
    setCreatedId(null);
  }
  function beginDelete(preset: ModelPreset) {
    setDeleteError("");
    setDeleting(preset);
  }
  async function handleDelete() {
    if (!deleting) return;
    setBusy(true);
    setDeleteError("");
    try {
      await remove(deleting.id);
      // Refill the library if deleting the last loaded item exposed another page.
      if (presets.length === 1 && total > 1) await load();
      setDeleting(null);
      if (selection === deleting.id) {
        setSnapshot(undefined);
        setSelection(undefined);
      }
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const selected =
    presets.find((p) => p.id === selection) ??
    (snapshot?.id === selection ? snapshot : undefined);
  return (
    <section className={styles.page} aria-label="Agent Presets">
      <header className="pageHeader">
        <div>
          <h1>
            Agent Presets<span className="count">{total}</span>
          </h1>
          <p>Reusable agent configurations across your workspaces.</p>
        </div>
        <button
          className="button primary"
          onClick={() => choose("new")}
          disabled={selection === "new"}
        >
          <Plus size={15} aria-hidden="true" />
          New preset
        </button>
      </header>
      {error && !presets.length && (
        <Appearance kind="fade">
        <Feedback role="alert">
          {error}
          <button className="textButton" onClick={() => void load()}>
            Retry
          </button>
        </Feedback>
        </Appearance>
      )}
      <div
        className={`${styles.layout} ${selection ? styles.hasSelection : ""}`}
      >
        <aside className={styles.library} aria-label="Preset library">
          {status === "loading" && !presets.length && (
            <Appearance kind="fade"><LoadingState className={styles.listMessage} role="status">
              Loading presets…
            </LoadingState></Appearance>
          )}
          {!presets.length && status === "ready" && (
            <Appearance kind="fade">
            <p className={styles.listMessage}>No agent presets yet.</p>
            </Appearance>
          )}
          <div className={styles.presetList}>
            {presets.map((preset) => (
              <Appearance key={preset.id} kind="fade" ready={preset.id === createdId}><button
                onAnimationEnd={clearCreatedAppearance}
                className={`${styles.presetItem} ${selection === preset.id ? styles.selected : ""}`}
                aria-current={selection === preset.id ? "true" : undefined}
                onClick={() => choose(preset.id)}
              >
                <span>
                  <strong>{preset.name}</strong>
                  <small>{preset.modelId ?? "No model selected"}</small>
                  {preset.isDefault && (
                    <small className={styles.defaultLabel}>Default</small>
                  )}
                </span>
              </button></Appearance>
            ))}
          </div>
          {offset < total && (
            <button
              className="button secondary"
              disabled={status === "loading"}
              onClick={handleLoadMore}
            >
              Load more presets
            </button>
          )}
        </aside>
        <Appearance kind="selection" trigger={selection}><div className={styles.detail}>
          {selection && (selection === "new" || selected) ? (
            <>
              {presets.length > 0 && (
                <button
                  className={`textButton ${styles.backButton}`}
                  onClick={() => choose(null)}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                  Preset library
                </button>
              )}
              {selection !== "new" &&
                !presets.some((p) => p.id === selection) && (
                  <Appearance kind="fade"><p className={styles.modelStatus} role="status">
                    This preset is no longer in the library. Your draft is still
                    shown; saving may fail if it was deleted in another session.
                  </p></Appearance>
                )}
              <PresetEditor
                key={`${selection}-${revision}`}
                preset={selected}
                onSaved={saved}
                onCancel={() => choose(null)}
                onDelete={beginDelete}
              />
            </>
          ) : (
            <div className="centerState">
              <SlidersHorizontal size={28} aria-hidden="true" />
              <h2>Choose an agent preset</h2>
              <p>Select a preset or create one with a name to get started.</p>
            </div>
          )}
        </div></Appearance>
      </div>
      {deleting && (
        <Dialog
          title="Delete agent preset?"
          onClose={() => setDeleting(null)}
          busy={busy}
          initialFocusSelector=".secondary"
        >
          <p>
            Permanently delete <strong>{deleting.name}</strong>?
          </p>
          {deleteError && (
            <Appearance kind="fade"><Feedback role="alert">
              {deleteError}
            </Feedback></Appearance>
          )}
          <div className="dialogActions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={handleDelete}
            >
              Delete preset
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
