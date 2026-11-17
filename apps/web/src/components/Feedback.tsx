import { AlertCircle, Check, Info, LoaderCircle } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import type { FeedbackTone } from "../feedback-store";
import styles from "./Feedback.module.scss";

export function LoadingIndicator({ className = "" }: { className?: string }) {
  return <LoaderCircle size={18} className={`${styles.spinner} ${className}`} aria-hidden="true" />;
}

type FeedbackProps = ComponentPropsWithRef<"div"> & {
  tone?: FeedbackTone;
  title?: string;
  busy?: boolean;
  details?: string;
};

export function Feedback({ tone = "error", title, busy = false, details, children, className = "", role, ...props }: FeedbackProps) {
  const Icon = tone === "error" ? AlertCircle : tone === "success" ? Check : Info;
  return <div {...props} className={`${styles.feedback} ${styles[tone]} ${className}`}
    role={role ?? (tone === "error" ? "alert" : "status")}>
    {busy || tone === "loading" ? <LoadingIndicator /> : <Icon size={18} className={styles.icon} aria-hidden="true" />}
    <div className={styles.body}>
      {title && <strong className={styles.title}>{title}</strong>}
      <div className={styles.message}>{children}</div>
      {details && <details className={styles.details}><summary>Technical details</summary><code>{details}</code></details>}
    </div>
  </div>;
}

export function LoadingState({ children, className = "", ...props }: Omit<ComponentPropsWithRef<"div">, "children"> & { children: ReactNode }) {
  return <div {...props} className={`${styles.loadingState} ${className}`} role="status"><LoadingIndicator /><span>{children}</span></div>;
}

export function BusyButton({ busy = false, children, disabled, ...props }: ComponentPropsWithRef<"button"> & { busy?: boolean }) {
  return <button {...props} disabled={disabled || busy} aria-busy={busy || undefined}>
    {busy && <LoadingIndicator />}{children}
  </button>;
}
