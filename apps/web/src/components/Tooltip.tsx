import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import styles from "./Tooltip.module.scss";
import { Appearance } from "./Appearance";

type Placement = "top" | "right" | "bottom" | "left";
type TriggerProps = HTMLAttributes<HTMLElement> & {
  disabled?: boolean;
  ref?: Ref<HTMLElement>;
};

const opposite: Record<Placement, Placement> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};
const margin = 8;
const gap = 8;

export function Tooltip({
  content,
  placement = "top",
  hoverDelayMs = 400,
  children,
}: {
  content: string;
  placement?: Placement;
  hoverDelayMs?: number;
  children: ReactElement<TriggerProps, string>;
}) {
  const id = useId();
  const trigger = useRef<HTMLElement | null>(null);
  const tooltip = useRef<HTMLDivElement | null>(null);
  const openingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovered = useRef(false);
  const tooltipHovered = useRef(false);
  const focused = useRef(false);
  const dismissed = useRef(false);
  const [phase, setPhase] = useState<"closed" | "waiting" | "open">("closed");
  const [host, setHost] = useState<Element | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const enabled = !!content.trim() && !children.props.disabled;
  const open = enabled && phase === "open";
  const active = enabled && phase !== "closed";
  const childRef = children.props.ref;

  const attachTrigger = useCallback(
    (node: HTMLElement | null) => {
      trigger.current = node;
      const cleanup = typeof childRef === "function" ? childRef(node) : undefined;
      if (childRef && typeof childRef !== "function") childRef.current = node;
      return () => {
        trigger.current = null;
        if (typeof cleanup === "function") cleanup();
        else if (typeof childRef === "function") childRef(null);
        else if (childRef) childRef.current = null;
      };
    },
    [childRef],
  );

  const clearTimers = useCallback(() => {
    clearTimeout(openingTimer.current);
    clearTimeout(closingTimer.current);
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    tooltipHovered.current = false;
    setPhase("closed");
    setPosition(null);
  }, [clearTimers]);

  function show() {
    if (!enabled || dismissed.current || !trigger.current?.isConnected) return;
    clearTimers();
    setHost(trigger.current.closest("dialog[open]") ?? document.body);
    setPhase("open");
  }

  function scheduleClose() {
    clearTimeout(openingTimer.current);
    clearTimeout(closingTimer.current);
    if (!focused.current && !hovered.current && !tooltipHovered.current) {
      closingTimer.current = setTimeout(hide, 120);
    }
  }

  function dismiss() {
    dismissed.current = true;
    hide();
  }

  useEffect(() => {
    hide();
    dismissed.current = false;
    return clearTimers;
  }, [content, enabled, hide, clearTimers]);

  useEffect(() => {
    if (!active) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      dismissed.current = true;
      hide();
      if (open) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [active, open, hide]);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !tooltip.current) return;
    const anchor = trigger.current;
    const bubble = tooltip.current;
    function updatePosition() {
      const rect = anchor.getBoundingClientRect();
      const { width, height } = bubble.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const space: Record<Placement, number> = {
        top: rect.top,
        right: viewportWidth - rect.right,
        bottom: viewportHeight - rect.bottom,
        left: rect.left,
      };
      const required =
        (placement === "top" || placement === "bottom" ? height : width) + gap + margin;
      const side =
        space[placement] < required && space[opposite[placement]] > space[placement]
          ? opposite[placement]
          : placement;
      let left = rect.left + (rect.width - width) / 2;
      let top = rect.top + (rect.height - height) / 2;
      if (side === "top") top = rect.top - height - gap;
      if (side === "bottom") top = rect.bottom + gap;
      if (side === "left") left = rect.left - width - gap;
      if (side === "right") left = rect.right + gap;
      left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
      top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
      setPosition((current) =>
        current?.left === left && current.top === top ? current : { left, top },
      );
    }
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(anchor);
    observer.observe(bubble);
    return () => observer.disconnect();
  }, [open, placement, content, host]);

  const describedBy = [children.props["aria-describedby"], open ? id : undefined]
    .filter(Boolean).join(" ") || undefined;

  return (
    <>
      {cloneElement(children, {
        ref: attachTrigger,
        "aria-describedby": describedBy,
        onPointerEnter(event) {
          children.props.onPointerEnter?.(event);
          if (event.pointerType !== "mouse" || !enabled) return;
          hovered.current = true;
          clearTimeout(closingTimer.current);
          if (dismissed.current || phase === "open") return;
          clearTimeout(openingTimer.current);
          setPhase("waiting");
          openingTimer.current = setTimeout(show, hoverDelayMs);
        },
        onPointerLeave(event) {
          children.props.onPointerLeave?.(event);
          if (event.pointerType !== "mouse") return;
          hovered.current = false;
          dismissed.current = false;
          scheduleClose();
        },
        onFocus(event) {
          children.props.onFocus?.(event);
          if (!event.currentTarget.matches(":focus-visible")) return;
          focused.current = true;
          show();
        },
        onBlur(event) {
          children.props.onBlur?.(event);
          focused.current = false;
          dismissed.current = false;
          hide();
        },
        onPointerDown(event) {
          dismiss();
          children.props.onPointerDown?.(event);
        },
        onClick(event) {
          dismiss();
          children.props.onClick?.(event);
        },
      })}
      {open && host && createPortal(
        <Appearance kind="fade" ready={!!position}>
        <div
          ref={tooltip}
          id={id}
          role="tooltip"
          className={`${styles.tooltip} ${position ? "" : styles.measuring}`}
          style={position ?? undefined}
          onPointerEnter={(event) => {
            if (event.pointerType !== "mouse") return;
            tooltipHovered.current = true;
            clearTimeout(closingTimer.current);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "mouse") return;
            tooltipHovered.current = false;
            scheduleClose();
          }}
        >
          {content}
        </div>
        </Appearance>,
        host,
      )}
    </>
  );
}
