import { useId, useLayoutEffect, useRef, type MouseEventHandler, type ReactNode } from "react";
import { ChevronDown, LockKeyhole } from "lucide-react";
import type { UserInputRequest } from "../../../server/src/vault-types";
import { BusyButton } from "./Feedback";
import styles from "./UserInputCard.module.scss";

export function RequestCard({ item, busy, expanded = true, onToggle, children }: {
  item: UserInputRequest;
  busy: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const id = useId();
  const card = useRef<HTMLElement>(null);
  const hadFocus = useRef(false);
  const pending = item.state === "pending";
  const privateRequest = item.kind === "secret";
  const status = item.state === "fulfilled" ? privateRequest ? "Secret provided" : "Answered"
    : item.state === "declined" ? "Declined" : item.state === "cancelled" ? "Cancelled" : "";

  useLayoutEffect(() => {
    if (!pending && hadFocus.current && document.activeElement === document.body) card.current?.focus();
  }, [pending]);

  return <section ref={card} className={styles.card} tabIndex={-1} aria-labelledby={id}
    aria-busy={busy} onFocusCapture={() => { hadFocus.current = true; }}
    onBlurCapture={event => {
      if (event.relatedTarget) hadFocus.current = card.current?.contains(event.relatedTarget) ?? false;
    }}>
    <header className={styles.summary}>
      <div className={styles.intro}>
        <div className={styles.header}>
          <strong id={id} className={styles.title}>
            {privateRequest && <LockKeyhole size={14} aria-hidden="true" />}
            <span>{item.name}</span>
          </strong>
          <span className={styles.status} role="status">{status}</span>
        </div>
        {pending && <p className={expanded ? styles.purpose : styles.preview}>{item.purpose}</p>}
      </div>
      {pending && onToggle && <button type="button" className={`button secondary ${styles.disclosure}`}
        aria-expanded={expanded} aria-controls={id + "-body"} aria-describedby={id}
        disabled={busy} onClick={onToggle}>
        {expanded ? "Hide fields" : privateRequest ? "Open private request" : "Answer"}
        <ChevronDown size={14} aria-hidden="true" className={expanded ? styles.expanded : undefined} />
      </button>}
    </header>
    {pending ? <div id={id + "-body"} hidden={!expanded}>{expanded && children}</div> : children}
  </section>;
}

export type RequestAction = "submit" | "decline" | null;

export function RequestActions({ label, busyLabel, pendingAction, disabled, declineDisabled, onDecline }: {
  label: string;
  busyLabel: string;
  pendingAction: RequestAction;
  disabled?: boolean;
  declineDisabled?: boolean;
  onDecline: MouseEventHandler<HTMLButtonElement>;
}) {
  return <div className={styles.actions}>
    <BusyButton type="submit" className="button primary" busy={pendingAction === "submit"} disabled={disabled || pendingAction === "decline"}>
      {pendingAction === "submit" ? busyLabel : label}
    </BusyButton>
    <BusyButton type="button" className={`textButton ${styles.quietButton}`} busy={pendingAction === "decline"}
      disabled={declineDisabled || pendingAction === "submit"} onClick={onDecline}>
      {pendingAction === "decline" ? "Declining…" : "Decline"}
    </BusyButton>
  </div>;
}
