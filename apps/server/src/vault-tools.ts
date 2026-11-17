import type { ToolSpec } from "./execution-types.js";
const str = (maxLength = 100) => ({ type: "string", minLength: 1, maxLength });
const spec = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec => ({
  name, description, parameters: { type: "object", properties, required, additionalProperties: false },
});
export const vaultTools: ToolSpec[] = [
  spec("vault_list", "Search the installation-wide shared Vault. Returns metadata and secret IDs, never values. All agents can use saved secrets.", {
    query: { type: "string", maxLength: 160 }, offset: { type: "integer", minimum: 0, maximum: 1000000 }, limit: { type: "integer", minimum: 1, maximum: 100 },
  }),
  spec("user_input_request", "Use whenever a user answer or decision is needed. Cards appear in conversation and Inbox. Kinds: secret (private Vault entry), text, single_choice, multi_select, form. Continue independent work, then task_yield; each reply/decline resumes automatically. Choices return {selected: option IDs, other?: text}. Date-time defaults need an offset. Maximum ten pending per task. Ordinary answers are visible to the agent", {
    kind: { type: "string", enum: ["secret", "text", "single_choice", "multi_select", "form"] }, name: str(160), purpose: str(2000), secretId: str(),
    definition: { type: "object", additionalProperties: true, description: "For form use {fields:[{id,label,type,required?,description?,default?,options?,allowOther?,minLength?,maxLength?,minimum?,maximum?,minSelections?,maxSelections?}]}. Types: text,single_choice,multi_select,boolean,number,integer,email,url,date,date_time. Options: [{id,label,description?}], max 50; max 20 fields. IDs: letters followed by letters/digits/_/-, max 64. Text/choice requests use their field properties directly, without fields/id/label/type/required. Choice defaults: {selected:[IDs],other?:text}. Text length bounds, numeric bounds and multi-select count bounds apply only to those types. Definition max 24 KiB; answer max 8 KiB. Secrets omit definition." },
  }, ["kind", "name", "purpose"]),
  spec("user_input_status", "Read your task's input request, definition and saved answer. Secret requests return only metadata and a Vault reference. Do not poll; use task_yield.", { requestId: str() }, ["requestId"]),
  spec("user_input_cancel", "Cancel your task's pending input request when its answer is no longer needed.", { requestId: str() }, ["requestId"]),
  spec("vault_browser_fill", "Fill a browser field using a Vault secret ID without reading its value. Requires Browser enabled and a fresh element ref. Returns status only. Normal browser snapshots redact known values; screenshot fields are masked. Websites may transform or echo secrets, so concealment is best effort.", {
    secretId: str(), ref: str(),
  }, ["secretId", "ref"]),
  spec("vault_http_request", 'Send an HTTP request with backend-only secret injection. Header/form values may be strings or {secretId,prefix?}; nested JSON values may use the same reference object. Example Authorization: {secretId:"id",prefix:"Bearer "}. HTTPS or loopback HTTP; redirects are returned, not followed. No automatic retry. Response text is bounded and known secret echoes are redacted. Never place secrets in URLs or literal arguments.', {
    url: str(4096), method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
    headers: { type: "object", maxProperties: 32, additionalProperties: true },
    json: { type: "object", additionalProperties: true }, form: { type: "object", maxProperties: 100, additionalProperties: true },
  }, ["url"]),
];
