import { useEffect, useState } from "react";
import { useSettings } from "../settings-store";
import { SkillSwitch } from "../components/SkillSwitch";
import { Feedback } from "../components/Feedback";
import styles from "./Settings.module.scss";

export default function SettingsPage() {
  const inApp = useSettings(state => state.snapshot.settings.inboxInAppAlertsEnabled);
  const desktop = useSettings(state => state.snapshot.settings.inboxDesktopAlertsEnabled);
  const update = useSettings(state => state.update);
  const supported = window.isSecureContext && "Notification" in window;
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() => supported ? Notification.permission : "unsupported");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => setPermission(supported ? Notification.permission : "unsupported");
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [supported]);
  async function enableDesktop() {
    setBusy(true); setError("");
    try {
      // Called directly from the button gesture, never during startup or arrival.
      const result = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      setPermission(result);
      if (result === "granted") await update({ inboxDesktopAlertsEnabled: true });
    } catch { setError("Desktop notifications could not be enabled. Check this site's browser permissions and try again."); }
    finally { setBusy(false); }
  }
  async function toggleInApp() {
    setBusy(true);
    try { await update({ inboxInAppAlertsEnabled: !inApp }); } finally { setBusy(false); }
  }
  async function disableDesktop() {
    setBusy(true);
    try { await update({ inboxDesktopAlertsEnabled: false }); } finally { setBusy(false); }
  }
  return <section className={styles.page}>
    <header className="pageHeader"><h1>Settings</h1></header>
    <div className={styles.content}>
      <h2>Notifications</h2>
      <p>New Inbox messages from every workspace can alert you while a ufAI tab is open. Ordinary task answers stay in their conversations.</p>
      <div className={styles.option}>
        <SkillSwitch aria-label="In-app alerts" checked={inApp} disabled={busy} onChange={() => void toggleInApp()} />
        <div><strong>In-app alerts</strong><p>Show dismissible alerts while you’re using ufAI.</p></div>
      </div>
      <div className={styles.option}>
        <div><strong>Desktop alerts</strong><p>Show workspace, sender, and a short preview when ufAI is in the background. Private input requests use generic text.</p></div>
      </div>
      <p role="status">{permission === "unsupported" ? "Desktop alerts are unavailable in this browser or connection. Use a supported desktop browser on localhost or HTTPS."
        : permission === "denied" ? "Desktop alerts are blocked. Allow notifications in this site's browser settings, then return here to enable them."
        : desktop && permission === "granted" ? "Desktop alerts are enabled in this browser."
        : desktop ? "Desktop alerts are enabled for this installation. Allow notifications in this browser to receive them here."
        : "Desktop alerts are off."}</p>
      <div className={styles.actions}>
        {permission !== "unsupported" && permission !== "denied" && (!desktop || permission !== "granted") &&
          <button className="button" disabled={busy} onClick={() => void enableDesktop()}>{busy ? "Saving…" : "Enable desktop alerts"}</button>}
        {desktop && <button className="button secondary" disabled={busy} onClick={() => void disableDesktop()}>Disable desktop alerts</button>}
      </div>
      {error && <Feedback role="alert">{error}</Feedback>}
      <p>No ufAI chime is added. Desktop sound follows browser and OS settings. Alerts require the browser to keep the tab running; delivery stops when all ufAI tabs are closed.</p>
    </div>
  </section>;
}
