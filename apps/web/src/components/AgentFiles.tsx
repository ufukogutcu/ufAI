import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowUp, ChevronRight, Copy, Download, File, Folder, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { request, errorMessage } from "../api";
import { useAgentFiles } from "../use-agent-files";
import type { AgentFileEntry } from "../../../server/src/contracts";
import { ContextMenu, type ContextMenuAnchor, type ContextMenuItem } from "./ContextMenu";
import { Dialog } from "./Dialog";
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
  const [copyFallback, setCopyFallback] = useState("");
  const [menu, setMenu] = useState<{ entry: AgentFileEntry; anchor: ContextMenuAnchor } | null>(null);
  const [deleting, setDeleting] = useState<AgentFileEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteRequest = useRef(false);
  const mounted = useRef(true);
  const focusAfterDelete = useRef<{ path: string; index: number } | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const acting = useRef<AbortController | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const breadcrumbs = useRef<HTMLElement | null>(null);
  const parts = path ? path.split("/") : [];
  function absolutePath(relative: string) {
    if (!location?.path) return "";
    const separator = location.path.includes("\\") ? "\\" : "/";
    return location.path + (relative ? separator + relative.split("/").join(separator) : "");
  }
  const absolute = absolutePath(path);
  const ready = location?.state === "ready";

  useEffect(() => {
    setAction(""); setActionError(""); setStatus(""); setCopyFallback(""); setMenu(null);
    if (content.current) content.current.scrollTop = 0;
    return () => acting.current?.abort();
  }, [agentId, path, offset]);

  useEffect(() => {
    if (breadcrumbs.current) breadcrumbs.current.scrollLeft = breadcrumbs.current.scrollWidth;
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => { if (busy) setMenu(null); }, [busy]);

  useLayoutEffect(() => {
    const pending = focusAfterDelete.current;
    if (!pending || busy || pending.path !== path) return;
    if (error) {
      focusAfterDelete.current = null;
      refreshButton.current?.focus();
      return;
    }
    if (!listing) return;
    if (!listing.items.length && offset > 0) {
      paginate(Math.max(0, offset - 100));
      return;
    }
    focusAfterDelete.current = null;
    const rows = content.current?.querySelectorAll<HTMLElement>("[data-file-entry]");
    (rows?.[Math.min(pending.index, rows.length - 1)] ?? refreshButton.current)?.focus();
  }, [busy, error, listing, offset, paginate, path]);

  async function run(kind: "open" | "repair" | "copy", targetPath = path, copyValue = absolute, copyLabel = "Path") {
    if (acting.current && !acting.current.signal.aborted) return;
    const controller = new AbortController();
    acting.current = controller;
    setAction(kind); setActionError(""); setStatus(""); setCopyFallback("");
    try {
      if (kind === "copy") {
        await navigator.clipboard.writeText(copyValue);
        if (!controller.signal.aborted) setStatus(`${copyLabel} copied.`);
      } else if (kind === "open") {
        await request(`/agents/${agentId}/files/open`, "POST", { path: targetPath }, controller.signal);
        if (!controller.signal.aborted) setStatus("Folder sent to your file manager.");
      } else {
        await request(`/locations/agent/${agentId}/repair`, "POST", undefined, controller.signal);
        if (!controller.signal.aborted) await refresh();
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setActionError(kind === "copy" ? "Copy is unavailable. Select and copy the text below." : errorMessage(e));
        if (kind === "copy") setCopyFallback(copyValue);
      }
    } finally {
      if (!controller.signal.aborted) { setAction(""); acting.current = null; }
    }
  }

  function go(next: string) {
    if (next === path) return;
    acting.current?.abort();
    setMenu(null);
    navigate(next);
  }

  function openMenu(entry: AgentFileEntry, trigger: HTMLElement, x: number, y: number) {
    if (busy || deleteBusy || deleting) return;
    trigger.focus({ preventScroll: true });
    setMenu({ entry, anchor: { x, y, returnFocus: trigger } });
  }

  function handleContextMenu(event: MouseEvent<HTMLElement>, entry: AgentFileEntry) {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu(entry, event.currentTarget, event.clientX || rect.left, event.clientY || rect.bottom);
  }

  function handleEntryKeyDown(event: KeyboardEvent<HTMLElement>, entry: AgentFileEntry) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu(entry, event.currentTarget, rect.left, rect.bottom);
  }

  function beginDelete(entry: AgentFileEntry) {
    setDeleteError(""); setDeleting(entry);
  }

  async function deleteEntry() {
    if (!deleting || deleteRequest.current) return;
    deleteRequest.current = true;
    setDeleteBusy(true); setDeleteError("");
    const entry = deleting;
    try {
      await request(`/agents/${agentId}/files`, "DELETE", {
        path: entry.path, expectedKind: entry.kind, confirmFilesDeletion: true,
      });
      if (!mounted.current) return;
      focusAfterDelete.current = { path, index: Math.max(0, listing?.items.findIndex(item => item.path === entry.path) ?? 0) };
      setDeleting(null);
      setStatus(`${entry.kind === "directory" ? "Folder" : "File"} deleted.`);
      await refresh();
    } catch (failure) {
      if (mounted.current) setDeleteError(errorMessage(failure));
    } finally {
      deleteRequest.current = false;
      if (mounted.current) setDeleteBusy(false);
    }
  }

  const menuItems: ContextMenuItem[] = [];
  if (menu) {
    const entry = menu.entry;
    const disabled = !!action;
    if (entry.kind === "file") menuItems.push({ id: "download", label: "Download", icon: <Download size={16} />,
      href: `/api/agents/${agentId}/files/download?${new URLSearchParams({ path: entry.path })}`, download: entry.name, disabled });
    if (entry.kind === "directory") menuItems.push(
      { id: "open", label: "Open", icon: <FolderOpen size={16} />, onSelect: () => go(entry.path), disabled },
      { id: "file-manager", label: "Open in file manager", icon: <Folder size={16} />, onSelect: () => void run("open", entry.path), disabled });
    menuItems.push(
      { id: "copy-path", label: "Copy path", icon: <Copy size={16} />, onSelect: () => void run("copy", entry.path, absolutePath(entry.path)), disabled: disabled || !absolutePath(entry.path) },
      { id: "copy-name", label: "Copy name", icon: <Copy size={16} />, onSelect: () => void run("copy", entry.path, entry.name, "Name"), disabled });
    if (entry.kind !== "unavailable") menuItems.push({ id: "delete-separator", separator: true },
      { id: "delete", label: "Delete…", icon: <Trash2 size={16} />, destructive: true, onSelect: () => beginDelete(entry), disabled });
  }

  return (
    <section className={styles.browser} aria-label="Agent files">
      <div className={styles.toolbar}>
        <div className={styles.actions}>
          <Tooltip content="Up one folder"><button type="button" className="iconButton" aria-label="Up one folder" disabled={!path} onClick={() => go(parts.slice(0, -1).join("/"))}><ArrowUp size={16} aria-hidden="true" /></button></Tooltip>
          <Tooltip content="Refresh files"><button type="button" className="iconButton" aria-label="Refresh files" ref={refreshButton} disabled={busy || action === "repair"} onClick={() => { setMenu(null); void refresh(); }}><RefreshCw size={16} aria-hidden="true" /></button></Tooltip>
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
        {copyFallback && <code className={styles.path} tabIndex={0}>{copyFallback}</code>}
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
              const rowProps = {
                "data-file-entry": entry.path,
                "aria-haspopup": "menu" as const,
                "aria-expanded": menu?.entry.path === entry.path,
                onContextMenu: (event: MouseEvent<HTMLElement>) => handleContextMenu(event, entry),
                onKeyDown: (event: KeyboardEvent<HTMLElement>) => handleEntryKeyDown(event, entry),
              };
              return <li key={entry.path}>
                <Tooltip content={menu?.entry.path === entry.path ? "" : tooltip} multiline>{entry.kind === "directory" ? <button {...rowProps} type="button" className={styles.entry} onClick={() => go(entry.path)}>{details}</button>
                  : entry.kind === "file" ? <a {...rowProps} className={styles.entry} href={`/api/agents/${agentId}/files/download?${new URLSearchParams({ path: entry.path })}`} download={entry.name} aria-label={`Download ${entry.name}`}>{details}</a>
                  : <div {...rowProps} className={`${styles.entry} ${styles.unavailable}`} role="group" tabIndex={0} aria-label={`${entry.name}: ${description}`}>{details}</div>}</Tooltip>
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
      {menu && <ContextMenu anchor={menu.anchor} label={`Actions for ${menu.entry.name}`} items={menuItems} onClose={closeMenu} />}
      {deleting && <Dialog title={deleting.kind === "directory" ? "Delete folder?" : "Delete file?"}
        busy={deleteBusy} initialFocusSelector="[data-cancel-delete]" onClose={() => setDeleting(null)}>
        <p className={styles.confirmation}>Permanently delete <strong>{deleting.name}</strong>{deleting.kind === "directory" ? " and all its contents" : ""}? This cannot be undone.</p>
        <p>Published files are kept.</p>
        {deleteError && <p className="error" role="alert">{deleteError}{deleting.kind === "directory" && " Folder deletion may have removed some contents. Refresh after cancelling to check what remains."}</p>}
        {deleteBusy && <p role="status">Deleting{deleting.kind === "directory" ? " folder and contents" : " file"}…</p>}
        <div className={styles.confirmationActions}>
          <button type="button" className="button" data-cancel-delete disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</button>
          <button type="button" className="button danger" disabled={deleteBusy} onClick={() => void deleteEntry()}>{deleteBusy ? "Deleting…" : "Delete permanently"}</button>
        </div>
      </Dialog>}
    </section>
  );
}
