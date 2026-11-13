import { useEffect, useState, type CSSProperties } from "react";
import { BookOpen, Brain, Check, Coffee, Glasses, Headphones, Laptop, Moon, Pause, Play, RotateCcw, Sparkles, Star, Sun, Undo2 } from "lucide-react";
import catalog from "@ufai/theme-catalog";
import { Character, activities, accessories, characters, characterNames, colors, type Accessory, type Activity, type Appearance } from "./Character";
import styles from "./Playground.module.scss";

const activityIcons = { idle: Coffee, working: Laptop, dreaming: Moon, studying: BookOpen, "studying-hard": Sparkles, thinking: Brain };
function CapIcon({ size = 17 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 14V12a8 8 0 0 1 16 0v2M4 14h16l2 3H4a2 2 0 0 1 0-4M12 5v7" /></svg>;
}
const accessoryIcons = { glasses: Glasses, headphones: Headphones, cap: CapIcon, badge: Star };
const defaultAppearance: Appearance = { kind: "pebble", color: "sage", accessories: [] };

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
  const [appearance, setAppearance] = useState<Appearance>(defaultAppearance);
  const [activity, setActivity] = useState<Activity>("idle");
  const [paused, setPaused] = useState(false);
  const [restart, setRestart] = useState(0);
  const [compare, setCompare] = useState(false);
  const [small, setSmall] = useState(false);
  const [mode, setMode] = useState<"light" | "dark">("light");
  const { reduced, hidden } = useMotionEnvironment();
  const activeActivity = activities.find(item => item.id === activity)!;
  const theme = Object.fromEntries(Object.values(catalog.tokens).map(token => [token.cssVariable, token[mode]])) as CSSProperties;
  function toggleAccessory(id: Accessory) {
    setAppearance(current => ({ ...current, accessories: current.accessories.includes(id) ? current.accessories.filter(item => item !== id) : [...current.accessories, id] }));
  }
  function reset() {
    setAppearance(defaultAppearance); setActivity("idle"); setPaused(false); setRestart(current => current + 1);
  }
  function restartAnimation() { setRestart(current => current + 1); }
  return <div className={styles.playground} style={{ ...theme, colorScheme: mode }} data-theme={mode}>
    <a className={styles.skip} href="#preview">Skip to preview</a>
    <div className={styles.shell}>
      <header className={styles.header}>
        <div><span className={styles.brand}>ufAI <span>/</span> experiments</span><h1>Character playground<span className={styles.version}>Prototype 01</span></h1><p>Pick a little companion. Give it a look. See it come to life.</p></div>
        <button className={styles.iconButton} onClick={() => setMode(current => current === "light" ? "dark" : "light")} aria-label={`Switch to ${mode === "light" ? "dark" : "light"} preview`} title={`Switch to ${mode === "light" ? "dark" : "light"} preview`}>{mode === "light" ? <Moon size={19} aria-hidden /> : <Sun size={19} aria-hidden />}</button>
      </header>
      <main className={styles.layout}>
        <aside className={styles.editor} aria-label="Character appearance">
          <fieldset><legend><span>01</span> Character</legend><div className={styles.characterChoices}>{characters.map(kind => <button key={kind} className={styles.characterChoice} aria-pressed={appearance.kind === kind} onClick={() => setAppearance(current => ({ ...current, kind }))}>
            <Character appearance={{ ...appearance, kind, accessories: [] }} paused decorative /><span>{characterNames[kind]}</span>{appearance.kind === kind && <Check className={styles.selectedCheck} size={14} aria-hidden />}
          </button>)}</div></fieldset>
          <fieldset><legend><span>02</span> Body color <small>{colors.find(color => color.id === appearance.color)!.name}</small></legend><div className={styles.colors}>{colors.map(color => <button key={color.id} className={styles.swatch} style={{ "--swatch": `var(--character-${color.id})` } as CSSProperties} aria-label={color.name} title={color.name} aria-pressed={appearance.color === color.id} onClick={() => setAppearance(current => ({ ...current, color: color.id }))}>{appearance.color === color.id && <Check size={19} aria-hidden />}</button>)}</div></fieldset>
          <fieldset><legend><span>03</span> Accessories</legend><p className={styles.fieldHint}>Mix a few. Or keep it simple.</p><div className={styles.accessories}>{accessories.map(item => {
            const Icon = accessoryIcons[item.id];
            return <button key={item.id} className={styles.accessory} aria-pressed={appearance.accessories.includes(item.id)} onClick={() => toggleAccessory(item.id)}><Icon size={17} aria-hidden /><span>{item.name}</span>{appearance.accessories.includes(item.id) && <Check size={14} aria-hidden />}</button>;
          })}</div>{appearance.accessories.length > 0 && <button className={styles.textButton} onClick={() => setAppearance(current => ({ ...current, accessories: [] }))}>Clear accessories</button>}</fieldset>
          <button className={styles.reset} onClick={reset}><Undo2 size={15} aria-hidden /> Reset character</button>
        </aside>
        <section className={styles.previewColumn} id="preview" tabIndex={-1} aria-label="Animation preview">
          <div className={styles.previewTop}><div className={styles.viewToggle} role="group" aria-label="Preview layout"><button aria-pressed={!compare} onClick={() => setCompare(false)}>Single preview</button><button aria-pressed={compare} onClick={() => setCompare(true)}>All six animations</button></div><span className={styles.live}>{reduced ? "Static poses" : paused ? "Paused" : "Live preview"}</span></div>
          <div className={styles.stage}>
            {compare ? <div className={styles.comparison}>{activities.map(item => <button key={item.id} className={styles.comparisonItem} aria-label={`Preview ${item.name}`} onClick={() => { setActivity(item.id); setCompare(false); }}><Character key={restart} appearance={appearance} activity={item.id} paused={paused || hidden} /><span>{item.name}</span></button>)}</div> : <>
              <div className={styles.stageLabel}><span>{characterNames[appearance.kind]}</span><span>{colors.find(color => color.id === appearance.color)!.name}</span></div>
              <div className={`${styles.heroCharacter} ${small ? styles.small : ""}`}><Character key={`${activity}-${restart}`} appearance={appearance} activity={activity} paused={paused || hidden} /></div>
              <div className={styles.caption} aria-live="polite"><h2>{activeActivity.name}</h2><p>{activeActivity.description}</p></div>
            </>}
          </div>
          <div className={styles.transport}><div><button className={styles.transportButton} disabled={reduced} onClick={() => setPaused(current => !current)} aria-label={paused ? "Play animations" : "Pause animations"}>{paused ? <Play size={16} aria-hidden /> : <Pause size={16} aria-hidden />}{paused ? "Play" : "Pause"}</button><button className={styles.iconButton} disabled={reduced} onClick={restartAnimation} aria-label="Restart animations" title="Restart animations"><RotateCcw size={16} aria-hidden /></button></div>{!compare && <button className={styles.sizeButton} aria-pressed={small} onClick={() => setSmall(current => !current)}>{small ? "64 px · canvas size" : "Large preview"}<span>{small ? "Enlarge" : "Try 64 px"}</span></button>}{reduced && <span className={styles.motionNotice}>Reduced motion is on.</span>}</div>
          <div className={styles.animationHeading}><h2>Try an activity</h2><span>6 animations · every character</span></div>
          <div className={styles.activities} role="group" aria-label="Activity">{activities.map(item => {
            const Icon = activityIcons[item.id];
            return <button key={item.id} className={styles.activity} aria-pressed={activity === item.id} onClick={() => { setActivity(item.id); setCompare(false); }}><Icon size={18} aria-hidden /><span>{item.name}</span>{activity === item.id && <span className={styles.activityDot} />}</button>;
          })}</div>
        </section>
      </main>
      <footer className={styles.footer}><span>A character study, separate from your workspaces.</span><span>Selections reset when you reload.</span></footer>
    </div>
  </div>;
}
