import type { CodexCredits, CodexUsageSnapshot, CodexUsageWindow } from "./api";
export function durationLabel(minutes: number | null): string {
  if (!minutes) return "Window";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
export function resetCountdown(timestamp: number | null, now: number): string {
  if (timestamp === null) return "Reset time unknown";
  const minutes = Math.ceil((timestamp * 1000 - now) / 60000);
  if (minutes <= 0) return "Reset due · refresh to check";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  return `Resets in ${[days ? `${days}d` : "", hours ? `${hours}h` : "", rest ? `${rest}m` : ""].filter(Boolean).join(" ")}`;
}
export function dateTime(timestamp: number | null): string {
  return timestamp === null ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp * 1000);
}
export function creditsLabel(credits: CodexCredits | null): string {
  if (!credits) return "Credits unavailable";
  if (credits.unlimited) return "Unlimited credits";
  return credits.balance !== null ? `${credits.balance} credits` : credits.hasCredits ? "Credits available · balance unknown" : "No credits available";
}
export const usageWindows = (snapshot?: CodexUsageSnapshot): CodexUsageWindow[] =>
  [snapshot?.defaultLimit?.primary, snapshot?.defaultLimit?.secondary].filter((window): window is CodexUsageWindow => !!window);
export function usageTooltip(name: string, snapshot: CodexUsageSnapshot | undefined, error: string, now: number): string {
  return [name, snapshot?.planType ? `Plan: ${snapshot.planType}` : "Plan unavailable",
    ...usageWindows(snapshot).map((window) => `${durationLabel(window.windowDurationMins)}: ${window.usedPercent}% used · ${resetCountdown(window.resetsAt, now)}`),
    creditsLabel(snapshot?.defaultLimit?.credits ?? null),
    snapshot ? `Updated ${dateTime(Date.parse(snapshot.fetchedAt) / 1000)}` : "Usage unavailable",
    error ? `${snapshot ? "Stale · " : ""}${error}` : "",
  ].filter(Boolean).join("\n");
}
