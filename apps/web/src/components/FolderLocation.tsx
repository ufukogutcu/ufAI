import { useEffect, useState, useCallback } from "react";
import type {
  LocationKind,
  ManagedLocation,
} from "../../../server/src/contracts";
import { useAgents, useAgentStore } from "../agent-store";
import { request, errorMessage } from "../api";
import { refreshOnFocus } from "../focus-refresh";
import styles from "./Clusters.module.scss";
const segments = {
  workspace: "workspaces",
  cluster: "clusters",
  agent: "agents",
  task: "tasks",
};
export function FolderLocation({
  kind,
  ownerId,
  label,
}: {
  kind: LocationKind;
  ownerId: string;
  label: string;
}) {
  const key = `${kind}:${ownerId}`,
    store = useAgentStore();
  const location = useAgents((s) => s.locations[key]);
  const [error, setError] = useState(""),
    [copied, setCopied] = useState(false),
    [busy, setBusy] = useState(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const value = await request<ManagedLocation>(
        `/${segments[kind]}/${ownerId}/locations`,
        "GET",
        undefined,
        signal,
      );
      if (!signal?.aborted)
        store.setState((s) => ({
          locations: { ...s.locations, [key]: value },
        }));
      return value;
    },
    [key, kind, ownerId, store],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      clearTimeout(timer);
      try {
        const value = await load(controller.signal);
        if (!controller.signal.aborted && value.state === "pending")
          timer = setTimeout(() => void refresh(), 500);
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e));
      }
    }
    void refresh();
    const unlisten = refreshOnFocus(refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      unlisten();
    };
  }, [load]);
  async function repair() {
    setBusy(true);
    setError("");
    try {
      const value = await request<ManagedLocation>(
        `/locations/${kind}/${ownerId}/repair`,
        "POST",
      );
      store.setState((s) => ({ locations: { ...s.locations, [key]: value } }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(location!.path);
      setCopied(true);
      setError("");
    } catch {
      setError("Copy is unavailable. Select and copy the path below.");
    }
  }
  return (
    <div className={styles.folder}>
      <strong>{label}</strong>
      {location?.path && <code tabIndex={0}>{location.path}</code>}
      <div className={styles.folderActions}>
        {location?.path && (
          <button
            type="button"
            className="textButton"
            onClick={() => void copy()}
          >
            Copy path
          </button>
        )}
        <span role="status">
          {copied
            ? "Path copied."
            : location?.state === "pending"
              ? "Creating folder…"
              : !location
                ? "Loading folder…"
                : ""}
        </span>
      </div>
      {(location?.state === "error" || error) && (
        <div>
          <p role="alert" className="error">
            {error || location?.error}
          </p>
          <button
            type="button"
            className="textButton"
            disabled={busy}
            onClick={() => void repair()}
          >
            {busy ? "Retrying…" : "Retry folder setup"}
          </button>
        </div>
      )}
    </div>
  );
}
