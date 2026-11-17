import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Workspace, WorkspaceDuplicateInput, WorkspaceDuplication } from "../../../server/src/contracts";
import { request, errorMessage, RequestError } from "../api";
import { Dialog } from "./Dialog";
import { BusyButton, Feedback, LoadingState } from "./Feedback";
import styles from "./WorkspaceDuplicate.module.scss";

export const duplicateOptions = [
  ["includeConnections", "Agent connections", true],
  ["includeSkills", "Skill settings", true],
  ["includeMcp", "MCP settings", true],
  ["includeMemories", "Learned memories", false],
  ["includeWorkspaceFiles", "Workspace shared files", false],
  ["includeAgentFiles", "Agent working files", false],
  ["includeTriggers", "Triggers", false],
] as const;

export function WorkspaceDuplicate({ source, initialOperation, onClose, onCompleted, openError = "" }: {
  source?: Workspace;
  initialOperation?: WorkspaceDuplication;
  onClose: () => void;
  onCompleted: (id: string) => void;
  openError?: string;
}) {
  const [name, setName] = useState(source ? `${source.name.slice(0, 113)} (copy)` : initialOperation?.name ?? "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [options, setOptions] = useState(() => Object.fromEntries(duplicateOptions.map(([key, , value]) => [key, value])) as Pick<WorkspaceDuplicateInput, typeof duplicateOptions[number][0]>);
  const [operation, setOperation] = useState(initialOperation ?? null);
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState("");
  const [pollFailed, setPollFailed] = useState(false), [pollRetry, setPollRetry] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const requestId = useRef(crypto.randomUUID());
  const sentInput = useRef<string | null>(null);
  const opened = useRef(false), completion = useRef(onCompleted);
  const fieldId = useId();
  const running = operation?.state === "pending" || operation?.state === "running";
  const busy = submitting || (running && !pollFailed);
  useEffect(() => { completion.current = onCompleted; }, [onCompleted]);
  useEffect(() => {
    if (!operation) return;
    if (operation.state === "completed") {
      if (!opened.current && operation.workspaceId) { opened.current = true; completion.current(operation.workspaceId); }
      return;
    }
    if (operation.state === "failed") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await request<WorkspaceDuplication>(`/workspace-duplications/${operation!.id}`, "GET", undefined, controller.signal);
        if (!controller.signal.aborted) { setError(""); setPollFailed(false); setOperation(value); }
      } catch (failure) {
        if (!controller.signal.aborted) { setError(errorMessage(failure)); setPollFailed(true); }
      }
    }
    timer = setTimeout(() => void poll(), 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [operation, pollRetry]);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setSubmitting(true); setError(""); setFields({});
    try {
      if (operation?.state === "failed") {
        setOperation(await request<WorkspaceDuplication>(`/workspace-duplications/${operation.id}/retry`, "POST"));
      } else if (source) {
        const payload = { name, description, ...options };
        const encoded = JSON.stringify(payload);
        if (sentInput.current !== null && sentInput.current !== encoded) requestId.current = crypto.randomUUID();
        sentInput.current = encoded;
        setOperation(await request<WorkspaceDuplication>(`/workspaces/${source.id}/duplicate`, "POST", { ...payload, requestId: requestId.current }));
      }
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof RequestError) setFields(failure.fields);
    } finally { setSubmitting(false); }
  }
  return <Dialog title="Duplicate workspace" onClose={onClose} busy={busy}>
    <form className={styles.form} onSubmit={submit}>
      {!operation && <>
        <label className="field">Workspace name
          <input value={name} onChange={event => setName(event.target.value)} maxLength={120} required disabled={busy}
            aria-invalid={!!fields.name} aria-describedby={fields.name ? `${fieldId}-name` : undefined} />
          {fields.name && <span className="fieldError" id={`${fieldId}-name`}>{fields.name}</span>}
        </label>
        <label className="field">Description (optional)
          <textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} maxLength={4000} disabled={busy}
            aria-invalid={!!fields.description} aria-describedby={fields.description ? `${fieldId}-description` : undefined} />
          {fields.description && <span className="fieldError" id={`${fieldId}-description`}>{fields.description}</span>}
        </label>
        <p className={styles.hint}>All agents, instructions, appearances, preset choices, and canvas layout are copied. Conversations start fresh.</p>
        <fieldset className={styles.options} disabled={busy}>
          <legend>Also copy</legend>
          {duplicateOptions.map(([key, label]) => <label key={key} className={styles.option}>
            <input type="checkbox" checked={options[key]} onChange={event => setOptions(current => ({ ...current, [key]: event.target.checked }))}
              aria-describedby={key === "includeTriggers" ? `${fieldId}-triggers` : undefined} />{label}
          </label>)}
        </fieldset>
        <p className={styles.hint}>Presets, skill packages, and MCP server configurations remain shared. Agent enablement settings are independent. Files include working folders only, with no task folders, published outputs, or browser profiles.</p>
        <p className={styles.hint} id={`${fieldId}-triggers`}>Included triggers keep their enabled and paused states. Enabled triggers can start work when copying finishes. Copied custom event sources need new credentials; rotate them in Triggers.</p>
      </>}
      {running && <LoadingState>{operation.phase === "publishing" ? "Finishing workspace…" : "Copying workspace…"} You can reopen ufAI to check progress if this page closes.</LoadingState>}
      {operation?.state === "completed" && <p role="status">Workspace duplicated: {operation.name}</p>}
      {(error || operation?.error || openError) && <Feedback role="alert">{error || operation?.error || openError}</Feedback>}
      <div className="dialogActions">
        <button type="button" className="button secondary" onClick={onClose} disabled={busy}>{operation ? "Close" : "Cancel"}</button>
        {pollFailed ? <button type="button" className="button primary" onClick={() => { setPollFailed(false); setError(""); setPollRetry(current => current + 1); }}>Retry status</button> : operation?.state === "completed" ? <button type="button" className="button primary" onClick={() => operation.workspaceId && onCompleted(operation.workspaceId)}>Open workspace</button> :
          <BusyButton busy={busy} className="button primary" disabled={busy}>{busy ? "Duplicating…" : operation?.state === "failed" ? "Retry duplication" : "Duplicate workspace"}</BusyButton>}
      </div>
    </form>
  </Dialog>;
}
