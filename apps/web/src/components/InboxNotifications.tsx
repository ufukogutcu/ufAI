import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createStore, useStore } from "zustand";
import type { InboxNotification, InboxNotifications } from "../../../server/src/contracts";
import { request, RequestError } from "../api";
import { startInboxDelivery, type InboxAlertGroup } from "../inbox-delivery";
import { useSettingsStore } from "../settings-store";
import { useFeedbackStore } from "./FeedbackProvider";

export interface InboxTarget { workspaceId: string; id: string; request: number }
export function createInboxNotificationStore() {
  let sequence = 0;
  return createStore<{
    unreadTotal: number;
    navigation: InboxTarget | null;
    target: InboxTarget | null;
    open: (entry: Pick<InboxNotification, "workspaceId" | "id">) => void;
  }>()(set => ({
    unreadTotal: 0, navigation: null, target: null,
    open: entry => set({ navigation: { workspaceId: entry.workspaceId, id: entry.id, request: ++sequence } }),
  }));
}
type InboxStore = ReturnType<typeof createInboxNotificationStore>;
const InboxContext = createContext<InboxStore | null>(null);
function createChannel() {
  try { return new BroadcastChannel("ufai-inbox"); } catch { return undefined; }
}
export function useInboxNotificationStore() { return useContext(InboxContext); }
export function useInboxNotifications<T>(selector: (state: ReturnType<InboxStore["getState"]>) => T) {
  const store = useContext(InboxContext);
  if (!store) throw new Error("InboxNotificationsProvider is missing.");
  return useStore(store, selector);
}

export function InboxNotificationsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createInboxNotificationStore);
  const settings = useSettingsStore();
  const feedback = useFeedbackStore();
  useEffect(() => {
    if (!feedback) return;
    const noticeIds: string[] = [];
    const desktop = new Map<string, Notification>();
    const groupCounts = new Map<string, number>();
    function alerts(groups: InboxAlertGroup[]) {
      for (const { latest, count } of groups) {
        const id = `inbox-arrival:${latest.workspaceId}`;
        const previous = feedback!.getState().notices.find(notice => notice.id === id);
        const total = (previous && !previous.dismissed ? groupCounts.get(id) ?? 0 : 0) + count;
        groupCounts.set(id, total);
        const index = noticeIds.indexOf(id);
        if (index !== -1) noticeIds.splice(index, 1);
        noticeIds.push(id);
        while (noticeIds.length > 20) { const removed = noticeIds.shift()!; feedback!.getState().remove(removed); groupCounts.delete(removed); }
        feedback!.getState().publish({ id, tone: "info",
          title: `${latest.workspaceName} · ${latest.agentName}`,
          message: `${total > 1 ? `${total} new messages. ` : ""}${latest.preview}`,
          // An arrival ID distinguishes two identical message previews.
          episode: latest.id,
          actionLabel: "Open Inbox",
          action: () => { store.getState().open(latest); feedback!.getState().resolve(id); },
        });
      }
    }
    const controller = startInboxDelivery({
      id: crypto.randomUUID(),
      async read(cursor, signal) {
        try {
          return await request<InboxNotifications>(`/inbox/notifications${cursor === undefined ? "" : `?after=${cursor}`}`, "GET", undefined, signal);
        } catch (error) {
          // A replaced/restored database may no longer contain this session's cursor.
          if (cursor !== undefined && error instanceof RequestError && error.status === 400)
            return request<InboxNotifications>("/inbox/notifications", "GET", undefined, signal);
          throw error;
        }
      },
      stream(refresh, failed) {
        const stream = new EventSource("/api/inbox/events");
        stream.addEventListener("change", refresh);
        stream.onopen = refresh;
        stream.onerror = failed;
        return () => stream.close();
      },
      settings: () => settings.getState().snapshot.settings,
      focused: () => document.visibilityState === "visible" && document.hasFocus(),
      alerts,
      desktop(group, failed) {
        if (!window.isSecureContext || !("Notification" in window) || Notification.permission !== "granted") return false;
        try {
          const { latest, count } = group;
          const notification = new Notification(`${latest.workspaceName} · ${latest.agentName}`, {
            body: `${count > 1 ? `${count} new messages. ` : ""}${latest.preview}`,
            tag: `ufai-inbox:${latest.workspaceId}`,
          });
          desktop.get(latest.workspaceId)?.close();
          desktop.delete(latest.workspaceId);
          desktop.set(latest.workspaceId, notification);
          while (desktop.size > 20) { const key = desktop.keys().next().value!; desktop.get(key)?.close(); desktop.delete(key); }
          notification.onerror = failed;
          notification.onclick = () => { window.focus(); store.getState().open(latest); notification.close(); };
          notification.onclose = () => { if (desktop.get(latest.workspaceId) === notification) desktop.delete(latest.workspaceId); };
          return true;
        } catch { return false; }
      },
      unread: unreadTotal => store.setState({ unreadTotal }),
      error(message) {
        if (message) feedback.getState().publish({ id: "inbox-sync", title: "Inbox could not sync", message, tone: "info", actionLabel: "Retry Inbox", action: () => controller.refresh() });
        else feedback.getState().resolve("inbox-sync");
      },
      channel: createChannel(),
      locks: navigator.locks,
      syncSettings: () => { void settings.getState().refresh(); },
    });
    const unsubscribe = settings.subscribe((current, previous) => {
      const next = current.snapshot.settings, old = previous.snapshot.settings;
      if (next.inboxInAppAlertsEnabled !== old.inboxInAppAlertsEnabled || next.inboxDesktopAlertsEnabled !== old.inboxDesktopAlertsEnabled) {
        controller.preferencesChanged();
        if (!next.inboxInAppAlertsEnabled) {
          for (const id of noticeIds) feedback.getState().remove(id);
          noticeIds.length = 0; groupCounts.clear();
        }
        if (!next.inboxDesktopAlertsEnabled) { for (const notification of desktop.values()) notification.close(); desktop.clear(); }
      }
    });
    const onFocus = () => controller.presence();
    window.addEventListener("focus", onFocus); window.addEventListener("blur", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      controller.stop(); unsubscribe();
      window.removeEventListener("focus", onFocus); window.removeEventListener("blur", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      for (const notification of desktop.values()) notification.close();
      for (const id of [...noticeIds, "inbox-sync"]) feedback.getState().remove(id);
    };
  }, [feedback, settings, store]);
  return <InboxContext.Provider value={store}>{children}</InboxContext.Provider>;
}
