import {
  memo,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { ArrowLeft, Plus, RefreshCw, Upload } from "lucide-react";
import type {
  McpAuthStatus,
  McpCapabilityKind,
  McpCapabilityPage,
  McpImportPreview,
  McpServerDetail,
  McpServerInput,
  McpServerSummary,
} from "../../../server/src/mcp-types";
import { errorMessage, request } from "../api";
import { useAgents } from "../agent-store";
import { refreshOnFocus } from "../focus-refresh";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import { createMcpStore } from "../mcp-store";
import { Dialog } from "./Dialog";
import { SkillSwitch } from "./SkillSwitch";
import styles from "./AgentMcp.module.scss";
function Field({
  id,
  label,
  children,
  className = "",
  error,
}: {
  id: string;
  label: string;
  children: ReactNode;
  className?: string;
  error?: string;
}) {
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>{label}</label>
      {isValidElement<{
        "aria-invalid"?: boolean;
        "aria-describedby"?: string;
      }>(children)
        ? cloneElement(children, {
            "aria-invalid": !!error,
            "aria-describedby": error ? `${id}-error` : undefined,
          })
        : children}
      {error && (
        <span className="fieldError" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}
const encode = encodeURIComponent;
const statuses = {
  not_connected: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  auth_required: "Sign-in required",
  error: "Connection error",
};
const kinds: { value: McpCapabilityKind; label: string }[] = [
  { value: "tools", label: "Tools" },
  { value: "resources", label: "Resources" },
  { value: "templates", label: "Resource templates" },
  { value: "prompts", label: "Prompts" },
];
interface Draft {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  cwd: string;
  url: string;
  authentication: "none" | "headers" | "oauth";
  env: string;
  headers: string;
  oauthClientId: string;
  oauthClientSecret: string;
  removeClientSecret: boolean;
}
function draftFrom(s?: McpServerDetail): Draft {
  return {
    name: s?.name ?? "",
    transport: s?.transport ?? "stdio",
    command: s?.command ?? "",
    args: JSON.stringify(s?.args ?? [], null, 2),
    cwd: s?.cwd ?? "",
    url: s?.url ?? "",
    authentication: s?.authentication ?? "none",
    env: "",
    headers: "",
    oauthClientId: s?.oauthClientId ?? "",
    oauthClientSecret: "",
    removeClientSecret: false,
  };
}
export function mcpDraftInput(d: Draft): McpServerInput {
  let args: unknown = [],
    env: unknown,
    headers: unknown;
  if (d.transport === "stdio") {
    try {
      args = JSON.parse(d.args);
    } catch {
      throw new Error("Arguments must be a JSON array of strings.");
    }
  }
  const changes =
    d.transport === "stdio"
      ? [["Environment variables", d.env]]
      : d.authentication !== "none"
        ? [["Headers", d.headers]]
        : [];
  for (const [label, value] of changes) {
    if (value?.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`${label} must be a JSON object.`);
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((v) => v !== null && typeof v !== "string")
      )
        throw new Error(
          `${label} must map names to strings, or null to remove a saved value.`,
        );
      if (label === "Headers") headers = parsed;
      else env = parsed;
    }
  }
  if (!Array.isArray(args) || args.some((v) => typeof v !== "string"))
    throw new Error("Arguments must be a JSON array of strings.");
  return {
    name: d.name,
    transport: d.transport,
    ...(d.transport === "stdio"
      ? {
          command: d.command,
          args,
          cwd: d.cwd,
          ...(env ? { env: env as McpServerInput["env"] } : {}),
        }
      : {
          url: d.url,
          authentication: d.authentication,
          ...(headers ? { headers: headers as McpServerInput["headers"] } : {}),
          oauthClientId: d.oauthClientId,
          ...(d.removeClientSecret
            ? { oauthClientSecret: null }
            : d.oauthClientSecret
              ? { oauthClientSecret: d.oauthClientSecret }
              : {}),
        }),
  };
}
const ServerRow = memo(function ServerRow({
  server,
  busy,
  onOpen,
  onToggle,
}: {
  server: McpServerSummary;
  busy: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  function open() {
    onOpen(server.id);
  }
  function toggle() {
    onToggle(server.id, !server.enabled);
  }
  return (
    <li className={styles.row}>
      <SkillSwitch
        checked={server.enabled}
        disabled={busy}
        onChange={toggle}
        aria-label={`Enable ${server.name} for this agent`}
      />
      <button
        className={styles.identity}
        onClick={open}
        data-mcp-id={server.id}
        title={server.name}
      >
        <span className={styles.name}>{server.name}</span>
        <span className={styles.status}>
          {server.transport === "stdio" ? "Local · stdio" : "Remote · HTTP"} ·{" "}
          {statuses[server.status]}
        </span>
      </button>
    </li>
  );
});
function Capabilities({
  server,
  agentId,
  version,
}: {
  server: McpServerDetail;
  agentId: string;
  version: number;
}) {
  const [kind, setKind] = useState<McpCapabilityKind>("tools"),
    [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [next, setNext] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [started, setStarted] = useState(false);
  const controller = useRef<AbortController | null>(null),
    sequence = useRef(0);
  const prefix = useId();
  useEffect(() => {
    sequence.current++;
    controller.current?.abort();
    setItems([]);
    setBusy(false);
    setNext(undefined);
    setStarted(false);
    setError("");
    return () => {
      sequence.current++;
      controller.current?.abort();
    };
  }, [kind, server.id, server.revision, server.enabled, version]);
  async function load(more = false) {
    const current = ++sequence.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true);
    setError("");
    try {
      const p = await request<McpCapabilityPage>(
        `/mcp/servers/${encode(server.id)}/capabilities?agentId=${encode(agentId)}&kind=${kind}&limit=25${more && next ? `&cursor=${encode(next)}` : ""}`,
        "GET",
        undefined,
        controller.current.signal,
      );
      if (current !== sequence.current) return;
      setItems((old) => (more ? [...old, ...p.items] : p.items));
      setNext(p.nextCursor);
      setStarted(true);
    } catch (e) {
      if (current === sequence.current) setError(errorMessage(e));
    } finally {
      if (current === sequence.current) setBusy(false);
    }
  }
  return (
    <section aria-label="MCP capabilities">
      <div className={styles.actions}>
        <label htmlFor={`${prefix}-kind`}>Capabilities</label>
        <select
          id={`${prefix}-kind`}
          value={kind}
          onChange={(e) => setKind(e.target.value as McpCapabilityKind)}
        >
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button"
          disabled={busy || !server.enabled}
          onClick={() => void load()}
        >
          {busy ? "Loading…" : started ? "Refresh" : "Load"}
        </button>
      </div>
      {error && (
        <p className="errorBanner" role="alert">
          {error}
        </p>
      )}
      {!server.enabled && (
        <p className={styles.help}>
          Enable this server to inspect its capabilities.
        </p>
      )}
      {started && !items.length && (
        <p className={styles.help}>
          This server has no{" "}
          {kinds.find((k) => k.value === kind)?.label.toLowerCase()}.
        </p>
      )}
      {items.map((item, i) => (
        <details
          className={styles.capability}
          key={String(item.uri ?? item.uriTemplate ?? item.name ?? i)}
        >
          <summary>
            {String(
              item.title ??
                item.name ??
                item.uri ??
                item.uriTemplate ??
                "Untitled",
            )}
          </summary>
          {typeof item.description === "string" && <p>{item.description}</p>}
          <pre
            className={styles.schema}
            tabIndex={0}
            aria-label="Capability definition"
          >
            {JSON.stringify(item, null, 2)}
          </pre>
        </details>
      ))}
      {next && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void load(true)}
        >
          Load more
        </button>
      )}
    </section>
  );
}
function ServerEditor({
  id,
  agentId,
  eventVersion,
  onBack,
  onSaved,
}: {
  id: string | null;
  agentId: string;
  eventVersion: number;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const guard = useNavigationGuard(),
    prefix = useId();
  const [saved, setSaved] = useState<McpServerDetail | null>(null),
    [baseline, setBaseline] = useState(() => draftFrom());
  const [draft, setDraft] = useState(() => draftFrom()),
    [editing, setEditing] = useState(!id);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!!id),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState(false),
    [auth, setAuth] = useState<McpAuthStatus | null>(null),
    [capVersion, setCapVersion] = useState(0);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const sequence = useRef(0),
    dirtyRef = useRef(false),
    busyRef = useRef(false),
    form = useRef<HTMLFormElement>(null),
    pendingFocus = useRef<string | null>(null);
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(baseline);
  useEffect(() => {
    dirtyRef.current = dirty;
    busyRef.current = busy;
  }, [dirty, busy]);
  useUnsavedChanges(dirty);
  useLayoutEffect(() => {
    if (busy || !pendingFocus.current) return;
    const field = pendingFocus.current;
    pendingFocus.current = null;
    const target = form.current?.querySelector<HTMLElement>(
      field === "first" ? "input,select,textarea" : `[id$="-${field}"]`,
    );
    target?.focus();
    target?.parentElement?.scrollIntoView?.({ block: "nearest" });
  }, [busy, error, inputErrors]);
  const refresh = useCallback(
    async (force = false) => {
      if (!id) return;
      const current = ++sequence.current;
      try {
        const d = await request<McpServerDetail>(
          `/mcp/servers/${encode(id)}?agentId=${encode(agentId)}`,
        );
        if (current !== sequence.current) return;
        // The editor's starting revision remains fixed while there are unsaved edits.
        if (force || (!dirtyRef.current && !busyRef.current)) {
          setSaved(d);
          const next = draftFrom(d);
          setDraft(next);
          setBaseline(next);
        } else
          setSaved((old) =>
            old
              ? {
                  ...old,
                  enabled: d.enabled,
                  status: d.status,
                  error: d.error,
                  authenticated: d.authenticated,
                  enabledAgents: d.enabledAgents,
                }
              : d,
          );
      } catch (e) {
        if (current === sequence.current) setError(errorMessage(e));
      } finally {
        if (current === sequence.current) setLoading(false);
      }
    },
    [id, agentId],
  );
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [refresh, eventVersion]);
  useEffect(
    () =>
      refreshOnFocus(async () => {
        await refresh();
      }),
    [refresh],
  );
  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    dirtyRef.current = true;
    setInputErrors((old) => (old[key] ? { ...old, [key]: "" } : old));
    setDraft((d) => ({ ...d, [key]: value }));
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setInputErrors({});
    setError("");
    setNotice("");
    if (!form.current?.reportValidity()) return;
    setBusy(true);
    busyRef.current = true;
    sequence.current++;
    try {
      const server = mcpDraftInput(draft);
      const d = await request<McpServerDetail>(
        id ? `/mcp/servers/${encode(id)}` : "/mcp/servers",
        id ? "PATCH" : "POST",
        {
          agentId,
          server,
          ...(saved ? { expectedRevision: saved.revision } : {}),
        },
      );
      dirtyRef.current = false;
      setSaved(d);
      const next = draftFrom(d);
      setDraft(next);
      setBaseline(next);
      setEditing(false);
      setAuth(null);
      setNotice("MCP server saved.");
      onSaved(d.id);
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      const field = message.startsWith("Arguments")
        ? "args"
        : message.startsWith("Environment variables")
          ? "env"
          : message.startsWith("Headers")
            ? "headers"
            : null;
      if (field) setInputErrors({ [field]: message });
      pendingFocus.current = field ?? "first";
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }
  async function action(
    kind: "connect" | "disconnect" | "sign-in" | "sign-out" | "toggle",
  ) {
    if (!saved) return;
    setBusy(true);
    busyRef.current = true;
    sequence.current++;
    setError("");
    setNotice("");
    try {
      if (kind === "toggle")
        await request(
          `/agents/${encode(agentId)}/mcp/servers/${encode(saved.id)}`,
          "PUT",
          { enabled: !saved.enabled },
        );
      else if (kind === "sign-in") {
        const status = await request<McpAuthStatus>(
          `/mcp/servers/${encode(saved.id)}/oauth/sign-in`,
          "POST",
          { agentId },
        );
        setAuth(status);
        setNotice(
          status.authorizationUrl
            ? "Open the sign-in link and finish signing in. The server connects automatically; then return here."
            : "MCP authentication is ready.",
        );
      } else
        await request(
          `/mcp/servers/${encode(saved.id)}/${kind === "sign-out" ? "oauth/sign-out" : kind}`,
          "POST",
          kind === "sign-out"
            ? { expectedRevision: saved.revision }
            : { agentId },
        );
      if (kind !== "sign-in") setAuth(null);
      await refresh(true);
      setCapVersion((v) => v + 1);
      onSaved(saved.id);
    } catch (e) {
      setError(errorMessage(e));
      await refresh(true);
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }
  async function beginRemove() {
    if (!saved) return;
    setBusy(true);
    setError("");
    try {
      const latest = await request<McpServerDetail>(
        `/mcp/servers/${encode(saved.id)}?agentId=${encode(agentId)}`,
      );
      setSaved(latest);
      setRemoving(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!saved) return;
    setBusy(true);
    busyRef.current = true;
    setError("");
    try {
      await request(`/mcp/servers/${encode(saved.id)}`, "DELETE", {
        confirmed: true,
        expectedRevision: saved.revision,
      });
      setRemoving(false);
      onBack();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }
  function back() {
    guard(onBack);
  }
  function cancelEdit() {
    guard(() => {
      setDraft(baseline);
      setEditing(false);
      setError("");
    });
  }
  function reload() {
    guard(() => {
      dirtyRef.current = false;
      void refresh(true);
    });
  }
  const readOnly = !editing || busy;
  return (
    <section className={styles.editor} aria-label="MCP server details">
      <div className={styles.toolbar}>
        <button className="textButton" disabled={busy} onClick={back}>
          <ArrowLeft size={14} aria-hidden />
          All servers
        </button>
        {saved && !editing && (
          <button
            className="button"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
        {saved && (
          <button className="textButton" disabled={busy} onClick={reload}>
            Reload saved
          </button>
        )}
      </div>
      {error && !removing && (
        <p className={`errorBanner ${styles.feedback}`} role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className={styles.content}>
          <p role="status">Loading MCP server…</p>
          {error && (
            <button className="button" onClick={() => void refresh()}>
              Retry
            </button>
          )}
        </div>
      ) : id && !saved ? (
        <div className={styles.content}>
          <button className="button" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <form
            id={`${prefix}-form`}
            ref={form}
            onSubmit={save}
            className={styles.fields}
          >
            <h3 className={styles.heading}>
              {saved?.name ?? "Add MCP server"}
            </h3>
            <p className={styles.help}>
              Configuration and credentials are shared across the installation.
              Enablement applies only to this agent.
            </p>
            {saved && !editing && (
              <>
                <SkillSwitch
                  checked={saved.enabled}
                  disabled={busy}
                  onChange={() => void action("toggle")}
                  label="Enabled for this agent"
                />
                <p className={styles.help} role="status">
                  {statuses[saved.status]}
                  {saved.authenticated ? " · OAuth signed in" : ""}
                </p>
                {saved.error && saved.error !== error && <p className="errorBanner" role="alert">{saved.error}</p>}
                {saved.authPending && !saved.authenticated && (
                  <p className={styles.help} role="status">
                    {auth?.authorizationUrl
                      ? "Waiting for sign-in to complete."
                      : "Waiting for sign-in. Use Sign In to retrieve the current link if you started from chat."}
                  </p>
                )}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !saved.enabled}
                    onClick={() => void action("connect")}
                  >
                    {saved.status === "connected"
                      ? "Reconnect"
                      : "Connect / Retry"}
                  </button>
                  <button
                    type="button"
                    className="textButton"
                    disabled={busy || saved.status === "not_connected"}
                    onClick={() => void action("disconnect")}
                  >
                    Disconnect
                  </button>
                </div>
                {saved.authentication === "oauth" && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className="button"
                      disabled={busy || !saved.enabled}
                      onClick={() => void action("sign-in")}
                    >
                      Sign In
                    </button>
                    <button
                      type="button"
                      className="textButton"
                      disabled={busy}
                      onClick={() => void action("sign-out")}
                    >
                      Sign Out for All Agents
                    </button>
                  </div>
                )}
                {auth?.authorizationUrl && !saved.authenticated && saved.authPending !== false && (
                  <a
                    className={styles.authLink}
                    href={auth.authorizationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Continue MCP Sign-In
                  </a>
                )}
                {saved.authentication === "oauth" && (
                  <p className={styles.help}>
                    OAuth callback:{" "}
                    {auth?.redirectUrl ??
                      saved.oauthRedirectUrl ??
                      "Shown when you start sign-in. Register it with your OAuth app when using a pre-registered client."}
                  </p>
                )}
              </>
            )}
            <Field label="Server name" id={`${prefix}-name`}>
              <input
                id={`${prefix}-name`}
                name="mcpName"
                autoComplete="off"
                required
                maxLength={120}
                value={draft.name}
                readOnly={readOnly}
                onChange={(e) => change("name", e.target.value)}
              />
            </Field>
            <Field label="Connection" id={`${prefix}-transport`}>
              <select
                id={`${prefix}-transport`}
                disabled={readOnly}
                value={draft.transport}
                onChange={(e) =>
                  change("transport", e.target.value as Draft["transport"])
                }
              >
                <option value="stdio">Local · stdio</option>
                <option value="http">Remote · Streamable HTTP</option>
              </select>
            </Field>
            {draft.transport === "stdio" ? (
              <>
                <Field label="Command" id={`${prefix}-command`}>
                  <input
                    id={`${prefix}-command`}
                    name="mcpCommand"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={draft.command}
                    readOnly={readOnly}
                    onChange={(e) => change("command", e.target.value)}
                    placeholder="npx…"
                  />
                </Field>
                <Field
                  label="Arguments (JSON array)"
                  id={`${prefix}-args`}
                  error={inputErrors.args}
                >
                  <textarea
                    id={`${prefix}-args`}
                    name="mcpArguments"
                    className={styles.code}
                    spellCheck={false}
                    value={draft.args}
                    readOnly={readOnly}
                    onChange={(e) => change("args", e.target.value)}
                  />
                </Field>
                <Field
                  label="Working directory (optional)"
                  id={`${prefix}-cwd`}
                >
                  <input
                    id={`${prefix}-cwd`}
                    name="mcpDirectory"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.cwd}
                    readOnly={readOnly}
                    onChange={(e) => change("cwd", e.target.value)}
                    placeholder="Defaults to this agent’s folder…"
                  />
                </Field>
                <p className={styles.help}>
                  Local commands run on the backend machine with its OS
                  permissions.
                </p>
                <p className={styles.help}>
                  Saved environment variables:{" "}
                  {saved?.envKeys.join(", ") || "None"}. Values are hidden.
                </p>
                {editing && (
                  <Field
                    label="Environment changes (JSON object)"
                    id={`${prefix}-env`}
                    error={inputErrors.env}
                  >
                    <textarea
                      id={`${prefix}-env`}
                      autoComplete="off"
                      spellCheck={false}
                      className={styles.code}
                      value={draft.env}
                      disabled={busy}
                      onChange={(e) => change("env", e.target.value)}
                      placeholder={'{"API_KEY":"value","OLD_KEY":null}…'}
                    />
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field label="Server URL" id={`${prefix}-url`}>
                  <input
                    id={`${prefix}-url`}
                    type="url"
                    name="mcpUrl"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={draft.url}
                    readOnly={readOnly}
                    onChange={(e) => change("url", e.target.value)}
                    placeholder="https://example.com/mcp…"
                  />
                </Field>
                <Field label="Authentication" id={`${prefix}-auth`}>
                  <select
                    id={`${prefix}-auth`}
                    value={draft.authentication}
                    disabled={readOnly}
                    onChange={(e) =>
                      change(
                        "authentication",
                        e.target.value as Draft["authentication"],
                      )
                    }
                  >
                    <option value="none">None</option>
                    <option value="headers">Headers / Bearer token</option>
                    <option value="oauth">OAuth</option>
                  </select>
                </Field>
                {draft.authentication !== "none" && (
                  <>
                    <p className={styles.help}>
                      Saved headers: {saved?.headerKeys.join(", ") || "None"}.
                      Values are hidden.
                    </p>
                    {editing && (
                      <Field
                        label="Header changes (JSON object)"
                        id={`${prefix}-headers`}
                        error={inputErrors.headers}
                      >
                        <textarea
                          id={`${prefix}-headers`}
                          autoComplete="off"
                          spellCheck={false}
                          className={styles.code}
                          value={draft.headers}
                          disabled={busy}
                          onChange={(e) => change("headers", e.target.value)}
                          placeholder={'{"Authorization":"Bearer token"}…'}
                        />
                      </Field>
                    )}
                  </>
                )}
                {draft.authentication === "oauth" && (
                  <>
                    <Field
                      label="OAuth client ID (optional)"
                      id={`${prefix}-client`}
                    >
                      <input
                        id={`${prefix}-client`}
                        name="mcpClientId"
                        autoComplete="off"
                        spellCheck={false}
                        value={draft.oauthClientId}
                        readOnly={readOnly}
                        onChange={(e) =>
                          change("oauthClientId", e.target.value)
                        }
                      />
                    </Field>
                    <p className={styles.help}>
                      Leave the client ID empty for automatic registration when
                      the server supports it.
                    </p>
                    {editing && (
                      <>
                        <Field
                          label="OAuth client secret (optional)"
                          id={`${prefix}-secret`}
                        >
                          <input
                            id={`${prefix}-secret`}
                            type="password"
                            name="mcpClientSecret"
                            autoComplete="new-password"
                            value={draft.oauthClientSecret}
                            disabled={busy || draft.removeClientSecret}
                            onChange={(e) =>
                              change("oauthClientSecret", e.target.value)
                            }
                            placeholder={
                              saved?.hasOAuthClientSecret
                                ? "Saved — leave blank to keep…"
                                : "Client secret…"
                            }
                          />
                        </Field>
                        {saved?.hasOAuthClientSecret && (
                          <label>
                            <input
                              type="checkbox"
                              checked={draft.removeClientSecret}
                              disabled={busy}
                              onChange={(e) =>
                                change("removeClientSecret", e.target.checked)
                              }
                            />{" "}
                            Remove saved client secret
                          </label>
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            )}
            {editing && (
              <p className={styles.help}>
                Leave secret changes blank to keep saved values. Set a JSON
                value to null to remove it. Save applies shared changes to every
                enabled agent.
              </p>
            )}
            {saved && !editing && (
              <>
                <p className={styles.help}>
                  Enabled agents:{" "}
                  {saved.enabledAgents.map((a) => a.name).join(", ") || "None"}.
                </p>
                <Capabilities
                  server={saved}
                  agentId={agentId}
                  version={capVersion}
                />
              </>
            )}
            {notice && (
              <p role="status" className={styles.help}>
                {notice}
              </p>
            )}
          </form>
          <div className={styles.footer}>
            {editing ? (
              <>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={id ? cancelEdit : back}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  form={`${prefix}-form`}
                  className="button primary"
                  disabled={busy}
                >
                  {busy ? "Saving…" : "Save Server"}
                </button>
              </>
            ) : (
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void beginRemove()}
              >
                Remove Shared Server
              </button>
            )}
          </div>
        </>
      )}
      {removing && saved && (
        <Dialog
          title="Remove shared MCP server?"
          onClose={() => setRemoving(false)}
          busy={busy}
          initialFocusSelector="[data-cancel]"
        >
          <p>
            Remove “{saved.name}” from the shared library and disconnect it for
            every agent?
          </p>
          <p>
            Enabled agents:{" "}
            {saved.enabledAgents.map((a) => a.name).join(", ") || "None"}.
          </p>
          {error && (
            <p className="errorBanner" role="alert">
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <button
              className="button"
              data-cancel
              disabled={busy}
              onClick={() => setRemoving(false)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "Removing…" : "Remove for All Agents"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
function ImportServers({
  agentId,
  onBack,
  onChanged,
}: {
  agentId: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [json, setJson] = useState(""),
    [preview, setPreview] = useState<McpImportPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [replacement, setReplacement] = useState<
    McpImportPreview["candidates"][number] | null
  >(null);
  const previewRef = useRef<string | null>(null),
    guard = useNavigationGuard(),
    prefix = useId();
  useUnsavedChanges(!!json.trim() || !!preview);
  useEffect(
    () => () => {
      const id = previewRef.current;
      if (id)
        void request(`/mcp/imports/${encode(id)}`, "DELETE", { agentId }).catch(
          () => {},
        );
    },
    [agentId],
  );
  async function inspect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (previewRef.current)
        await request(`/mcp/imports/${encode(previewRef.current)}`, "DELETE", {
          agentId,
        });
      const result = await request<McpImportPreview>("/mcp/imports", "POST", {
        agentId,
        config: json,
      });
      previewRef.current = result.id;
      setPreview(result);
      setJson("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit(candidate: McpImportPreview["candidates"][number]) {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await request(`/mcp/imports/${encode(preview.id)}/commit`, "POST", {
        agentId,
        candidateKey: candidate.key,
        ...(candidate.existingId
          ? {
              replaceId: candidate.existingId,
              expectedRevision: candidate.expectedRevision,
            }
          : {}),
      });
      setReplacement(null);
      onChanged();
      const remaining = preview.candidates.filter(
        (c) => c.key !== candidate.key,
      );
      if (!remaining.length) {
        setPreview(null);
        previewRef.current = null;
        onBack();
      } else setPreview({ ...preview, candidates: remaining });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.editor} aria-label="Import MCP servers">
      <div className={styles.toolbar}>
        <button
          className="textButton"
          disabled={busy}
          onClick={() => guard(onBack)}
        >
          <ArrowLeft size={14} aria-hidden />
          All servers
        </button>
      </div>
      <div className={styles.fields}>
        <h3 className={styles.heading}>Import MCP servers</h3>
        <p className={styles.help}>
          Paste a mcpServers JSON configuration. Previewing and saving imports
          do not launch local commands. New servers are enabled only for this
          agent.
        </p>
        {error && !replacement && (
          <p className="errorBanner" role="alert">
            {error}
          </p>
        )}
        {!preview ? (
          <form
            id={`${prefix}-import`}
            onSubmit={inspect}
            className={styles.fields}
          >
            <Field label="MCP configuration JSON" id={`${prefix}-json`}>
              <textarea
                id={`${prefix}-json`}
                className={styles.code}
                required
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                value={json}
                onChange={(e) => setJson(e.target.value)}
                placeholder={
                  '{"mcpServers":{"example":{"command":"node","args":["server.js"]}}}…'
                }
              />
            </Field>
          </form>
        ) : (
          <ul className={styles.rows}>
            {preview.candidates.map((c) => (
              <li className={styles.candidate} key={c.key}>
                <strong>{c.name}</strong>
                {c.disabled && !c.existingId && (
                  <p className={styles.help}>Starts disabled for this agent.</p>
                )}
                <p className={styles.help}>
                  {c.transport === "stdio"
                    ? "Local stdio"
                    : c.transport === "http"
                      ? "Remote HTTP"
                      : "Invalid configuration"}
                </p>
                {c.error ? (
                  <p className="errorBanner">{c.error}</p>
                ) : (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      c.existingId ? setReplacement(c) : void commit(c)
                    }
                  >
                    {c.existingId ? "Replace Existing…" : "Import Server"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.footer}>
        <button
          className="button"
          disabled={busy}
          onClick={() => guard(onBack)}
        >
          Cancel
        </button>
        {!preview && (
          <button
            className="button primary"
            form={`${prefix}-import`}
            disabled={busy}
          >
            {busy ? "Inspecting…" : "Preview Import"}
          </button>
        )}
      </div>
      {replacement && (
        <Dialog
          title="Replace shared MCP server?"
          onClose={() => setReplacement(null)}
          busy={busy}
          initialFocusSelector="[data-cancel]"
        >
          <p>
            Replace the shared configuration for “{replacement.name}”? This
            disconnects its sessions and affects every agent using it. Existing
            enable switches are preserved.
          </p>
          {error && (
            <p role="alert" className="errorBanner">
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <button
              className="button"
              data-cancel
              disabled={busy}
              onClick={() => setReplacement(null)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void commit(replacement)}
            >
              {busy ? "Replacing…" : "Replace Shared Server"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
export function AgentMcp({ agentId }: { agentId: string }) {
  const [store] = useState(() => createMcpStore(agentId));
  const items = useStore(store, (s) => s.items),
    total = useStore(store, (s) => s.total),
    loading = useStore(store, (s) => s.loading);
  const eventVersion = useAgents((s) => s.eventVersion);
  const [query, setQuery] = useState(""),
    [view, setView] = useState<"list" | "editor" | "import">("list"),
    [selected, setSelected] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null),
    [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null),
    position = useRef(0),
    lastOpened = useRef<string | null>(null),
    add = useRef<HTMLButtonElement>(null);
  const prefix = useId();
  const load = useCallback(
    async (more = false) => {
      try {
        await store.getState().load(query, more);
        setError("");
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [store, query],
  );
  useEffect(() => {
    void load();
  }, [load, eventVersion]);
  useEffect(
    () =>
      refreshOnFocus(async () => {
        await load();
      }),
    [load],
  );
  useEffect(() => () => store.getState().dispose(), [store]);
  useLayoutEffect(() => {
    if (view !== "list") return;
    if (scroll.current) scroll.current.scrollTop = position.current;
    const button = Array.from(
      scroll.current?.querySelectorAll<HTMLButtonElement>("[data-mcp-id]") ??
        [],
    ).find((b) => b.dataset.mcpId === lastOpened.current);
    if (lastOpened.current)
      (button ?? add.current)?.focus({ preventScroll: true });
  }, [view]);
  const open = useCallback((id: string) => {
    position.current = scroll.current?.scrollTop ?? 0;
    lastOpened.current = id;
    setSelected(id);
    setView("editor");
  }, []);
  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      setBusyId(id);
      setError("");
      store.getState().invalidate();
      try {
        await request(
          `/agents/${encode(agentId)}/mcp/servers/${encode(id)}`,
          "PUT",
          { enabled },
        );
        await load();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusyId(null);
      }
    },
    [agentId, store, load],
  );
  function back() {
    setView("list");
    store.getState().invalidate();
    void load();
  }
  function saved(id: string) {
    store.getState().invalidate();
    setSelected(id);
    void load();
  }
  if (view === "editor")
    return (
      <ServerEditor
        key={selected ?? "new"}
        id={selected}
        agentId={agentId}
        eventVersion={eventVersion}
        onBack={back}
        onSaved={saved}
      />
    );
  if (view === "import")
    return (
      <ImportServers
        agentId={agentId}
        onBack={back}
        onChanged={() => void load()}
      />
    );
  return (
    <section className={styles.panel} aria-label="Agent MCP servers">
      <div className={styles.toolbar}>
        <button
          ref={add}
          className="button"
          onClick={() => {
            setSelected(null);
            setView("editor");
          }}
        >
          <Plus size={14} aria-hidden />
          Add Server
        </button>
        <button className="button" onClick={() => setView("import")}>
          <Upload size={14} aria-hidden />
          Import JSON
        </button>
        <button
          className="button"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={14} aria-hidden />
          Refresh
        </button>
        <Field
          className={styles.search}
          label="Search MCP servers"
          id={`${prefix}-search`}
        >
          <input
            id={`${prefix}-search`}
            type="search"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              position.current = 0;
              setQuery(e.target.value);
            }}
            placeholder="Search servers…"
          />
        </Field>
      </div>
      {error && (
        <p role="alert" className={`errorBanner ${styles.feedback}`}>
          {error}
        </p>
      )}
      <div className={styles.content} ref={scroll} aria-busy={loading}>
        <p className={styles.help}>
          Servers and credentials are shared. Switches grant this agent access
          to all capabilities on each enabled server.
        </p>
        {loading && !items.length && <p role="status">Loading MCP servers…</p>}
        {!loading && !items.length && (
          <p className={styles.help}>
            {query
              ? "No servers match this search."
              : "No MCP servers yet. Add a local command or remote server to get started."}
          </p>
        )}
        <ul className={styles.rows}>
          {items.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              busy={busyId !== null}
              onOpen={open}
              onToggle={toggle}
            />
          ))}
        </ul>
        {items.length > 0 && (
          <div className={styles.pagination}>
            <span>
              {items.length} of {total} servers
            </span>
            {items.length < total && (
              <button
                className="button"
                disabled={loading}
                onClick={() => void load(true)}
              >
                Load more
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
