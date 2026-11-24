import { useRef, useState, type FormEvent } from "react";
import { errorMessage, RequestError } from "../api";
import { Dialog } from "./Dialog";
import { BusyButton, Feedback } from "./Feedback";
import { Field } from "./FormField";

const copySuffix = " (copy)";

export function LibraryDuplicateDialog({ kind, sourceName, hint, onDuplicate, onClose }: {
  kind: "agent preset" | "Provider";
  sourceName: string;
  hint?: string;
  onDuplicate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(() =>
    sourceName.slice(0, 120 - copySuffix.length).replace(/[\uD800-\uDBFF]$/u, "").trimEnd() + copySuffix);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setNameError("Enter a name.");
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onDuplicate(name);
    } catch (failure) {
      const fieldError = failure instanceof RequestError ? failure.fields.name : undefined;
      if (fieldError) {
        setNameError(fieldError);
        requestAnimationFrame(() => input.current?.focus());
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  }
  return <Dialog title={`Duplicate ${kind}`} busy={busy} onClose={onClose}>
    <form onSubmit={submit} noValidate>
      <Field label="Name" hint={hint} error={nameError || undefined}>
        {props => <input {...props} ref={input} value={name} maxLength={120} disabled={busy}
          onChange={event => { setName(event.target.value); setNameError(""); }} />}
      </Field>
      {error && <Feedback role="alert">{error}</Feedback>}
      <div className="dialogActions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <BusyButton type="submit" busy={busy} className="button primary">{busy ? "Duplicating…" : "Duplicate"}</BusyButton>
      </div>
    </form>
  </Dialog>;
}
