import type { CodexCredits, CodexResetCredit, CodexUsageLimit, CodexUsageSnapshot, CodexUsageWindow } from "./contracts.js";
import { ConnectionError } from "./model-providers.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown, length = 300): string | null =>
  typeof value === "string" && value.trim() ? value.slice(0, length) : null;
const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
function window(value: unknown): CodexUsageWindow | null {
  const row = object(value);
  return typeof row.usedPercent === "number" && Number.isSafeInteger(row.usedPercent) && row.usedPercent >= 0
    ? { usedPercent: row.usedPercent, windowDurationMins: positive(row.windowDurationMins), resetsAt: positive(row.resetsAt) }
    : null;
}
function credits(value: unknown): CodexCredits | null {
  const row = object(value);
  return typeof row.hasCredits === "boolean" && typeof row.unlimited === "boolean"
    ? { hasCredits: row.hasCredits, unlimited: row.unlimited, balance: text(row.balance, 100) } : null;
}
function limit(value: unknown, id: string): CodexUsageLimit {
  const row = object(value);
  return {
    id: text(row.limitId, 200) ?? id,
    name: text(row.limitName), primary: window(row.primary), secondary: window(row.secondary),
    credits: credits(row.credits), reachedType: text(row.rateLimitReachedType, 200),
  };
}
export function normalizeCodexUsage(account: unknown, value: unknown): CodexUsageSnapshot {
  const raw = object(value);
  if (!raw.rateLimits || typeof raw.rateLimits !== "object" || Array.isArray(raw.rateLimits))
    throw new ConnectionError("Codex returned invalid usage information. Please retry.");
  const defaultLimit = limit(raw.rateLimits, "codex");
  const limits = Object.entries(object(raw.rateLimitsByLimitId)).slice(0, 128).map(([id, row]) => limit(row, id));
  if (!limits.some((row) => row.id === defaultLimit.id)) limits.unshift(defaultLimit);
  const reset = object(raw.rateLimitResetCredits);
  let resetCredits: CodexUsageSnapshot["resetCredits"] = null;
  if (typeof reset.availableCount === "number" && Number.isSafeInteger(reset.availableCount) && reset.availableCount >= 0) {
    const rows: CodexResetCredit[] | null = Array.isArray(reset.credits) ? reset.credits.slice(0, 1000).flatMap((value: unknown) => {
      const row = object(value);
      const id = text(row.id, 500);
      if (!id) return [];
      return [{
        id, resetType: row.resetType === "codexRateLimits" ? "codexRateLimits" : "unknown",
        status: ["available", "redeeming", "redeemed"].includes(String(row.status)) ? row.status as CodexResetCredit["status"] : "unknown",
        grantedAt: positive(row.grantedAt), expiresAt: positive(row.expiresAt),
        title: text(row.title), description: text(row.description, 1500),
      }];
    }) : null;
    resetCredits = { availableCount: reset.availableCount, credits: rows };
  }
  return {
    planType: text(object(account).planType, 100), defaultLimit, limits, resetCredits,
    ordinaryUsageAllowed: typeof raw.ordinaryUsageAllowed === "boolean" ? raw.ordinaryUsageAllowed : null,
    fetchedAt: new Date().toISOString(),
  };
}
