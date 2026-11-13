import { usageLevel } from "../codex-usage-format";
import styles from "./CodexUsageBar.module.scss";

export function CodexUsageBar({ remaining }: { remaining: number }) {
  return <span className={styles.track} aria-hidden="true">
    <span className={`${styles.fill} ${styles[usageLevel(remaining)]}`} style={{ width: `${Math.min(100, Math.max(0, remaining))}%` }} />
  </span>;
}
