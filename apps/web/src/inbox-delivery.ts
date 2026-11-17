import type { AppSettings, InboxNotification, InboxNotifications } from "../../server/src/contracts";

export interface InboxAlertGroup { latest: InboxNotification; count: number }
export function groupInboxAlerts(items: InboxNotification[], previous: InboxAlertGroup[] = []): InboxAlertGroup[] {
  const groups = new Map(previous.map(group => [group.latest.workspaceId, group]));
  for (const item of items) {
    if (item.readAt) continue;
    const old = groups.get(item.workspaceId);
    if (old && old.latest.sequence >= item.sequence) continue;
    groups.delete(item.workspaceId);
    groups.set(item.workspaceId, { latest: item, count: (old?.count ?? 0) + 1 });
    if (groups.size > 20) groups.delete(groups.keys().next().value!);
  }
  return [...groups.values()];
}

export interface InboxChannel {
  postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null;
  close: () => void;
}
export interface InboxDeliveryOptions {
  id: string;
  read: (cursor: number | undefined, signal: AbortSignal) => Promise<InboxNotifications>;
  stream: (refresh: () => void, failed: () => void) => () => void;
  settings: () => Pick<AppSettings, "inboxInAppAlertsEnabled" | "inboxDesktopAlertsEnabled">;
  focused: () => boolean;
  alerts: (groups: InboxAlertGroup[]) => void;
  desktop: (group: InboxAlertGroup, failed: () => void) => boolean;
  syncSettings?: () => void;
  unread: (total: number) => void;
  error: (message: string) => void;
  channel?: InboxChannel;
  locks?: Pick<LockManager, "request">;
}

type SharedState = { cursor: number | undefined; unreadTotal: number; pending: InboxAlertGroup[] };
type Packet =
  | { type: "hello" | "presence"; id: string; focused: boolean }
  | { type: "bye"; id: string }
  | { type: "preferences" }
  | { type: "state"; state: SharedState }
  | { type: "alerts"; target: string; groups: InboxAlertGroup[] };

// Instance-scoped coordination contains no durable preferences or browser identity.
// Only the lock owner reads the feed and creates desktop notifications.
export function startInboxDelivery(options: InboxDeliveryOptions) {
  const coordinated = !!options.channel && !!options.locks;
  let channel = coordinated ? options.channel : undefined;
  if (!coordinated) options.channel?.close();
  const peers = new Map<string, { focused: boolean; seen: number }>();
  let state: SharedState = { cursor: undefined, unreadTotal: 0, pending: [] };
  let stopped = false, leader = false, reading = false, dirty = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  let closeStream: (() => void) | undefined;
  let release: (() => void) | undefined;
  const abort = new AbortController();
  const send = (packet: Packet) => channel?.postMessage(packet);
  const share = () => send({ type: "state", state });
  const focusedTab = () => {
    for (const [id, peer] of peers) if (Date.now() - peer.seen > 15000) peers.delete(id);
    if (options.focused()) return options.id;
    for (const [id, peer] of peers) if (peer.focused) return id;
    return undefined;
  };
  function present(groups: InboxAlertGroup[], target: string) {
    if (target === options.id) options.alerts(groups);
    else send({ type: "alerts", target, groups });
  }
  function flush() {
    if (!leader || !state.pending.length) return;
    if (!options.settings().inboxInAppAlertsEnabled) { state.pending = []; share(); return; }
    const target = focusedTab();
    if (target) { present(state.pending, target); state.pending = []; share(); }
  }
  function defer(group: InboxAlertGroup) {
    if (stopped || !options.settings().inboxInAppAlertsEnabled) return;
    const old = state.pending.find(item => item.latest.workspaceId === group.latest.workspaceId);
    state.pending = groupInboxAlerts([group.latest], state.pending).map(item => item.latest.id === group.latest.id
      ? { ...item, count: (old?.count ?? 0) + group.count } : item);
    flush(); share();
  }
  function deliver(groups: InboxAlertGroup[]) {
    const settings = options.settings(), target = focusedTab();
    if (target) {
      if (settings.inboxInAppAlertsEnabled) present(groups, target);
      return;
    }
    for (const group of groups) {
      let deferred = false;
      const fallback = () => { if (!deferred) { deferred = true; defer(group); } };
      const delivered = settings.inboxDesktopAlertsEnabled && options.desktop(group, fallback);
      if (!delivered) fallback();
    }
  }
  function failed(message: string) {
    if (stopped) return;
    options.error(message);
    retry ??= setTimeout(() => { retry = undefined; refresh(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
  function refresh() {
    if (stopped || !leader) return;
    dirty = true;
    if (reading) return;
    reading = true;
    void (async () => {
      try {
        do {
          dirty = false;
          const page = await options.read(state.cursor, abort.signal);
          if (stopped) return;
          const groups = groupInboxAlerts(page.items);
          state = { ...state, cursor: page.cursor, unreadTotal: page.unreadTotal };
          options.unread(page.unreadTotal);
          if (groups.length) deliver(groups);
          // Broadcast each committed page so a successor resumes without replay.
          share();
          if (page.hasMore) dirty = true;
        } while (dirty && !stopped);
        flush(); share();
        clearTimeout(retry); retry = undefined; retryDelay = 1000;
        options.error("");
      } catch (error) {
        failed(error instanceof Error ? error.message : "Inbox could not refresh.");
      } finally {
        reading = false;
      }
    })();
  }
  function presence(refreshRead = true) {
    if (stopped) return;
    send({ type: "presence", id: options.id, focused: options.focused() });
    flush();
    // A resumed tab may have a suspended stream; read through the same cursor.
    if (refreshRead && options.focused()) refresh();
  }
  if (channel) channel.onmessage = event => {
    if (stopped) return;
    const packet = event.data as Packet;
    if (packet.type === "hello" || packet.type === "presence") {
      peers.delete(packet.id);
      peers.set(packet.id, { focused: packet.focused, seen: Date.now() });
      if (peers.size > 128) peers.delete(peers.keys().next().value!);
      if (packet.type === "hello") {
        if (state.cursor !== undefined) share();
        send({ type: "presence", id: options.id, focused: options.focused() });
      }
      flush();
    } else if (packet.type === "bye") peers.delete(packet.id);
    else if (packet.type === "preferences") options.syncSettings?.();
    else if (packet.type === "state" && !leader && (state.cursor === undefined || (packet.state.cursor ?? -1) >= state.cursor)) {
      state = packet.state; options.unread(state.unreadTotal);
    } else if (packet.type === "alerts" && packet.target === options.id && options.settings().inboxInAppAlertsEnabled) {
      options.alerts(packet.groups);
    }
  };
  const start = () => {
    if (stopped) return;
    leader = true;
    closeStream = options.stream(refresh, () => failed("Inbox is reconnecting. New messages will appear when the connection returns."));
    refresh();
  };
  send({ type: "hello", id: options.id, focused: options.focused() });
  // Allow existing tabs to share their cursor before a new leader initializes.
  const startup = setTimeout(() => {
    if (coordinated) {
      void options.locks!.request("ufai-inbox-delivery", { signal: abort.signal }, async () => {
        if (stopped) return;
        await new Promise<void>(resolve => { release = resolve; start(); });
      }).catch(() => {
        if (stopped) return;
        // A browser can expose Locks while refusing access in this context.
        // Continue without coordination, as when either API is absent.
        channel?.close(); channel = undefined; peers.clear(); start();
      });
    } else start();
  }, coordinated ? 120 : 0);
  const heartbeat = setInterval(() => presence(false), 5000);
  return {
    refresh,
    presence,
    preferencesChanged() { send({ type: "preferences" }); flush(); },
    stop() {
      if (stopped) return;
      stopped = true; send({ type: "bye", id: options.id });
      clearTimeout(startup); clearTimeout(retry); clearInterval(heartbeat);
      abort.abort(); closeStream?.(); release?.(); channel?.close();
    },
  };
}
