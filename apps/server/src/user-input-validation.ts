import type { InputAnswer, InputDefinition, InputField, InputValue } from "./vault-types.js";
import { InputError } from "./validation.js";

const types = ["text", "single_choice", "multi_select", "boolean", "number", "integer", "email", "url", "date", "date_time"];
const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError({ definition: "Supply an object." });
  return value as Record<string, any>;
}
function invalid(message: string): never { throw new InputError({ definition: message }); }
export function validateDefinition(kind: string, value: unknown): InputDefinition {
  const d = object(value ?? {});
  if (bytes(d) > 24576) invalid("Request definition must fit within 24 KiB.");
  if (Object.keys(d).some(k => !["fields", "options", "allowOther", "default", "minLength", "maxLength", "minSelections", "maxSelections"].includes(k))) invalid("Unknown request definition field.");
  if (kind === "form") {
    if (Object.keys(d).some(k => k !== "fields") || !Array.isArray(d.fields) || d.fields.length < 1 || d.fields.length > 20) invalid("A form needs 1–20 fields.");
    const seen = new Set<string>();
    for (const f of d.fields) {
      validateField(f);
      if (seen.has(f.id)) invalid("Form field IDs must be unique.");
      seen.add(f.id);
    }
  } else {
    if (d.fields !== undefined) invalid("Only forms have fields.");
    validateField({ ...d, id: "answer", label: "Answer", type: kind, required: true });
  }
  return JSON.parse(JSON.stringify(d)) as InputDefinition;
}
function validateField(value: unknown) {
  const f = object(value);
  if (Object.keys(f).some(k => !["id", "label", "type", "required", "description", "options", "allowOther", "default", "minLength", "maxLength", "minimum", "maximum", "minSelections", "maxSelections"].includes(k))) invalid("Unknown form field property.");
  if (typeof f.id !== "string" || (!identifier.test(f.id) || ["constructor", "prototype", "__proto__"].includes(f.id)) || !types.includes(f.type) || typeof f.label !== "string" || !f.label.trim() || f.label.length > 160) invalid("Each field needs a stable ID, supported type and label of at most 160 characters.");
  if (f.description !== undefined && (typeof f.description !== "string" || f.description.length > 2000)) invalid("Field descriptions allow at most 2,000 characters.");
  if (f.required !== undefined && typeof f.required !== "boolean") invalid("Required must be true or false.");
  const choice = ["single_choice", "multi_select"].includes(f.type);
  if (choice) {
    if (!Array.isArray(f.options) || !f.options.length || f.options.length > 50) invalid("Choice fields need 1–50 options.");
    const ids = new Set<string>();
    for (const o of f.options) {
      object(o);
      if (Object.keys(o).some(k => !["id", "label", "description"].includes(k)) || typeof o.id !== "string" || !identifier.test(o.id) || ids.has(o.id) || typeof o.label !== "string" || !o.label.trim() || o.label.length > 160 || (o.description !== undefined && (typeof o.description !== "string" || o.description.length > 2000))) invalid("Options need unique IDs, labels, and optional descriptions.");
      ids.add(o.id);
    }
    if (f.required && f.type === "multi_select" && f.maxSelections === 0) invalid("A required selection must allow at least one answer.");
    if (f.allowOther !== undefined && typeof f.allowOther !== "boolean") invalid("Allow Other must be true or false.");
  } else if (f.options !== undefined || f.allowOther !== undefined) invalid("Only choice fields allow options or Other.");
  for (const [lo, hi, allowed] of [["minLength", "maxLength", ["text", "email", "url"]], ["minSelections", "maxSelections", ["multi_select"]], ["minimum", "maximum", ["number", "integer"]]] as const) {
    for (const key of [lo, hi]) if (f[key] !== undefined && (!allowed.includes(f.type as never) || typeof f[key] !== "number" || !Number.isFinite(f[key]) || (key !== "minimum" && key !== "maximum" && (!Number.isInteger(f[key]) || f[key] < 0)))) invalid("Invalid field bounds.");
    if (f[lo] !== undefined && f[hi] !== undefined && f[lo] > f[hi]) invalid("Minimum cannot exceed maximum.");
  }
  if (f.maxLength > 8192 || f.minLength > 8192 || f.maxSelections > 51 || f.minSelections > (f.options?.length ?? 0) + (f.allowOther ? 1 : 0)) invalid("Field bounds exceed supported limits.");
  if (Object.hasOwn(f, "default")) {
    const errors: Record<string, string> = {};
    validateValue(f as InputField, f.default, errors);
    if (Object.keys(errors).length) invalid("A field default does not satisfy its constraints.");
  }
}
function validateValue(f: InputField, v: unknown, errors: Record<string, string>): InputValue | undefined {
  const error = (message: string) => { errors[f.id] = message; return undefined; };
  if (v === undefined || v === "") return f.required ? error("Answer this field.") : undefined;
  if (["single_choice", "multi_select"].includes(f.type)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return error("Select a valid option.");
    const c = v as Record<string, any>;
    if (Object.keys(c).some(k => !["selected", "other"].includes(k)) || !Array.isArray(c.selected) || c.selected.some((id: unknown) => typeof id !== "string" || !f.options?.some(o => o.id === id)) || new Set(c.selected).size !== c.selected.length) return error("Select valid, distinct options.");
    if (c.other !== undefined && (!f.allowOther || typeof c.other !== "string" || !c.other.trim() || c.other.length > 8192)) return error("Enter a custom answer or clear Other.");
    const count = c.selected.length + (c.other === undefined ? 0 : 1);
    if (!count && !f.required && !(f.minSelections ?? 0)) return undefined;
    if ((f.type === "single_choice" && count !== 1) || count < Math.max(f.minSelections ?? 0, f.required ? 1 : 0) || count > (f.maxSelections ?? 51)) return error("Choose the required number of answers.");
    return { selected: f.options!.filter(o => c.selected.includes(o.id)).map(o => o.id), ...(c.other === undefined ? {} : { other: c.other }) };
  }
  if (f.type === "boolean") return typeof v === "boolean" ? v : error("Choose Yes or No.");
  if (f.type === "number" || f.type === "integer") return typeof v === "number" && Number.isFinite(v) && (f.type !== "integer" || Number.isSafeInteger(v)) && (f.minimum === undefined || v >= f.minimum) && (f.maximum === undefined || v <= f.maximum) ? v : error("Enter a valid number within the allowed range.");
  if (typeof v !== "string" || !v.trim() || v.length < (f.minLength ?? 0) || v.length > (f.maxLength ?? 8192)) return error("Enter text within the allowed length.");
  if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return error("Enter a valid email address.");
  if (f.type === "url") { try { new URL(v); } catch { return error("Enter a complete URL."); } }
  if (f.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)) return error("Enter a valid calendar date.");
  if (f.type === "date_time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v)) || !Number.isFinite(Date.parse(v.slice(0, 10))) || new Date(v.slice(0, 10)).toISOString().slice(0, 10) !== v.slice(0, 10) || Number(v.slice(11, 13)) > 23)) return error("Enter a valid date and time with a timezone offset.");
  return v;
}
export function inputFields(kind: string, name: string, definition: InputDefinition): InputField[] {
  return kind === "form" ? definition.fields! : [{ ...definition, id: "answer", label: name, type: kind as InputField["type"], required: true }];
}
export function validateAnswer(kind: string, name: string, definition: InputDefinition, answer: unknown): InputAnswer {
  const errors: Record<string, string> = {};
  const fields = inputFields(kind, name, definition);
  const values = kind === "form" ? object(answer) : { answer };
  const result: Record<string, InputValue> = Object.create(null);
  for (const key of Object.keys(values)) if (!fields.some(f => f.id === key)) errors[key] = "Unknown answer field.";
  for (const field of fields) {
    const value = validateValue(field, Object.hasOwn(values, field.id) ? values[field.id] : undefined, errors);
    if (value !== undefined) result[field.id] = value;
  }
  if (bytes(result) > 8192) errors.answer = "The complete answer must fit within 8 KiB. Shorten your answers.";
  if (Object.keys(errors).length) throw new InputError(errors);
  return kind === "form" ? result : result.answer!;
}
