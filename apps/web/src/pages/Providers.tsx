import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  TriangleAlert,
  Check,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import {
  errorMessage,
  request,
  RequestError,
  type CodexLoginStatus,
  type ConnectionProvider,
  type ModelTestResult,
  type ModelSelection,
  type SelectionImpact,
  type ProviderConnection,
  type ProviderModel,
} from "../api";
import { useDashboard } from "../store";
import { Tooltip } from "../components/Tooltip";
import { reconcileSelection, selectModels, selectedCount, selectionChanges, type SelectionDraft } from "../model-selection";
import { useConnections } from "../connection-store";
import { contextDifference, resetContextToAutomatic } from "../model-context";
import {
  providerCategories,
  providerOptions,
  type ProviderCategory,
} from "../provider-options";
import { useNavigationGuard, useUnsavedChanges } from "../navigation-guard";
import { useCodexUsage } from "../codex-usage-store";
import { refreshOnFocus } from "../focus-refresh";
import { Dialog } from "../components/Dialog";
import { Appearance, AppearanceGroup } from "../components/Appearance";
import { Field } from "../components/FormField";
import shared from "./Presets.module.scss";
import styles from "./Providers.module.scss";

function ProviderPicker({
  category,
  provider,
  locked,
  error,
  onCategoryChange,
  onProviderChange,
}: {
  category: ProviderCategory;
  provider: ConnectionProvider | null;
  locked: boolean;
  error?: string;
  onCategoryChange: (category: ProviderCategory) => void;
  onProviderChange: (provider: ConnectionProvider) => void;
}) {
  const pickerId = useId();
  const hint = locked
    ? "Provider type is fixed once setup begins. Create a new Provider to choose another."
    : provider
      ? "You can change provider until setup begins."
      : "Choose a provider to see its setup fields.";
  return (
    <div className={styles.providerPicker}>
      <div className={styles.pickerLabel}>Provider type</div>
      <div
        className={styles.categoryTabs}
        role="tablist"
        aria-label="Provider category"
      >
        {providerCategories.map((option, index) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            id={`${pickerId}-${option.id}-tab`}
            aria-selected={category === option.id}
            aria-controls={`${pickerId}-${option.id}-panel`}
            tabIndex={category === option.id ? 0 : -1}
            disabled={locked}
            onClick={() => onCategoryChange(option.id)}
            onKeyDown={(event) => {
              let next: number | undefined;
              if (event.key === "ArrowRight")
                next = (index + 1) % providerCategories.length;
              if (event.key === "ArrowLeft")
                next =
                  (index - 1 + providerCategories.length) % providerCategories.length;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = providerCategories.length - 1;
              const target =
                next === undefined ? undefined : providerCategories[next];
              if (!target) return;
              event.preventDefault();
              onCategoryChange(target.id);
              document.getElementById(`${pickerId}-${target.id}-tab`)?.focus();
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {providerCategories.map((group) => (
        <div
          key={group.id}
          id={`${pickerId}-${group.id}-panel`}
          role="tabpanel"
          aria-labelledby={`${pickerId}-${group.id}-tab`}
          hidden={category !== group.id}
        >
          <fieldset
            className={styles.providerChoices}
            disabled={locked}
            aria-describedby={`${pickerId}-help`}
          >
            <legend className={styles.choicesLegend}>
              {group.label} provider
            </legend>
            {providerOptions
              .filter((option) => option.category === group.id)
              .map((option) => (
                <label key={option.id} className={styles.providerChoice}>
                  <input
                    type="radio"
                    name={`${pickerId}-provider`}
                    value={option.id}
                    checked={provider === option.id}
                    aria-invalid={!!error && category === group.id}
                    aria-describedby={`${pickerId}-help`}
                    onChange={() => onProviderChange(option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
          </fieldset>
        </div>
      ))}
      <p id={`${pickerId}-help`} className={error ? "fieldError" : "fieldHint"}>
        {error ?? hint}
      </p>
    </div>
  );
}

type ModelPage = { items: ProviderModel[]; total: number };
function ModelContextWarning({
  model,
  onSaved,
}: {
  model: ProviderModel;
  onSaved: (model: ProviderModel) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const warningRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const difference = contextDifference(model);
  if (!difference) return null;

  async function applyAutomaticContext() {
    setBusy(true);
    setError("");
    try {
      const saved = await resetContextToAutomatic(model);
      // The warning disappears after saving; leave focus on this model's Edit control.
      warningRef.current?.closest("article")?.querySelector<HTMLButtonElement>("[data-model-edit]")?.focus();
      onSaved(saved);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.contextWarning} ref={warningRef}>
      <p id={descriptionId}>
        <TriangleAlert size={14} aria-hidden="true" />
        <span>Fetched context differs: {difference.automatic.toLocaleString()} tokens. Your manual value: {difference.manual.toLocaleString()} tokens.</span>
      </p>
      <button type="button" className="textButton" disabled={busy}
        aria-label={`Use automatic context for ${model.name}`} aria-describedby={descriptionId}
        aria-busy={busy} onClick={applyAutomaticContext}>
        {busy ? "Saving…" : "Use automatic context"}
      </button>
      {error && <p className="fieldError" role="alert">{error}</p>}
    </div>
  );
}

function ModelEditor({
  connectionId,
  model,
  onClose,
  onSaved,
  onDirty,
}: {
  connectionId: string;
  model?: ProviderModel;
  onClose: () => void;
  onSaved: (createdId?: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [id, setId] = useState(model?.id ?? "");
  const [name, setName] = useState(model?.name ?? "");
  const [context, setContext] = useState(
    model?.contextWindowOverride?.toString() ?? "",
  );
  const [baseline] = useState(() =>
    JSON.stringify([id, name, context]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<"discard" | "delete" | null>(null);
  const dirty = baseline !== JSON.stringify([id, name, context]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (Object.keys(fields).length)
      formRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [fields]);
  function close() {
    if (dirty) setConfirm("discard");
    else onClose();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setFields({});
    try {
      const saved = await request<ProviderModel>(
        `/connections/${connectionId}/models${model ? `/${encodeURIComponent(model.id)}` : ""}`,
        model ? "PATCH" : "POST",
        {
          id,
          name: name.trim() || id,
          contextWindowOverride: context === "" ? null : Number(context),
        },
      );
      onSaved(model ? undefined : saved.id);
      onClose();
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof RequestError) setFields(error.fields);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!model) return;
    setBusy(true);
    setError("");
    try {
      await request(
        `/connections/${connectionId}/models/${encodeURIComponent(model.id)}`,
        "DELETE",
      );
      onSaved();
      onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={model ? "Model settings" : "Add model"}
      onClose={close}
      busy={busy}
    >
      {confirm ? (
        <>
          <p>
            {confirm === "delete"
              ? "Remove this model? Linked presets will have their model selection cleared."
              : "Discard unsaved model changes?"}
          </p>
          {error && (
            <Appearance kind="fade"><p className="error" role="alert">
              {error}
            </p></Appearance>
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
              onClick={confirm === "delete" ? remove : onClose}
            >
              {confirm === "delete" ? "Remove model" : "Discard changes"}
            </button>
          </div>
        </>
      ) : (
        <form ref={formRef} onSubmit={save} noValidate>
          <fieldset className={styles.dialogFields} disabled={busy}>
            <Field label="Model ID" error={fields.id}>
              {(props) => (
                <input
                  {...props}
                  name="modelId"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                  readOnly={!!model}
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  placeholder="Enter exact model ID…"
                />
              )}
            </Field>
            <Field label="Display name (optional)" error={fields.name}>
              {(props) => (
                <input
                  {...props}
                  maxLength={300}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Uses the model ID…"
                />
              )}
            </Field>
            <Field
              label="Context window override"
              error={fields.contextWindowOverride}
              hint={`Automatic: ${model?.discoveredContextWindow?.toLocaleString() ?? "Unknown"} tokens`}
            >
              {(props) => (
                <input
                  {...props}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  value={context}
                  onChange={(event) => setContext(event.target.value)}
                  placeholder="Automatic / unknown…"
                />
              )}
            </Field>
            <button
              type="button"
              className="textButton"
              onClick={() => {
                setContext("");
              }}
            >
              Reset context to automatic
            </button>
          </fieldset>
          {error && (
            <Appearance kind="fade"><p className="error" role="alert">
              {error}
            </p></Appearance>
          )}
          <div className="dialogActions">
            {model && (
              <button
                type="button"
                className="button deleteButton"
                disabled={busy}
                onClick={() => setConfirm("delete")}
              >
                Remove
              </button>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? "Saving…" : "Save model"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
function ProviderEditor({
  connection,
  onSaved,
  onCreated,
  onClose,
  onDeleted,
}: {
  connection?: ProviderConnection;
  onSaved: (id: string) => void;
  onCreated: (id: string) => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const invalidateUsage = useCodexUsage((state) => state.invalidate);
  const [id, setId] = useState(connection?.id ?? null);
  const [provider, setProvider] = useState<ConnectionProvider | null>(
    connection?.provider ?? null,
  );
  const [category, setCategory] = useState<ProviderCategory>(
    () => providerOptions.find((option) => option.id === connection?.provider)?.category ?? "api",
  );
  const [name, setName] = useState(connection?.name ?? "");
  const nameManuallyEdited = useRef(false);
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? "");
  const [apiKey, setApiKey] = useState("");
  const [hasCredential, setHasCredential] = useState(
    connection?.hasCredential ?? false,
  );
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify([provider, name, endpoint, ""]),
  );
  const [draft, setDraft] = useState(connection?.draft ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalog, setCatalog] = useState<ModelPage>({ items: [], total: 0 });
  const [modelActionStatus, setModelActionStatus] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft>(() => ({ saved: new Map(), changes: new Map() }));
  const [selectionLoading, setSelectionLoading] = useState(true);
  const [selectionLoadError, setSelectionLoadError] = useState("");
  const [selectionImpact, setSelectionImpact] = useState<SelectionImpact | null>(null);
  const loadPresets = useDashboard(state => state.loadPresets);
  const clearPresetModels = useDashboard(state => state.clearPresetModels);
  const enabledCount = selectedCount(selectionDraft);
  const selectionDirty = selectionDraft.changes.size > 0;
  const selectionErrorId = useId();
  const [createdModelId, setCreatedModelId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [modelEditor, setModelEditor] = useState<{
    model?: ProviderModel;
  } | null>(null);
  const [modelDirty, setModelDirty] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [login, setLogin] = useState<CodexLoginStatus>({
    status: "disconnected",
  });
  const [loginRevision, setLoginRevision] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saveConnection = useConnections((state) => state.save);
  const removeConnection = useConnections((state) => state.remove);
  const attempt = useNavigationGuard();
  const resource = useRef<{ id: string | null; discard: boolean }>({
    id: connection?.id ?? null,
    discard: !connection,
  });
  const discoverAfterLogin = useRef(false);
  const testController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const dirty =
    baseline !== JSON.stringify([provider, name, endpoint, apiKey]);
  useUnsavedChanges(dirty || selectionDirty || modelDirty || (!!id && draft));
  const refreshLocal = useCallback(() => setRevision((v) => v + 1), []);
  function clearProviderFields() {
    setEndpoint("");
    setApiKey("");
    setError("");
    setFields({});
  }
  function selectCategory(next: ProviderCategory) {
    if (id || category === next) return;
    setCategory(next);
    setProvider(null);
    clearProviderFields();
  }
  function selectProvider(next: ConnectionProvider) {
    if (id || provider === next) return;
    clearProviderFields();
    setProvider(next);
    if (!nameManuallyEdited.current || !name.trim()) {
      const option = providerOptions.find((option) => option.id === next);
      if (option) setName(option.label);
    }
    setEndpoint(next === "ollama" ? "http://localhost:11434" : "");
  }
  function changeName(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    nameManuallyEdited.current = value.trim().length > 0;
    setName(value);
  }
  function handleModelSaved(createdId?: string) {
    setModelActionStatus("");
    setCreatedModelId(createdId ?? null);
    refreshLocal();
  }
  function handleAutomaticContextSaved(model: ProviderModel) {
    setCatalog(current => ({
      ...current,
      items: current.items.map(item => item.id === model.id ? model : item),
    }));
    setModelActionStatus(`${model.name} now uses automatic context: ${model.contextWindow?.toLocaleString() ?? "Unknown"} tokens.`);
    refreshLocal();
  }
  function changeModelPage(next: number) {
    setCreatedModelId(null);
    setOffset(next);
  }
  function clearCreatedModelAppearance() {
    setCreatedModelId(null);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const testingHere = !!testController.current;
      testController.current?.abort();
      const current = resource.current;
      if (current.id) {
        if (testingHere)
          void request(`/connections/${current.id}/test`, "DELETE").catch(
            () => {},
          );
        if (current.discard)
          void removeConnection(current.id).catch(() => {});
        else if (provider === "codex")
          void request(`/connections/${current.id}/login`, "DELETE").catch(
            () => {},
          );
      }
    };
  }, [provider, removeConnection]);
  useEffect(() => refreshOnFocus(async () => refreshLocal()), [refreshLocal]);
  useEffect(() => {
    const controller = new AbortController();
    if (!id) {
      setSelectionLoading(false);
      return;
    }
    setSelectionLoading(true);
    setSelectionLoadError("");
    void request<{ items: ModelSelection[] }>(`/connections/${id}/model-selection`, "GET", undefined, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) {
          setSelectionDraft(current => reconcileSelection(current, result.items));
          setSelectionLoading(false);
        }
      })
      .catch(error => {
        if (!controller.signal.aborted) setSelectionLoadError(errorMessage(error));
      })
      .finally(() => { if (!controller.signal.aborted) setSelectionLoading(false); });
    return () => controller.abort();
  }, [id, revision]);
  useEffect(() => {
    const controller = new AbortController();
    if (!id) {
      setCatalogLoading(false);
      return;
    }
    setCatalogLoading(true);
    const timer = setTimeout(() => {
      void request<ModelPage>(
        `/connections/${id}/models?limit=50&offset=${offset}&q=${encodeURIComponent(query)}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setCatalog(result);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(errorMessage(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setCatalogLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [id, query, offset, revision]);
  useEffect(() => {
    if (!id || provider !== "codex") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const status = await request<CodexLoginStatus>(
          `/connections/${id}/login`,
          "GET",
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setLogin(status);
        if (status.status === "pending")
          timer = setTimeout(() => void poll(), 1000);
        if (status.status === "connected") {
          setHasCredential(true);
          if (discoverAfterLogin.current) {
            discoverAfterLogin.current = false;
            setBusy(true);
            try {
              await request(
                `/connections/${id}/models/refresh`,
                "POST",
                {},
                controller.signal,
              );
              if (!controller.signal.aborted) refreshLocal();
            } catch (error) {
              if (!controller.signal.aborted) {
                setError(errorMessage(error));
                if (error instanceof RequestError) setFields(error.fields);
              }
            } finally {
              if (!controller.signal.aborted) setBusy(false);
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, provider, loginRevision, refreshLocal]);
  useEffect(() => {
    if (Object.keys(fields).length)
      document.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"][tabindex="-1"]')?.focus();
  }, [fields]);
  function fail(error: unknown) {
    setError(errorMessage(error));
    if (error instanceof RequestError) setFields(error.fields);
  }
  async function persist() {
    if (!provider) {
      setFields({ provider: "Choose a provider." });
      throw new Error("Choose a provider to continue setup.");
    }
    if (id && !dirty) return id;
    const saved = await saveConnection(id, {
      name,
      provider,
      ...(provider === "openai-compatible" || provider === "ollama"
        ? {
            endpoint:
              endpoint ||
              (provider === "ollama" ? "http://localhost:11434" : ""),
          }
        : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(id ? {} : { draft: true }),
    });
    resource.current.id = saved.id;
    if (!mounted.current) {
      if (resource.current.discard)
        await removeConnection(saved.id);
      throw new Error("Setup closed.");
    }
    setId(saved.id);
    setName(saved.name);
    setEndpoint(saved.endpoint ?? "");
    setApiKey("");
    setHasCredential(saved.hasCredential);
    setBaseline(
      JSON.stringify([
        saved.provider,
        saved.name,
        saved.endpoint ?? "",
        "",
      ]),
    );
    return saved.id;
  }
  async function discover() {
    setBusy(true);
    setModelActionStatus("");
    setError("");
    setFields({});
    try {
      const current = await persist();
      await request(`/connections/${current}/models/refresh`, "POST", {});
      setOffset(0);
      refreshLocal();
    } catch (error) {
      fail(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function authenticate(deviceCode: boolean) {
    setBusy(true);
    setError("");
    setFields({});
    try {
      const current = await persist();
      invalidateUsage(current);
      discoverAfterLogin.current = true;
      setLogin(
        await request<CodexLoginStatus>(
          `/connections/${current}/login`,
          "POST",
          { deviceCode },
        ),
      );
      setLoginRevision((v) => v + 1);
    } catch (error) {
      fail(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function finish(event: FormEvent) {
    event.preventDefault();
    void saveProvider();
  }
  async function saveProvider(confirmationToken?: string) {
    if (!provider || selectionLoading || selectionLoadError) return;
    if (!enabledCount) {
      setFields({ models: "Select at least one model before saving the Provider." });
      return;
    }
    if (!id) return;
    setBusy(true);
    setError("");
    setFields({});
    try {
      const saved = await saveConnection(id, {
        provider, name,
        ...(provider === "openai-compatible" || provider === "ollama" ? { endpoint: endpoint || (provider === "ollama" ? "http://localhost:11434" : "") } : {}),
        ...(apiKey ? { apiKey } : {}),
        draft: false,
        modelSelection: selectionChanges(selectionDraft),
        ...(confirmationToken ? { confirmationToken } : {}),
      });
      resource.current.discard = false;
      if (draft) onCreated(saved.id);
      clearPresetModels(id, [...selectionDraft.saved.keys()].filter(modelId => !(selectionDraft.changes.get(modelId) ?? selectionDraft.saved.get(modelId))));
      setDraft(false);
      setName(saved.name);
      setEndpoint(saved.endpoint ?? "");
      setApiKey("");
      setHasCredential(saved.hasCredential);
      setBaseline(JSON.stringify([saved.provider, saved.name, saved.endpoint ?? "", ""]));
      setSelectionDraft(current => ({ saved: new Map([...current.saved].map(([modelId, enabled]) => [modelId, current.changes.get(modelId) ?? enabled])), changes: new Map() }));
      setSelectionImpact(null);
      refreshLocal();
      await loadPresets();
      onSaved(saved.id);
    } catch (error) {
      if (error instanceof RequestError && error.selectionImpact) setSelectionImpact(error.selectionImpact);
      else {
        setSelectionImpact(null);
        fail(error);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function toggleModel(modelId: string, enabled: boolean) {
    setSelectionDraft(current => selectModels(current, [modelId], enabled));
    setFields(current => ({ ...current, models: "" }));
  }
  async function selectMatching(enabled: boolean) {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ items: ModelSelection[] }>(`/connections/${id}/model-selection?q=${encodeURIComponent(query)}`);
      if (mounted.current) {
        // Include models another session added since our last snapshot.
        setSelectionDraft(current => {
          const saved = new Map(current.saved);
          for (const model of result.items) if (!saved.has(model.id)) saved.set(model.id, model.enabled);
          return selectModels({ ...current, saved }, result.items.map(model => model.id), enabled);
        });
        setFields(current => ({ ...current, models: "" }));
      }
    } catch (error) { if (mounted.current) fail(error); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function addModel() {
    setBusy(true);
    setError("");
    setFields({});
    try {
      await persist();
      setModelEditor({});
    } catch (error) {
      fail(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function test(model: ProviderModel) {
    if (!id) return;
    setTesting(model.id);
    setError("");
    const controller = new AbortController();
    testController.current = controller;
    try {
      await request<ModelTestResult>(
        `/connections/${id}/models/${encodeURIComponent(model.id)}/test`,
        "POST",
        {},
        controller.signal,
      );
      if (!controller.signal.aborted) refreshLocal();
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      if (testController.current === controller) testController.current = null;
      if (mounted.current) setTesting(null);
    }
  }
  async function remove() {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      await removeConnection(id);
      resource.current.id = null;
      onDeleted();
    } catch (error) {
      fail(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function cancelTest() {
    testController.current?.abort();
    if (id) {
      await request(`/connections/${id}/test`, "DELETE").catch(fail);
      refreshLocal();
    }
  }
  async function signOut() {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      await request(`/connections/${id}/logout`, "POST", {});
      invalidateUsage(id, true);
      setLogin({ status: "disconnected" });
      setHasCredential(false);
      refreshLocal();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form className={shared.editor} onSubmit={finish} noValidate>
        <header className={shared.editorHeading} data-appearance-content>
          <h2>{draft ? "Set up Provider" : "Edit Provider"}</h2>
        </header>
        <fieldset className={shared.fields} disabled={busy || !!testing} data-appearance-content>
          <section className={shared.formSection}>
            <ProviderPicker
              category={category}
              provider={provider}
              locked={!!id}
              error={fields.provider}
              onCategoryChange={selectCategory}
              onProviderChange={selectProvider}
            />
          </section>
          {provider && <>
          <section
            className={`${shared.formSection} ${styles.connectionFields}`}
          >
            <Field label="Provider name" error={fields.name}>
              {(props) => (
                <input
                  {...props}
                  name="name"
                  value={name}
                  onChange={changeName}
                  maxLength={120}
                  autoComplete="off"
                  placeholder="Name this configuration…"
                  required
                />
              )}
            </Field>
            {(provider === "openai-compatible" || provider === "ollama") && (
              <Field
                label={provider === "ollama" ? "Server URL" : "API base URL"}
                error={fields.endpoint}
                hint={
                  provider === "ollama"
                    ? "Ollama server URL, normally http://localhost:11434."
                    : "Include the API prefix, for example https://example.com/v1."
                }
              >
                {(props) => (
                  <input
                    {...props}
                    name="endpoint"
                    type="url"
                    spellCheck={false}
                    autoComplete="off"
                    value={endpoint}
                    maxLength={2000}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder={
                      provider === "ollama"
                        ? "http://localhost:11434"
                        : "https://example.com/v1"
                    }
                  />
                )}
              </Field>
            )}
            {provider !== "codex" && (
              <Field
                label={
                  hasCredential
                    ? "Replace API key"
                    : provider === "ollama" || provider === "openai-compatible"
                      ? "API key (optional)"
                      : "API key"
                }
                error={fields.apiKey}
                hint={
                  hasCredential
                    ? "Leave empty to keep the saved key."
                    : provider === "ollama" || provider === "openai-compatible"
                      ? "Optional for servers that do not require authentication."
                      : "Stored on your local backend; never returned to the browser."
                }
              >
                {(props) => (
                  <input
                    {...props}
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                    maxLength={8192}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                )}
              </Field>
            )}
            {provider !== "codex" && (
              <button
                type="button"
                className="button secondary"
                onClick={discover}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {id
                  ? "Apply connection & refresh models"
                  : "Connect & load models"}
              </button>
            )}
            {provider === "codex" && (
              <Appearance><div className={shared.loginArea}>
                <Appearance kind="fade"><p role="status">
                  {login.status === "connected"
                    ? "Connected to ChatGPT."
                    : login.status === "pending"
                      ? "Finish signing in, then return here."
                      : (login.error ?? "Sign in with your ChatGPT account.")}
                </p></Appearance>
                {login.authUrl && login.status === "pending" && (
                  <a
                    className="button primary"
                    href={login.authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Continue to ChatGPT
                  </a>
                )}
                {login.userCode && login.status === "pending" && (
                  <p>
                    Code: <strong>{login.userCode}</strong>
                  </p>
                )}
                <div className={shared.inlineActions}>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void authenticate(false)}
                  >
                    {login.status === "connected"
                      ? "Reconnect"
                      : "Sign in with ChatGPT"}
                  </button>
                  <button
                    type="button"
                    className="textButton"
                    onClick={() => void authenticate(true)}
                  >
                    Use a device code
                  </button>
                  {login.status === "connected" && (
                    <button
                      type="button"
                      className="textButton"
                      onClick={signOut}
                    >
                      Sign out
                    </button>
                  )}
                  {login.status === "pending" && (
                    <button
                      type="button"
                      className="textButton"
                      onClick={() => {
                        if (id)
                          void request(`/connections/${id}/login`, "DELETE")
                            .then(() => setLoginRevision((v) => v + 1))
                            .catch(fail);
                      }}
                    >
                      Cancel sign-in
                    </button>
                  )}
                </div>
              </div></Appearance>
            )}
          </section>
          <section className={shared.formSection}>
            <div className={styles.modelToolbar}>
              <h3>
                Models <span className="count">{catalog.total}</span>
              </h3>
              <button
                type="button"
                className="button secondary"
                onClick={discover}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Refresh models
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={addModel}
              >
                <Plus size={14} aria-hidden="true" />
                Add model
              </button>
            </div>
            <div className={styles.selectionToolbar}>
              <span role="status">{selectionLoading ? "Loading model selections…" : `${enabledCount.toLocaleString()} of ${selectionDraft.saved.size.toLocaleString()} selected`}</span>
              <button type="button" className="textButton" disabled={!id || selectionLoading || !!selectionLoadError} onClick={() => void selectMatching(true)}>Select all{query ? " matching" : ""}</button>
              <button type="button" className="textButton" disabled={!id || selectionLoading || !!selectionLoadError} onClick={() => void selectMatching(false)}>Unselect all{query ? " matching" : ""}</button>
            </div>
            {selectionLoadError && <p className="fieldError" role="alert">{selectionLoadError}{" "}<button type="button" className="textButton" onClick={refreshLocal}>Retry model selections</button></p>}
            {fields.models && (
              <Appearance kind="fade"><p id={selectionErrorId} className="fieldError" role="alert" tabIndex={-1}>
                {fields.models}
              </p></Appearance>
            )}
            <Field label="Search models">
              {(props) => (
                <input
                  {...props}
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setCreatedModelId(null);
                    setQuery(event.target.value);
                    setOffset(0);
                  }}
                  placeholder="Search by name or model ID…"
                />
              )}
            </Field>
            <p className={shared.modelStatus}>
              Discovery and testing are optional. Add a model manually if its
              list cannot be loaded. Only checked models appear in model selections. Checkbox changes apply when you save this Provider.
            </p>
            <p className={styles.actionStatus} role="status">{modelActionStatus}</p>
            <div className={styles.modelList}>
              {catalog.items.map((model) => (
                <Appearance kind="fade" key={model.id} ready={model.id === createdModelId}><article className={styles.modelRow} onAnimationEnd={clearCreatedModelAppearance}>
                  <div className={styles.modelHeading}>
                    <label className={styles.modelIdentity}>
                      <input type="checkbox" name="enabledModels" value={model.id}
                        aria-label={`Include ${model.name} in model selections`}
                        aria-invalid={!!fields.models}
                        aria-describedby={fields.models ? selectionErrorId : undefined}
                        disabled={selectionLoading || !!selectionLoadError}
                        checked={selectionDraft.changes.get(model.id) ?? selectionDraft.saved.get(model.id) ?? model.enabled}
                        onChange={event => toggleModel(model.id, event.target.checked)} />
                      <span>
                        <strong title={model.name}>{model.name}</strong>
                        <small>
                          {model.name !== model.id && <><span title={model.id}>{model.id}</span> · </>}
                          Context: {model.contextWindow?.toLocaleString() ?? "Unknown"}
                          {model.manual ? " · Manual" : ""}
                          {model.contextWindowOverride !== null ? " · Custom context" : ""}
                        </small>
                      </span>
                    </label>
                    <div className={styles.modelActions}>
                      <Tooltip content={`Edit ${model.name}`}><button type="button" className="iconButton"
                        data-model-edit aria-label={`Edit ${model.name}`} onClick={() => setModelEditor({ model })}>
                        <Pencil size={15} aria-hidden="true" />
                      </button></Tooltip>
                      <Tooltip content={dirty ? "Apply or save connection changes first" : testing === model.id ? "Testing…" : `Test ${model.name}`}>
                        <button type="button" className="iconButton" aria-label={testing === model.id ? `Testing ${model.name}` : `Test ${model.name}`}
                          disabled={dirty || !!testing} aria-busy={testing === model.id} onClick={() => void test(model)}>
                          {testing === model.id ? <LoaderCircle className={styles.testingIcon} size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                  <ModelContextWarning model={model} onSaved={handleAutomaticContextSaved} />
                  {(model.lastTest || model.legacyLimits.length > 0 || (!model.available && !model.manual)) && (
                  <details className={styles.modelDetails}>
                    <summary>{model.lastTest ? model.lastTest.success ? "Test passed" : "Test failed" : "Model details"}</summary>
                    {!model.available && !model.manual && <p className={styles.status}>Not returned by the latest refresh; kept in your list.</p>}
                  {model.legacyLimits.length > 0 && (
                    <p className={`${styles.status} ${styles.failure}`}>
                      Previous presets used different context windows:{" "}
                      {model.legacyLimits
                        .map(
                          (l) =>
                            `${l.contextWindow?.toLocaleString() ?? "Unknown"} tokens`,
                        )
                        .join("; ")}
                      . Edit this model to choose a shared context window.
                    </p>
                  )}
                  {model.lastTest && (
                    <Appearance kind="fade"><p
                      className={`${styles.status} ${model.lastTest.success ? styles.success : styles.failure}`}
                      role="status"
                    >
                      {model.lastTest.success ? "Answered" : "Test failed"} ·{" "}
                      {new Date(model.lastTest.testedAt).toLocaleString()} ·{" "}
                      {model.lastTest.durationMs.toLocaleString()} ms
                      <br />
                      {model.lastTest.success
                        ? model.lastTest.reply
                        : model.lastTest.error}
                    </p></Appearance>
                  )}
                  </details>)}
                </article></Appearance>
              ))}
            </div>
            {dirty && id && (
              <p className={shared.modelStatus}>
                Apply or save connection changes before testing models.
              </p>
            )}
            {catalogLoading && !catalog.items.length && (
              <Appearance kind="fade"><p className={shared.listMessage} role="status">
                Loading saved models…
              </p></Appearance>
            )}
            {!catalogLoading && !catalog.items.length && (
              <Appearance kind="fade">
              <p className={shared.listMessage}>
                {query
                  ? "No matching models."
                  : "No models yet. Load the model list or add a model manually."}
              </p>
              </Appearance>
            )}
            {catalog.total > 50 && (
              <div className={styles.pagination}>
                <button
                  type="button"
                  className="textButton"
                  disabled={!offset}
                  onClick={() => changeModelPage(Math.max(0, offset - 50))}
                >
                  Previous
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + 50, catalog.total)} of{" "}
                  {catalog.total}
                </span>
                <button
                  type="button"
                  className="textButton"
                  disabled={offset + 50 >= catalog.total}
                  onClick={() => changeModelPage(offset + 50)}
                >
                  Next
                </button>
              </div>
            )}
          </section>
          </>}
        </fieldset>
        <footer className={shared.editorFooter}>
          {error && (
            <Appearance kind="fade"><p className="error" role="alert">
              {error}{" "}
              <button
                type="button"
                className="textButton"
                onClick={discover}
                disabled={busy || !!testing}
              >
                Retry discovery
              </button>
            </p></Appearance>
          )}
          {testing && (
            <Appearance kind="fade"><p className={styles.status} role="status">
              Testing {testing}…{" "}
              <button type="button" className="textButton" onClick={cancelTest}>
                Cancel test
              </button>
            </p></Appearance>
          )}
          <div className={shared.footerActions}>
            {id && (
              <button
                type="button"
                className="button deleteButton"
                disabled={busy || !!testing}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={14} aria-hidden="true" />
                Delete
              </button>
            )}
            <div />
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => attempt(onClose)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!provider || busy || !!testing || selectionLoading || !!selectionLoadError}
            >
              <Check size={14} aria-hidden="true" />
              {busy ? "Working…" : "Save Provider"}
            </button>
          </div>
        </footer>
      </form>
      {selectionImpact && (
        <Dialog title="Clear linked model choices?" busy={busy} onClose={() => setSelectionImpact(null)}>
          <p>Saving this Provider will clear the model choice from {selectionImpact.total.toLocaleString()} linked {selectionImpact.total === 1 ? "preset" : "presets"}. Their Provider and compaction settings will be kept.</p>
          <ul>{selectionImpact.presets.map(preset => <li key={preset.id}>{preset.name}</li>)}</ul>
          {selectionImpact.total > selectionImpact.presets.length && <p>And {(selectionImpact.total - selectionImpact.presets.length).toLocaleString()} more.</p>}
          <div className="dialogActions">
            <button type="button" className="button secondary" disabled={busy} onClick={() => setSelectionImpact(null)}>Cancel</button>
            <button type="button" className="button primary" disabled={busy} onClick={() => void saveProvider(selectionImpact.confirmationToken)}>{busy ? "Saving…" : "Save & clear model choices"}</button>
          </div>
        </Dialog>
      )}
      {id && modelEditor && (
        <ModelEditor
          connectionId={id}
          model={modelEditor.model}
          onDirty={setModelDirty}
          onClose={() => setModelEditor(null)}
          onSaved={handleModelSaved}
        />
      )}
      {confirmDelete && (
        <Dialog
          title="Delete Provider?"
          onClose={() => setConfirmDelete(false)}
          busy={busy}
        >
          <p>
            Delete <strong>{name}</strong> and its saved models and credentials?
            Linked presets will have their Provider and model selections
            cleared.
          </p>
          {error && (
            <Appearance kind="fade"><p className="error" role="alert">
              {error}
            </p></Appearance>
          )}
          <div className="dialogActions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button className="button danger" disabled={busy} onClick={remove}>
              Delete Provider
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
export default function Providers() {
  const connections = useConnections((state) => state.connections);
  const load = useConnections((state) => state.load);
  const status = useConnections((state) => state.status);
  const error = useConnections((state) => state.error);
  const lastOpenedId = useConnections((state) => state.lastOpenedId);
  const rememberOpened = useConnections((state) => state.rememberOpened);
  const [snapshot, setSnapshot] = useState<ProviderConnection | undefined>();
  // Undefined resolves the entry selection; null is an explicit library view.
  const [selection, setSelection] = useState<string | null>();
  const [opened, setOpened] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const attempt = useNavigationGuard();
  useEffect(() => {
    let active = true;
    void load().then(() => {
      if (active) setOpened(true);
    });
    const stopRefreshing = refreshOnFocus(load);
    return () => {
      active = false;
      stopRefreshing();
    };
  }, [load]);
  useEffect(() => {
    if (!opened || status !== "ready") return;
    if (selection === undefined) {
      const next =
        connections.find((connection) => connection.id === lastOpenedId) ??
        connections[0];
      setSnapshot(next);
      setSelection(next?.id ?? "new");
      rememberOpened(next?.id ?? null);
    } else if (!connections.length && selection === null) {
      setSelection("new");
    }
  }, [opened, status, connections, selection, lastOpenedId, rememberOpened]);
  function choose(id: string | null) {
    if (id === selection) return;
    attempt(() => {
      setSnapshot(connections.find((connection) => connection.id === id));
      setSelection(id);
      if (id && id !== "new") rememberOpened(id);
    });
  }
  function saved(id: string) {
    setSnapshot(connections.find((connection) => connection.id === id));
    setSelection(id);
    rememberOpened(id);
  }
  function deleted() {
    setSnapshot(undefined);
    setSelection(undefined);
  }
  function clearCreatedAppearance() {
    setCreatedId(null);
  }
  const selected =
    connections.find((connection) => connection.id === selection) ??
    (snapshot?.id === selection ? snapshot : undefined);
  return (
    <section className={shared.page} aria-label="Providers">
      <header className="pageHeader">
        <div>
          <h1>
            Providers
            <span className="count">
              {connections.length}
            </span>
          </h1>
          <p>Connect your AI services and manage their models.</p>
        </div>
        <button
          className="button primary"
          onClick={() => choose("new")}
          disabled={selection === "new"}
        >
          <Plus size={15} aria-hidden="true" />
          New Provider
        </button>
      </header>
      {error && (
        <Appearance kind="fade">
        <div className="errorBanner" role="alert">
          {error}
          <button className="textButton" onClick={() => void load()}>
            Retry
          </button>
        </div>
        </Appearance>
      )}
      <div
        className={`${shared.layout} ${selection ? shared.hasSelection : ""}`}
      >
        <aside className={shared.library} aria-label="Provider library">
          {status === "loading" && !connections.length && (
            <Appearance kind="fade"><p className={shared.listMessage} role="status">
              Loading Providers…
            </p></Appearance>
          )}
          {status === "ready" && !connections.length && (
            <Appearance kind="fade">
            <p className={shared.listMessage}>
              No Providers yet. Connect a service to get started.
            </p>
            </Appearance>
          )}
          <div className={shared.presetList}>
            {connections.map((connection) => (
              <Appearance key={connection.id} kind="fade" ready={connection.id === createdId}><button
                onAnimationEnd={clearCreatedAppearance}
                className={`${shared.presetItem} ${selection === connection.id ? styles.selected : ""}`}
                aria-current={selection === connection.id ? "true" : undefined}
                onClick={() => choose(connection.id)}
              >
                <Server size={17} aria-hidden="true" />
                <span>
                  <strong>{connection.name}</strong>
                  <small>
                    {providerOptions.find((p) => p.id === connection.provider)
                      ?.label ?? connection.provider}
                  </small>
                </span>
              </button></Appearance>
            ))}
          </div>
        </aside>
        <Appearance kind="selection" trigger={selection}><div className={shared.detail}>
          {selection &&
          (selection === "new" || selected) ? (
            <>
              {connections.length > 0 && (
                <button
                  className={`textButton ${shared.backButton}`}
                  onClick={() => choose(null)}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                  Provider library
                </button>
              )}
              <ProviderEditor
                key={selection}
                connection={selected}
                onSaved={saved}
                onCreated={setCreatedId}
                onClose={() => setSelection(null)}
                onDeleted={deleted}
              />
            </>
          ) : (
            <div className="centerState">
              <Server size={28} aria-hidden="true" />
              <h2>Choose a Provider</h2>
              <p>
                Set up authentication, browse models, and try a short test
                prompt.
              </p>
            </div>
          )}
        </div></Appearance>
      </div>
    </section>
  );
}
