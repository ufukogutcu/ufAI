import { useEffect, useState } from "react";
import { useConnections } from "../connection-store";
import type { ProviderModel } from "../api";
import { compactionThreshold, modelConfigurationInput, setCodexPresetOption, type ModelConfigurationDraft } from "../preset-form";
import { Appearance } from "./Appearance";
import { Field } from "./FormField";
import { ModelSelect } from "./ModelSelect";
import { CodexPresetFields } from "./CodexPresetFields";
import styles from "../pages/Presets.module.scss";

export default function ModelConfigurationFields({
  draft, fields, onChange, clearErrors, incompleteHint, presetContext, refreshVersion,
}: {
  draft: ModelConfigurationDraft;
  fields: Record<string, string>;
  onChange: (changes: Partial<ModelConfigurationDraft>) => void;
  clearErrors: (...keys: string[]) => void;
  incompleteHint: string;
  presetContext?: number | null;
  refreshVersion?: number;
}) {
  const [model, setModel] = useState<ProviderModel | null>(null);
  const connections = useConnections(state => state.connections);
  const connectionError = useConnections(state => state.error);
  const loadConnections = useConnections(state => state.load);
  useEffect(() => {
    if (refreshVersion !== undefined) void loadConnections();
  }, [refreshVersion, loadConnections]);
  const selectedConnection = connections.find(item => item.id === draft.connectionId);
  const selectedModel = model?.id === draft.modelId && model.connectionId === draft.connectionId
    ? model : null;
  const context = selectedModel ? selectedModel.contextWindow : presetContext ?? null;
  const compaction = modelConfigurationInput(draft).compaction;
  const threshold = compactionThreshold(context, compaction);
  const invalidThreshold = compaction?.mode === "tokens" && context && compaction.value > context;

  function handleModel(id: string, selected: ProviderModel | null) {
    if (id !== draft.modelId) onChange({ modelId: id, providerOptions: null });
    clearErrors("modelId", "providerOptions");
    setModel(selected);
  }
  function handleCodexOption(field: "reasoningEffort" | "serviceTier", value: string) {
    onChange({ providerOptions: setCodexPresetOption(draft, field, value).providerOptions });
    clearErrors("providerOptions", `providerOptions.${field}`);
  }

  return <>
    <section className={styles.formSection}>
      <Field
        label="Provider"
        error={fields.connectionId ?? fields.providerOptions}
        hint="Set up connections and models on the Providers page."
      >
        {(props) => (
          <select
            {...props}
            name="connectionId"
            value={draft.connectionId ?? ""}
            onChange={(event) => {
              onChange({
                connectionId: event.target.value || null,
                modelId: "",
                providerOptions: null,
              });
              setModel(null);
              clearErrors("connectionId", "modelId", "providerOptions");
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
          {connectionError}{" "}
          <button type="button" className="textButton" onClick={() => void loadConnections()}>Retry Providers</button>
        </p></Appearance>
      )}
      <ModelSelect
        key={draft.connectionId}
        connectionId={draft.connectionId}
        refreshVersion={refreshVersion}
        value={draft.modelId}
        onSelect={handleModel}
        onResolved={setModel}
        error={fields.modelId}
      />
      <p className={styles.modelStatus}>
        Context window:{" "}
        {context?.toLocaleString() ?? "Unknown"} tokens
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
        <p className={styles.modelStatus}>{incompleteHint}</p>
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
              onChange={(event) => {
                onChange({ compactionValue: event.target.value });
                clearErrors("compaction", "compaction.value");
              }}
            />
          )}
        </Field>
        <Field label="Threshold unit" error={fields["compaction.mode"]}>
          {(props) => (
            <select
              {...props}
              name="compactionMode"
              value={draft.compactionMode}
              onChange={(event) => {
                onChange({
                  compactionMode: event.target.value as
                    | "percentage"
                    | "tokens",
                  compactionValue: "",
                });
                clearErrors("compaction", "compaction.mode", "compaction.value");
              }}
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
          it before starting work.
        </p></Appearance>
      ) : null}
      <p className={styles.compactionHelp}>
        Agents compact long task conversations automatically. Leave this empty
        to use an 80% threshold; execution may compact earlier to fit safely.
      </p>
    </section>
  </>;
}
