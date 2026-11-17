import { Feedback, BusyButton, LoadingState } from "../components/Feedback";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, LockKeyhole, Plus } from "lucide-react";
import type { VaultSecret, UserInputRequest } from "../../../server/src/vault-types";
import type { Page } from "../../../server/src/contracts";
import { errorMessage, request } from "../api";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import { Dialog } from "../components/Dialog";
import { PrivateInputCard } from "../components/PrivateInputCard";
import shared from "./Presets.module.scss";
import styles from "./Vault.module.scss";

function SecretEditor({ secret, onSaved, onClose, onDeleted, onReload }: {
  secret?: VaultSecret; onSaved: (secret: VaultSecret) => void; onClose: () => void; onDeleted: () => void; onReload: () => void;
}) {
  const [name, setName] = useState(secret?.name ?? ""), [description, setDescription] = useState(secret?.description ?? "");
  const [value, setValue] = useState(""), [revealed, setRevealed] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const revealGeneration = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const discard = useCallback(() => { setValue(""); setName(secret?.name ?? ""); setDescription(secret?.description ?? ""); }, [secret]);
  useUnsavedChanges(!!value || name !== (secret?.name ?? "") || description !== (secret?.description ?? ""), discard);
  useEffect(() => {
    function hide() { revealGeneration.current++; setRevealed(""); clearTimeout(timer.current); }
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => { revealGeneration.current++; clearTimeout(timer.current); window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", hide); };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const saved = await request<VaultSecret>(secret ? `/vault/secrets/${secret.id}` : "/vault/secrets", secret ? "PATCH" : "POST",
        { name, description, ...(!secret || value ? { value } : {}), ...(secret ? { expectedRevision: secret.revision } : {}) });
      setValue(""); setRevealed(""); onSaved(saved);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function reveal(copy = false) {
    if (!secret) return;
    if (revealed && !copy) { revealGeneration.current++; setRevealed(""); return; }
    const serial = ++revealGeneration.current;
    setError(""); setNotice("");
    try {
      const result = await request<{ value: string }>(`/vault/secrets/${secret.id}/reveal`, "POST");
      if (serial !== revealGeneration.current || document.visibilityState === "hidden") return;
      if (copy) { await navigator.clipboard.writeText(result.value); setNotice("Secret copied."); }
      else { setRevealed(result.value); clearTimeout(timer.current); timer.current = setTimeout(() => { revealGeneration.current++; setRevealed(""); }, 30000); }
    } catch { if (serial === revealGeneration.current) setError(copy ? "Could not copy the secret. Check clipboard access, or reveal and copy it manually." : "Could not reveal the secret. Check the original credential key and try again."); }
  }
  async function remove() {
    if (!secret) return;
    setBusy(true); setError("");
    try { await request(`/vault/secrets/${secret.id}`, "DELETE", { expectedRevision: secret.revision }); setDeleting(false); setValue(""); onDeleted(); }
    catch (e) { setError(errorMessage(e)); setDeleting(false); }
    finally { setBusy(false); }
  }
  return <>
    <form className={shared.editor} onSubmit={save}>
      <header className={shared.editorHeading}><h2>{secret ? "Edit Secret" : "New Secret"}</h2></header>
      <fieldset className={`${shared.fields} ${styles.fields}`} disabled={busy}>
        <section className={shared.formSection}>
          <div className="field"><label htmlFor={id + "-name"}>Name</label><input id={id + "-name"} name="secret-name" autoComplete="off" required maxLength={160} value={name} onChange={e => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor={id + "-description"}>Description (optional)</label><textarea id={id + "-description"} name="secret-description" autoComplete="off" maxLength={2000} rows={3} value={description} onChange={e => setDescription(e.target.value)} /></div>
          <div className="field"><label htmlFor={id + "-value"}>{secret ? "Replace Value" : "Secret Value"}</label><textarea id={id + "-value"} name="secret-value" className={styles.secretInput} autoComplete="off" spellCheck={false} required={!secret} maxLength={8192} rows={3} value={value} onChange={e => setValue(e.target.value)} aria-describedby={id + "-help"} /><p id={id + "-help"} className={styles.hint}>{secret ? "Leave blank to keep the saved value. " : ""}Values are encrypted locally and shared across all agents.</p></div>
        </section>
        {secret && <section className={shared.formSection}>
          <div className={styles.actions}><button type="button" className="button secondary" onClick={() => void reveal()}>{revealed ? "Hide Value" : "Reveal Value"}</button><button type="button" className="button secondary" onClick={() => void reveal(true)}>Copy Value</button></div>
          {revealed && <div className="field"><label htmlFor={id + "-revealed"}>Saved Value</label><textarea id={id + "-revealed"} name="revealed-secret" autoComplete="off" spellCheck={false} readOnly value={revealed} rows={3} /><p className={styles.hint}>Hides after 30 seconds or when this page loses focus.</p></div>}
          <p className={styles.hint}>Updated {new Date(secret.updatedAt).toLocaleString()} · Revision {secret.revision}</p>
        </section>}
        <p className={styles.hint}>Agents use references to fill websites or send API requests. Local host tools and websites that transform or echo values can bypass practical masking.</p>
      </fieldset>
      <footer className={shared.editorFooter}>
        {error && <Feedback role="alert">{error} {secret && <button type="button" className="textButton" onClick={onReload}>Reload saved secret</button>}</Feedback>}
        <p role="status" className={styles.hint}>{notice}</p>
        <div className={shared.footerActions}>
          {secret && <button type="button" className="button danger" disabled={busy} onClick={() => setDeleting(true)}>Delete</button>}
          <div />
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <BusyButton className="button primary" busy={busy}>{busy ? "Saving…" : "Save Secret"}</BusyButton>
        </div>
      </footer>
    </form>
    {deleting && <Dialog title="Delete Secret?" busy={busy} onClose={() => setDeleting(false)} initialFocusSelector=".secondary">
      <p>Delete <strong>{secret?.name}</strong>? All agents will lose access. Existing external sessions remain signed in.</p>
      <div className="dialogActions"><button className="button secondary" disabled={busy} onClick={() => setDeleting(false)}>Keep Secret</button><button className="button danger" disabled={busy} onClick={() => void remove()}>Delete Secret</button></div>
    </Dialog>}
  </>;
}

export default function VaultPage() {
  const [secrets, setSecrets] = useState<VaultSecret[]>([]), [total, setTotal] = useState(0);
  const [inputs, setInputs] = useState<UserInputRequest[]>([]), [inputTotal, setInputTotal] = useState(0);
  const [query, setQuery] = useState(""), [selection, setSelection] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<VaultSecret | undefined>();
  const [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const guard = useNavigationGuard(), generation = useRef(0), searchId = useId();
  const load = useCallback(async () => {
    const serial = ++generation.current;
    try {
      const [page, requests] = await Promise.all([
        request<Page<VaultSecret>>(`/vault/secrets?limit=100&query=${encodeURIComponent(query)}`),
        request<Page<UserInputRequest>>("/user-input-requests?kind=secret&limit=100"),
      ]);
      if (serial !== generation.current) return;
      setSecrets(page.items); setTotal(page.total); setInputs(requests.items); setInputTotal(requests.total); setError("");
    } catch (e) { if (serial === generation.current) setError(errorMessage(e)); }
    finally { if (serial === generation.current) setLoading(false); }
  }, [query]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 150);
    function visible() { if (document.visibilityState === "visible") void load(); }
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    window.addEventListener("ufai-private-input-updated", visible);
    return () => { generation.current++; clearTimeout(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); window.removeEventListener("ufai-private-input-updated", visible); };
  }, [load]);
  useEffect(() => {
    const events = new EventSource("/api/vault/events");
    const changed = () => { void load(); };
    events.addEventListener("change", changed);
    events.onopen = changed;
    return () => { events.close(); };
  }, [load]);
  function choose(secret?: VaultSecret, create = false) { guard(() => { setSnapshot(secret); setSelection(create ? "new" : secret?.id ?? null); }); }
  function saved(secret: VaultSecret) { setSnapshot(secret); setSelection(secret.id); void load(); }
  function close() { guard(() => { setSelection(null); setSnapshot(undefined); void load(); }); }
  async function more() {
    const serial = generation.current;
    try {
      const page = await request<Page<VaultSecret>>(`/vault/secrets?limit=100&offset=${secrets.length}&query=${encodeURIComponent(query)}`);
      if (serial === generation.current) setSecrets(old => [...old, ...page.items.filter(s => !old.some(o => o.id === s.id))]);
    } catch (e) { setError(errorMessage(e)); }
  }
  async function moreInputs() {
    try {
      const page = await request<Page<UserInputRequest>>(`/user-input-requests?kind=secret&limit=100&offset=${inputs.length}`);
      setInputs(old => [...old, ...page.items.filter(s => !old.some(o => o.id === s.id))]); setInputTotal(page.total);
    } catch (e) { setError(errorMessage(e)); }
  }
  async function reload() {
    if (!snapshot) return;
    try { const secret = await request<VaultSecret>(`/vault/secrets/${snapshot.id}`); guard(() => setSnapshot(secret)); }
    catch (e) { setError(errorMessage(e)); }
  }
  return <section className={shared.page} aria-label="Vault">
    <header className="pageHeader"><div><h1>Vault <span className="count">{total}</span></h1><p>Keep secrets encrypted and let agents use them by reference.</p></div><button className="button primary" onClick={() => choose(undefined, true)} disabled={selection === "new"}><Plus size={15} aria-hidden="true" />New Secret</button></header>
    {error && <Feedback role="alert">{error} <button className="textButton" onClick={() => void load()}>Retry</button></Feedback>}
    <div className={`${shared.layout} ${selection ? shared.hasSelection : ""}`}>
      <aside className={shared.library} aria-label="Secret library">
        <label className={styles.srOnly} htmlFor={searchId}>Search secrets</label><input id={searchId} name="vault-search" type="search" autoComplete="off" placeholder="Search secrets…" value={query} onChange={e => setQuery(e.target.value)} />
        {loading && <LoadingState className={shared.listMessage}>Loading Vault…</LoadingState>}
        {!loading && !secrets.length && <p className={shared.listMessage}>{query ? "No matching secrets." : "No secrets yet. Add one or answer an agent’s private request."}</p>}
        <div className={shared.presetList}>{secrets.map(secret => <button key={secret.id} className={`${shared.presetItem} ${selection === secret.id ? styles.selected : ""}`} aria-current={selection === secret.id ? "true" : undefined} onClick={() => choose(secret)}><LockKeyhole size={17} aria-hidden="true" /><span><strong>{secret.name}</strong><small>{secret.description || "Encrypted · Shared with all agents"}</small></span></button>)}</div>
        {secrets.length < total && <button className="button secondary" onClick={() => void more()}>Load More Secrets</button>}
        {!!inputs.length && <section className={styles.requests} aria-label="Pending private inputs"><h2>Private Requests <span className="count">{inputTotal}</span></h2>{inputs.map(item => <PrivateInputCard key={item.id} requestId={item.id} item={item} onChange={load} />)}{inputs.length < inputTotal && <button className="button secondary" onClick={() => void moreInputs()}>Load More Requests</button>}</section>}
      </aside>
      <div className={shared.detail}>
        {selection ? <><button className={`textButton ${shared.backButton}`} onClick={close}><ArrowLeft size={14} aria-hidden="true" />Secret library</button><SecretEditor key={selection + ":" + (snapshot?.revision ?? 0)} secret={snapshot} onSaved={saved} onClose={close} onDeleted={() => { setSelection(null); setSnapshot(undefined); void load(); }} onReload={() => void reload()} /></> : <div className="centerState"><LockKeyhole size={28} aria-hidden="true" /><h2>Choose a Secret</h2><p>Add and manage secrets shared across your agents.</p></div>}
      </div>
    </div>
  </section>;
}
