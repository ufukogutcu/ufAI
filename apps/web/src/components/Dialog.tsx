import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Tooltip } from "./Tooltip";
import { GlassMaterial } from "./GlassMaterial";
import { Appearance } from "./Appearance";
import styles from "./Dialog.module.scss";

export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  contentClassName = "",
  initialFocusSelector = "input",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  contentClassName?: string;
  initialFocusSelector?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
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
    };
  }, [initialFocusSelector]);
  return (
    <Appearance kind="dialog">
      <dialog
        ref={ref}
        className={`${styles.dialog} glassSurface nodrag nopan`}
        onClick={(event) => event.stopPropagation()}
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
