import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { UserInputRequest, VaultSecret } from "../../../server/src/vault-types";
import type { Page } from "../../../server/src/contracts";
import { errorMessage, request, RequestError } from "../api";
import { useUnsavedChanges } from "../navigation-guard";
import { BusyButton, Feedback, LoadingState } from "./Feedback";
import { RequestActions, RequestCard, type RequestAction } from "./RequestCard";
import styles from "./UserInputCard.module.scss";

/** Plaintext stays inside this form and its private submission request. */
export function PrivateInputCard({ item, onSaved, onRefresh }: {
  item: UserInputRequest;
  onSaved: (result: UserInputRequest) => void;
  onRefresh: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [useSaved, setUseSaved] = useState(false);
  const [secrets, setSecrets] = useState<VaultSecret[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [pickerRetry, setPickerRetry] = useState(0);
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState("");
  const [pendingAction, setPendingAction] = useState<RequestAction>(null);
  const [reloadingRevision, setReloadingRevision] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [revision, setRevision] = useState<number>();
  const [revisionConflict, setRevisionConflict] = useState(false);
  const fieldId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLSelectElement>(null);
  const methodButton = useRef<HTMLButtonElement>(null);
  const focusReplacement = useRef(false);
  const lock = useRef(false);
  const pending = item.state === "pending";
  const busy = pendingAction !== null;
  const saving = busy || reloadingRevision;

  const discard = useCallback(() => { setValue(""); setSelected(""); }, []);
  useUnsavedChanges(pending && (!!value || !!selected), discard);
  useEffect(() => { if (!pending) discard(); }, [pending, discard]);

  useEffect(() => {
    if (!pending || !expanded || !useSaved) return;
    const controller = new AbortController();
    setPickerLoading(true);
    setPickerError("");
    // The Vault has at most 256 entries. The picker loads metadata only.
    void Promise.all([0, 100, 200].map(offset =>
      request<Page<VaultSecret>>(`/vault/secrets?limit=100&offset=${offset}`, "GET", undefined, controller.signal),
    )).then(pages => {
      if (controller.signal.aborted) return;
      const available = pages.flatMap(page => page.items);
      setSecrets(available);
      setSelected(current => available.some(secret => secret.id === current) ? current : "");
    }).catch(cause => {
      if (!controller.signal.aborted) setPickerError(errorMessage(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setPickerLoading(false);
    });
    return () => controller.abort();
  }, [pending, expanded, useSaved, pickerRetry]);
  useLayoutEffect(() => {
    if (saving) return;
    if (focusReplacement.current) {
      focusReplacement.current = false;
      input.current?.focus();
    }
    if (document.activeElement !== methodButton.current) return;
    if (!useSaved) input.current?.focus();
    else if (!pickerLoading && !pickerError) picker.current?.focus();
  }, [saving, useSaved, pickerLoading, pickerError]);

  async function submit(event: FormEvent, decline = false) {
    event.preventDefault();
    if (lock.current) return;
    if (!decline && !(useSaved ? selected : value)) {
      setFieldError(useSaved ? "Select a saved secret." : "Enter a secret value.");
      (useSaved ? picker : input).current?.focus();
      return;
    }
    lock.current = true;
    setPendingAction(decline ? "decline" : "submit");
    setError("");
    setFieldError("");
    try {
      const payload = decline ? { decline: true } : useSaved ? { secretId: selected }
        : { value, ...(revision === undefined ? {} : { expectedRevision: revision }) };
      const result = await request<UserInputRequest>(`/user-input-requests/${item.id}/resolve`, "POST", payload);
      discard();
      onSaved(result);
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof RequestError && cause.status === 409) {
        if (!decline && !useSaved && item.secretId && cause.message.startsWith("Secret changed.")) setRevisionConflict(true);
        else await onRefresh();
      }
    } finally {
      lock.current = false;
      setPendingAction(null);
    }
  }

  async function reloadRevision() {
    if (!item.secretId || lock.current) return;
    lock.current = true;
    setReloadingRevision(true);
    try {
      const secret = await request<VaultSecret>(`/vault/secrets/${item.secretId}`);
      setRevision(secret.revision);
      setRevisionConflict(false);
      setError("");
      focusReplacement.current = true;
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setReloadingRevision(false);
    }
  }

  function switchMethod() {
    if (!useSaved) setPickerLoading(true);
    setUseSaved(current => !current);
    setFieldError("");
    setError("");
  }

  return <RequestCard item={item} busy={saving} expanded={expanded} onToggle={() => setExpanded(open => !open)}>
    {pending && <form className={styles.form} onSubmit={submit}>
      <p className={styles.hint} id={fieldId + "-privacy"}>Secrets are encrypted in the shared Vault. The agent receives a reference.</p>
      <div className={styles.field}>
        {useSaved ? <>
          <label htmlFor={fieldId}>Saved secret</label>
          <select ref={picker} id={fieldId} name="saved-secret" value={selected} disabled={saving || pickerLoading || !!pickerError}
            aria-invalid={!!fieldError} aria-describedby={fieldId + "-privacy" + (fieldError ? " " + fieldId + "-error" : "")}
            onChange={event => { setSelected(event.target.value); setFieldError(""); }}>
            <option value="">{pickerLoading ? "Loading secrets…" : "Select a secret"}</option>
            {secrets.map(secret => <option key={secret.id} value={secret.id}>{secret.name}</option>)}
          </select>
          {pickerLoading && <LoadingState>Loading saved secrets…</LoadingState>}
          {pickerError && <Feedback>{pickerError} <button type="button" className={`textButton ${styles.quietButton}`}
            disabled={saving} onClick={() => setPickerRetry(count => count + 1)}>Retry</button></Feedback>}
          {!pickerLoading && !pickerError && !secrets.length && <p className={styles.hint}>No saved secrets. Enter a new secret to continue.</p>}
        </> : <>
          <label htmlFor={fieldId}>{item.secretId ? "Replacement value" : "Secret value"}</label>
          <textarea ref={input} id={fieldId} name="private-secret" value={value} onChange={event => { setValue(event.target.value); setFieldError(""); }}
            disabled={saving} autoComplete="off" spellCheck={false} maxLength={8192} rows={2} className={styles.secret}
            aria-invalid={!!fieldError} aria-describedby={fieldId + "-privacy" + (fieldError ? " " + fieldId + "-error" : "")} />
        </>}
        {fieldError && <p className={styles.error} id={fieldId + "-error"} role="alert">{fieldError}</p>}
        <button ref={methodButton} type="button" className={`textButton ${styles.quietButton}`} disabled={saving} onClick={switchMethod}>
          {useSaved ? "Enter a new secret" : "Use a saved secret"}
        </button>
      </div>
      {error && <Feedback>{error}</Feedback>}
      {!useSaved && revisionConflict && <BusyButton type="button" className={`textButton ${styles.quietButton}`}
        busy={reloadingRevision} disabled={busy} onClick={() => void reloadRevision()}>
        {reloadingRevision ? "Loading revision…" : "Use latest revision"}
      </BusyButton>}
      <RequestActions label={useSaved ? "Use secret" : "Save secret"} busyLabel="Saving…" pendingAction={pendingAction}
        disabled={reloadingRevision || (useSaved && (pickerLoading || !!pickerError))}
        declineDisabled={reloadingRevision}
        onDecline={event => void submit(event, true)} />
    </form>}
  </RequestCard>;
}
