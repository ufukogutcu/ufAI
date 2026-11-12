import { Appearance } from "./Appearance";
import { useEffect, useState } from "react";
import { errorMessage, request, type ProviderModel } from "../api";
import { Field } from "./FormField";
import { refreshOnFocus } from "../focus-refresh";
import styles from "../pages/Presets.module.scss";
export function ModelSelect({
  connectionId,
  value,
  onSelect,
  onResolved,
  error,
}: {
  connectionId: string | null;
  value: string;
  onSelect: (id: string, model: ProviderModel | null) => void;
  onResolved: (model: ProviderModel | null) => void;
  error?: string;
}) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<{ items: ProviderModel[]; total: number }>({
    items: [],
    total: 0,
  });
  const [selected, setSelected] = useState<ProviderModel | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => refreshOnFocus(async () => setRevision((v) => v + 1)), []);
  useEffect(() => {
    const controller = new AbortController();
    setPage({ items: [], total: 0 });
    setMessage("");
    if (!connectionId) return;
    const timer = setTimeout(() => {
      void request<{ items: ProviderModel[]; total: number }>(
        `/connections/${connectionId}/models?limit=50&offset=${offset}&q=${encodeURIComponent(query)}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setPage(result);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setMessage(errorMessage(error));
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [connectionId, query, offset, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setSelected(null);
    onResolved(null);
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
            onResolved(model);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setMessage(errorMessage(error));
        });
    return () => controller.abort();
  }, [connectionId, value, onResolved, revision]);
  return (
    <div className={styles.modelPicker}>
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
                setOffset(0);
              }}
              placeholder="Search models…"
            />
          )}
        </Field>
      )}
      <Field label="Model" error={error}>
        {(props) => (
          <select
            {...props}
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
              <option value={value}>{selected?.name ?? value}</option>
            )}
            {page.items.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        )}
      </Field>
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
      {message && (
        <Appearance kind="fade"><p className="fieldError" role="status">
          {message}
        </p></Appearance>
      )}
    </div>
  );
}
