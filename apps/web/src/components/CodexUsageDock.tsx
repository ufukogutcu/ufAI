import { memo, useContext, useEffect, useRef, useState } from "react";
import { AlertCircle, Info, LoaderCircle, LogIn } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ConnectionContext, useConnections } from "../connection-store";
import { CodexUsageContext, useCodexUsage, type UsageEntry } from "../codex-usage-store";
import { startUsagePolling } from "../codex-usage-polling";
import { creditsLabel, dateTime, durationLabel, expiryCountdown, remainingPercent, resetCountdown, usageTooltip, usageWindowLabel, usageWindows } from "../codex-usage-format";
import type { CodexResetCredit, CodexUsageWindow, ProviderConnection } from "../api";
import { Dialog } from "./Dialog";
import { GlassMaterial } from "./GlassMaterial";
import { Tooltip } from "./Tooltip";
import { CodexUsageBar } from "./CodexUsageBar";
import styles from "./CodexUsageDock.module.scss";

function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => { if (document.visibilityState !== "hidden") setNow(Date.now()); };
    const timer = setInterval(tick, 60000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);
  return now;
}
function UsageCoordinator() {
  const connections = useContext(ConnectionContext)!;
  const usage = useContext(CodexUsageContext)!;
  const providers = useConnections(useShallow((state) => state.connections.filter((provider) => provider.provider === "codex" && !provider.draft)));
  useEffect(() => {
    usage.getState().sync(providers.map((provider) => provider.id));
    if (document.visibilityState !== "hidden") void usage.getState().refreshAll();
  }, [providers, usage]);
  useEffect(() => {
    const stop = startUsagePolling(async () => {
      await connections.getState().load();
      if (document.visibilityState === "visible") await usage.getState().refreshAll();
    });
    return () => { stop(); usage.getState().dispose(); };
  }, [connections, usage]);
  return null;
}
const UsageButton = memo(function UsageButton({ provider, onOpen }: { provider: ProviderConnection; onOpen: (id: string) => void }) {
  const entry = useCodexUsage((state) => state.entries[provider.id]);
  const refresh = useCodexUsage((state) => state.refresh);
  const now = useMinute();
  const lastDue = useRef<string>("");
  const windows = usageWindows(entry?.snapshot);
  useEffect(() => {
    const due = usageWindows(entry?.snapshot).some((window) => window.resetsAt !== null && window.resetsAt * 1000 <= now);
    const key = usageWindows(entry?.snapshot).filter((window) => window.resetsAt !== null && window.resetsAt * 1000 <= now).map((window) => window.resetsAt).join(",");
    if (due && lastDue.current !== key && !entry?.loading) {
      lastDue.current = key;
      void refresh(provider.id, false, true);
    }
  }, [entry?.snapshot, entry?.loading, now, provider.id, refresh]);
  const summary = windows.map((window) => `${durationLabel(window.windowDurationMins)} ${remainingPercent(window.usedPercent)}% remaining`).join(", ");
  return <Tooltip content={usageTooltip(provider.name, entry?.snapshot, entry?.error ?? "", now)} visualContent={<UsageTooltip name={provider.name} entry={entry} now={now} />} bubbleClassName={styles.usageTooltip} placement="right" hoverDelayMs={100} live>
    <button className={styles.usageButton} type="button" aria-label={`${provider.name}: ${summary || (entry?.disconnected ? "Sign in to view usage" : entry?.loading ? "Loading usage" : "Usage unavailable")}. Open usage details`} aria-haspopup="dialog" onClick={() => onOpen(provider.id)}>
      {windows.length ? windows.map((window) => <span key={entry?.snapshot?.defaultLimit?.primary === window ? "primary" : "secondary"} className={styles.compactWindow}>
        <span>{durationLabel(window.windowDurationMins)}</span><CodexUsageBar remaining={remainingPercent(window.usedPercent)} />
      </span>) : entry?.disconnected ? <LogIn size={18} aria-hidden="true" /> : entry?.loading ? <LoaderCircle size={18} aria-hidden="true" /> : <span aria-hidden="true">—</span>}
      {entry?.error && !!windows.length && <AlertCircle className={styles.staleMark} size={10} aria-hidden="true" />}
    </button>
  </Tooltip>;
});
function usageState(entry: UsageEntry | undefined): string {
  return entry?.disconnected ? "Sign-in required." : entry?.loading ? "Loading usage…" : "Usage unavailable.";
}
function UsageTooltip({ name, entry, now }: { name: string; entry?: UsageEntry; now: number }) {
  const snapshot = entry?.snapshot;
  const windows = usageWindows(snapshot);
  return <div className={styles.tooltipBody}>
    <div className={styles.tooltipHeading}><strong>{name}</strong><span>{snapshot?.planType ? `Plan: ${snapshot.planType}` : "Plan unavailable"}</span></div>
    {windows.length ? windows.map((window) => <UsageWindow key={snapshot?.defaultLimit?.primary === window ? "primary" : "secondary"} window={window} now={now} />) : <p className={styles.emptyState}>{snapshot ? "Usage windows unavailable." : usageState(entry)}</p>}
    {snapshot?.ordinaryUsageAllowed === false && <p className={styles.notice}>Included usage is currently unavailable according to Codex.</p>}
    {entry?.error && <div className={styles.warning}><AlertCircle size={14} aria-hidden="true" /><span>{snapshot ? "Stale usage · " : ""}{entry.error}</span></div>}
    <div className={styles.tooltipFooter}>
      <span>{creditsLabel(snapshot?.defaultLimit?.credits ?? null)}</span>
      {snapshot && <span>Updated {dateTime(Date.parse(snapshot.fetchedAt) / 1000)}</span>}
    </div>
  </div>;
}
function UsageWindow({ window, now, showDate = false }: { window: CodexUsageWindow; now: number; showDate?: boolean }) {
  return <div className={styles.window}>
    <div className={styles.windowHeading}><span>{usageWindowLabel(window.windowDurationMins)}</span><strong>{remainingPercent(window.usedPercent)}% remaining</strong></div>
    <CodexUsageBar remaining={remainingPercent(window.usedPercent)} fullWidth />
    <div className={styles.resetTime}><span>{resetCountdown(window.resetsAt, now)}</span>{showDate && window.resetsAt !== null && <span>{dateTime(window.resetsAt)}</span>}</div>
  </div>;
}
function resetIneligibility(credit: CodexResetCredit, now: number): string {
  if (credit.status !== "available") return `This reset is ${credit.status}.`;
  if (credit.resetType !== "codexRateLimits") return "This reset type is not supported.";
  if (credit.expiresAt !== null && credit.expiresAt * 1000 <= now) return "This reset has expired.";
  return "";
}
function ResetRow({ credit, now, unavailableReason, onUse }: {
  credit: CodexResetCredit;
  now: number;
  unavailableReason: string;
  onUse: (credit: CodexResetCredit) => void;
}) {
  const title = credit.title ?? "Earned reset";
  const ineligible = resetIneligibility(credit, now);
  const reason = ineligible || unavailableReason;
  const expiry = expiryCountdown(credit.expiresAt, now);
  const expiryPrefix = expiry.startsWith("Expires in ") ? "Expires in " : expiry === "Expiry unknown" ? "Expiry " : "";
  const details = [title, credit.description, `Status: ${credit.status}`, `Granted: ${dateTime(credit.grantedAt)}`, `Expires: ${credit.expiresAt === null ? "No expiry supplied" : dateTime(credit.expiresAt)}`, reason].filter(Boolean).join("\n");
  return <div className={styles.credit}>
    <Tooltip content={details} multiline live toggleOnClick bubbleClassName={styles.resetTooltip}>
      <button type="button" className={styles.creditTitle} aria-label={`Reset details: ${title}`}><span>{title}</span><Info size={14} aria-hidden="true" /></button>
    </Tooltip>
    <span className={styles.expiry}>{expiryPrefix && <span className={styles.expiryPrefix}>{expiryPrefix}</span>}<span className={styles.expiryValue}>{expiry.slice(expiryPrefix.length)}</span></span>
    {ineligible ? <span className={styles.creditStatus}>{credit.status === "available" ? "Unavailable" : credit.status}</span> : <button type="button" className={`button secondary ${styles.useReset}`} aria-label={`Use reset: ${title}`} disabled={!!reason} onClick={() => onUse(credit)}>Use</button>}
  </div>;
}
function UsageModal({ provider, onClose }: { provider: ProviderConnection; onClose: () => void }) {
  const entry = useCodexUsage((state) => state.entries[provider.id]);
  const refresh = useCodexUsage((state) => state.refresh);
  const redeem = useCodexUsage((state) => state.redeem);
  const setDetails = useCodexUsage((state) => state.setDetails);
  const [confirmation, setConfirmation] = useState<{ creditId?: string; title: string; retry?: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const resetsHeading = useRef<HTMLHeadingElement>(null);
  const now = useMinute();
  useEffect(() => {
    setDetails(provider.id, true);
    void refresh(provider.id, true, true);
    return () => setDetails(provider.id, false);
  }, [provider.id, refresh, setDetails]);
  const snapshot = entry?.snapshot;
  const reset = snapshot?.resetCredits;
  const busy = confirming || !!entry?.redeeming;
  const canReset = !!snapshot && !entry?.disconnected && !busy && !entry?.loading;
  const unavailableReason = entry?.disconnected ? "Sign in to use a reset." : busy ? "A reset is being used." : entry?.loading ? "Wait for usage to finish refreshing." : entry?.attempt ? "Retry the previous reset attempt before using another reset." : !reset?.availableCount ? "No resets are currently available." : "";
  const selectedCredit = reset?.credits?.find((credit) => credit.id === confirmation?.creditId);
  const confirmationReason = confirmation?.retry ? "" : confirmation?.creditId ? selectedCredit ? resetIneligibility(selectedCredit, now) || unavailableReason : "This reset is no longer available. Refresh usage to check." : unavailableReason;
  function openReset(credit: CodexResetCredit) {
    setConfirmation({ creditId: credit.id, title: credit.title ?? "Earned reset" });
  }
  function closeConfirmation() { if (!busy) setConfirmation(null); }
  async function confirm() {
    if (!confirmation || !canReset || confirmationReason) return;
    setConfirming(true);
    try {
      await redeem(provider.id, confirmation.creditId);
      setConfirmation(null);
    } finally { setConfirming(false); }
  }
  return <><Dialog title={`${provider.name} usage`} onClose={onClose} busy={busy} contentClassName={styles.dialogContent}>
    <div className={styles.modalBody}>
      <div className={styles.summary}><div className={styles.accountDetails}><span>Plan: {snapshot?.planType ?? "Unknown"}</span>{snapshot && <span className={styles.updated}>Updated {dateTime(Date.parse(snapshot.fetchedAt) / 1000)}</span>}</div><button type="button" className="button secondary" disabled={entry?.loading || entry?.redeeming} onClick={() => void refresh(provider.id, true, true)}>{entry?.loading ? "Refreshing…" : "Refresh"}</button></div>
      {entry?.error && <div className={`${styles.warning} ${styles.error}`} role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{snapshot ? "Stale usage · " : ""}{entry.error}</span></div>}
      {!snapshot && <p className={styles.emptyState}>{usageState(entry)}</p>}
      {snapshot && <>
        {snapshot.ordinaryUsageAllowed === false && <p className={styles.notice}>Included usage is currently unavailable according to Codex.</p>}
        {!snapshot.limits.length && <p className={styles.emptyState}>Usage windows unavailable.</p>}
        {snapshot.limits.map((limit) => <section className={styles.section} key={limit.id}>
          <h3>{limit.name ?? (limit.id === "codex" ? "Codex limits" : limit.id)}</h3>
          {limit.primary && <UsageWindow window={limit.primary} now={now} showDate />}
          {limit.secondary && <UsageWindow window={limit.secondary} now={now} showDate />}
          {!limit.primary && !limit.secondary && <p>Usage windows unavailable.</p>}
          <p className={styles.supporting}>{creditsLabel(limit.credits)}</p>
          {limit.reachedType && <p className={styles.supporting}>Limit status: {limit.reachedType.replaceAll("_", " ")}</p>}
        </section>)}
        <section className={styles.section}>
          <div className={styles.sectionHeading}><h3 ref={resetsHeading} tabIndex={-1}>Earned resets</h3>{reset && <span>{reset.availableCount} available</span>}</div>
          {!reset && <p>Reset availability is unknown.</p>}
          {reset && reset.credits === null && <p>Individual reset details are unavailable.</p>}
          {reset?.credits && reset.credits.length < reset.availableCount && <p>Codex returned details for only some available resets.</p>}
          {!!reset?.credits?.length && <div className={styles.resetsList}>{reset.credits.map((credit) => <ResetRow key={credit.id} credit={credit} now={now} unavailableReason={unavailableReason} onUse={openReset} />)}</div>}
          {!!reset?.availableCount && (!reset.credits?.length || reset.credits.length < reset.availableCount) && <button type="button" className={`button secondary ${styles.resetFallback}`} disabled={!canReset || !!entry?.attempt} onClick={() => setConfirmation({ title: "Next available reset" })}>Use next available reset</button>}
          {entry?.attempt && <button type="button" className={`button secondary ${styles.resetFallback}`} disabled={!canReset} onClick={() => setConfirmation({ creditId: entry.attempt?.creditId, title: "Previous reset attempt", retry: true })}>Retry previous reset attempt</button>}
          {entry?.message && <p role="status">{entry.message}</p>}
        </section>
      </>}
    </div>
  </Dialog>
    {confirmation && <Dialog title="Use reset?" onClose={closeConfirmation} busy={busy} initialFocusSelector="[data-cancel-reset]" returnFocusFallbackRef={resetsHeading} contentClassName={styles.dialogContent}>
      <div className={styles.confirmation}>
        <strong>{confirmation.title}</strong>
        <p>This consumes one earned reset if an eligible usage window can be reset.</p>
        {confirmationReason && !busy && <p role="status">{confirmationReason}</p>}
        <div className={styles.actions}><button type="button" className="button secondary" data-cancel-reset disabled={busy} onClick={closeConfirmation}>Cancel</button><button type="button" className="button" disabled={!canReset || !!confirmationReason} onClick={() => void confirm()}>{busy ? "Using reset…" : "Use reset"}</button></div>
      </div>
    </Dialog>}
  </>;
}
export function CodexUsageDock() {
  const providers = useConnections(useShallow((state) => state.connections.filter((provider) => provider.provider === "codex" && !provider.draft)));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = providers.find((provider) => provider.id === selectedId);
  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);
  return <>
    <UsageCoordinator />
    {!!providers.length && <div className={`${styles.dock} glassSurface`} role="group" aria-label="Codex Provider usage">
      <GlassMaterial />
      <div className={styles.buttons}>{providers.map((provider) => <UsageButton key={provider.id} provider={provider} onOpen={setSelectedId} />)}</div>
    </div>}
    {selected && <UsageModal key={selected.id} provider={selected} onClose={() => setSelectedId(null)} />}
  </>;
}
