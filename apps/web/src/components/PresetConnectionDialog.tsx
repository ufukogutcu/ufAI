import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  errorMessage,
  request,
  RequestError,
  type CodexLoginStatus,
  type ConnectionProvider,
  type ProviderConnection,
} from "../api";
import { useConnections } from "../connection-store";
import { providerLabel } from "../preset-form";
import { Dialog } from "./Dialog";
import { Field } from "./FormField";
import styles from "../pages/Presets.module.scss";
export function PresetConnectionDialog({
  provider,
  connection,
  onSelected,
  onClose,
}: {
  provider: ConnectionProvider;
  connection?: ProviderConnection;
  onSelected: (id: string | null) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(connection?.id ?? null);
  const [name, setName] = useState(
    connection?.name ?? providerLabel({ provider, customProviderName: null }),
  );
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? "");
  const [apiKey, setApiKey] = useState("");
  const [isDefault, setDefault] = useState(connection?.isDefault ?? false);
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify([name, endpoint, "", isDefault]),
  );
  const [hasCredential, setHasCredential] = useState(
    connection?.hasCredential ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [login, setLogin] = useState<CodexLoginStatus>({
    status: "disconnected",
  });
  const [poll, setPoll] = useState(0);
  const [confirm, setConfirm] = useState<"discard" | "delete" | null>(null);
  const save = useConnections((state) => state.save);
  const remove = useConnections((state) => state.remove);
  const load = useConnections((state) => state.load);
  const pending = useRef<string | null>(null);
  const dirty =
    baseline !== JSON.stringify([name, endpoint, apiKey, isDefault]);
  useEffect(() => {
    function unload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    if (dirty) window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  useEffect(
    () => () => {
      if (pending.current)
        void request(`/connections/${pending.current}/login`, "DELETE").catch(
          () => {},
        );
    },
    [],
  );
  useEffect(() => {
    if (!id || provider !== "codex") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await request<CodexLoginStatus>(
          `/connections/${id}/login`,
          "GET",
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        pending.current = result.status === "pending" ? id : null;
        setLogin(result);
        if (result.status === "pending")
          timer = setTimeout(() => void refresh(), 1000);
        if (result.status === "connected") {
          setHasCredential(true);
          void load();
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, provider, poll, load]);
  async function persist() {
    const saved = await save(id, {
      provider,
      name,
      ...(provider === "openai-compatible" ? { endpoint } : {}),
      ...(apiKey ? { apiKey } : {}),
      isDefault,
    });
    setId(saved.id);
    setName(saved.name);
    setEndpoint(saved.endpoint ?? "");
    setDefault(saved.isDefault);
    setHasCredential(saved.hasCredential);
    setApiKey("");
    setBaseline(
      JSON.stringify([saved.name, saved.endpoint ?? "", "", saved.isDefault]),
    );
    onSelected(saved.id);
    return saved.id;
  }
  function fail(error: unknown) {
    setError(errorMessage(error));
    if (error instanceof RequestError) setFields(error.fields);
  }
  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setFields({});
    try {
      await persist();
      onClose();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function handleLogin(deviceCode: boolean) {
    setBusy(true);
    setError("");
    setFields({});
    try {
      const savedId = await persist();
      const result = await request<CodexLoginStatus>(
        `/connections/${savedId}/login`,
        "POST",
        { deviceCode },
      );
      pending.current = result.status === "pending" ? savedId : null;
      setLogin(result);
      setPoll((p) => p + 1);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function handleCancelLogin() {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      await request(`/connections/${id}/login`, "DELETE");
      pending.current = null;
      setLogin({ status: "disconnected" });
      setPoll((p) => p + 1);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function handleLogout() {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      await request(`/connections/${id}/logout`, "POST", {});
      setLogin({ status: "disconnected" });
      setHasCredential(false);
      setPoll((p) => p + 1);
      await load();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function handleDelete() {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      await remove(id);
      pending.current = null;
      onSelected(null);
      onClose();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  function close() {
    if (dirty) setConfirm("discard");
    else onClose();
  }
  return (
    <Dialog
      title={id ? "Manage connection" : "Connect provider"}
      onClose={close}
      busy={busy}
    >
      {confirm ? (
        <>
          <p>
            {confirm === "delete"
              ? "Delete this connection? Linked presets keep their model settings and become unlinked."
              : "Discard unsaved connection changes? Saved connections are kept."}
          </p>
          {error && (
            <p role="alert" className="error">
              {error}

            </p>
          )}
          <div className="dialogActions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Keep editing
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={confirm === "delete" ? handleDelete : onClose}
            >
              {confirm === "delete" ? "Delete connection" : "Discard changes"}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={handleSave} className={styles.connectionForm}>
          <p className={styles.dialogHint}>
            {providerLabel({ provider, customProviderName: null })} · Saved
            connections can be reused by other presets.
          </p>
          <fieldset disabled={busy}>
            <Field label="Connection name" error={fields.name}>
              {(props) => (
                <input
                  {...props}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                  autoComplete="off"
                  required
                />
              )}
            </Field>
            {provider === "openai-compatible" && (
              <Field
                label="API base URL"
                error={fields.endpoint}
                hint="Include the API prefix, for example https://example.com/v1."
              >
                {(props) => (
                  <input
                    {...props}
                    type="url"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder="https://example.com/v1"
                    maxLength={2000}
                    required
                  />
                )}
              </Field>
            )}
            {provider !== "codex" && (
              <Field
                label={hasCredential ? "Replace API key" : "API key"}
                error={fields.apiKey}
                hint={
                  hasCredential
                    ? "A key is saved. Leave empty to keep it."
                    : provider === "openai-compatible"
                      ? "Optional for endpoints that do not require a key."
                      : "Stored on this local backend; never returned to the browser."
                }
              >
                {(props) => (
                  <input
                    {...props}
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="new-password"
                    maxLength={8192}
                    required={
                      !hasCredential && provider !== "openai-compatible"
                    }
                  />
                )}
              </Field>
            )}
            <details className={styles.connectionOptions}>
              <summary>Connection options</summary>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(event) => setDefault(event.target.checked)}
                />
                Use by default for new presets
              </label>
            </details>
          </fieldset>
          {provider === "codex" && (
            <div className={styles.loginArea}>
              <p role="status">
                {login.status === "connected"
                  ? "Connected to ChatGPT."
                  : login.status === "pending"
                    ? "Finish signing in, then return here."
                    : (login.error ??
                      "Sign in with your ChatGPT account to browse Codex models.")}
              </p>
              {login.status === "pending" && (
                <>
                  {login.userCode && (
                    <p className={styles.userCode}>
                      Code: <strong>{login.userCode}</strong>
                    </p>
                  )}
                  {login.authUrl && (
                    <a
                      className="button primary"
                      href={login.authUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Continue to ChatGPT
                    </a>
                  )}
                  <button
                    type="button"
                    className="textButton"
                    disabled={busy}
                    onClick={handleCancelLogin}
                  >
                    Cancel sign-in
                  </button>
                </>
              )}
              <div className={styles.inlineActions}>
                {login.status !== "pending" && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void handleLogin(false)}
                  >
                    {login.status === "connected"
                      ? "Reconnect"
                      : "Sign in with ChatGPT"}
                  </button>
                )}
                {login.status !== "pending" && login.status !== "connected" && (
                  <button
                    type="button"
                    className="textButton"
                    disabled={busy}
                    onClick={() => void handleLogin(true)}
                  >
                    Use a device code
                  </button>
                )}
                {login.status === "pending" && !login.userCode && (
                  <button
                    type="button"
                    className="textButton"
                    disabled={busy}
                    onClick={() => void handleLogin(true)}
                  >
                    Use a device code instead
                  </button>
                )}
                {login.status === "connected" && (
                  <button
                    type="button"
                    className="textButton"
                    disabled={busy}
                    onClick={handleLogout}
                  >
                    Sign out
                  </button>
                )}
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
              {provider === "codex" && id && (
                <button
                  type="button"
                  className="textButton"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setPoll((value) => value + 1);
                  }}
                >
                  Check sign-in status
                </button>
              )}
            </p>
          )}
          <div className="dialogActions">
            {id && (
              <button
                type="button"
                className="button deleteButton"
                disabled={busy}
                onClick={() => setConfirm("delete")}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={close}
            >
              Close
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={busy || login.status === "pending"}
            >
              {busy ? "Saving…" : "Save connection"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
