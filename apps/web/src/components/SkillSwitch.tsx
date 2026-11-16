import type { InputHTMLAttributes } from "react";
import styles from "./SkillSwitch.module.scss";

type SkillSwitchProps = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "checked" | "disabled" | "onChange" | "readOnly" | "aria-label"
> & { label?: string };

export function SkillSwitch({ label, ...inputProps }: SkillSwitchProps) {
  return (
    <label className={styles.control}>
      <span className={styles.switch}>
        <input
          {...inputProps}
          className={styles.input}
          type="checkbox"
          role="switch"
        />
        <span className={styles.track} aria-hidden="true" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}
