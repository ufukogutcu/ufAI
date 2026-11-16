import {
  useEffect, useId, useRef,
  type MouseEvent, type PointerEvent, type ReactNode, type RefObject,
} from "react";
import { X } from "lucide-react";
import { Tooltip } from "./Tooltip";
import { GlassMaterial } from "./GlassMaterial";
import { Appearance } from "./Appearance";
import styles from "./Dialog.module.scss";

function isBackdropEvent(event: MouseEvent<HTMLDialogElement>) {
  // Native backdrops target the dialog itself, as do its padding and scrollbars.
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom;
}

export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  contentClassName = "",
  initialFocusSelector = "input",
  returnFocusFallbackRef,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  contentClassName?: string;
  initialFocusSelector?: string;
  returnFocusFallbackRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropGesture = useRef<{ pointerId: number; released: boolean } | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>(initialFocusSelector)?.focus();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
      if (returnFocusFallbackRef && document.activeElement !== previous)
        returnFocusFallbackRef.current?.focus();
    };
  }, [initialFocusSelector, returnFocusFallbackRef]);

  function handlePointerDown(event: PointerEvent<HTMLDialogElement>) {
    backdropGesture.current = !busy && event.isPrimary && event.button === 0 && isBackdropEvent(event)
      ? { pointerId: event.pointerId, released: false }
      : null;
  }
  function handlePointerUp(event: PointerEvent<HTMLDialogElement>) {
    const gesture = backdropGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !event.isPrimary ||
      event.button !== 0 || busy || !isBackdropEvent(event)) {
      backdropGesture.current = null;
      return;
    }
    gesture.released = true;
  }
  function handlePointerCancel() {
    backdropGesture.current = null;
  }
  function handleClick(event: MouseEvent<HTMLDialogElement>) {
    event.stopPropagation();
    const gesture = backdropGesture.current;
    backdropGesture.current = null;
    if (gesture?.released && !busy && !event.defaultPrevented && event.button === 0 && isBackdropEvent(event))
      onClose();
  }

  return (
    <Appearance kind="dialog">
      <dialog
        ref={ref}
        className={`${styles.dialog} glassSurface nodrag nopan`}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={handleClick}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onClose();
          }
        }}
        aria-labelledby={titleId}
        aria-busy={busy}
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) onClose();
        }}
      >
        <GlassMaterial appearance="regular" />
        <div className={`${styles.content} ${contentClassName}`}>
          <div className={styles.heading}>
            <h2 id={titleId}>{title}</h2>
            <Tooltip content="Close dialog">
              <button
                type="button"
                className="iconButton"
                aria-label="Close dialog"
                onClick={onClose}
                disabled={busy}
              >
                <X size={18} />
              </button>
            </Tooltip>
          </div>
          {children}
        </div>
      </dialog>
    </Appearance>
  );
}
