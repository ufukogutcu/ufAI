import { createPortal } from "react-dom";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Check } from "lucide-react";
import type { AgentAppearance } from "../../../server/src/contracts";
import { characters, characterNames, colors, accessories, type Accessory } from "../agent-appearance";
import { errorMessage } from "../api";
import { useSettings } from "../settings-store";
import { AgentCharacter } from "./AgentCharacter";
import { Dialog } from "./Dialog";
import styles from "./CharacterEditor.module.scss";

export function CharacterEditor({ initial, onSave, onClose, creating = false }: {
  initial: AgentAppearance; onSave: (appearance: AgentAppearance) => Promise<void>;
  onClose: () => void; creating?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  useEffect(() => {
    if (!dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ""; }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  function toggle(id: Accessory) {
    setDraft(current => ({ ...current, accessories: accessories.filter(item => item.id === id ? !current.accessories.includes(id) : current.accessories.includes(item.id)).map(item => item.id) }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true); setError("");
    try { await onSave(draft); onClose(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return createPortal(<Dialog title="Edit character" onClose={onClose} busy={busy} contentClassName={styles.dialogContent} initialFocusSelector='button[aria-pressed="true"]'>
    <form onSubmit={submit} className={styles.form}>
      <div className={styles.preview}><AgentCharacter appearance={draft} paused={paused} /></div>
      <div className={styles.fields}>
        <fieldset disabled={busy}><legend>Character</legend><div className={styles.characters}>{characters.map(kind => <button type="button" key={kind} aria-pressed={draft.kind === kind} onClick={() => setDraft(current => ({ ...current, kind }))}>
          <AgentCharacter appearance={{ ...draft, kind, accessories: [] }} paused decorative /><span>{characterNames[kind]}</span>
        </button>)}</div></fieldset>
        <fieldset disabled={busy}><legend>Body color</legend><div className={styles.colors}>{colors.map(color => <button type="button" key={color.id} className={styles.swatch} style={{ "--swatch": color.variable } as CSSProperties} aria-label={color.name} title={color.name} aria-pressed={draft.color === color.id} onClick={() => setDraft(current => ({ ...current, color: color.id }))}>{draft.color === color.id && <Check size={18} aria-hidden />}</button>)}</div></fieldset>
        <fieldset disabled={busy}><legend>Accessories</legend><div className={styles.accessories}>{accessories.map(item => <label key={item.id}><input type="checkbox" checked={draft.accessories.includes(item.id)} onChange={() => toggle(item.id)} />{item.name}</label>)}</div></fieldset>
        <p className="fieldHint">{creating ? "Use this look when you create the agent." : "Changes apply when you save."}</p>
        {error && <p role="alert" className="errorBanner">{error}</p>}
      </div>
      <div className={styles.actions}><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : creating ? "Use character" : "Save character"}</button></div>
    </form>
  </Dialog>, document.body);
}
