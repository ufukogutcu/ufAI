import { useId, type ReactNode } from "react";
import { Appearance } from "./Appearance";
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby"?: string;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <Appearance><div className="field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-invalid": !!error,
        "aria-describedby": error || hint ? `${id}-help` : undefined,
      })}
      {(error || hint) && (
        <Appearance kind="fade">
        <span id={`${id}-help`} className={error ? "fieldError" : "fieldHint"}>
          {error ?? hint}
        </span>
        </Appearance>
      )}
    </div></Appearance>
  );
}
