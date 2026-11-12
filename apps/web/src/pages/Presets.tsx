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
  validateDraft,
} from "../preset-form";
import { Field } from "../components/FormField";
import { Dialog } from "../components/Dialog";
import { ModelSelect } from "../components/ModelSelect";
import { refreshOnFocus } from "../focus-refresh";
import styles from "./Presets.module.scss";

function PresetEditor({
  preset,
  onSaved,
  onCancel,
}: {
  preset?: ModelPreset;
  onSaved: (preset: ModelPreset) => void;
  onCancel: () => void;
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
      setDraft((current) => ({ ...current, modelId: id }));
      setModel(selected);
    },
    [],
  );
  const handleResolvedModel = useCallback(
    (selected: ProviderModel | null) => setModel(selected),
    [],
  );
  const input = draftToInput(draft);
  const threshold = compactionThreshold(
    model?.contextWindow ?? null,
    input.compaction,
  );
  const context = model?.contextWindow;
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
    <form className={styles.editor} onSubmit={handleSave} noValidate>
      <header className={styles.editorHeading}>
        <h2>{preset ? "Edit agent preset" : "New agent preset"}</h2>
      </header>
      <fieldset className={styles.fields} disabled={busy}>
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
                  });
                  setModel(null);
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
            <p className="fieldError" role="status">
              {connectionError}
            </p>
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
            {model?.contextWindow?.toLocaleString() ?? "Unknown"} tokens ·
            Maximum output:{" "}
            {model?.maxOutputTokens?.toLocaleString() ?? "Unknown"} tokens
          </p>
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
            <p className={styles.modelStatus} role="status">
              This threshold exceeds the model’s current context window. Adjust
              it before using the preset.
            </p>
          ) : null}
          <p className={styles.compactionHelp}>
            Optional configuration. Agent execution and compaction are not
            available yet.
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
          <div />
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save preset"}
          </button>
        </div>
      </footer>
    </form>
  );
}
export default function Presets() {
  const presets = useDashboard((state) => state.presets);
  const status = useDashboard((state) => state.presetStatus);
  const total = useDashboard((state) => state.presetTotal);
  const offset = useDashboard((state) => state.presetOffset);
  const error = useDashboard((state) => state.presetError);
  const load = useDashboard((state) => state.loadPresets);
  const remove = useDashboard((state) => state.deletePreset);
  const loadConnections = useConnections((state) => state.load);
  const [snapshot, setSnapshot] = useState<ModelPreset | undefined>();
  const [selection, setSelection] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState<ModelPreset | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useNavigationGuard();
  useEffect(() => {
    void load();
    void loadConnections();
    return refreshOnFocus(async () => {
      await Promise.all([load(), loadConnections()]);
    });
  }, [load, loadConnections]);
  useEffect(() => {
    if (status === "ready" && total === 0 && selection === null)
      setSelection("new");
  }, [status, total, selection]);
  function choose(id: string | null) {
    if (id === selection) return;
    attempt(() => {
      setSnapshot(presets.find((p) => p.id === id));
      setSelection(id);
    });
  }
  function saved(preset: ModelPreset) {
    setSnapshot(preset);
    setSelection(preset.id);
    setRevision((value) => value + 1);
  }
  async function handleDelete() {
    if (!deleting) return;
    setBusy(true);
    setDeleteError("");
    try {
      await remove(deleting.id);
      setDeleting(null);
      if (selection === deleting.id) setSelection(null);
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
      {error && (
        <div className="errorBanner" role="alert">
          {error}
          <button className="textButton" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <div
        className={`${styles.layout} ${selection ? styles.hasSelection : ""}`}
      >
        <aside className={styles.library} aria-label="Preset library">
          {status === "loading" && !presets.length && (
            <p className={styles.listMessage} role="status">
              Loading presets…
            </p>
          )}
          {!presets.length && status === "ready" && (
            <p className={styles.listMessage}>No agent presets yet.</p>
          )}
          <div className={styles.presetList}>
            {presets.map((preset) => (
              <button
                key={preset.id}
                className={`${styles.presetItem} ${selection === preset.id ? styles.selected : ""}`}
                aria-current={selection === preset.id ? "true" : undefined}
                onClick={() => choose(preset.id)}
              >
                <span>
                  <strong>{preset.name}</strong>
                  <small>{preset.modelId ?? "No model selected"}</small>
                </span>
              </button>
            ))}
          </div>
          {offset < total && (
            <button
              className="button secondary"
              disabled={status === "loading"}
              onClick={() => void load(true)}
            >
              Load more presets
            </button>
          )}
        </aside>
        <div className={styles.detail}>
          {selection && (selection === "new" || selected) ? (
            <>
              <div className={styles.inlineActions}>
                {presets.length > 0 && (
                  <button
                    className={`textButton ${styles.backButton}`}
                    onClick={() => choose(null)}
                  >
                    <ArrowLeft size={14} aria-hidden="true" />
                    Preset library
                  </button>
                )}
                {selected && (
                  <button
                    className="textButton"
                    onClick={() => {
                      setDeleteError("");
                      setDeleting(selected);
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete preset
                  </button>
                )}
              </div>
              {selection !== "new" &&
                !presets.some((p) => p.id === selection) && (
                  <p className={styles.modelStatus} role="status">
                    This preset is no longer in the library. Your draft is still
                    shown; saving may fail if it was deleted in another session.
                  </p>
                )}
              <PresetEditor
                key={`${selection}-${revision}`}
                preset={selected}
                onSaved={saved}
                onCancel={() => choose(null)}
              />
            </>
          ) : (
            <div className="centerState">
              <SlidersHorizontal size={28} aria-hidden="true" />
              <h2>Choose an agent preset</h2>
              <p>Select a preset or create one with a name to get started.</p>
            </div>
          )}
        </div>
      </div>
      {deleting && (
        <Dialog
          title="Delete agent preset?"
          onClose={() => setDeleting(null)}
          busy={busy}
        >
          <p>
            Permanently delete <strong>{deleting.name}</strong>?
          </p>
          {deleteError && (
            <p className="error" role="alert">
              {deleteError}
            </p>
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
