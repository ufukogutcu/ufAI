import { Feedback, BusyButton, LoadingState } from "./Feedback";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import type { UserInputRequest, VaultSecret } from "../../../server/src/vault-types";
import type { Page } from "../../../server/src/contracts";
import { errorMessage, request } from "../api";
import { useUnsavedChanges } from "../navigation-guard";
import styles from "./PrivateInputCard.module.scss";

/** Plaintext stays inside this form and its private submission request. */
export function PrivateInputCard({ requestId, item, refreshKey, onChange }: {
  requestId: string; item?: UserInputRequest; refreshKey?: unknown; onChange?: () => void;
}) {
  const [loaded, setLoaded] = useState<UserInputRequest | null>(null);
  const [secrets, setSecrets] = useState<VaultSecret[]>([]);
  const [value, setValue] = useState(""), [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState<number | undefined>();
  const fieldId = useId(), input = useRef<HTMLTextAreaElement>(null), generation = useRef(0);
  const current = item && (!loaded || item.updatedAt > loaded.updatedAt) ? item : loaded ?? item;
  const pending = current?.state === "pending";
  const discard = useCallback(() => { setValue(""); setSelected(""); }, []);
  useUnsavedChanges(!!pending && (!!value || !!selected), discard);
  const refresh = useCallback(async () => {
    const serial = ++generation.current;
    try {
      const r = await request<UserInputRequest>(`/user-input-requests/${requestId}`);
      if (serial !== generation.current) return;
      setLoaded(r);
      if (r.state !== "pending") { setValue(""); setSelected(""); }
      setError("");
    } catch (e) { if (serial === generation.current) setError(errorMessage(e)); }
  }, [requestId]);
  useEffect(() => {
    void refresh();
    function visible() { if (document.visibilityState === "visible") void refresh(); }
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("ufai-private-input-updated", visible);
    return () => {
      generation.current++;
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("ufai-private-input-updated", visible);
    };
  }, [refresh, refreshKey]);
  useEffect(() => {
    if (!pending) return;
    let live = true;
    // The vault is bounded to 256 entries; fetch all metadata for this picker.
    void Promise.all([0, 100, 200].map(offset => request<Page<VaultSecret>>(`/vault/secrets?limit=100&offset=${offset}`)))
      .then(pages => { if (live) setSecrets(pages.flatMap(p => p.items)); })
      .catch(e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [pending, requestId]);
  async function submit(event: FormEvent, decline = false) {
    event.preventDefault();
    if (!decline && !selected && !value) { setError("Enter a value or select a saved secret."); input.current?.focus(); return; }
    setBusy(true); setError("");
    try {
      const r = await request<UserInputRequest>(`/user-input-requests/${requestId}/resolve`, "POST",
        decline ? { decline: true } : selected ? { secretId: selected } : { value, ...(revision === undefined ? {} : { expectedRevision: revision }) });
      setLoaded(r); setValue(""); setSelected("");
      window.dispatchEvent(new window.Event("ufai-private-input-updated")); onChange?.();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function reloadRevision() {
    if (!current?.secretId) return;
    try {
      const secret = await request<VaultSecret>(`/vault/secrets/${current.secretId}`);
      setRevision(secret.revision); setError("");
    } catch (e) { setError(errorMessage(e)); }
  }
  return <section className={styles.card} aria-label="Private secret input" aria-busy={busy}>
    <div className={styles.heading}><LockKeyhole size={16} aria-hidden="true" /><strong>{current?.name ?? "Private input"}</strong></div>
    {current && <p>{current.purpose}</p>}
    {pending && <form onSubmit={submit}>
      <p className={styles.hint}>Saved encrypted in the shared Vault. All agents can use it; the value is kept out of chat and model context.</p>
      <label htmlFor={fieldId}>Secret value{current.secretId ? " (replacement)" : ""}</label>
      <textarea ref={input} id={fieldId} name="private-secret" value={value} onChange={e => setValue(e.target.value)}
        disabled={busy || !!selected} autoComplete="off" spellCheck={false} maxLength={8192} rows={2} className={styles.secret} />
      <label htmlFor={fieldId + "-existing"}>Or use a saved secret</label>
      <select id={fieldId + "-existing"} name="saved-secret" value={selected} onChange={e => setSelected(e.target.value)} disabled={busy}>
        <option value="">Enter a new value above</option>
        {secrets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <div className={styles.actions}>
        <BusyButton className="button primary" busy={busy}>{busy ? "Saving…" : selected ? "Use Secret" : "Save Secret"}</BusyButton>
        <button type="button" className="button secondary" disabled={busy} onClick={e => void submit(e, true)}>Decline</button>
        {current.secretId && <button type="button" className="textButton" disabled={busy} onClick={() => void reloadRevision()}>Use latest revision</button>}
      </div>
    </form>}
    {current && !pending && <p role="status">{current.state === "fulfilled" ? "Secret saved. Only its reference was sent to the agent." : current.state === "declined" ? "Request declined." : "Request cancelled."}</p>}
    {!current && !error && <LoadingState>Loading private request…</LoadingState>}
    {error && <Feedback role="alert">{error} <button type="button" className="textButton" onClick={() => void refresh()}>Refresh request</button></Feedback>}
  </section>;
}
