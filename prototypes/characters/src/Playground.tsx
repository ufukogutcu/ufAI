import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { BookOpen, Brain, Check, Coffee, Laptop, Moon, Pause, Play, RotateCcw, Shuffle, Sparkles, Sun, Undo2 } from "lucide-react";
import catalog from "@ufai/theme-catalog";
import { Character, activities, characters, characterNames, colors, type Activity, type Appearance } from "./Character";
import styles from "./Playground.module.scss";
import { collections, looks, sameAppearance, selectAccessory, shuffleAccessories, slots, wardrobe, type Accessory, type Collection } from "./wardrobe";

const activityIcons = { idle: Coffee, working: Laptop, dreaming: Moon, studying: BookOpen, "studying-hard": Sparkles, thinking: Brain };
const defaultAppearance: Appearance = looks[0]!.appearance;

function useMotionEnvironment() {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    function handleMotion() { setReduced(media.matches); }
    function handleVisibility() { setHidden(document.hidden); }
    media.addEventListener("change", handleMotion);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      media.removeEventListener("change", handleMotion);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
  return { reduced, hidden };
}

export default function Playground() {
  const [collection, setCollection] = useState<Collection>("Cute");
  const [size, setSize] = useState<"large" | "canvas" | "small">("large");
  const [appearance, setAppearance] = useState<Appearance>(defaultAppearance);
  const [activity, setActivity] = useState<Activity>("idle");
  const [paused, setPaused] = useState(false);
  const [restart, setRestart] = useState(0);
  const [compare, setCompare] = useState(false);
  const [mode, setMode] = useState<"light" | "dark">("light");
  const { reduced, hidden } = useMotionEnvironment();
  const activeActivity = activities.find(item => item.id === activity)!;
  const theme = useMemo(() => Object.fromEntries(Object.values(catalog.tokens).map(token => [token.cssVariable, token[mode]])) as CSSProperties, [mode]);
  const selectedLook = looks.find(look => sameAppearance(look.appearance, appearance));
  const visibleLooks = looks.filter(look => collection === "All" || look.collection === collection);
  function shuffle() { setAppearance(current => shuffleAccessories(current)); }
  function reset() {
    setAppearance(defaultAppearance); setCollection("Cute"); setActivity("idle"); setPaused(false); setSize("large"); setCompare(false); setRestart(current => current + 1);
  }
  function restartAnimation() { setRestart(current => current + 1); }
  return <div className={styles.playground} style={{ ...theme, colorScheme: mode }} data-theme={mode}>
    <a className={styles.skip} href="#preview">Skip to preview</a>
    <div className={styles.shell}>
      <header className={styles.header}>
        <div><span className={styles.brand}>ufAI <span>/</span> experiments</span><h1>Character showroom<span className={styles.version}>Wardrobe study</span></h1><p>Cute, fantasy, tech. Mix a look and see how it moves.</p></div>
        <button className={styles.iconButton} onClick={() => setMode(current => current === "light" ? "dark" : "light")} aria-label={`Switch to ${mode === "light" ? "dark" : "light"} preview`} title={`Switch to ${mode === "light" ? "dark" : "light"} preview`}>{mode === "light" ? <Moon size={19} aria-hidden /> : <Sun size={19} aria-hidden />}</button>
      </header>
      <main className={styles.layout}>
        <aside className={styles.editor} id="wardrobe" tabIndex={-1} aria-label="Character appearance">
          <section aria-labelledby="looks-heading" className={styles.lookLibrary}>
            <div className={styles.sectionHeading}><h2 id="looks-heading">Start with a look</h2><span>{looks.length} combinations</span></div>
            <div className={styles.collections} role="group" aria-label="Look collection">{collections.map(item => <button key={item} aria-pressed={collection === item} onClick={() => setCollection(item)}>{item}</button>)}</div>
            <div className={styles.looks}>{visibleLooks.map(look => <button key={look.name} className={styles.look} aria-pressed={sameAppearance(appearance, look.appearance)} onClick={() => setAppearance({ ...look.appearance, accessories: [...look.appearance.accessories] })}>
              <Character appearance={look.appearance} paused decorative /><span>{look.name}</span><small>{look.collection}</small>
            </button>)}</div>
            <a className={styles.previewLink} href="#preview">See selected look in motion ↓</a>
          </section>
          <div className={styles.sectionHeading}><h2>Make it yours</h2><span>Mix across collections</span></div>
          <fieldset><legend><span>01</span> Character</legend><div className={styles.characterChoices}>{characters.map(kind => <button key={kind} className={styles.characterChoice} aria-pressed={appearance.kind === kind} onClick={() => setAppearance(current => ({ ...current, kind }))}>
            <Character appearance={{ ...appearance, kind, accessories: [] }} paused decorative /><span>{characterNames[kind]}</span>{appearance.kind === kind && <Check className={styles.selectedCheck} size={14} aria-hidden />}
          </button>)}</div></fieldset>
          <fieldset><legend><span>02</span> Body color <small>{colors.find(color => color.id === appearance.color)!.name}</small></legend><div className={styles.colors}>{colors.map(color => <button key={color.id} className={styles.swatch} style={{ "--swatch": `var(--character-${color.id})` } as CSSProperties} aria-label={color.name} title={color.name} aria-pressed={appearance.color === color.id} onClick={() => setAppearance(current => ({ ...current, color: color.id }))}>{appearance.color === color.id && <Check size={19} aria-hidden />}</button>)}</div></fieldset>
          <fieldset><legend><span>03</span> Accessories <small>{appearance.accessories.length} selected</small></legend><p className={styles.fieldHint}>One per group. Change any piece independently.</p><div className={styles.wardrobe}>{slots.map(slot => <label className={styles.slot} key={slot.id}><span>{slot.name}</span><select value={appearance.accessories.find(id => wardrobe.find(item => item.id === id)!.slot === slot.id) ?? ""} onChange={event => setAppearance(current => selectAccessory(current, slot.id, (event.target.value || undefined) as Accessory | undefined))}><option value="">None</option>{wardrobe.filter(item => item.slot === slot.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>)}</div>
            <div className={styles.wardrobeActions}><button className={styles.transportButton} onClick={shuffle}><Shuffle size={15} aria-hidden />Shuffle accessories</button><button className={styles.textButton} disabled={!appearance.accessories.length} onClick={() => setAppearance(current => ({ ...current, accessories: [] }))}>Clear all</button></div>
          </fieldset>
          <button className={styles.reset} onClick={reset}><Undo2 size={15} aria-hidden /> Reset character</button>
          <a className={styles.editorLink} href="#preview">Preview your combination ↑</a>
        </aside>
        <section className={styles.previewColumn} id="preview" tabIndex={-1} aria-label="Animation preview">
          <div className={styles.previewInner}><div className={styles.selectedIdentity} aria-live="polite"><h2>{selectedLook?.name ?? "Your combination"}</h2><p>{characterNames[appearance.kind]} · {colors.find(color => color.id === appearance.color)!.name}{selectedLook ? ` · ${selectedLook.collection}` : " · Custom look"}</p></div><div className={styles.previewTop}><div className={styles.viewToggle} role="group" aria-label="Preview layout"><button aria-pressed={!compare} onClick={() => setCompare(false)}>Single preview</button><button aria-pressed={compare} onClick={() => setCompare(true)}>All six animations</button></div><span className={styles.live}>{reduced ? "Static poses" : (paused || hidden) ? "Paused" : "Live preview"}</span></div>
          <div className={styles.stage}>
            {compare ? <div className={styles.comparison}>{activities.map(item => <button key={item.id} className={styles.comparisonItem} aria-label={`Preview ${item.name}`} onClick={() => { setActivity(item.id); setCompare(false); }}><Character key={restart} appearance={appearance} activity={item.id} paused={paused || hidden} /><span>{item.name}</span></button>)}</div> : <>
              <div className={styles.stageLabel}><span>{characterNames[appearance.kind]}</span><span>{colors.find(color => color.id === appearance.color)!.name}</span></div>
              <div className={`${styles.heroCharacter} ${size === "canvas" ? styles.canvasSize : size === "small" ? styles.small : ""}`}><Character key={`${activity}-${restart}`} appearance={appearance} activity={activity} paused={paused || hidden} /></div>
              <div className={styles.caption} aria-live="polite"><h2>{activeActivity.name}</h2><p>{activeActivity.description}</p></div>
            </>}
          </div>
          <div className={styles.transport}><div><button className={styles.transportButton} disabled={reduced} onClick={() => setPaused(current => !current)} aria-label={paused ? "Play animations" : "Pause animations"}>{paused ? <Play size={16} aria-hidden /> : <Pause size={16} aria-hidden />}{paused ? "Play" : "Pause"}</button><button className={styles.iconButton} disabled={reduced} onClick={restartAnimation} aria-label="Restart animations" title="Restart animations"><RotateCcw size={16} aria-hidden /></button></div>{!compare && <div className={styles.sizeChoices} role="group" aria-label="Character preview size">{([ ["large", "Large"], ["canvas", "128 px"], ["small", "64 px"] ] as const).map(([id, label]) => <button key={id} aria-pressed={size === id} onClick={() => setSize(id)}>{label}</button>)}</div>}{reduced && <span className={styles.motionNotice}>Reduced motion is on.</span>}</div>
          <div className={styles.animationHeading}><h2>Try an activity</h2><span>6 animations · every character</span></div>
          <div className={styles.activities} role="group" aria-label="Activity">{activities.map(item => {
            const Icon = activityIcons[item.id];
            return <button key={item.id} className={styles.activity} aria-pressed={activity === item.id} onClick={() => { setActivity(item.id); setCompare(false); }}><Icon size={18} aria-hidden /><span>{item.name}</span>{activity === item.id && <span className={styles.activityDot} />}</button>;
          })}</div>
          <p className={styles.previewNote}>Experimental wardrobe · animations are manually previewed.</p><a className={styles.editorLink} href="#wardrobe">Choose a look or customize ↓</a></div>
        </section>
      </main>
      <footer className={styles.footer}><span>Showroom only. Your agents and saved appearances stay unchanged.</span><span>Selections reset when you reload.</span></footer>
    </div>
  </div>;
}
