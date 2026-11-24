import type { ProviderModel, ProviderPresetOptions } from "../api";
import styles from "../pages/Presets.module.scss";
import { Field } from "./FormField";

function thinkingLabel(id: string) {
  if (id === "xhigh") return "Extra high";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function speedLabel(id: string) {
  if (id === "default") return "Standard";
  if (id === "priority") return "Fast";
  return id;
}

export function CodexPresetFields({
  model,
  options,
  fields,
  onChange,
}: {
  model: ProviderModel | null;
  options: ProviderPresetOptions | null;
  fields: Record<string, string>;
  onChange: (field: "reasoningEffort" | "serviceTier", value: string) => void;
}) {
  const capabilities = model?.presetCapabilities;
  const levels = capabilities?.reasoningEfforts ?? [];
  const tiers = capabilities?.serviceTiers ?? [];
  const effort = options?.reasoningEffort ?? "";
  const speed = options?.serviceTier ?? "";
  const selectedLevel = levels.find(({ id }) => id === effort);
  const selectedTier = tiers.find(({ id }) => id === speed);
  const hasTiers = tiers.length > 0;
  const showEffort = levels.length > 0 || effort !== "";
  const showSpeed = hasTiers || speed !== "";
  const missingLevel = effort !== "" && !selectedLevel;
  const missingTier = speed !== "" && !selectedTier && !(speed === "default" && hasTiers);
  const thinkingError = fields["providerOptions.reasoningEffort"] ?? (
    model && missingLevel
      ? "This thinking level is unavailable. Choose another level or use Codex default."
      : undefined
  );
  const speedError = fields["providerOptions.serviceTier"] ?? (
    model && missingTier
      ? "This speed is unavailable. Choose another speed or use Codex default."
      : undefined
  );
  const unknownOptions = model && (!capabilities?.reasoningEfforts || !capabilities.serviceTiers);
  const layout = showEffort && showSpeed ? `${styles.codexOptions} ${styles.twoColumns}` : styles.codexOptions;
  if (!showEffort && !showSpeed && !unknownOptions) return null;

  return (
    <div className={layout}>
      {showEffort && (
        <Field
          label="Thinking level"
          error={thinkingError}
          hint={effort === "ultra" && selectedLevel
            ? "Maximum reasoning. Agent delegation follows ufAI’s permissions."
            : selectedLevel?.description}
        >
          {(props) => (
            <select
              {...props}
              name="reasoningEffort"
              value={effort}
              onChange={(event) => onChange("reasoningEffort", event.target.value)}
            >
              <option value="">Codex default</option>
              {missingLevel && (
                <option value={effort} disabled>
                  {thinkingLabel(effort)}{model ? " (unavailable)" : ""}
                </option>
              )}
              {levels.map(({ id }) => (
                <option key={id} value={id}>{thinkingLabel(id)}</option>
              ))}
            </select>
          )}
        </Field>
      )}
      {showSpeed && (
        <Field label="Speed" error={speedError} hint={selectedTier?.description}>
          {(props) => (
            <select
              {...props}
              name="serviceTier"
              value={speed}
              onChange={(event) => onChange("serviceTier", event.target.value)}
            >
              <option value="">Codex default</option>
              {missingTier && (
                <option value={speed} disabled>
                  {speedLabel(speed)}{model ? " (unavailable)" : ""}
                </option>
              )}
              {hasTiers && <option value="default">Standard</option>}
              {tiers.filter(({ id }) => id !== "default").map(({ id, name }) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}
        </Field>
      )}
      {unknownOptions && (
        <p className={styles.modelStatus}>
          Use Refresh models in Providers to check for available Codex options.
        </p>
      )}
    </div>
  );
}
