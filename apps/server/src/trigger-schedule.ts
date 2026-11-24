import { retiredFileEvent } from "./workspace-folder-migration.js";
import { Cron } from "croner";
import { isDeepStrictEqual } from "node:util";
import { ConnectionError } from "./model-providers.js";
import type {
  EventFilter,
  TriggerInput,
  TriggerWhen,
} from "./trigger-types.js";

export const triggerError = (message: string, status = 400): never => {
  throw new ConnectionError(message, status);
};
export function text(value: unknown, label: string, maximum = 12000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    value.includes("\0")
  )
    triggerError(`Provide ${label} (1–${maximum} characters).`);
  return (value as string).trim();
}
export function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    triggerError("Use an ISO timestamp with an explicit UTC offset.");
  return new Date(value as string).toISOString();
}
export function timezone(value: unknown): string {
  const zone = text(value, "an IANA timezone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    triggerError("Invalid IANA timezone.");
  }
  return zone;
}
export function validateWhen(
  value: unknown,
  now: string,
  allowPast = false,
): TriggerWhen {
  if (!value || typeof value !== "object" || Array.isArray(value))
    triggerError("Choose when the trigger runs.");
  const w = value as any;
  if (w.kind === "at") {
    const at = instant(w.at);
    if (!allowPast && at <= now) triggerError("Choose a future time.");
    return { kind: "at", at, timezone: timezone(w.timezone) };
  }
  if (w.kind === "every") {
    if (!Number.isSafeInteger(w.everyMs) || w.everyMs < 1000)
      triggerError("Use an interval of at least 1,000 whole milliseconds.");
    return {
      kind: "every",
      everyMs: w.everyMs,
      anchor: w.anchor ? instant(w.anchor) : now,
    };
  }
  if (w.kind === "cron") {
    const expression = text(w.expression, "a cron expression", 256),
      zone = timezone(w.timezone);
    if (![5, 6].includes(expression.split(/\s+/).length))
      triggerError("Use five or six cron fields.");
    try {
      const c = new Cron(expression, { timezone: zone, paused: true });
      if (!c.nextRun(new Date(now)))
        triggerError("This cron expression has no future occurrence.");
    } catch {
      triggerError("Invalid cron expression or no future occurrence.");
    }
    return { kind: "cron", expression, timezone: zone };
  }
  if (w.kind === "event") {
    const eventType = text(w.eventType, "an event type", 160);
    if (eventType === retiredFileEvent)
      triggerError("This file event was retired. Choose another event type.");
    if (!/^[a-zA-Z0-9][\w.:-]*$/.test(eventType))
      triggerError(
        "Use letters, numbers, dots, colons or hyphens in event types.",
      );
    const filters: EventFilter[] = w.filters ?? [];
    if (!Array.isArray(filters) || filters.length > 32)
      triggerError("Use at most 32 filters.");
    for (const f of filters) {
      if (
        !f ||
        typeof f.path !== "string" ||
        !/^[\w-]+(?:\.[\w-]+)*$/.test(f.path) ||
        f.path
          .split(".")
          .some((p) => ["__proto__", "prototype", "constructor"].includes(p)) ||
        !["exists", "eq", "ne", "gt", "gte", "lt", "lte", "in"].includes(
          f.operator,
        )
      )
        triggerError("Invalid event filter.");
      if (
        ["gt", "gte", "lt", "lte"].includes(f.operator) &&
        (typeof f.value !== "number" || !Number.isFinite(f.value))
      )
        triggerError("Numeric filters need a finite number.");
      if (
        f.operator === "in" &&
        (!Array.isArray(f.value) || f.value.length > 100)
      )
        triggerError("Membership filters need an array of at most 100 values.");
    }
    if (Buffer.byteLength(JSON.stringify(filters)) > 12000)
      triggerError("Event filters exceed 12 KiB.");
    return {
      kind: "event",
      eventType,
      ...(w.sourceId ? { sourceId: text(w.sourceId, "a source ID", 100) } : {}),
      filters,
    };
  }
  return triggerError("Choose Once, Interval, Cron or Event.");
}
export function triggerInput(
  value: unknown,
  now: string,
  allowPast = false,
): TriggerInput {
  const x = value as any;
  if (!x || typeof x !== "object" || Array.isArray(x))
    triggerError("Provide a trigger definition.");
  if (typeof x.enabled !== "boolean" || typeof x.paused !== "boolean")
    triggerError("Provide enabled and paused switches.");
  const ids = x.requiredSkillIds ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 50 ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 100)
  )
    triggerError("Provide at most 50 required skill IDs.");
  return {
    name: text(x.name, "a trigger name", 160),
    instructions: text(x.instructions, "task instructions"),
    when: validateWhen(x.when, now, allowPast),
    enabled: x.enabled,
    paused: x.paused,
    requiredSkillIds: [...new Set<string>(ids)],
    ...(x.skillId ? { skillId: text(x.skillId, "a skill ID", 100) } : {}),
    ...(x.templateId
      ? { templateId: text(x.templateId, "a template ID", 100) }
      : {}),
  };
}
export function nextTime(w: TriggerWhen, after: string): string | null {
  if (w.kind === "event") return null;
  if (w.kind === "at") return w.at > after ? w.at : null;
  if (w.kind === "every") {
    const anchor = Date.parse(w.anchor!),
      t =
        anchor +
        Math.max(1, Math.floor((Date.parse(after) - anchor) / w.everyMs) + 1) *
          w.everyMs;
    return Number.isFinite(t) && t <= 253402300799999
      ? new Date(t).toISOString()
      : null;
  }
  return (
    new Cron(w.expression, { timezone: w.timezone, paused: true })
      .nextRun(new Date(after))
      ?.toISOString() ?? null
  );
}
export function matches(filters: EventFilter[] = [], data: unknown): boolean {
  return filters.every((f) => {
    let v: any = data;
    for (const part of f.path.split("."))
      v =
        v != null && typeof v === "object" && Object.hasOwn(v, part)
          ? v[part]
          : undefined;
    const equal = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);
    switch (f.operator) {
      case "exists":
        return v !== undefined;
      case "eq":
        return v !== undefined && equal(v, f.value);
      case "ne":
        return v !== undefined && !equal(v, f.value);
      case "in":
        return (
          v !== undefined && (f.value as unknown[]).some((x) => equal(v, x))
        );
      default:
        return (
          typeof v === "number" &&
          (f.operator === "gt"
            ? v > Number(f.value)
            : f.operator === "gte"
              ? v >= Number(f.value)
              : f.operator === "lt"
                ? v < Number(f.value)
                : v <= Number(f.value))
        );
    }
  });
}
/** Resolve a wall time without depending on the browser or host timezone. */
export function wallTime(local: string, zone: string): string {
  timezone(zone);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(local))
    triggerError("Choose a local date and time.");
  const target = Date.parse(`${local.length === 16 ? local + ":00" : local}Z`);
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = (ms: number) =>
    Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, p.value]));
  const normalized = local.length === 16 ? local + ":00" : local;
  const candidates = new Set<number>();
  for (const sample of [target - 86400000, target, target + 86400000]) {
    const p = parts(sample),
      offset =
        Date.parse(
          `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
        ) - sample;
    candidates.add(target - offset);
  }
  for (const ms of [...candidates].sort((a, b) => a - b)) {
    const p = parts(ms);
    if (
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` ===
      normalized
    )
      return new Date(ms).toISOString();
  }
  return triggerError(
    "This local time does not exist in the selected timezone.",
  );
}
