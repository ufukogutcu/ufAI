import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { InputField, InputValue, UserInputRequest } from "../../../server/src/vault-types";
import { errorMessage, request, RequestError } from "../api";
import { useUnsavedChanges } from "../navigation-guard";
import { Feedback, LoadingState } from "./Feedback";
import { PrivateInputCard } from "./PrivateInputCard";
import { RequestActions, RequestCard, type RequestAction } from "./RequestCard";
import styles from "./UserInputCard.module.scss";

type Props = { requestId: string; item?: UserInputRequest; refreshKey?: unknown; onChange?: () => void };
export function UserInputCard({ requestId, item, refreshKey, onChange }: Props) {
  const [loaded, setLoaded] = useState<UserInputRequest | undefined>(item);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const current = item && (!loaded || (item.updatedAt > loaded.updatedAt || (loaded.state === "pending" && item.state !== "pending"))) ? item : loaded;
  const refresh = useCallback(async () => {
    const serial = ++generation.current;
    try {
      const result = await request<UserInputRequest>(`/user-input-requests/${requestId}`);
      if (serial === generation.current) { setLoaded(result); setError(""); }
    } catch (e) { if (serial === generation.current) setError(errorMessage(e)); }
  }, [requestId]);
  useEffect(() => {
    void refresh();
    function visible() { if (document.visibilityState === "visible") void refresh(); }
    window.addEventListener("focus", visible);
    window.addEventListener("ufai-private-input-updated", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { generation.current++; window.removeEventListener("focus", visible); window.removeEventListener("ufai-private-input-updated", visible); document.removeEventListener("visibilitychange", visible); };
  }, [refresh, refreshKey]);
  function saved(result: UserInputRequest) { generation.current++; setLoaded(result); onChange?.(); window.dispatchEvent(new window.Event("ufai-private-input-updated")); }
  return current ? current.kind === "secret" ? <PrivateInputCard key={requestId} item={current} onSaved={saved} onRefresh={refresh} />
    : <OrdinaryInputCard key={requestId} item={current} onSaved={saved} onRefresh={refresh} />
    : error ? <Feedback>{error} <button className="textButton" onClick={() => void refresh()}>Retry</button></Feedback> : <LoadingState>Loading request…</LoadingState>;
}
function requestFields(item: UserInputRequest): InputField[] {
  return item.kind === "form" ? item.definition!.fields! : [{ ...item.definition, id: "answer", label: item.name, type: item.kind as InputField["type"], required: true }];
}
function localDateTime(value: string) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, -1) : "";
}
function initialValues(fields: InputField[]) {
  return Object.fromEntries(fields.filter(f => f.default !== undefined).map(f => [f.id, f.type === "date_time" ? localDateTime(String(f.default)) : f.default]));
}
function displayInputValue(field: InputField, value: InputValue | undefined) {
  if (value === undefined) return "Not answered";
  if (typeof value === "object") return [...value.selected.map(id => field.options?.find(o => o.id === id)?.label ?? id), ...(value.other === undefined ? [] : [value.other])].join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (field.type === "date_time") return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(String(value)));
  return String(value);
}
function OrdinaryInputCard({ item, onSaved, onRefresh }: { item: UserInputRequest; onSaved: (r: UserInputRequest) => void; onRefresh: () => Promise<void> }) {
  const fields = requestFields(item);
  const standalone = item.kind !== "form";
  const collapsible = !standalone || (item.definition?.options?.length ?? 0) + Number(!!item.definition?.allowOther) > 4;
  const [expanded, setExpanded] = useState(!collapsible);
  const [values, setValues] = useState<Record<string, any>>(() => initialValues(fields));
  const [dirty, setDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<RequestAction>(null);
  const [error, setError] = useState(""), [errors, setErrors] = useState<Record<string, string>>({});
  const lock = useRef(false), form = useRef<HTMLFormElement>(null), prefix = useId();
  const focusTarget = useRef<string | null>(null);
  const pending = item.state === "pending";
  const busy = pendingAction !== null;
  const discard = useCallback(() => { setValues({}); setDirty(false); }, []);
  useUnsavedChanges(pending && dirty, discard);
  useEffect(() => { if (!pending) discard(); }, [pending, discard]);
  function update(id: string, value: unknown) { setValues(previous => ({ ...previous, [id]: value })); setDirty(true); setErrors(previous => { const next = { ...previous }; delete next[id]; return next; }); }
  function reportErrors(failures: Record<string, string>) {
    focusTarget.current = fields.find(field => failures[field.id])?.id ?? "form";
    setErrors(failures);
  }
  useLayoutEffect(() => {
    if (busy || !focusTarget.current) return;
    const element = document.getElementById(`${prefix}-${focusTarget.current}`);
    focusTarget.current = null;
    (element?.querySelector<HTMLElement>("input,select,textarea") ?? element ?? form.current)?.focus();
  }, [busy, errors, prefix]);
  async function submit(event: FormEvent, decline = false) {
    event.preventDefault();
    if (lock.current) return;
    const failures: Record<string, string> = {}, answers: Record<string, InputValue> = {};
    if (!decline) for (const field of fields) {
      let value = values[field.id];
      const control = form.current?.elements.namedItem(field.id) as HTMLInputElement | null;
      if (control?.validity && !control.validity.valid) failures[field.id] = control.validationMessage;
      if (value === "" || value === undefined) { if (field.required) failures[field.id] = "Answer this field."; continue; }
      if (field.type === "number" || field.type === "integer") value = Number(value);
      if (field.type === "date_time") {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) { failures[field.id] = "Enter a valid date and time."; continue; }
        value = date.toISOString();
      }
      if (field.type === "single_choice" || field.type === "multi_select") {
        const count = value.selected.length + (value.other === undefined ? 0 : 1);
        if (!count && !field.required && !field.minSelections) continue;
        if ((field.type === "single_choice" && count !== 1) || count < Math.max(field.minSelections ?? 0, field.required ? 1 : 0) || count > (field.maxSelections ?? 51)) failures[field.id] = "Choose the required number of answers.";
        if (value.other !== undefined && !value.other.trim()) failures[field.id] = "Enter your custom answer.";
      }
      answers[field.id] = value;
    }
    if (Object.keys(failures).length) { reportErrors(failures); return; }
    lock.current = true; setPendingAction(decline ? "decline" : "submit"); setErrors({}); setError("");
    try {
      const answer = item.kind === "form" ? answers : answers.answer;
      const result = await request<UserInputRequest>(`/user-input-requests/${item.id}/resolve`, "POST", decline ? { decline: true } : { answer });
      discard(); onSaved(result);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof RequestError) {
        if (Object.keys(e.fields).length) reportErrors(e.fields);
        if (e.status === 409) await onRefresh();
      }
    } finally { lock.current = false; setPendingAction(null); }
  }
  return <RequestCard item={item} busy={busy} expanded={expanded} onToggle={collapsible ? () => setExpanded(open => !open) : undefined}>
    {pending ? <form ref={form} className={styles.form} tabIndex={-1} onSubmit={submit} noValidate>
      {fields.map(field => <InputControl key={field.id} field={field} id={`${prefix}-${field.id}`} standalone={standalone} value={values[field.id]} disabled={busy} error={errors[field.id]} onChange={update} />)}
      {errors.answer && !fields.some(f => f.id === "answer") && <Feedback>{errors.answer}</Feedback>}
      {error && <Feedback>{error}</Feedback>}
      <RequestActions label="Send answer" busyLabel="Sending…" pendingAction={pendingAction} onDecline={e => void submit(e, true)} />
    </form> : item.state === "fulfilled" && <details className={styles.outcome}>
      <summary>View answer</summary>
      {standalone ? <p className={styles.answer}>{displayInputValue(fields[0]!, item.answer as InputValue)}</p>
        : <dl className={styles.answers}>{fields.map(field => <div key={field.id}>
          <dt>{field.label}</dt><dd className={styles.answer}>{displayInputValue(field, (item.answer as Record<string, InputValue>)?.[field.id])}</dd>
        </div>)}</dl>}
    </details>}
  </RequestCard>;
}
function InputControl({ field: f, id, standalone, value, disabled, error, onChange }: { field: InputField; id: string; standalone: boolean; value: any; disabled: boolean; error?: string; onChange: (id: string, v: unknown) => void }) {
  const limit = f.type === "multi_select" ? selectionLimit(f) : "";
  const showLimit = !standalone && !!limit;
  const describedBy = [f.description ? id + "-hint" : "", error ? id + "-error" : "", f.type === "date_time" ? id + "-zone" : "", showLimit ? id + "-limit" : ""].filter(Boolean).join(" ") || undefined;
  const common = { id, name: f.id, disabled, "aria-invalid": !!error, "aria-describedby": describedBy, autoComplete: "off" } as const;
  const choice = f.type === "single_choice" || f.type === "multi_select";
  const label = standalone && choice ? f.type === "single_choice" ? "Choose one" : limit || "Choose one or more" : f.label;
  const optional = !standalone && !f.required && <span className={styles.optional}> (optional)</span>;
  const selected: string[] = value?.selected ?? [];
  function choose(option: string, checked: boolean) { onChange(f.id, f.type === "single_choice" ? { selected: [option] } : { ...value, selected: checked ? [...selected, option] : selected.filter(x => x !== option) }); }
  return <div className={styles.field}>
    {choice || f.type === "boolean" ? <fieldset id={id} tabIndex={-1} disabled={disabled} aria-describedby={describedBy} aria-invalid={!!error}>
      <legend>{label}{optional}{f.required && <span className={styles.srOnly}> (required)</span>}</legend>
      {showLimit && <p className={styles.hint} id={id + "-limit"}>{limit}.</p>}
      {f.type === "boolean" ? [true, false].map(v => <label key={String(v)} className={styles.option}><input type="radio" name={f.id} value={String(v)} checked={value === v} onChange={() => onChange(f.id, v)} />{v ? "Yes" : "No"}</label>) : <>
        {f.options!.map(option => <label key={option.id} className={styles.option}><input type={f.type === "single_choice" ? "radio" : "checkbox"} name={f.id} value={option.id} checked={selected.includes(option.id)} onChange={e => choose(option.id, e.target.checked)} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
        {f.allowOther && <><label className={styles.option}><input type={f.type === "single_choice" ? "radio" : "checkbox"} name={f.id} checked={value?.other !== undefined} onChange={e => onChange(f.id, { selected: f.type === "single_choice" ? [] : selected, ...(e.target.checked ? { other: "" } : {}) })} />Other</label>
          {value?.other !== undefined && <><label htmlFor={id + "-other"}>Your own answer</label><textarea id={id + "-other"} name={f.id + "-other"} rows={2} aria-describedby={describedBy} disabled={disabled} value={value.other} maxLength={8192} onChange={e => onChange(f.id, { ...value, other: e.target.value })} /></>}
        </>}
      </>}
    </fieldset> : <><label className={standalone ? styles.srOnly : undefined} htmlFor={id}>{label}{optional}</label>
      {f.type === "text" ? <textarea {...common} rows={2} placeholder={standalone ? "Your answer…" : undefined} required={f.required} minLength={f.minLength} maxLength={f.maxLength ?? 8192} value={value ?? ""} onChange={e => onChange(f.id, e.target.value)} /> : <input {...common} type={f.type === "integer" ? "number" : f.type === "date_time" ? "datetime-local" : f.type} step={f.type === "integer" ? 1 : f.type === "number" || f.type === "date_time" ? "any" : undefined} min={f.minimum} max={f.maximum} required={f.required} spellCheck={false} minLength={f.minLength} maxLength={f.maxLength ?? 8192} value={value ?? ""} onChange={e => onChange(f.id, e.target.value)} />}
    </>}
    {!f.required && (choice || f.type === "boolean") && value !== undefined && <button type="button" className={`textButton ${styles.quietButton}`} disabled={disabled} onClick={() => onChange(f.id, undefined)}>Clear selection</button>}
    {f.description && <p className={styles.hint} id={id + "-hint"}>{f.description}</p>}
    {f.type === "date_time" && <p className={styles.hint} id={id + "-zone"}>Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>}
    {error && <p className={styles.error} id={id + "-error"} role="alert">{error}</p>}
  </div>;
}

function selectionLimit(field: InputField) {
  const minimum = Math.max(field.minSelections ?? 0, field.required ? 1 : 0);
  const available = (field.options?.length ?? 0) + Number(!!field.allowOther);
  const maximum = field.maxSelections ?? available;
  if (minimum === maximum) return `Choose exactly ${minimum}`;
  if (minimum > 1 && maximum < available) return `Choose ${minimum}–${maximum}`;
  if (minimum > 1) return `Choose at least ${minimum}`;
  return maximum < available ? `Choose up to ${maximum}` : "";
}
