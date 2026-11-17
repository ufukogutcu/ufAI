/** Browser-safe contracts. Import these as types only. */
export type TriggerWhen =
  | { kind: "at"; at: string; timezone: string }
  | { kind: "every"; everyMs: number; anchor?: string }
  | { kind: "cron"; expression: string; timezone: string }
  | {
      kind: "event";
      sourceId?: string;
      eventType: string;
      filters?: EventFilter[];
    };
export interface EventFilter {
  path: string;
  operator: "exists" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in";
  value?: unknown;
}
export interface TriggerInput {
  name: string;
  instructions: string;
  when: TriggerWhen;
  enabled: boolean;
  paused: boolean;
  requiredSkillIds: string[];
  skillId?: string;
  templateId?: string;
}
export interface Trigger extends TriggerInput {
  id: string;
  agentId: string;
  workspaceId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  state: "active" | "paused" | "disabled" | "blocked" | "review_required";
  blocker: string | null;
  nextAt: string | null;
  queued: number;
  oldestPendingAt: string | null;
  collectingBacklog: boolean;
  currentTaskId: string | null;
}
export interface TriggerOccurrence {
  id: string;
  triggerId: string;
  triggerName: string;
  agentId: string;
  revision: number;
  kind: "schedule" | "event" | "manual";
  scheduledAt: string;
  createdAt: string;
  dispatchedAt: string | null;
  state:
    | "queued"
    | "submitted"
    | "completed"
    | "failed"
    | "cancelled"
    | "suppressed";
  taskId: string | null;
  turnId: string | null;
  eventId: string | null;
  error: string | null;
  taskStatus?: string;
}
export interface EventSource {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface EventAttachment {
  versionId: string;
  mode?: "file" | "inspect";
}
export interface EventInput {
  eventId: string;
  eventType: string;
  occurredAt?: string;
  data: unknown;
  attachments?: EventAttachment[];
}
export interface EventReceipt {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  eventId: string;
  eventType: string;
  occurredAt: string;
  receivedAt: string;
  data: unknown;
  attachments: EventAttachment[];
  matched: number;
  processed: boolean;
}
export interface SkillTriggerTemplate {
  timezoneRequired?: boolean;
  id: string;
  name: string;
  description: string;
  instructions: string;
  when: TriggerWhen;
  requiredSkills?: string[];
}
export interface SkillAutomationSetup {
  id: string;
  agentId: string;
  skillId: string;
  fingerprint: string;
  kind: "setup" | "review";
  state: "pending" | "reviewing" | "awaiting_user" | "approved" | "declined";
  taskId: string | null;
  templates: SkillTriggerTemplate[];
  error: string | null;
  snapshot: {
    instructions: string;
    files: { path: string; hash: string }[];
    manifest: unknown;
  };
  previousSnapshot: SkillAutomationSetup["snapshot"] | null;
  createdAt: string;
}
export interface TriggerPage<T> {
  items: T[];
  total: number;
}
