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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <Appearance kind="dialog">
    <dialog
      ref={ref}
      className={`${styles.dialog} glassSurface`}
      aria-labelledby={titleId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <GlassMaterial appearance="regular" />
      <div className={styles.content}>
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
