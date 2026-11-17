import type { KeyboardEvent, MouseEvent } from "react";
import { Workflow } from "lucide-react";
import type { Workspace } from "../../../server/src/contracts";
import type { ContextMenuAnchor } from "./ContextMenu";
import styles from "../pages/Home.module.scss";

export function WorkspaceTab({ workspace, activeId, tabs, onSelect, onMenu, menuOpen }: {
  workspace: Workspace; activeId: string | null; tabs: Workspace[];
  onSelect: (id: string) => void;
  onMenu: (workspace: Workspace, anchor: ContextMenuAnchor) => void;
  menuOpen: boolean;
}) {
  function contextMenu(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault(); event.stopPropagation();
    const trigger = event.currentTarget, rect = trigger.getBoundingClientRect();
    trigger.focus({ preventScroll: true });
    onMenu(workspace, { x: event.clientX || rect.left, y: event.clientY || rect.bottom, returnFocus: trigger });
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); event.stopPropagation();
      const trigger = event.currentTarget, rect = trigger.getBoundingClientRect();
      onMenu(workspace, { x: rect.left, y: rect.bottom, returnFocus: trigger });
      return;
    }
    const index = tabs.findIndex(tab => tab.id === workspace.id);
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    const target = next === undefined ? undefined : tabs[next];
    if (target) { event.preventDefault(); onSelect(target.id); document.getElementById(`tab-${target.id}`)?.focus(); }
  }
  return <button type="button" role="tab" id={`tab-${workspace.id}`} aria-selected={workspace.id === activeId}
    aria-controls="workspace-panel" tabIndex={workspace.id === activeId ? 0 : -1}
    aria-haspopup="menu" aria-expanded={menuOpen || undefined}
    className={`${styles.tab} ${workspace.id === activeId ? styles.active : ""}`}
    onClick={() => onSelect(workspace.id)} onContextMenu={contextMenu} onKeyDown={keyDown}>
    <Workflow size={14} aria-hidden="true" /><span>{workspace.name}</span>
  </button>;
}
