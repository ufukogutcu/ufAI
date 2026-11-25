import { Appearance } from "./Appearance";
import { useEffect, useState } from "react";
import { errorMessage, request, type ProviderModel, type ProviderModelPage } from "../api";
import { Field } from "./FormField";
import { ModelCompanyField } from "./ModelCompanyField";
import { refreshOnFocus } from "../focus-refresh";
import { catalogSearch, groupModels, makerLabel } from "../model-catalog";
import styles from "../pages/Presets.module.scss";

function modelOption(model: ProviderModel) {
  return <option key={model.id} value={model.id}>{model.name}</option>;
}

export function ModelSelect({
  connectionId,
  refreshVersion,
  value,
  onSelect,
  onResolved,
  error,
}: {
  connectionId: string | null;
  refreshVersion?: number;
  value: string;
  onSelect: (id: string, model: ProviderModel | null) => void;
  onResolved: (model: ProviderModel | null) => void;
  error?: string;
}) {
  const [query, setQuery] = useState("");
  const [maker, setMaker] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<ProviderModelPage>({
    items: [],
    total: 0,
  });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ProviderModel | null>(null);
  const [message, setMessage] = useState("");
  const [selectedMessage, setSelectedMessage] = useState("");
  useEffect(() => refreshOnFocus(async () => setRevision((v) => v + 1)), []);
  useEffect(() => {
    const controller = new AbortController();
    setPage(current => ({ ...current, items: [], total: current.makers ? current.total : 0 }));
    setMessage("");
    if (!connectionId) return;
    setLoading(true);
    const timer = setTimeout(() => {
      void request<ProviderModelPage>(
        `/connections/${connectionId}/models?enabled=true&limit=50&offset=${offset}&${catalogSearch(query, maker)}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setPage(result);
          if (maker !== undefined && result.makers && !result.makers.includes(maker || null)) {
            setMaker(undefined);
            setOffset(0);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setMessage(errorMessage(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [connectionId, query, maker, offset, revision, refreshVersion]);
  useEffect(() => {
    const controller = new AbortController();
    setSelectedMessage("");
    if (connectionId && value)
      void request<ProviderModel>(
        `/connections/${connectionId}/models/${encodeURIComponent(value)}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((model) => {
          if (!controller.signal.aborted) {
            setSelected(model);
            onResolved(model.enabled ? model : null);
            if (!model.enabled) setSelectedMessage("This model is no longer selected in its Provider. Choose another model.");
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setSelectedMessage(errorMessage(error));
        });
    else {
      setSelected(null);
      onResolved(null);
    }
    return () => controller.abort();
  }, [connectionId, value, onResolved, revision, refreshVersion]);
  const selectedModel = selected?.id === value && selected.connectionId === connectionId
    ? selected : null;
  function resetFiltersPage() {
    setPage(current => ({ ...current, items: [], total: 0 }));
    setOffset(0);
  }
  function changeCompany(next: string | undefined) {
    setMaker(next);
    resetFiltersPage();
  }
  return (
    <div className={styles.modelPicker}>
      {!!page.makers?.length && <ModelCompanyField makers={page.makers} value={maker} onChange={changeCompany} />}
      {connectionId && (
        <Field label="Search saved models">
          {(props) => (
            <input
              {...props}
              type="search"
              autoComplete="off"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                resetFiltersPage();
              }}
              placeholder={page.makers ? "Name, ID or company…" : "Search models…"}
            />
          )}
        </Field>
      )}
      <Field label="Model" error={error}>
        {(props) => (
          <select
            {...props}
            name="modelId"
            disabled={!connectionId}
            value={value}
            onChange={(event) =>
              onSelect(
                event.target.value,
                page.items.find((m) => m.id === event.target.value) ?? null,
              )
            }
          >
            <option value="">None</option>
            {value && !page.items.some((m) => m.id === value) && (
              <option value={value} disabled={selectedModel?.enabled === false}>{selectedModel?.name ?? value}{selectedModel?.enabled === false ? " (unselected)" : ""}</option>
            )}
            {page.makers ? groupModels(page.items).map(group => (
              <optgroup key={group.maker ?? ""} label={makerLabel(group.maker)}>
                {group.models.map(modelOption)}
              </optgroup>
            )) : page.items.map(modelOption)}
          </select>
        )}
      </Field>
      {page.makers && !loading && !message && !page.items.length && (query || maker !== undefined) && (
        <p className={styles.modelStatus} role="status">No matching models.</p>
      )}
      {connectionId && page.total > 50 && (
        <div className={styles.inlineActions}>
          <button
            type="button"
            className="textButton"
            disabled={offset === 0}
            onClick={() => setOffset((v) => Math.max(0, v - 50))}
          >
            Previous models
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 50, page.total)} of {page.total}
          </span>
          <button
            type="button"
            className="textButton"
            disabled={offset + 50 >= page.total}
            onClick={() => setOffset((v) => v + 50)}
          >
            Next models
          </button>
        </div>
      )}
      {(message || selectedMessage) && (
        <Appearance kind="fade"><p className="fieldError" role="status">
          {message || selectedMessage}
        </p></Appearance>
      )}
    </div>
  );
}
