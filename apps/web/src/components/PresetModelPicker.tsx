import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { DiscoveredModel } from "../api";
import { createModelLoader, emptyDiscovery } from "../model-discovery";
import { Field } from "./FormField";
import styles from "../pages/Presets.module.scss";
export function PresetModelPicker({
  connectionId,
  value,
  error,
  onSelect,
  refreshKey,
}: {
  connectionId: string | null;
  value: string;
  error?: string;
  refreshKey: number;
  onSelect: (id: string, models: DiscoveredModel[]) => void;
}) {
  const [loader] = useState(createModelLoader);
  const [result, setResult] = useState(emptyDiscovery);
  const [revision, setRevision] = useState(0);
  const [manual, setManual] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const optionsRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open)
      optionsRef.current?.children[active]?.scrollIntoView({
        block: "nearest",
      });
  }, [active, open]);
  useEffect(
    () => loader.load(connectionId, setResult),
    [loader, connectionId, revision, refreshKey],
  );
  const state = result.connectionId === connectionId ? result : emptyDiscovery;
  const filtered = state.models
    .filter((model) =>
      `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 50);
  const selected = state.models.find((model) => model.id === value);
  const manualMode = manual || !connectionId;
  function choose(model: DiscoveredModel) {
    onSelect(model.id, state.models);
    setOpen(false);
    setQuery("");
  }
  function handleKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((current) =>
        Math.max(
          0,
          Math.min(
            filtered.length - 1,
            current + (event.key === "ArrowDown" ? 1 : -1),
          ),
        ),
      );
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      if (filtered[active]) choose(filtered[active]);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }
  return (
    <div className={styles.modelPicker}>
      <Field label={manualMode ? "Model ID" : "Model"} error={error}>
        {(props) =>
          manualMode ? (
            <input
              {...props}
              name="modelId"
              value={value}
              onChange={(event) => onSelect(event.target.value, state.models)}
              maxLength={200}
              placeholder="Enter model ID"
              spellCheck={false}
              autoComplete="off"
            />
          ) : (
            <div className={styles.combobox}>
              <input
                {...props}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listId}
                aria-activedescendant={
                  open && filtered[active] ? `${listId}-${active}` : undefined
                }
                autoComplete="off"
                value={open ? query : (selected?.name ?? value)}
                placeholder={
                  state.status === "loading"
                    ? "Loading models…"
                    : "Search models…"
                }
                onFocus={() => {
                  setQuery("");
                  setActive(0);
                  setOpen(true);
                }}
                onBlur={() => setOpen(false)}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                  setOpen(true);
                }}
                onKeyDown={handleKeys}
              />
              {open && (
                <ul
                  ref={optionsRef}
                  id={listId}
                  role="listbox"
                  aria-label="Available models"
                  className={styles.modelOptions}
                >
                  {filtered.map((model, index) => (
                    <li
                      key={model.id}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={model.id === value}
                      className={
                        index === active ? styles.modelActive : undefined
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(model)}
                    >
                      <strong>{model.name}</strong>
                      {model.name !== model.id && <small>{model.id}</small>}
                    </li>
                  ))}
                  {!filtered.length && (
                    <li role="presentation" className={styles.modelEmpty}>
                      {state.status === "loading"
                        ? "Fetching models…"
                        : "No matching models. Try another search or enter an ID manually."}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )
        }
      </Field>
      <div className={styles.inlineActions}>
        {connectionId && (
          <button
            type="button"
            className="textButton"
            onClick={() => {
              setManual(!manual);
              setOpen(false);
            }}
          >
            {manual ? "Choose from models" : "Enter model ID manually"}
          </button>
        )}
        {connectionId && (
          <button
            type="button"
            className="textButton"
            disabled={state.status === "loading"}
            onClick={() => setRevision((r) => r + 1)}
          >
            Refresh models
          </button>
        )}
      </div>
      <p className={styles.modelStatus} role="status">
        {!connectionId
          ? "Connect to browse available models, or enter an ID."
          : state.status === "error"
            ? state.error
            : state.status === "loading"
              ? "Fetching available models…"
              : state.status === "ready" && !state.models.length
                ? "No models returned. Enter a model ID manually."
                : value && !selected && state.status === "ready"
                  ? `Current model: ${value}. This ID was not returned; you can keep it.`
                  : ""}
      </p>
    </div>
  );
}
