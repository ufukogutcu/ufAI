import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Copy, Ellipsis, Pencil, Trash2 } from "lucide-react";
import { ContextMenu, type ContextMenuAnchor } from "./ContextMenu";
import styles from "./LibraryRow.module.scss";

export function LibraryRow({ name, selected, className, onEdit, onDuplicate, onDelete, onAnimationEnd, children }: {
  name: string;
  selected: boolean;
  className: string;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAnimationEnd: () => void;
  children: ReactNode;
}) {
  const primary = useRef<HTMLButtonElement>(null);
  const overflow = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const label = `Actions for ${name}`;
  function open(button: HTMLButtonElement, x?: number, y?: number) {
    const bounds = button.getBoundingClientRect();
    button.focus({ preventScroll: true });
    setAnchor({ x: x ?? bounds.left, y: y ?? bounds.bottom, returnFocus: button, toggle: button === overflow.current });
  }
  function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const button = overflow.current?.contains(event.target as Node) ? overflow.current : primary.current;
    if (button) open(button, event.clientX || undefined, event.clientY || undefined);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    open(event.currentTarget);
  }
  return <div className={styles.row} onContextMenu={handleContextMenu} onAnimationEnd={onAnimationEnd}>
    <button type="button" ref={primary} className={className}
      aria-current={selected || undefined} aria-haspopup="menu" aria-expanded={!!anchor && anchor.returnFocus === primary.current}
      onClick={onEdit} onKeyDown={handleKeyDown}>
      {children}
    </button>
    <button type="button" ref={overflow} className={`iconButton ${styles.overflow}`} aria-label={label}
      aria-haspopup="menu" aria-expanded={!!anchor && anchor.returnFocus === overflow.current}
      onClick={event => anchor?.returnFocus === event.currentTarget ? close() : open(event.currentTarget)}
      onKeyDown={handleKeyDown}>
      <Ellipsis size={17} aria-hidden="true" />
    </button>
    {anchor && <ContextMenu anchor={anchor} label={label} onClose={close} items={[
      { id: "edit", label: "Edit", icon: <Pencil size={16} />, onSelect: onEdit },
      { id: "duplicate", label: "Duplicate…", icon: <Copy size={16} />, onSelect: onDuplicate },
      { id: "separator", separator: true },
      { id: "delete", label: "Delete…", icon: <Trash2 size={16} />, destructive: true, onSelect: onDelete },
    ]} />}
  </div>;
}
