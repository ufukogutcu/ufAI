import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GlassMaterial } from "./GlassMaterial";
import { Appearance } from "./Appearance";
import styles from "./ContextMenu.module.scss";

export interface ContextMenuAnchor {
  x: number;
  y: number;
  returnFocus: HTMLElement;
}
export type ContextMenuDismissal = "escape" | "tab" | "outside" | "action" | "invalidated";
export type ContextMenuItem = { id: string; separator: true } | {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
} & ({ onSelect: () => void; href?: never; download?: never } | { href: string; download?: string; onSelect?: never });

/** File-agnostic, controlled menu. The caller owns trigger events and application actions. */
export function ContextMenu({ anchor, label, items, onClose }: {
  anchor: ContextMenuAnchor;
  label: string;
  items: ContextMenuItem[];
  onClose: (reason: ContextMenuDismissal) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusedAnchor = useRef<ContextMenuAnchor | null>(null);
  const closing = useRef(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const host = anchor.returnFocus.closest("dialog[open]") ?? document.body;

  useLayoutEffect(() => {
    closing.current = false;
    search.current = "";
    clearTimeout(searchTimer.current);
    const element = menu.current!;
    function place() {
      const rect = element.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      setPosition({ left: Math.max(8, Math.min(anchor.x, width - rect.width - 8)),
        top: Math.max(8, Math.min(anchor.y, height - rect.height - 8)) });
    }
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor]);

  useLayoutEffect(() => {
    if (!position || focusedAnchor.current === anchor) return;
    focusedAnchor.current = anchor;
    (menu.current!.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? menu.current!)
      .focus({ preventScroll: true });
  }, [anchor, position]);

  useEffect(() => {
    const element = menu.current!;
    function close(reason: ContextMenuDismissal) {
      if (closing.current) return;
      closing.current = true;
      onClose(reason);
    }
    const outside = (event: Event) => {
      if (event.target instanceof Node && !element.contains(event.target)) close("outside");
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) close("invalidated");
    };
    const resize = () => close("invalidated");
    const observer = new MutationObserver(() => {
      if (!anchor.returnFocus.isConnected) close("invalidated");
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", resize);
    return () => {
      observer.disconnect();
      clearTimeout(searchTimer.current);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", resize);
    };
  }, [anchor, onClose]);

  function dismiss(reason: ContextMenuDismissal, restore = true) {
    if (closing.current) return;
    closing.current = true;
    onClose(reason);
    if (restore && anchor.returnFocus.isConnected) anchor.returnFocus.focus({ preventScroll: true });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // React portal events still bubble to the owning panel/canvas.
    event.stopPropagation();
    const enabled = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
    const index = enabled.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault(); dismiss("escape");
    } else if (event.key === "Tab") {
      event.preventDefault();
      const controls = [...host.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest('[inert], [hidden]') &&
          !menu.current!.contains(element) && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden");
      const next = controls[(controls.indexOf(anchor.returnFocus) + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
      dismiss("tab", false);
      (next ?? anchor.returnFocus).focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 :
        (index + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      enabled[index]?.click();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      clearTimeout(searchTimer.current);
      search.current += event.key.toLocaleLowerCase();
      const query = [...search.current].every(letter => letter === search.current[0]) ? search.current[0]! : search.current;
      const ordered = [...enabled.slice(index + 1), ...enabled.slice(0, index + 1)];
      ordered.find(element => element.textContent?.trim().toLocaleLowerCase().startsWith(query))?.focus();
      searchTimer.current = setTimeout(() => { search.current = ""; }, 500);
    }
  }

  return createPortal(<Appearance kind="fade" ready={!!position}>
    <div ref={menu} role="menu" aria-label={label} tabIndex={-1}
      className={`${styles.menu} glassSurface nodrag nopan ${position ? "" : styles.measuring}`}
      style={position ?? undefined} onKeyDown={handleKeyDown} onContextMenu={event => event.preventDefault()}
      onClick={event => event.stopPropagation()}>
      <GlassMaterial appearance="regular" />
      <div className={styles.items}>
        {items.map(item => {
          if ("separator" in item) return <div key={item.id} role="separator" className={styles.separator} />;
          const common = {
            role: "menuitem", tabIndex: -1, "aria-disabled": item.disabled || undefined,
            className: `${styles.item} ${item.destructive ? styles.destructive : ""}`,
            onPointerMove: (event: PointerEvent<HTMLElement>) => { if (!item.disabled && event.pointerType === "mouse") event.currentTarget.focus({ preventScroll: true }); },
            onClick: (event: MouseEvent<HTMLElement>) => {
              if (item.disabled) { event.preventDefault(); return; }
              dismiss("action");
              item.onSelect?.();
            },
          };
          const content = <>{item.icon && <span className={styles.icon} aria-hidden="true">{item.icon}</span>}<span>{item.label}</span></>;
          return item.href !== undefined ? <a key={item.id} {...common} href={item.disabled ? undefined : item.href} download={item.download}>{content}</a> :
            <button key={item.id} {...common} type="button">{content}</button>;
        })}
      </div>
    </div>
  </Appearance>, host);
}
