import { usageLevel } from "../codex-usage-format";
import styles from "./CodexUsageBar.module.scss";

export function CodexUsageBar({ remaining, fullWidth = false }: { remaining: number; fullWidth?: boolean }) {
  return <span className={`${styles.track} ${fullWidth ? styles.fullWidth : ""}`} aria-hidden="true">
    <span className={`${styles.fill} ${styles[usageLevel(remaining)]}`} style={{ width: `${Math.min(100, Math.max(0, remaining))}%` }} />
  </span>;
}
