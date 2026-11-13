import { clusterColors } from "../cluster-colors";
import { useSettings } from "../settings-store";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from "react";
import { ArrowLeft, Check, ChevronDown, Copy, Home, ListTodo, LockKeyhole, MoreHorizontal, Palette, Plus, Settings, SlidersHorizontal, Trash2 } from "lucide-react";
import { Dialog } from "../components/Dialog";
import { Appearance, AppearanceGroup } from "../components/Appearance";
import { Disclosure } from "../components/Disclosure";
import { RelaySymbol } from "../components/RelaySymbol";
import { errorMessage, RequestError } from "../api";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import { useTheme } from "../theme-store";
import {
  catalog,
  colorKeys,
  contrastWarnings,
  defaultThemes,
  hexColor,
  normalizeColor,
  themeStyle,
  type Theme,
  type ThemeColorKey,
  type ThemeColors,
  type ThemeInput,
} from "../themes";
import styles from "./Themes.module.scss";
import { GlassMaterial } from "../components/GlassMaterial";
import { AgentCharacter } from "../components/AgentCharacter";
import { defaultAppearance } from "../agent-appearance";

const characterPreviewColors = [
  "var(--character-sage)", "var(--character-honey)", "var(--character-sky)",
  "var(--character-coral)", "var(--character-lilac)", "var(--character-teal)",
];

const regions = [
  {
    id: "dashboard",
    label: "Dashboard",
    text: "Page surfaces, text, borders and scrollbars",
  },
  {
    id: "navigation",
    label: "Navigation",
    text: "Floating dock, optical glass, workspace tabs and preset selection",
  },
  {
    id: "buttons",
    label: "Buttons",
    text: "Primary, secondary and segmented actions",
  },
  {
    id: "form",
    label: "Form",
    text: "Inputs, placeholders, invalid fields and selected options",
  },
  {
    id: "feedback",
    label: "Feedback",
    text: "Local status, errors, warnings and deletion",
  },
  {
    id: "canvas",
    label: "Flowboard",
    text: "Canvas, dot grid, illustration and controls",
  },
  {
    id: "dialog",
    label: "Dialog & overlays",
    text: "Modal, tooltip and navigation overlay shadows",
  },
  {
    id: "decoration",
    label: "Decorative details",
    text: "Empty-state icons and configuration badges",
  },
] as const;

function ThemePreview({
  input,
  selected,
  onInspect,
}: {
  input: ThemeInput;
  selected: ThemeColorKey | null;
  onInspect: (key: ThemeColorKey) => void;
}) {
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected || !preview.current) return;
    const region = preview.current.querySelector<HTMLElement>(
      `[data-region="${catalog.tokens[selected].region}"]`,
    );
    const scroller = preview.current.closest("details") ?? preview.current;
    if (region)
      scroller.scrollTop +=
        region.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        12;
  }, [selected]);
  const css = useMemo(() => themeStyle(input), [input]);
  return (
    <div
      ref={preview}
      className={styles.preview}
      style={css}
      aria-label="Live theme preview"
    >
      <div className={styles.previewHeader}>
        <Palette size={16} />
        <strong>{input.name || "Your theme"}</strong>
        <span>LIVE PREVIEW</span>
      </div>
      <div className={styles.previewGrid}>
        {regions.map((region) => {
          const keys = colorKeys.filter(
            (key) => catalog.tokens[key].region === region.id,
          );
          const active = !!selected && keys.includes(selected);
          return (
            <section
              key={region.id}
              data-region={region.id}
              className={`${styles.previewRegion} ${styles[region.id]} ${active ? styles.highlighted : ""}`}
              aria-label={`${region.label} preview`}
            >
              <button
                type="button"
                className={styles.regionTitle}
                onClick={() => onInspect(keys[0]!)}
                aria-label={`Inspect ${region.label} colors`}
              >
                {region.label}
                <span>Inspect colors ↗</span>
              </button>
              <p className={styles.regionDescription}>{region.text}</p>
              {region.id === "dashboard" && (
                <div className={styles.dashboardSample}>
                  <h3>Your workspace</h3>
                  <p>A place for your next idea.</p>
                  <small>Ready when you are</small>
                  <div className={styles.raisedSample}>
                    Raised panel <span>Shared surface</span>
                  </div>
                  <span className={styles.selectionSample}>Selected text</span>
                </div>
              )}
              {region.id === "navigation" && (
                <div className={styles.navSample}>
                  <span className={styles.logoSample}>
                    <RelaySymbol />
                  </span>
                  <div className={`${styles.dockSample} glassSurface`}>
                    <GlassMaterial />
                    <span className={styles.navActive}><Home size={18} /></span>
                    <SlidersHorizontal size={18} /><Palette size={18} /><Settings size={18} />
                  </div>
                  <div className={`${styles.tabSample} glassSurface`}><GlassMaterial />Workspace tab</div>
                  <div className={styles.presetSample}>
                    <span>✦</span> Selected preset
                  </div>
                  <small>
                    ufAI <b>/</b> Local workspace
                  </small>
                </div>
              )}
              {region.id === "buttons" && (
                <div className={styles.buttonSamples}>
                  <button type="button" className="button primary">
                    Save changes
                  </button>
                  <button type="button" className="button secondary">
                    Cancel
                  </button>
                  <span className={styles.segmentSample}>Selected option</span>
                </div>
              )}
              {region.id === "form" && (
                <div className={styles.formSample}>
                  <label>
                    Model name
                    <input placeholder="Choose a model" readOnly />
                  </label>
                  <label>
                    Invalid field
                    <input value="Example value" readOnly aria-invalid="true" />
                  </label>
                  <div className={styles.optionSample}>Selected option</div>
                </div>
              )}
              {region.id === "feedback" && (
                <div className={styles.feedbackSample}>
                  <span className={styles.localSample}>● Local instance</span>
                  <p className={styles.errorSample}>
                    Example: the change could not be saved.
                  </p>
                  <p className={styles.warningSample}>Unsaved changes</p>
                  <button
                    type="button"
                    className="button danger"
                    aria-label="Preview destructive button"
                  >
                    Delete theme
                  </button>
                  <button type="button" className="button deleteButton">
                    Delete action
                  </button>
                </div>
              )}
              {region.id === "canvas" && (
                <div className={styles.canvasSample}>
                  <span className={styles.canvasIcon}>✦</span>
                  <span className={`${styles.canvasControls} glassSurface`}>
                    <GlassMaterial />
                    − &nbsp; 100% &nbsp; +
                  </span>
                  <div className={styles.agentSample}>
                    <AgentCharacter appearance={defaultAppearance} paused decorative className={styles.agentSampleCharacter} />
                    <MoreHorizontal className={styles.agentSampleMenu} size={16} aria-hidden="true" />
                    <span>Researcher</span>
                    <small><Check size={14} aria-label="Ready" /><ListTodo size={14} aria-hidden="true" /> 0</small>
                  </div>
                  <div className={styles.agentPanelSample}>Agent conversation</div>
                  <div className={styles.clusterSample}>
                    <strong>Research Cluster</strong>
                    <span className={styles.clusterDropSample}>Drop an agent here</span>
                    <div className={styles.clusterPalette}>{clusterColors.map((color,i)=><span key={color} title={`Cluster color ${i+1}`} style={{background:color}}/>)}</div>
                  </div>
                  <pre className={styles.terminalSample}>$ build report{'\n'}Report saved · exit 0</pre>
                  <svg width="100" height="24" aria-label="Communication permission preview"><path d="M4 12 H82 L74 6 M82 12 L74 18" fill="none" stroke="var(--communication-edge)" strokeWidth="2"/><path d="M4 22 H82" stroke="var(--communication-edge-selected)" strokeWidth="2"/></svg>
                  <small>Workspace canvas</small>
                  <svg width="220" height="58" viewBox="0 0 220 58" role="img" aria-label="Character prototype colors and props">
                    {characterPreviewColors.map((color, index) => <g key={color} transform={`translate(${index * 32 + 3} 0)`}>
                      <ellipse cx="14" cy="51" rx="14" ry="3" fill="var(--character-shadow)" />
                      <rect x="1" y="9" width="26" height="36" rx="12" fill={color} stroke="var(--character-ink)" strokeWidth="2" />
                      <path d="M4 10Q5 1 14 1Q23 1 24 10Z" fill="var(--character-accent)" stroke="var(--character-ink)" />
                      <rect x="5" y="20" width="18" height="13" rx="5" fill="var(--character-paper)" />
                      <path d="M10 26h1M17 26h1" stroke="var(--character-ink)" strokeWidth="2" strokeLinecap="round" />
                      <path d="M7 37h14v9H7z" fill="var(--character-prop)" stroke="var(--character-ink)" />
                    </g>)}
                  </svg>
                </div>
              )}
              {region.id === "dialog" && (
                <div className={styles.overlaySample}>
                  <div className={styles.sidebarOverlaySample}>
                    Navigation overlay
                  </div>
                  <div className={`${styles.dialogSample} glassSurface`}>
                    <GlassMaterial appearance="regular" />
                    <strong>Dialog title</strong>
                    <p>Preview your decisions.</p>
                    <span className={styles.tooltipSample}>
                      Helpful tooltip
                    </span>
                  </div>
                </div>
              )}
              {region.id === "decoration" && (
                <div className={styles.decorationSample}>
                  <span className="emptyIcon">✦</span>
                  <span className={styles.configSample}>
                    CONFIGURATION ONLY
                  </span>
                </div>
              )}
              <div
                className={styles.regionColors}
                aria-label={`${region.label} color samples`}
              >
                {keys.map((key) => (
                  <button
                    type="button"
                    key={key}
                    className={`${styles.previewSwatch} ${key === selected ? styles.swatchSelected : ""}`}
                    style={{ "--swatch": input.colors[key] } as CSSProperties}
                    onClick={() => onInspect(key)}
                    aria-label={`Inspect ${catalog.tokens[key].label}`}
                    aria-pressed={key === selected}
                  >
                    <span />
                    {catalog.tokens[key].label}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ColorControl({
  colorKey,
  value,
  rawValue,
  locked,
  selected,
  onSelect,
  onReveal,
  onChange,
}: {
  colorKey: ThemeColorKey;
  value: string;
  rawValue: string;
  locked: boolean;
  selected: boolean;
  onSelect: (key: ThemeColorKey) => void;
  onReveal: (key: ThemeColorKey) => void;
  onChange: (key: ThemeColorKey, color: string) => void;
}) {
  const id = useId();
  const token = catalog.tokens[colorKey];
  const invalid = !hexColor.test(rawValue);
  const alpha = value.length === 9 ? parseInt(value.slice(7), 16) : 255;
  function changePicker(event: FormEvent<HTMLInputElement>) {
    onChange(
      colorKey,
      event.currentTarget.value +
        (alpha < 255 ? alpha.toString(16).padStart(2, "0") : ""),
    );
  }
  function changeAlpha(event: FormEvent<HTMLInputElement>) {
    const opacity = Math.round((Number(event.currentTarget.value) * 255) / 100);
    onChange(
      colorKey,
      value.slice(0, 7) +
        (opacity < 255 ? opacity.toString(16).padStart(2, "0") : ""),
    );
  }
  return (
    <div
      id={`color-${colorKey}`}
      className={`${styles.colorControl} ${selected ? styles.selectedControl : ""}`}
      onFocus={() => onSelect(colorKey)}
    >
      <div className={styles.colorHeading}>
        <label htmlFor={`${id}-hex`}>{token.label}</label>
        <button
          type="button"
          className="textButton"
          onClick={() => onReveal(colorKey)}
          aria-label={`Show ${token.label} in preview`}
        >
          Show in preview ↗
        </button>
      </div>
      <p id={`${id}-help`}>{token.description}</p>
      <div className={styles.colorInputs}>
        <div
          className={styles.picker}
          style={{ "--swatch": value } as CSSProperties}
        >
          <input
            type="color"
            value={value.slice(0, 7)}
            onInput={changePicker}
            disabled={locked}
            aria-label={`${token.label} color picker`}
          />
        </div>
        <input
          id={`${id}-hex`}
          value={rawValue}
          onChange={(event) => onChange(colorKey, event.target.value)}
          readOnly={locked}
          spellCheck={false}
          maxLength={9}
          aria-invalid={invalid}
          aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ""}`}
        />
        <label className={styles.opacity}>
          Opacity <span>{Math.round((alpha / 255) * 100)}%</span>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round((alpha / 255) * 100)}
            onInput={changeAlpha}
            disabled={locked}
            aria-label={`${token.label} opacity`}
          />
        </label>
      </div>
      {invalid && (
        <Appearance kind="fade"><span id={`${id}-error`} className="fieldError">
          Use #RGB, #RGBA, #RRGGBB or #RRGGBBAA.
        </span></Appearance>
      )}
    </div>
  );
}

function ThemeEditor({
  record,
  source,
  initialName,
  onSaved,
  onCancel,
  onDuplicate,
  onDelete,
}: {
  record: Theme | null;
  source: Theme;
  initialName: string;
  onSaved: (theme: Theme) => void;
  onCancel: () => void;
  onDuplicate: (theme: Theme) => void;
  onDelete: (theme: Theme) => void;
}) {
  const [draft, setDraft] = useState<ThemeInput>(() => ({
    name: record?.name ?? initialName,
    mode: source.mode,
    colors: { ...source.colors },
  }));
  const [raw, setRaw] = useState<Partial<ThemeColors>>({});
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ThemeColorKey | null>(null);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const [busy, setBusy] = useState(false);
  const controlList = useRef<HTMLDivElement>(null);
  const previewColumn = useRef<HTMLDetailsElement>(null);
  const [previewOpen, setPreviewOpen] = useState(() => window.matchMedia("(min-width: 1001px)").matches);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1001px)");
    function handleWidth() { setPreviewOpen(wide.matches); }
    wide.addEventListener("change", handleWidth);
    return () => wide.removeEventListener("change", handleWidth);
  }, []);
  const nameId = useId();
  const modeId = useId();
  const searchId = useId();
  const save = useTheme((state) => state.save);
  const updateSettings = useSettings((state) => state.update);
  const activeId = useSettings(
    (state) => state.snapshot.settings.activeThemeId,
  );
  const attempt = useNavigationGuard();
  const locked = !!record?.builtIn;
  const invalid = Object.values(raw).some((value) => !hexColor.test(value));
  const dirty =
    !locked &&
    (!record ||
      draft.name !== record.name ||
      draft.mode !== record.mode ||
      colorKeys.some((key) => draft.colors[key] !== record.colors[key]) ||
      invalid);
  useUnsavedChanges(dirty);
  const warnings = useMemo(() => contrastWarnings(draft), [draft]);
  const matching = colorKeys.filter((key) => {
    const token = catalog.tokens[key];
    return `${token.label} ${token.description} ${token.group} ${key} ${token.components.join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase());
  });
  function handleColor(key: ThemeColorKey, value: string) {
    setRaw((current) => ({ ...current, [key]: value }));
    if (hexColor.test(value))
      setDraft((current) => ({
        ...current,
        colors: { ...current.colors, [key]: normalizeColor(value) },
      }));
  }
  function handleReveal(key: ThemeColorKey) {
    setSelected(key);
    setPreviewOpen(true);
    previewColumn.current?.scrollIntoView({
      block: "nearest",
      behavior: "instant",
    });
  }
  function handleInspect(key: ThemeColorKey) {
    setSelected(key);
    setQuery("");
    requestAnimationFrame(() => {
      const row = controlList.current?.querySelector<HTMLElement>(
        `#color-${key}`,
      );
      const group = row?.closest("details");
      if (group) group.open = true;
      row
        ?.querySelector<HTMLInputElement>(
          'input[type="text"], input:not([type])',
        )
        ?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  }
  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (busy || locked) return;
    const invalidName = !draft.name.trim() || draft.name.length > 120;
    setNameError(
      invalidName ? "Enter a name between 1 and 120 characters." : "",
    );
    if (invalid || invalidName) {
      setError("Correct the highlighted fields before saving.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onSaved(await save(record?.id ?? null, draft));
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof RequestError)
        setNameError(failure.fields.name ?? "");
    } finally {
      setBusy(false);
    }
  }
  function handleCancel() {
    attempt(onCancel);
  }
  function handleUse() {
    if (record)
      attempt(() => void updateSettings({ activeThemeId: record.id }));
  }
  function handleDuplicate() {
    if (record) attempt(() => onDuplicate(record));
  }
  function handleDelete() {
    if (record) attempt(() => onDelete(record));
  }
  return (
    <AppearanceGroup>
    <form className={styles.editor} onSubmit={handleSave} aria-busy={busy}>
      <div className={styles.editorHeading}>
        <div data-appearance-content>
          <h2>
            {locked ? "Default theme" : record ? "Edit theme" : "Create theme"}
          </h2>
          <p>
            {locked
              ? "These colors are locked. Duplicate this theme to make it your own."
              : "Explore each color in the preview. Changes stay here until you save."}
          </p>
        </div>
        <span className={styles.state} data-appearance-content>
          {locked ? (
            <>
              <LockKeyhole size={13} /> Locked
            </>
          ) : dirty ? (
            "Unsaved changes"
          ) : (
            "Saved"
          )}
        </span>
      </div>
      <fieldset className={styles.editorFields} disabled={busy}>
        <div className={styles.editLayout}>
          <div className={styles.colorList} ref={controlList} data-appearance-content>
        <div className={styles.identity}>
          <div className="field">
            <label htmlFor={nameId}>Theme name</label>
            <input
              id={nameId}
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              readOnly={locked}
              maxLength={120}
              aria-invalid={!!nameError}
              aria-describedby={nameError ? `${nameId}-error` : undefined}
            />
            {nameError && (
              <Appearance kind="fade"><span id={`${nameId}-error`} className="fieldError">
                {nameError}
              </span></Appearance>
            )}
          </div>
          <div className="field">
            <label htmlFor={modeId}>Native controls</label>
            <select
              id={modeId}
              value={draft.mode}
              disabled={locked}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  mode: event.target.value as Theme["mode"],
                }))
              }
              aria-describedby={`${modeId}-hint`}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <span id={`${modeId}-hint`} className="fieldHint">
              Choose light or dark browser menus and built-in controls.
            </span>
          </div>
        </div>
            <label className="field" htmlFor={searchId}>
              Find a color or component
              <input
                id={searchId}
                type="search"
                placeholder="Try buttons, canvas or borders"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {catalog.groups.map((group) => {
              const keys = matching.filter(
                (key) => catalog.tokens[key].group === group,
              );
              if (!keys.length) return null;
              return (
                <Disclosure key={group}><details
                  open={
                    !!query ||
                    (!!selected && keys.includes(selected)) ||
                    group === "Surfaces"
                  }
                  className={styles.colorGroup}
                >
                  <summary>
                    {group}
                    <span>
                      {keys.length} {keys.length === 1 ? "color" : "colors"}
                    </span>
                  </summary>
                  {keys.map((key) => (
                    <ColorControl
                      key={key}
                      colorKey={key}
                      value={draft.colors[key]}
                      rawValue={raw[key] ?? draft.colors[key]}
                      locked={locked}
                      selected={selected === key}
                      onSelect={setSelected}
                      onReveal={handleReveal}
                      onChange={handleColor}
                    />
                  ))}
                </details></Disclosure>
              );
            })}
            {!matching.length && (
              <Appearance kind="fade">
              <p className={styles.help}>
                No matching colors. Try a component name.
              </p>
              </Appearance>
            )}
          </div>
          <details ref={previewColumn} className={styles.previewColumn} open={previewOpen}
            onToggle={(event) => setPreviewOpen(event.currentTarget.open)}>
            <summary><span>Live preview</span><ChevronDown size={16} /></summary>
            <p className={styles.help}>
              Select a preview swatch to find its color control. Preview buttons
              also show hover and focus states.
            </p>
            <ThemePreview
              input={draft}
              selected={selected}
              onInspect={handleInspect}
            />
            {!!warnings.length && (
              <Disclosure><details className={styles.contrast}>
                <summary>Contrast suggestions ({warnings.length})</summary>
                <p>These suggestions do not prevent saving.</p>
                <ul>
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details></Disclosure>
            )}
          </details>
        </div>
      </fieldset>
      <div className={styles.editorActions}>
        {error && (
          <Appearance kind="fade"><p className="error" role="alert">
            {error}
          </p></Appearance>
        )}
        <div className={styles.actions} data-appearance-content>
          {!locked && (
            <>
              <button
                className="button primary"
                type="submit"
                disabled={busy || (!dirty && !!record)}
              >
                {busy ? "Saving…" : "Save theme"}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={handleCancel}
                disabled={busy}
              >
                Cancel
              </button>
            </>
          )}
          {record && (
            <>
              <button
                className="button secondary"
                type="button"
                onClick={handleUse}
                disabled={busy || record.id === activeId}
              >
                {record.id === activeId ? (
                  <>
                    <Check size={14} /> In use
                  </>
                ) : (
                  "Use theme"
                )}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={handleDuplicate}
                disabled={busy}
              >
                <Copy size={14} />
                {locked ? "Duplicate to customize" : "Duplicate"}
              </button>
              {!locked && (
                <button
                  className="button deleteButton"
                  type="button"
                  onClick={handleDelete}
                  disabled={busy}
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </form>
    </AppearanceGroup>
  );
}

export default function Themes() {
  const themes = useTheme((state) => state.themes);
  const active = useSettings((state) => state.snapshot.activeTheme);
  const total = useTheme((state) => state.total);
  const offset = useTheme((state) => state.offset);
  const loading = useTheme((state) => state.loading);
  const error = useTheme((state) => state.error);
  const load = useTheme((state) => state.load);
  const updateSettings = useSettings((state) => state.update);
  const remove = useTheme((state) => state.remove);
  const attempt = useNavigationGuard();
  const [editor, setEditor] = useState<{
    record: Theme | null;
    source: Theme;
    initialName: string;
    sequence: number;
  }>(() => ({
    record: active,
    source: active,
    initialName: active.name,
    sequence: 0,
  }));
  const [editing, setEditing] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [baseId, setBaseId] = useState(active.id);
  const [deleting, setDeleting] = useState<Theme | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  useEffect(() => {
    void load();
  }, [load]);
  function show(theme: Theme) {
    setEditing(true);
    setEditor((current) => ({
      record: theme,
      source: theme,
      initialName: theme.name,
      sequence: current.sequence + 1,
    }));
  }
  function handleOpen(theme: Theme) {
    attempt(() => show(theme));
  }
  function handleSaved(theme: Theme) {
    if (!editor.record) setCreatedId(theme.id);
    show(theme);
  }
  function handleLoadMore() {
    setCreatedId(null);
    void load(true);
  }
  function clearCreatedAppearance() {
    setCreatedId(null);
  }
  function handleDuplicate(theme: Theme) {
    setEditing(true);
    setEditor((current) => ({
      record: null,
      source: theme,
      initialName: `${theme.name.slice(0, 115)} copy`,
      sequence: current.sequence + 1,
    }));
  }
  function handleCreate() {
    attempt(() => {
      setBaseId(active.id);
      setCreating(true);
    });
  }
  function handleChooseBase(event: FormEvent) {
    event.preventDefault();
    const source =
      themes.find((theme) => theme.id === baseId) ??
      (active.id === baseId ? active : defaultThemes[0]!);
    setCreating(false);
    setEditing(true);
    setEditor((current) => ({
      record: null,
      source,
      initialName: "",
      sequence: current.sequence + 1,
    }));
  }
  function handleCancel() {
    setEditing(false);
  }
  function handleDelete(theme: Theme) {
    setDeleteError("");
    setDeleting(theme);
  }
  async function handleConfirmDelete() {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await remove(deleting.id);
      setEditing(false);
      setDeleting(null);
    } catch (failure) {
      setDeleteError(errorMessage(failure));
    } finally {
      setDeleteBusy(false);
    }
  }
  const choices = themes.some((theme) => theme.id === active.id)
    ? themes
    : [...themes, active];
  return (
    <section className={styles.page}>
      <header className="pageHeader">
        <div>
          <h1>
            {editing ? "Theme editor" : "Themes"}
          </h1>
          <p>{editing ? "Your colors, with a preview that stays separate." : "Choose a theme or make it your own."}</p>
        </div>
        {editing ? (
          <button className="button secondary" onClick={() => attempt(() => setEditing(false))}>
            <ArrowLeft size={15} /> Back to library
          </button>
        ) : (
          <button className="button primary" onClick={handleCreate}>
            <Plus size={15} /> Create theme
          </button>
        )}
      </header>
      <div className={`${styles.content} ${editing ? styles.editingContent : ""}`}>
        {!editing && <>
        {error && (
          <Appearance kind="fade">
          <div className={styles.notice} role="alert">
            {error}
            <button className="textButton" onClick={() => void load()}>
              Retry loading
            </button>
          </div>
          </Appearance>
        )}
        <div className={styles.library} aria-label="Theme library">
          {choices.map((theme) => (
            <Appearance key={theme.id} kind="fade" ready={theme.id === createdId}><article
              onAnimationEnd={clearCreatedAppearance}
              className={`${styles.card} ${active.id === theme.id ? styles.cardSelected : ""}`}
            >
              <button
                className={styles.cardOpen}
                onClick={() => handleOpen(theme)}
                aria-label={`${theme.builtIn ? "Inspect" : "Edit"} ${theme.name}`}
              >
                <span className={styles.miniPreview} style={themeStyle(theme)}>
                  <span className={styles.miniSidebar}>
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className={styles.miniContent}>
                    <i />
                    <span>
                      <i />
                      <i />
                    </span>
                    <b />
                  </span>
                </span>
                <span className={styles.cardTitle}>
                  {theme.name}
                  {theme.builtIn && <LockKeyhole size={13} />}
                </span>
                <span className={styles.cardMeta}>
                  {theme.builtIn
                    ? "Built-in · Locked"
                    : `${theme.mode === "dark" ? "Dark" : "Light"} controls · Custom`}
                  {theme.id === active.id && (
                    <span>
                      <Check size={12} />
                      Active
                    </span>
                  )}
                </span>
              </button>
              <div className={styles.cardActions}>
                <button
                  type="button"
                  className="textButton"
                  onClick={() =>
                    attempt(
                      () => void updateSettings({ activeThemeId: theme.id }),
                    )
                  }
                  disabled={theme.id === active.id}
                >
                  {theme.id === active.id ? "In use" : "Use theme"}
                </button>
                <button
                  type="button"
                  className="textButton"
                  onClick={() => attempt(() => handleDuplicate(theme))}
                  aria-label={`Duplicate ${theme.name}`}
                >
                  <Copy size={13} />
                  Duplicate
                </button>
              </div>
            </article></Appearance>
          ))}
        </div>
        {loading && (
          <Appearance kind="fade"><p className={styles.help} role="status">
            Loading themes…
          </p></Appearance>
        )}
        {!loading && offset < total && !error && (
          <button className="button secondary" onClick={handleLoadMore}>
            Load more themes
          </button>
        )}
        </>}
        {editing && <Appearance kind="selection" trigger={editor.record?.id ?? editor.sequence}>
          <div className={styles.editorEntrance}>
          <ThemeEditor
          key={editor.sequence}
          {...editor}
          onSaved={handleSaved}
          onCancel={handleCancel}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
        />
          </div>
        </Appearance>}
      </div>
      {creating && (
        <Dialog title="Create a theme" onClose={() => setCreating(false)}>
          <form onSubmit={handleChooseBase}>
            <label className="field">
              Start with a theme
              <select
                value={baseId}
                onChange={(event) => setBaseId(event.target.value)}
              >
                {choices.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
            </label>
            <p className={styles.help}>
              Your new theme begins with these colors. The original stays saved.
            </p>
            <div className="dialogActions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
              <button className="button primary" type="submit">
                Continue to editor
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          title="Delete theme?"
          onClose={() => setDeleting(null)}
          busy={deleteBusy}
        >
          <p>
            Delete “{deleting.name}”? This cannot be undone.
            {deleting.id === active.id
              ? " Your setup will switch to Light Mode."
              : ""}
          </p>
          {deleteError && (
            <Appearance kind="fade"><p className="error" role="alert">
              {deleteError}
            </p></Appearance>
          )}
          <div className="dialogActions">
            <button
              className="button secondary"
              onClick={() => setDeleting(null)}
              disabled={deleteBusy}
            >
              Cancel
            </button>
            <button
              className="button danger"
              onClick={() => void handleConfirmDelete()}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Deleting…" : "Delete theme"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
