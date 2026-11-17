import { memo, useCallback, useEffect, useRef, useState, type PointerEvent, type MouseEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import { Workflow } from "lucide-react";
import type { Workspace } from "../../../server/src/contracts";
import type { ContextMenuAnchor } from "./ContextMenu";
import { WorkspaceTab } from "./WorkspaceTab";
import homeStyles from "../pages/Home.module.scss";
import styles from "./WorkspaceTabs.module.scss";

type TabGeometry = { id: string; element: HTMLElement; left: number; width: number };
type Drag = {
  pointerId: number; source: TabGeometry; tabs: TabGeometry[]; bounds: DOMRect; gap: number;
  startX: number; startY: number; x: number; y: number; scroll: number; index: number;
  active: boolean; threshold: number; time: number;
};
export type WorkspaceMove = (id: string, relativeToId: string, placement: "before" | "after") => Promise<boolean>;

/** Pointer frames change only local presentation; durable order changes once on release. */
export const WorkspaceTabs = memo(function WorkspaceTabs({ tabs, activeId, menuId, disabled, onSelect, onMenu, onMove }: {
  tabs: Workspace[]; activeId: string | null; menuId?: string; disabled: boolean;
  onSelect: (id: string) => void; onMenu: (workspace: Workspace, anchor: ContextMenuAnchor) => void;
  onMove: WorkspaceMove;
}) {
  const list = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const overlayName = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const suppressClick = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  const reset = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (overlay.current) overlay.current.hidden = true;
    list.current?.removeAttribute("data-dragging");
    for (const tab of current?.tabs ?? []) {
      tab.element.style.removeProperty("--tab-shift");
      tab.element.removeAttribute("data-drag-source");
    }
    if (current?.source.element.hasPointerCapture?.(current.pointerId))
      current.source.element.releasePointerCapture(current.pointerId);
  }, []);

  function visualPositions(current: Drag) {
    return new Map(current.tabs.map(tab => [tab.id,
      tab.id === current.source.id && overlay.current && current.active
        ? overlay.current.getBoundingClientRect() : tab.element.getBoundingClientRect()]));
  }
  function settle(previous: Map<string, DOMRect>) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const element of list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []) {
      const before = previous.get(element.id.slice(4));
      if (!before) continue;
      const after = element.getBoundingClientRect();
      const x = before.left - after.left, y = before.top - after.top;
      if (Math.abs(x) + Math.abs(y) > 0.5) element.animate?.([
        { transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" },
      ], { duration: 150, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
  }
  function cancel() {
    const current = drag.current;
    const previous = current?.active ? visualPositions(current) : undefined;
    reset();
    if (previous) settle(previous);
  }

  useEffect(() => {
    // A changed list or disabled state invalidates the measured geometry.
    reset();
    const container = list.current;
    if (!container) return;
    const invalidate = () => reset();
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) { event.preventDefault(); reset(); }
    };
    const observer = new ResizeObserver(() => {
      const current = drag.current;
      if (!current) return;
      const bounds = container.getBoundingClientRect();
      if (bounds.width !== current.bounds.width || bounds.left !== current.bounds.left || bounds.top !== current.bounds.top
        || current.tabs.some(tab => tab.element.offsetWidth !== Math.round(tab.width))) reset();
    });
    observer.observe(container);
    for (const tab of container.children) observer.observe(tab);
    window.addEventListener("resize", invalidate);
    window.addEventListener("blur", invalidate);
    document.addEventListener("keydown", escape);
    return () => {
      reset(); observer.disconnect();
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("blur", invalidate);
      document.removeEventListener("keydown", escape);
    };
  }, [tabs, disabled, reset]);

  useEffect(() => {
    const container = list.current;
    const selected = container?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!container || !selected) return;
    let revealFrame = 0;
    function reveal() {
      if (drag.current) return;
      const bounds = container!.getBoundingClientRect(), tab = selected!.getBoundingClientRect();
      if (tab.left < bounds.left) container!.scrollLeft -= bounds.left - tab.left;
      else if (tab.right > bounds.right) container!.scrollLeft += tab.right - bounds.right;
    }
    function schedule() { cancelAnimationFrame(revealFrame); revealFrame = requestAnimationFrame(reveal); }
    const observer = new ResizeObserver(schedule);
    observer.observe(container); observer.observe(selected); schedule();
    return () => { cancelAnimationFrame(revealFrame); observer.disconnect(); };
  }, [activeId, tabs.length]);

  function paint(time: number) {
    const current = drag.current, container = list.current, floating = overlay.current;
    if (!current?.active || !container || !floating) return;
    const elapsed = current.time ? Math.min(time - current.time, 32) / 1000 : 0;
    current.time = time;
    const edge = Math.min(40, current.bounds.width / 4);
    const velocity = current.x < current.bounds.left + edge
      ? -Math.min(1, (current.bounds.left + edge - current.x) / edge)
      : current.x > current.bounds.right - edge ? Math.min(1, (current.x - current.bounds.right + edge) / edge) : 0;
    container.scrollLeft += velocity * 650 * elapsed;
    const delta = current.x - current.startX + container.scrollLeft - current.scroll;
    const center = current.source.left + delta + current.source.width / 2;
    const others = current.tabs.filter(tab => tab.id !== current.source.id);
    const index = others.filter(tab => center > tab.left + tab.width / 2).length;
    if (index !== current.index) {
      current.index = index;
      const ordered = [...others];
      ordered.splice(index, 0, current.source);
      let left = current.tabs[0]!.left;
      for (const tab of ordered) {
        tab.element.style.setProperty("--tab-shift", `${left - tab.left}px`);
        left += tab.width + current.gap;
      }
    }
    floating.style.transform = `translate(${current.bounds.left + current.source.left - current.scroll + current.x - current.startX}px, ${current.bounds.top + current.y - current.startY}px)`;
    frame.current = requestAnimationFrame(paint);
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    suppressClick.current = false;
    if (disabled || tabs.length < 2) return;
    const target = (event.target as Element).closest<HTMLElement>('[role="tab"]');
    const container = list.current;
    if (!target || !container) return;
    for (const tab of container.children) (tab as HTMLElement).getAnimations?.().forEach(animation => animation.cancel());
    const bounds = container.getBoundingClientRect();
    const geometry = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map(element => {
      const rect = element.getBoundingClientRect();
      return { id: element.id.slice(4), element, left: rect.left - bounds.left + container.scrollLeft, width: rect.width };
    });
    const source = geometry.find(tab => tab.element === target);
    if (!source) return;
    drag.current = { pointerId: event.pointerId, source, tabs: geometry, bounds,
      gap: parseFloat(getComputedStyle(container).columnGap) || 0, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, scroll: container.scrollLeft, index: geometry.indexOf(source),
      active: false, threshold: event.pointerType === "touch" ? 10 : 6, time: 0 };
    target.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    if (!current.active) {
      if (Math.abs(current.x - current.startX) < current.threshold) return;
      current.active = true;
      suppressClick.current = true;
      list.current!.setAttribute("data-dragging", "true");
      current.source.element.setAttribute("data-drag-source", "true");
      const floating = overlay.current!;
      floating.className = `${homeStyles.tab} ${styles.overlay} ${current.source.element.getAttribute("aria-selected") === "true" ? homeStyles.active : ""}`;
      floating.style.width = `${current.source.width}px`;
      floating.style.height = `${current.source.element.getBoundingClientRect().height}px`;
      overlayName.current!.textContent = tabs.find(tab => tab.id === current.source.id)!.name;
      floating.hidden = false;
      paint(performance.now());
    }
    event.preventDefault();
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.active) { reset(); return; }
    current.x = event.clientX; current.y = event.clientY;
    cancelAnimationFrame(frame.current);
    paint(performance.now());
    const others = current.tabs.filter(tab => tab.id !== current.source.id);
    const relative = others[Math.min(current.index, others.length - 1)];
    const placement = current.index === others.length ? "after" : "before";
    const previous = visualPositions(current);
    const moved = current.index !== current.tabs.indexOf(current.source)
      && current.y >= current.bounds.top - 32 && current.y <= current.bounds.bottom + 32;
    reset();
    if (moved && relative) {
      const name = tabs.find(tab => tab.id === current.source.id)!.name;
      flushSync(() => {
        void onMove(current.source.id, relative.id, placement).then(saved => {
          setAnnouncement(saved ? `${name} moved to position ${current.index + 1}.` : `Could not save the position of ${name}.`);
        });
      });
    }
    settle(previous);
  }
  function clickCapture(event: MouseEvent) {
    if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); }
    suppressClick.current = false;
  }
  return <>
    <div ref={list} className={`${homeStyles.tabs} ${styles.tabs}`} role="tablist" aria-label="Workspaces"
      data-reorder-disabled={disabled || tabs.length < 2 || undefined}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
      onPointerCancel={cancel} onLostPointerCapture={cancel} onClickCapture={clickCapture}
      onContextMenuCapture={cancel} onDragStart={event => event.preventDefault()}>
      {tabs.map(workspace => <WorkspaceTab key={workspace.id} workspace={workspace} activeId={activeId}
        tabs={tabs} onSelect={onSelect} onMenu={onMenu} menuOpen={menuId === workspace.id} />)}
    </div>
    <span className={styles.srOnly} role="status" aria-live="polite">{announcement}</span>
    {createPortal(<div ref={overlay} hidden aria-hidden="true" className={`${homeStyles.tab} ${styles.overlay}`}>
      <Workflow size={14} /><span ref={overlayName} />
    </div>, document.body)}
  </>;
});
