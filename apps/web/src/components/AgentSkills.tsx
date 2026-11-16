import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  memo,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useStore } from "zustand";
import {
  ArrowLeft,
  Copy,
  FolderOpen,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react";
import type {
  SkillDetail,
  SkillInput,
  SkillInstallation,
} from "../../../server/src/skill-types";
import { errorMessage, request, RequestError } from "../api";
import { useAgents } from "../agent-store";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import {
  defaultSkillFilters,
  skillPageKey,
  useSkillsStore,
  type SkillFilters,
} from "../skills-store";
import { Dialog } from "./Dialog";
import { Field } from "./FormField";
import { Tooltip } from "./Tooltip";
import { SkillSwitch } from "./SkillSwitch";
import styles from "./AgentSkills.module.scss";

const emptySkill: SkillInput = { name: "", description: "", instructions: "" };
const encode = encodeURIComponent;
const inputFrom = (skill: SkillDetail): SkillInput => ({
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  ...(skill.license !== undefined ? { license: skill.license } : {}),
  ...(skill.compatibility !== undefined
    ? { compatibility: skill.compatibility }
    : {}),
  ...(skill.metadata ? { metadata: skill.metadata } : {}),
  ...(skill["allowed-tools"] !== undefined
    ? { "allowed-tools": skill["allowed-tools"] }
    : {}),
});

const SkillRow = memo(function SkillRow({
  agentId,
  id,
  onOpen,
  onToggle,
  busy,
}: {
  agentId: string;
  id: string;
  onOpen: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  busy: boolean;
}) {
  const store = useSkillsStore();
  const skill = useStore(store, (s) => s.library[id]);
  const enabled = useStore(store, (s) => s.enabled[agentId]?.[id] ?? false);
  if (!skill) return null;
  return (
    <li className={styles.row} data-skill-id={id}>
      <button
        className={styles.identity}
        type="button"
        onClick={() => onOpen(id)}
      >
        <span className={styles.name}>{skill.id === "builtin-browser" ? "browser" : skill.name}</span>
        <span className={styles.description}>{skill.description}</span>
        {skill.error && (
          <span className={styles.invalid}>Unavailable — open for details</span>
        )}
      </button>
      <span className={styles.kind}>
        {skill.builtIn ? "Built-in" : "Custom"}
      </span>
      <SkillSwitch
        aria-label={`Enable ${skill.id === "builtin-browser" ? "browser" : skill.name} for this agent`}
        checked={enabled}
        disabled={busy}
        onChange={(event) => onToggle(id, event.target.checked)}
      />
    </li>
  );
});

function SkillEditor({
  initial,
  revision,
  onSave,
  onCancel,
  busy,
}: {
  initial: SkillInput;
  revision?: number;
  onSave: (input: SkillInput, expectedRevision?: number) => Promise<void>;
  onCancel: () => void;
  busy: boolean;
}) {
  const [baseline] = useState(initial);
  const [startingRevision] = useState(revision);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const dirty = JSON.stringify(baseline) !== JSON.stringify(draft);
  useUnsavedChanges(dirty);
  const form = useRef<HTMLFormElement>(null);
  const guard = useNavigationGuard();
  useEffect(() => {
    form.current
      ?.querySelector<HTMLElement>(revision ? "textarea" : "input")
      ?.focus();
  }, [revision]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await onSave(draft, startingRevision);
    } catch (error) {
      setError(errorMessage(error));
      form.current?.querySelector<HTMLInputElement>("input")?.focus();
    }
  }
  function change(key: keyof SkillInput, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  return (
    <form
      className={styles.editor}
      ref={form}
      onSubmit={(event) => void submit(event)}
    >
      <div className={styles.fields}>
        <h3>{revision ? "Edit Skill" : "Create Skill"}</h3>
        <p className={styles.muted}>
          {revision
            ? "Saved changes affect every agent with this skill enabled."
            : "This skill will appear on all agents and start enabled only for this agent."}
        </p>
        <Field
          label="Name"
          hint="Lowercase letters, numbers and single hyphens."
        >
          {(props) => (
            <input
              {...props}
              value={draft.name}
              maxLength={64}
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              disabled={!!revision}
              onChange={(event) => change("name", event.target.value)}
            />
          )}
        </Field>
        <Field
          label="Description"
          hint="Explain what the skill does and when to use it."
        >
          {(props) => (
            <textarea
              {...props}
              value={draft.description}
              maxLength={1024}
              required
              rows={3}
              onChange={(event) => change("description", event.target.value)}
            />
          )}
        </Field>
        <Field
          label="Instructions"
          hint="Markdown. Reference bundled files using relative paths."
        >
          {(props) => (
            <textarea
              {...props}
              className={styles.instructionsInput}
              value={draft.instructions}
              maxLength={30000}
              rows={12}
              onChange={(event) => change("instructions", event.target.value)}
            />
          )}
        </Field>
        <Field label="License (optional)">
          {(props) => (
            <input
              {...props}
              value={draft.license ?? ""}
              maxLength={2000}
              onChange={(event) => change("license", event.target.value)}
            />
          )}
        </Field>
        <Field label="Compatibility (optional)">
          {(props) => (
            <input
              {...props}
              value={draft.compatibility ?? ""}
              maxLength={500}
              onChange={(event) => change("compatibility", event.target.value)}
            />
          )}
        </Field>
        <Field label="Author (optional)">
          {(props) => (
            <input
              {...props}
              value={draft.metadata?.author ?? ""}
              maxLength={2000}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  metadata: { ...current.metadata, author: event.target.value },
                }))
              }
            />
          )}
        </Field>
        <Field label="Version (optional)">
          {(props) => (
            <input
              {...props}
              value={draft.metadata?.version ?? ""}
              maxLength={2000}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  metadata: {
                    ...current.metadata,
                    version: event.target.value,
                  },
                }))
              }
            />
          )}
        </Field>
        {error && (
          <p className="errorBanner" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className={styles.footer}>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => guard(onCancel)}
        >
          Cancel
        </button>
        <button className="button primary" disabled={busy}>
          {busy ? "Saving…" : "Save Skill"}
        </button>
      </div>
    </form>
  );
}

export function AgentSkills({ agentId }: { agentId: string }) {
  const store = useSkillsStore(),
    guard = useNavigationGuard();
  const eventVersion = useAgents((s) => s.eventVersion);
  const [filters, setFilters] = useState<SkillFilters>(defaultSkillFilters);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const key = skillPageKey(agentId, filters);
  const page = useStore(store, (s) => s.pages[key]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [editing, setEditing] = useState(false),
    [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [installing, setInstalling] = useState(false),
    [replace, setReplace] = useState<SkillDetail | null>(null),
    [url, setUrl] = useState("");
  const [installation, setInstallation] = useState<SkillInstallation | null>(
    null,
  );
  const [removing, setRemoving] = useState(false);
  const scroll = useRef<HTMLDivElement>(null),
    listPosition = useRef(0),
    detailSequence = useRef(0),
    readSequence = useRef(0);
  const returnFocus = useRef<HTMLButtonElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null),
    lastOpened = useRef<string | null>(null);
  const prefix = useId();

  const load = useCallback(
    async (more = false) => {
      const sequence = ++readSequence.current;
      setLoading(true);
      try {
        await store.getState().load(agentId, filters, more);
      } catch (error) {
        if (sequence === readSequence.current) setError(errorMessage(error));
      } finally {
        if (sequence === readSequence.current) setLoading(false);
      }
    },
    [store, agentId, filters],
  );
  useEffect(() => {
    void load();
    return () => {
      readSequence.current++;
    };
  }, [load, eventVersion, refreshVersion]);
  useEffect(() => {
    let active = true;
    let refreshing = false;
    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        await request("/skills/refresh", "POST");
        if (active) {
          store.getState().invalidate();
          setRefreshVersion((value) => value + 1);
        }
      } catch (error) {
        if (active) setError(errorMessage(error));
      } finally {
        refreshing = false;
      }
    }
    void refresh();
    function focused() {
      if (document.visibilityState !== "hidden") void refresh();
    }
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", focused);
    return () => {
      active = false;
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", focused);
    };
  }, [store, agentId]);
  useEffect(() => {
    const sequence = ++detailSequence.current;
    if (!selected) return;
    const controller = new AbortController();
    void request<SkillDetail>(
      `/skills/${encode(selected)}?agentId=${encode(agentId)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted && sequence === detailSequence.current)
          setDetail(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted && sequence === detailSequence.current)
          setError(errorMessage(error));
      });
    return () => {
      controller.abort();
    };
  }, [selected, agentId, eventVersion]);
  useLayoutEffect(() => {
    if (!selected && !creating && scroll.current) {
      scroll.current.scrollTop = listPosition.current;
      if (lastOpened.current)
        scroll.current
          .querySelector<HTMLButtonElement>(
            `[data-skill-id="${lastOpened.current}"] button`,
          )
          ?.focus({ preventScroll: true });
    }
    if (selected && !editing)
      detailHeading.current?.focus({ preventScroll: true });
  }, [selected, creating, editing, detail?.id, key]);
  const open = useCallback((id: string) => {
    listPosition.current = scroll.current?.scrollTop ?? 0;
    setError("");
    setDetail(null);
    lastOpened.current = id;
    setSelected(id);
  }, []);
  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      setToggling(id);
      setError("");
      try {
        await store.getState().toggle(agentId, id, enabled);
        setDetail((current) =>
          current?.id === id ? { ...current, enabled } : current,
        );
        await load();
      } catch (error) {
        setError(errorMessage(error));
      } finally {
        setToggling(null);
      }
    },
    [store, agentId, load],
  );
  async function refresh() {
    setError("");
    try {
      await request("/skills/refresh", "POST");
      await load();
      if (selected)
        setDetail(
          await request<SkillDetail>(
            `/skills/${encode(selected)}?agentId=${encode(agentId)}`,
          ),
        );
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function folder(id?: string) {
    setError("");
    try {
      await request(
        id ? `/skills/${encode(id)}/open-folder` : "/skills/open-folder",
        "POST",
      );
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function copy(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setNotice("Folder path copied.");
    } catch {
      setError("Could not copy the path. Select and copy it from the details.");
    }
  }
  function back() {
    setEditing(false);
    setCreating(false);
    setSelected(null);
    setDetail(null);
    setError("");
  }
  async function save(input: SkillInput, expectedRevision?: number) {
    setBusy(true);
    try {
      store.getState().invalidate();
      const saved = await request<SkillDetail>(
        detail && editing ? `/skills/${encode(detail.id)}` : "/skills",
        detail && editing ? "PATCH" : "POST",
        {
          agentId,
          skill: input,
          ...(detail && editing ? { expectedRevision } : {}),
        },
      );
      store.getState().invalidate();
      setDetail(saved);
      setSelected(saved.id);
      setCreating(false);
      setEditing(false);
      await load();
    } finally {
      setBusy(false);
    }
  }
  function beginInstall(replacement?: SkillDetail) {
    setReplace(replacement ?? null);
    setUrl("");
    setInstallation(null);
    setInstalling(true);
    setError("");
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const data = new FormData();
      data.append("agentId", agentId);
      data.append("file", file);
      const response = await fetch("/api/skills/installations", {
        method: "POST",
        body: data,
      });
      const result = await response.json();
      if (!response.ok)
        throw new RequestError(
          result.error ?? "Could not inspect this package.",
        );
      setInstallation(result as SkillInstallation);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }
  async function inspect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setInstallation(
        await request<SkillInstallation>("/skills/installations", "POST", {
          agentId,
          url,
        }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function commit(candidate: SkillInstallation["candidates"][number]) {
    if (!installation) return;
    setBusy(true);
    setError("");
    try {
      store.getState().invalidate();
      const saved = await request<SkillDetail>(
        `/skills/installations/${encode(installation.id)}/commit`,
        "POST",
        {
          agentId,
          candidateKey: candidate.key,
          ...(replace
            ? { replaceId: replace.id, expectedRevision: replace.revision }
            : {}),
        },
      );
      store.getState().invalidate();
      void request(
        `/skills/installations/${encode(installation.id)}`,
        "DELETE",
        { agentId },
      ).catch(() => {});
      setInstalling(false);
      setInstallation(null);
      setSelected(saved.id);
      setDetail(saved);
      setNotice("Skill installed.");
      await load();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function closeInstall() {
    setInstalling(false);
    setError("");
    if (installation)
      void request(
        `/skills/installations/${encode(installation.id)}`,
        "DELETE",
        { agentId },
      ).catch(() => {});
    setInstallation(null);
  }
  async function remove() {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      store.getState().invalidate();
      await request(`/skills/${encode(detail.id)}`, "DELETE", {
        expectedRevision: detail.revision,
        confirmed: true,
      });
      store.getState().invalidate();
      setRemoving(false);
      back();
      await load();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function changeFilter(key: keyof SkillFilters, value: string) {
    listPosition.current = 0;
    setFilters((current) => ({ ...current, [key]: value }));
  }

  if (creating || (editing && detail))
    return (
      <SkillEditor
        key={creating ? "create" : detail!.id}
        initial={creating ? emptySkill : inputFrom(detail!)}
        revision={creating ? undefined : detail!.revision}
        onSave={save}
        onCancel={() => {
          setEditing(false);
          setCreating(false);
        }}
        busy={busy}
      />
    );
  return (
    <section className={styles.skills} aria-label="Agent skills">
      <div className={styles.toolbar}>
        {selected ? (
          <button type="button" className="textButton" onClick={back}>
            <ArrowLeft size={16} aria-hidden />
            All skills
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button"
              ref={returnFocus}
              onClick={() => {
                listPosition.current = scroll.current?.scrollTop ?? 0;
                setCreating(true);
              }}
            >
              <Plus size={16} aria-hidden />
              Create Skill
            </button>
            <button
              type="button"
              className="button"
              onClick={() => beginInstall()}
            >
              <Upload size={16} aria-hidden />
              Install Skill
            </button>
          </>
        )}
        <div className={styles.tools}>
          <Tooltip content="Refresh skills">
            <button
              type="button"
              className="iconButton"
              aria-label="Refresh skills"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content="Open skills folder">
            <button
              type="button"
              className="iconButton"
              aria-label="Open skills folder"
              onClick={() =>
                void folder(
                  selected && detail && !detail.builtIn ? selected : undefined,
                )
              }
            >
              <FolderOpen size={16} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content="Copy folder path">
            <button
              type="button"
              className="iconButton"
              aria-label="Copy skills folder path"
              disabled={!page?.path && !detail}
              onClick={() => void copy(detail?.path ?? page!.path)}
            >
              <Copy size={16} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>
      {!installing && !removing && error && (
        <p role="alert" className="errorBanner">
          {error}
        </p>
      )}
      <p role="status" className={styles.feedback}>
        {notice}
      </p>
      {selected ? (
        <div className={styles.content} ref={scroll}>
          {!detail ? (
            <p className={styles.muted}>Loading skill…</p>
          ) : (
            <>
              <div className={styles.detailHeading}>
                <h3 ref={detailHeading} tabIndex={-1}>
                  {detail.id === "builtin-browser" ? "browser" : detail.name}
                </h3>
                <SkillSwitch
                  label="Enabled for this agent"
                  checked={detail.enabled}
                  disabled={toggling !== null}
                  onChange={(event) =>
                    void toggle(detail.id, event.target.checked)
                  }
                />
              </div>
              <p>{detail.description}</p>
              <p className={styles.muted}>
                {detail.builtIn
                  ? "Built-in · Read-only"
                  : "Custom · Shared across all agents"}
              </p>
              {detail.error && (
                <p className="errorBanner" role="alert">
                  {detail.error}
                </p>
              )}
              <dl className={styles.metadata}>
                <dt>Source</dt>
                <dd>
                  {detail.source.kind}
                  {detail.source.location && (
                    <>
                      {" "}
                      ·{" "}
                      <a
                        href={detail.source.location}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Original source
                      </a>
                    </>
                  )}
                </dd>
                {detail.metadata?.author && (
                  <>
                    <dt>Author</dt>
                    <dd>{detail.metadata.author}</dd>
                  </>
                )}
                {detail.metadata?.version && (
                  <>
                    <dt>Version</dt>
                    <dd>{detail.metadata.version}</dd>
                  </>
                )}
                {detail.license && (
                  <>
                    <dt>License</dt>
                    <dd>{detail.license}</dd>
                  </>
                )}
                {detail.compatibility && (
                  <>
                    <dt>Compatibility</dt>
                    <dd>{detail.compatibility}</dd>
                  </>
                )}
                {detail["allowed-tools"] && (
                  <>
                    <dt>Requested tools</dt>
                    <dd>
                      {detail["allowed-tools"]} (does not grant permissions)
                    </dd>
                  </>
                )}
                <dt>Enabled agents</dt>
                <dd>{detail.enabledAgents.length}</dd>
              </dl>
              {!detail.builtIn && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setEditing(true)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => beginInstall(detail)}
                  >
                    Replace Package
                  </button>
                  <button
                    type="button"
                    className="textButton"
                    onClick={() => setRemoving(true)}
                  >
                    Remove
                  </button>
                </div>
              )}
              <h4>Instructions</h4>
              <pre className={styles.instructions}>
                {detail.instructions || "No instructions."}
              </pre>
              <h4>Package files</h4>
              <code className={styles.path}>{detail.path}</code>
              <ul className={styles.files}>
                {detail.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    <span>
                      {new Intl.NumberFormat().format(file.size)} bytes
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <>
          <div className={styles.filters}>
            <label className={styles.search} htmlFor={`${prefix}-search`}>
              Search skills
              <input
                id={`${prefix}-search`}
                type="search"
                value={filters.query}
                onChange={(event) => changeFilter("query", event.target.value)}
              />
            </label>
            <label htmlFor={`${prefix}-status`}>
              Status
              <select
                id={`${prefix}-status`}
                value={filters.status}
                onChange={(event) => changeFilter("status", event.target.value)}
              >
                <option value="all">All</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label htmlFor={`${prefix}-origin`}>
              Origin
              <select
                id={`${prefix}-origin`}
                value={filters.origin}
                onChange={(event) => changeFilter("origin", event.target.value)}
              >
                <option value="all">All</option>
                <option value="builtin">Built-in</option>
                <option value="custom">Custom</option>
              </select>
            </label>
          </div>
          <div className={styles.content} ref={scroll}>
            <p className={styles.muted}>
              Installed skills are shared. Switches apply only to this agent.
            </p>
            {!page && loading ? (
              <p className={styles.muted}>Loading skills…</p>
            ) : !page?.ids.length ? (
              <p className={styles.muted}>No skills match these filters.</p>
            ) : (
              <ul className={styles.rows}>
                {page.ids.map((id) => (
                  <SkillRow
                    key={id}
                    id={id}
                    agentId={agentId}
                    onOpen={open}
                    onToggle={toggle}
                    busy={toggling !== null}
                  />
                ))}
              </ul>
            )}
            {page && (
              <div className={styles.pagination}>
                <span>
                  {page.ids.length} of {page.total} skills
                </span>
                {page.ids.length < page.total && (
                  <button
                    type="button"
                    className="textButton"
                    disabled={loading}
                    onClick={() => void load(true)}
                  >
                    {loading ? "Loading…" : "Load more"}
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
      {installing && (
        <Dialog
          title={replace ? "Replace Skill Package" : "Install Skill"}
          busy={busy}
          onClose={closeInstall}
          returnFocusFallbackRef={returnFocus}
        >
          <p>
            {replace
              ? `Replace ${replace.name} for all enabled agents. Existing toggles are preserved.`
              : "Add a public skill URL, upload SKILL.md, or upload a ZIP containing skill folders."}
          </p>
          {!installation ? (
            <>
              <form
                className={styles.installForm}
                onSubmit={(event) => void inspect(event)}
              >
                <Field label="Public skill URL">
                  {(props) => (
                    <input
                      {...props}
                      type="url"
                      required
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://github.com/owner/repository…"
                    />
                  )}
                </Field>
                <button className="button" disabled={busy}>
                  {busy ? "Inspecting…" : "Inspect URL"}
                </button>
              </form>
              <label className={styles.upload}>
                Upload package
                <input
                  type="file"
                  accept=".md,.zip"
                  disabled={busy}
                  onChange={(event) => void upload(event)}
                />
              </label>
            </>
          ) : (
            <>
              <p className={styles.muted}>
                Choose a skill to install. Nothing is installed until you select
                Install.
              </p>
              <ul className={styles.candidates}>
                {installation.candidates.map((candidate) => (
                  <li key={candidate.key}>
                    <strong>{candidate.name}</strong>
                    <p>{candidate.description}</p>
                    {candidate.warnings.map((warning) => (
                      <p className={styles.muted} key={warning}>
                        {warning}
                      </p>
                    ))}
                    {candidate.existingId &&
                      !candidate.identical &&
                      !replace && (
                        <p>
                          A different version is installed. Open that skill’s
                          details and choose Replace Package.
                        </p>
                      )}
                    <button
                      type="button"
                      className="button"
                      disabled={
                        busy ||
                        !!(
                          candidate.existingId &&
                          !candidate.identical &&
                          !replace
                        ) ||
                        !!(replace && candidate.name !== replace.name)
                      }
                      onClick={() => void commit(candidate)}
                    >
                      {busy
                        ? "Installing…"
                        : candidate.identical
                          ? "Use Installed Skill"
                          : "Install"}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {error && (
            <p className="errorBanner" role="alert">
              {error}
            </p>
          )}
          <div className={styles.footer}>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={closeInstall}
            >
              Cancel
            </button>
          </div>
        </Dialog>
      )}
      {removing && detail && (
        <Dialog
          title="Remove Shared Skill"
          busy={busy}
          onClose={() => setRemoving(false)}
          initialFocusSelector="button[data-cancel]"
          returnFocusFallbackRef={returnFocus}
        >
          <p>
            Remove {detail.name} from the shared library? This removes it from
            every agent and deletes its current package folder.
          </p>
          <p>
            Enabled on {detail.enabledAgents.length}{" "}
            {detail.enabledAgents.length === 1 ? "agent" : "agents"}:
          </p>
          <ul>
            {detail.enabledAgents.map((agent) => (
              <li key={agent.id}>{agent.name}</li>
            ))}
          </ul>
          {error && (
            <p className="errorBanner" role="alert">
              {error}
            </p>
          )}
          <div className={styles.footer}>
            <button
              type="button"
              data-cancel
              className="button"
              disabled={busy}
              onClick={() => setRemoving(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "Removing…" : "Remove Skill Everywhere"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
