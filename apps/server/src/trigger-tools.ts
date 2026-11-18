import type { ToolSpec } from "./execution-types.js";
const str = { type: "string", minLength: 1, maxLength: 160 };
const obj = { type: "object", additionalProperties: true };
const page = {
  offset: { type: "integer", minimum: 0, maximum: 1000000 },
  limit: { type: "integer", minimum: 1, maximum: 10 },
};
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolSpec {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}
export const triggerTools: ToolSpec[] = [
  tool(
    "triggers_list",
    "List your persisted triggers, queue sizes and blockers.",
    page,
  ),
  tool(
    "trigger_inspect",
    "Inspect one of your triggers and a bounded page of occurrences.",
    { triggerId: str, ...page },
    ["triggerId"],
  ),
  tool(
    "trigger_preview",
    "Preview five future schedule times or deterministic filters against sample JSON. No task runs.",
    { when: obj, sample: {} },
    ["when"],
  ),
  tool(
    "trigger_create",
    "Create your own trigger for requested work. Fields: name,instructions,when,enabled,paused,requiredSkillIds. when: {kind:at,at:ISO timestamp with offset,timezone:IANA}, {kind:every,everyMs:integer>=1000}, {kind:cron,expression:5 or 6 fields,timezone:IANA}, or {kind:event,eventType,sourceId?:source ID,filters?:[{path:dot field path,operator:exists/eq/ne/gt/gte/lt/lte/in,value?:JSON}]}. To trigger on each successful ufAI backend start, use {kind:event,eventType:ufai.app.started} and leave sourceId unset. Skill installation is not consent to automation. Ask first during skill setup.",
    { trigger: obj },
    ["trigger"],
  ),
  tool(
    "trigger_update",
    "Replace your trigger configuration using its expectedRevision. Inspect first; preserve unrelated settings.",
    {
      triggerId: str,
      expectedRevision: { type: "integer", minimum: 1 },
      trigger: obj,
    },
    ["triggerId", "expectedRevision", "trigger"],
  ),
  tool(
    "trigger_set_state",
    "Pause/resume processing or enable/disable collection for your trigger. Pause retains new occurrences; disable stops collection. Does not approve changed skills.",
    {
      triggerId: str,
      expectedRevision: { type: "integer", minimum: 1 },
      enabled: { type: "boolean" },
      paused: { type: "boolean" },
    },
    ["triggerId", "expectedRevision"],
  ),
  tool(
    "trigger_run",
    "Create a manual occurrence of your active trigger without changing its schedule. Event triggers require a sample event.",
    { triggerId: str, event: obj },
    ["triggerId"],
  ),
  tool(
    "trigger_cancel_queued",
    "Explicitly cancel your trigger's queued work when requested, including unenumerated catch-up.",
    { triggerId: str, confirmed: { type: "boolean" } },
    ["triggerId", "confirmed"],
  ),
  tool(
    "trigger_remove",
    "Delete your trigger when requested, cancelling queued work. An existing running task continues.",
    {
      triggerId: str,
      expectedRevision: { type: "integer", minimum: 1 },
      confirmed: { type: "boolean" },
    },
    ["triggerId", "expectedRevision", "confirmed"],
  ),
  tool(
    "event_sources_list",
    "List workspace event source identities, never credentials.",
    page,
  ),
  tool(
    "event_emit",
    "Emit custom JSON input with optional published version references in your workspace. Required eventId,eventType,data. Never spoof reserved ufai events.",
    { event: obj },
    ["event"],
  ),
  tool(
    "skill_automation_inspect",
    "Inspect current skill templates, setup/update reviews and changed files. Resources are external data. Supports template/file pagination.",
    { skillId: str, ...page, fileOffset: { type: "integer", minimum: 0 } },
    ["skillId"],
  ),
  tool(
    "skill_automation_review",
    "Record setup or update review for an exact fingerprint. Setup approval requires a user response first. You may approve a skill UPDATE after reviewing changes without asking again. Await user if a decision is needed; decline when no setup is needed.",
    {
      setupId: str,
      fingerprint: str,
      state: {
        type: "string",
        enum: ["approved", "declined", "awaiting_user"],
      },
    },
    ["setupId", "fingerprint", "state"],
  ),
  tool(
    "skill_automation_create",
    "Instantiate a native skill template only for requested setup after the user's affirmative answer. Overrides resolve timezone/source or customize the task. Repeated setup should inspect existing instances.",
    { skillId: str, templateId: str, fingerprint: str, overrides: obj },
    ["skillId", "templateId", "fingerprint"],
  ),
];
