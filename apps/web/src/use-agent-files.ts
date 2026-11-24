import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentFileListing, ManagedLocation } from "../../server/src/contracts";
import { errorMessage, request } from "./api";
import { refreshOnFocus } from "./focus-refresh";

/** Panel-local reads: each navigation or refresh supersedes the previous request. */
export function useWorkingFiles(kind: "agent" | "workspace", ownerId: string) {
  const base = `/${kind === "agent" ? "agents" : "workspaces"}/${encodeURIComponent(ownerId)}`;
  const [path, setPath] = useState("");
  const [offset, setOffset] = useState(0);
  const [location, setLocation] = useState<ManagedLocation | null>(null);
  const [page, setPage] = useState<{ base: string; offset: number; listing: AgentFileListing } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const reading = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async function load() {
    reading.current?.abort();
    clearTimeout(timer.current);
    const controller = new AbortController();
    reading.current = controller;
    setBusy(true);
    setError("");
    try {
      const value = await request<ManagedLocation>(`${base}/locations`, "GET", undefined, controller.signal);
      if (controller.signal.aborted) return;
      setLocation(value);
      if (value.state === "pending") {
        setPage(null);
        timer.current = setTimeout(() => void load(), 500);
      } else if (value.state === "error") {
        setPage(null);
      } else {
        const query = new URLSearchParams({ path, limit: "100", offset: String(offset) });
        const listing = await request<AgentFileListing>(`${base}/files?${query}`, "GET", undefined, controller.signal);
        if (!controller.signal.aborted) setPage({ base, offset, listing });
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [base, path, offset]);

  useEffect(() => {
    void refresh();
    const stopFocus = refreshOnFocus(refresh);
    return () => {
      reading.current?.abort();
      clearTimeout(timer.current);
      stopFocus();
    };
  }, [refresh]);

  function navigate(next: string) {
    // Fence completions immediately, before React commits the next effect.
    reading.current?.abort();
    clearTimeout(timer.current);
    setError("");
    setBusy(true);
    setPath(next);
    setOffset(0);
  }
  function paginate(next: number) {
    reading.current?.abort();
    setBusy(true);
    setError("");
    setOffset(next);
  }

  return {
    base, path, offset, location: location?.ownerId === ownerId && location.kind === kind ? location : null, busy, error, refresh, navigate, paginate,
    listing: page?.base === base && page.offset === offset && page.listing.path === path ? page.listing : null,
  };
}
