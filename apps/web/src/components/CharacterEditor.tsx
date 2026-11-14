import { createPortal } from "react-dom";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Check, Shuffle } from "lucide-react";
import type { AgentAppearance } from "../../../server/src/contracts";
import { characters, characterNames, colors, accessories, collections, looks, sameAppearance, selectAccessory, shuffleAccessories, slots, type Accessory, type Collection } from "../agent-appearance";
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
  const [collection, setCollection] = useState<Collection>("All");
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  useEffect(() => {
    if (!dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ""; }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const selectedLook = looks.find(look => sameAppearance(look.appearance, draft));
  const visibleLooks = looks.filter(look => collection === "All" || look.collection === collection);
  function shuffle() { setDraft(current => shuffleAccessories(current)); }
  function clearAccessories() { setDraft(current => ({ ...current, accessories: [] })); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true); setError("");
    try { await onSave(draft); onClose(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return createPortal(<Dialog title="Edit character" onClose={onClose} busy={busy} contentClassName={styles.dialogContent} initialFocusSelector='button[data-character-choice][aria-pressed="true"]'>
    <form onSubmit={submit} className={styles.form}>
      <div className={styles.preview}><AgentCharacter appearance={draft} paused={paused} /></div>
      <p className={styles.lookName} aria-live="polite">{selectedLook?.name ?? "Custom look"}</p>
      <div className={styles.fields}>
        <details className={styles.startingLooks}>
          <summary>Starting looks <span>{looks.length} styles · Cute, Fantasy, Tech</span></summary>
          <fieldset disabled={busy}><legend className={styles.srOnly}>Starting look</legend>
            <div className={styles.collections} role="group" aria-label="Look collection">{collections.map(item => <button type="button" key={item} aria-pressed={collection === item} onClick={() => setCollection(item)}>{item}</button>)}</div>
            <div className={styles.looks}>{visibleLooks.map(look => <button type="button" key={look.id} aria-pressed={sameAppearance(look.appearance, draft)} onClick={() => setDraft({ ...look.appearance, accessories: [...look.appearance.accessories] })}>
              <AgentCharacter appearance={look.appearance} paused decorative /><span>{look.name}</span><small>{look.collection}</small>
            </button>)}</div>
          </fieldset>
        </details>
        <fieldset disabled={busy}><legend>Character</legend><div className={styles.characters}>{characters.map(kind => <button type="button" data-character-choice key={kind} aria-pressed={draft.kind === kind} onClick={() => setDraft(current => ({ ...current, kind }))}>
          <AgentCharacter appearance={{ ...draft, kind, accessories: [] }} paused decorative /><span>{characterNames[kind]}</span>
        </button>)}</div></fieldset>
        <fieldset disabled={busy}><legend>Body color</legend><div className={styles.colors}>{colors.map(color => <button type="button" key={color.id} className={styles.swatch} style={{ "--swatch": color.variable } as CSSProperties} aria-label={color.name} title={color.name} aria-pressed={draft.color === color.id} onClick={() => setDraft(current => ({ ...current, color: color.id }))}>{draft.color === color.id && <Check size={18} aria-hidden />}</button>)}</div></fieldset>
        <fieldset disabled={busy}><legend>Accessories</legend><div className={styles.accessories}>{slots.map(slot => <label key={slot.id}><span>{slot.name}</span><select value={draft.accessories.find(id => accessories.find(item => item.id === id)!.slot === slot.id) ?? ""} onChange={event => setDraft(current => selectAccessory(current, slot.id, (event.target.value || undefined) as Accessory | undefined))}>
          <option value="">None</option>{accessories.filter(item => item.slot === slot.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>)}</div><div className={styles.wardrobeActions}><button type="button" className="button secondary" onClick={shuffle}><Shuffle size={15} aria-hidden />Shuffle accessories</button><button type="button" className="button secondary" disabled={!draft.accessories.length} onClick={clearAccessories}>Clear accessories</button></div></fieldset>
        <p className="fieldHint">{creating ? "Use this look when you create the agent." : "Changes apply when you save."}</p>
        {error && <p role="alert" className="errorBanner">{error}</p>}
      </div>
      <div className={styles.actions}><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : creating ? "Use character" : "Save character"}</button></div>
    </form>
  </Dialog>, document.body);
}
