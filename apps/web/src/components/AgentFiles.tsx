import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Copy, Download, File, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { request, errorMessage } from "../api";
import { useAgentFiles } from "../use-agent-files";
import { Tooltip } from "./Tooltip";
import styles from "./AgentFiles.module.scss";

const modified = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const sizes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function fileSize(bytes: number) {
  if (bytes < 1024) return `${sizes.format(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${sizes.format(size)} ${units[unit]}`;
}

export function AgentFiles({ agentId }: { agentId: string }) {
  const { path, offset, location, listing, busy, error, refresh, navigate, paginate } = useAgentFiles(agentId);
  const [action, setAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [status, setStatus] = useState("");
  const [showPath, setShowPath] = useState(false);
  const acting = useRef<AbortController | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const breadcrumbs = useRef<HTMLElement | null>(null);
  const parts = path ? path.split("/") : [];
  const absolute = location?.path ? location.path + (path ? (location.path.includes("\\") ? "\\" + parts.join("\\") : "/" + path) : "") : "";
  const ready = location?.state === "ready";

  useEffect(() => {
    setAction(""); setActionError(""); setStatus(""); setShowPath(false);
    if (content.current) content.current.scrollTop = 0;
    return () => acting.current?.abort();
  }, [agentId, path, offset]);

  useEffect(() => {
    if (breadcrumbs.current) breadcrumbs.current.scrollLeft = breadcrumbs.current.scrollWidth;
  }, [path]);

  async function run(kind: "open" | "repair" | "copy") {
    if (acting.current && !acting.current.signal.aborted) return;
    const controller = new AbortController();
    acting.current = controller;
    setAction(kind); setActionError(""); setStatus("");
    try {
      if (kind === "copy") {
        await navigator.clipboard.writeText(absolute);
        if (!controller.signal.aborted) setStatus("Path copied.");
      } else if (kind === "open") {
        await request(`/agents/${agentId}/files/open`, "POST", { path }, controller.signal);
        if (!controller.signal.aborted) setStatus("Folder sent to your file manager.");
      } else {
        await request(`/locations/agent/${agentId}/repair`, "POST", undefined, controller.signal);
        if (!controller.signal.aborted) await refresh();
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setActionError(kind === "copy" ? "Copy is unavailable. Select and copy the path below." : errorMessage(e));
        if (kind === "copy") setShowPath(true);
      }
    } finally {
      if (!controller.signal.aborted) { setAction(""); acting.current = null; }
    }
  }

  function go(next: string) {
    if (next === path) return;
    acting.current?.abort();
    navigate(next);
  }

  return (
    <section className={styles.browser} aria-label="Agent files">
      <div className={styles.toolbar}>
        <div className={styles.actions}>
          <Tooltip content="Up one folder"><button type="button" className="iconButton" aria-label="Up one folder" disabled={!path} onClick={() => go(parts.slice(0, -1).join("/"))}><ArrowUp size={16} aria-hidden="true" /></button></Tooltip>
          <Tooltip content="Refresh files"><button type="button" className="iconButton" aria-label="Refresh files" disabled={busy || action === "repair"} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" /></button></Tooltip>
          <Tooltip content="Copy folder path"><button type="button" className="iconButton" aria-label="Copy folder path" disabled={!absolute || !!action} onClick={() => void run("copy")}><Copy size={16} aria-hidden="true" /></button></Tooltip>
          <Tooltip content="Open in file manager"><button type="button" className="iconButton" aria-label="Open in file manager" aria-busy={action === "open"} disabled={!ready || !!action} onClick={() => void run("open")}><FolderOpen size={16} aria-hidden="true" /></button></Tooltip>
        </div>
        {!!parts.length && <nav ref={breadcrumbs} className={styles.breadcrumbs} aria-label="File location">
          {parts.map((part, index) => <span key={parts.slice(0, index + 1).join("/")}>
            {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
            <button type="button" aria-current={index === parts.length - 1 ? "location" : undefined} onClick={() => go(parts.slice(0, index + 1).join("/"))}>{part}</button>
          </span>)}
        </nav>}
      </div>
      <div ref={content} className={styles.content} aria-busy={busy}>
        <p className={styles.status} role="status">{busy ? "Loading files…" : location?.state === "pending" ? "Creating folder…" : action === "open" ? "Opening folder…" : status}</p>
        {actionError && <p className="error" role="alert">{actionError}</p>}
        {showPath && <code className={styles.path} tabIndex={0}>{absolute}</code>}
        {(error || location?.state === "error") && <div className={styles.feedback}>
          <p className="error" role="alert">{error || location?.error || "The agent's files folder is unavailable."}</p>
          <button type="button" className="textButton" disabled={busy} onClick={() => void refresh()}>Retry</button>
          {(location?.state === "error" || (location && !path)) && <button type="button" className="textButton" disabled={busy || !!action} onClick={() => void run("repair")}>{action === "repair" ? "Retrying…" : "Retry folder setup"}</button>}
        </div>}
        {!error && ready && listing && <>
          {!listing.total ? <p className={styles.empty}>This folder is empty.</p> : <ul className={styles.entries} aria-label="Files and folders">
            {listing.items.map(entry => {
              const Icon = entry.kind === "directory" ? Folder : File;
              const description = entry.kind === "unavailable"
                ? "Unavailable · link, special file, or inaccessible entry"
                : [entry.kind === "directory" ? "Folder" : fileSize(entry.size ?? 0),
                  entry.modifiedAt ? `Modified ${modified.format(new Date(entry.modifiedAt))}` : ""].filter(Boolean).join("\n");
              const tooltip = `${entry.name}\n${description}`;
              const details = <>
                <Icon size={16} aria-hidden="true" />
                <span className={styles.name}>{entry.name}</span>
                {entry.kind !== "directory" && <span className={styles.metadata}>{entry.kind === "unavailable" ? "Unavailable" : fileSize(entry.size ?? 0)}</span>}
                {entry.kind === "file" && <Download size={14} aria-hidden="true" />}
              </>;
              return <li key={entry.path}>
                <Tooltip content={tooltip} multiline>{entry.kind === "directory" ? <button type="button" className={styles.entry} onClick={() => go(entry.path)}>{details}</button>
                  : entry.kind === "file" ? <a className={styles.entry} href={`/api/agents/${agentId}/files/download?${new URLSearchParams({ path: entry.path })}`} download={entry.name} aria-label={`Download ${entry.name}`}>{details}</a>
                  : <div className={`${styles.entry} ${styles.unavailable}`} role="group" tabIndex={0} aria-label={`${entry.name}: ${description}`}>{details}</div>}</Tooltip>
              </li>;
            })}
          </ul>}
          {listing.total > 100 && <div className={styles.pagination}>
            <button type="button" className="textButton" disabled={busy || !offset} onClick={() => paginate(Math.max(0, offset - 100))}>Previous</button>
            <span>{Math.min(offset + 1, listing.total)}–{Math.min(offset + 100, listing.total)} of {listing.total}</span>
            <button type="button" className="textButton" disabled={busy || offset + 100 >= listing.total} onClick={() => paginate(offset + 100)}>Next</button>
          </div>}
          {!listing.items.length && listing.total > 0 && <button type="button" className="textButton" onClick={() => paginate(0)}>Back to first page</button>}
        </>}
      </div>
    </section>
  );
}
