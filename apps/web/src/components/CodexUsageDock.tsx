import { memo, useContext, useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle, LogIn } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ConnectionContext, useConnections } from "../connection-store";
import { CodexUsageContext, useCodexUsage } from "../codex-usage-store";
import { startUsagePolling } from "../codex-usage-polling";
import { creditsLabel, dateTime, durationLabel, remainingPercent, resetCountdown, usageTooltip, usageWindows } from "../codex-usage-format";
import type { CodexUsageWindow, ProviderConnection } from "../api";
import { Dialog } from "./Dialog";
import { GlassMaterial } from "./GlassMaterial";
import { Tooltip } from "./Tooltip";
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
  return <Tooltip content={usageTooltip(provider.name, entry?.snapshot, entry?.error ?? "", now)} placement="right" hoverDelayMs={100} live multiline>
    <button className={styles.usageButton} type="button" aria-label={`${provider.name}: ${summary || (entry?.disconnected ? "Sign in to view usage" : "Usage unavailable")}. Open usage details`} aria-haspopup="dialog" onClick={() => onOpen(provider.id)}>
      {windows.length ? windows.map((window) => <span key={entry?.snapshot?.defaultLimit?.primary === window ? "primary" : "secondary"} className={styles.compactWindow}>
        <span>{durationLabel(window.windowDurationMins)}</span><strong>{remainingPercent(window.usedPercent)}%</strong>
      </span>) : entry?.disconnected ? <LogIn size={18} aria-hidden="true" /> : entry?.loading ? <LoaderCircle size={18} aria-hidden="true" /> : <span aria-hidden="true">—</span>}
      {entry?.error && !!windows.length && <AlertCircle className={styles.staleMark} size={10} aria-hidden="true" />}
    </button>
  </Tooltip>;
});
function UsageWindow({ window, now }: { window: CodexUsageWindow; now: number }) {
  return <div className={styles.window}>
    <div><strong>{durationLabel(window.windowDurationMins)} usage</strong><span>{remainingPercent(window.usedPercent)}% remaining</span></div>
    <p>{resetCountdown(window.resetsAt, now)}<br />{dateTime(window.resetsAt)}</p>
  </div>;
}
function UsageModal({ provider, onClose }: { provider: ProviderConnection; onClose: () => void }) {
  const entry = useCodexUsage((state) => state.entries[provider.id]);
  const refresh = useCodexUsage((state) => state.refresh);
  const redeem = useCodexUsage((state) => state.redeem);
  const setDetails = useCodexUsage((state) => state.setDetails);
  const [confirmation, setConfirmation] = useState<{ creditId?: string; title: string } | null>(null);
  const now = useMinute();
  useEffect(() => {
    setDetails(provider.id, true);
    void refresh(provider.id, true, true);
    return () => setDetails(provider.id, false);
  }, [provider.id, refresh, setDetails]);
  const snapshot = entry?.snapshot;
  const reset = snapshot?.resetCredits;
  const canReset = !!snapshot && !entry?.disconnected && !entry?.redeeming && !entry?.loading;
  async function confirm() {
    await redeem(provider.id, confirmation?.creditId);
    setConfirmation(null);
  }
  return <Dialog title={`${provider.name} usage`} onClose={onClose} busy={entry?.redeeming}>
    <div className={styles.modalBody}>
      <div className={styles.summary}><span>Plan: {snapshot?.planType ?? "Unknown"}</span><button type="button" className="button secondary" disabled={entry?.loading || entry?.redeeming} onClick={() => void refresh(provider.id, true, true)}>{entry?.loading ? "Refreshing…" : "Refresh"}</button></div>
      {entry?.error && <p className={styles.error} role="alert">{snapshot ? "Previously fetched usage · " : ""}{entry.error}</p>}
      {!snapshot && !entry?.error && <p>{entry?.loading ? "Loading usage…" : "Usage unavailable."}</p>}
      {snapshot && <>
        <p className={styles.updated}>Updated {dateTime(Date.parse(snapshot.fetchedAt) / 1000)}</p>
        {snapshot.ordinaryUsageAllowed === false && <p>Included usage is currently unavailable according to Codex.</p>}
        {snapshot.limits.map((limit) => <section className={styles.section} key={limit.id}>
          <h3>{limit.name ?? (limit.id === "codex" ? "Codex limits" : limit.id)}</h3>
          {limit.primary && <UsageWindow window={limit.primary} now={now} />}
          {limit.secondary && <UsageWindow window={limit.secondary} now={now} />}
          {!limit.primary && !limit.secondary && <p>Usage windows unavailable.</p>}
          <p>{creditsLabel(limit.credits)}</p>
          {limit.reachedType && <p>Limit status: {limit.reachedType.replaceAll("_", " ")}</p>}
        </section>)}
        <section className={styles.section}>
          <h3>Earned resets</h3>
          <p>{reset ? `${reset.availableCount} available` : "Reset availability is unknown."}</p>
          {reset && reset.credits === null && <p>Individual reset details are unavailable.</p>}
          {reset?.credits && reset.credits.length < reset.availableCount && <p>Codex returned details for only some available resets.</p>}
          {reset?.credits?.map((credit) => <div className={styles.credit} key={credit.id}>
            <strong>{credit.title ?? "Earned reset"}</strong>
            {credit.description && <p>{credit.description}</p>}
            <p>Status: {credit.status}<br />Granted: {dateTime(credit.grantedAt)}<br />Expires: {credit.expiresAt === null ? "No expiry supplied" : dateTime(credit.expiresAt)}</p>
            <button type="button" className="button secondary" aria-label={`Use reset: ${credit.title ?? credit.id}`} disabled={!canReset || !reset?.availableCount || !!entry?.attempt || credit.status !== "available" || credit.resetType !== "codexRateLimits" || (credit.expiresAt !== null && credit.expiresAt * 1000 <= now)} onClick={() => setConfirmation({ creditId: credit.id, title: credit.title ?? "Earned reset" })}>Use reset</button>
          </div>)}
          {!!reset?.availableCount && (!reset.credits?.length || reset.credits.length < reset.availableCount) && <button type="button" className="button secondary" disabled={!canReset || !!entry?.attempt} onClick={() => setConfirmation({ title: "Next available reset" })}>Use next available reset</button>}
          {entry?.attempt && <button type="button" className="button secondary" disabled={!canReset} onClick={() => setConfirmation({ creditId: entry.attempt?.creditId, title: "Previous reset attempt" })}>Retry previous reset attempt</button>}
          {confirmation && <div className={styles.confirmation}>
            <p><strong>{confirmation.title}</strong><br />This consumes one earned reset if an eligible usage window can be reset.</p>
            <div className={styles.actions}><button type="button" className="button" disabled={!canReset} onClick={() => void confirm()}>{entry?.redeeming ? "Using reset…" : "Confirm use reset"}</button><button type="button" className="button secondary" disabled={entry?.redeeming} onClick={() => setConfirmation(null)}>Cancel</button></div>
          </div>}
          {entry?.message && <p role="status">{entry.message}</p>}
        </section>
      </>}
    </div>
  </Dialog>;
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
