import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { InboxNotification, InboxNotifications } from "../../server/src/contracts";
import { groupInboxAlerts, startInboxDelivery, type InboxAlertGroup, type InboxChannel, type InboxDeliveryOptions } from "../src/inbox-delivery";
import { createFeedbackStore } from "../src/feedback-store";

function entry(sequence: number, workspaceId = "workspace"): InboxNotification {
  return { sequence, id: `message-${sequence}`, workspaceId, workspaceName: workspaceId, agentName: "Agent", preview: "Ready", readAt: null };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail("Notification condition did not settle");
}
function fixture(t: any, overrides: Partial<InboxDeliveryOptions> = {}) {
  const rows: InboxNotification[] = [];
  const reads: (number | undefined)[] = [], alerts: InboxAlertGroup[][] = [], desktops: InboxAlertGroup[] = [], errors: string[] = [], unread: number[] = [];
  let focused = true, fail = false, refresh = () => {}, closed = 0;
  const preferences = { inboxInAppAlertsEnabled: true, inboxDesktopAlertsEnabled: false };
  const options: InboxDeliveryOptions = {
    id: "a", settings: () => preferences, focused: () => focused,
    async read(cursor) {
      reads.push(cursor);
      if (fail) throw new Error("Offline");
      const items = cursor === undefined ? [] : rows.filter(row => row.sequence > cursor).slice(0, 100);
      return { cursor: items.at(-1)?.sequence ?? rows.at(-1)?.sequence ?? 0, unreadTotal: rows.filter(row => !row.readAt).length, items, hasMore: cursor !== undefined && rows.filter(row => row.sequence > cursor).length > 100 };
    },
    stream(changed) { refresh = changed; return () => { closed++; }; },
    alerts: groups => alerts.push(groups), desktop: group => { desktops.push(group); return true; },
    unread: total => unread.push(total), error: message => errors.push(message), ...overrides,
  };
  const controller = startInboxDelivery(options);
  t.after(() => controller.stop());
  return { controller, rows, reads, alerts, desktops, errors, unread, preferences, refresh: () => refresh(), focus(value: boolean) { focused = value; controller.presence(); }, fail(value: boolean) { fail = value; }, closed: () => closed };
}

test("initial history is silent; arrivals and reconnect catch-up advance once; read changes only update counts", async t => {
  const f = fixture(t);
  f.rows.push(entry(1));
  await until(() => f.reads.length > 0);
  assert.deepEqual(f.alerts, []); assert.equal(f.unread.at(-1), 1);
  f.rows.push(entry(2)); f.refresh();
  await until(() => f.alerts.length === 1);
  assert.equal(f.alerts[0]![0]!.latest.id, "message-2");
  f.rows[0]!.readAt = "read"; f.refresh(); await delay(5);
  assert.equal(f.unread.at(-1), 1); assert.equal(f.alerts.length, 1);
  f.fail(true); f.rows.push(entry(3)); f.refresh();
  await until(() => f.errors.includes("Offline"));
  f.fail(false); f.controller.refresh();
  await until(() => f.alerts.length === 2);
  assert.equal(f.alerts[1]![0]!.latest.sequence, 3); assert.equal(f.errors.at(-1), "");
  f.controller.stop(); f.refresh(); await delay(5);
  assert.equal(f.closed(), 1); assert.equal(f.alerts.length, 2);
});

test("background fallback groups messages on return; granted desktop delivery stays out of in-app alerts", async t => {
  const f = fixture(t, { desktop: () => false });
  await until(() => f.reads.length > 0);
  f.focus(false); f.preferences.inboxDesktopAlertsEnabled = true;
  f.rows.push(entry(1), entry(2)); f.refresh(); await until(() => f.unread.at(-1) === 2);
  assert.deepEqual(f.alerts, []);
  f.focus(true); assert.equal(f.alerts[0]![0]!.count, 2);
  const g = fixture(t);
  await until(() => g.reads.length > 0);
  g.preferences.inboxDesktopAlertsEnabled = true; g.focus(false);
  g.rows.push(entry(1)); g.refresh(); await until(() => g.desktops.length === 1);
  g.focus(true); assert.deepEqual(g.alerts, []);
});

test("asynchronous desktop failures fall back once and disabled alerts still keep unread counts", async t => {
  let failed = () => {};
  const f = fixture(t, { desktop(_group, onFailure) { failed = onFailure; return true; } });
  await until(() => f.reads.length > 0);
  f.preferences.inboxDesktopAlertsEnabled = true; f.focus(false);
  f.rows.push(entry(1)); f.refresh(); await until(() => f.unread.at(-1) === 1);
  failed(); failed(); f.focus(true);
  assert.equal(f.alerts.length, 1); assert.equal(f.alerts[0]![0]!.count, 1);
  f.preferences.inboxInAppAlertsEnabled = false;
  f.rows.push(entry(2)); f.refresh(); await until(() => f.unread.at(-1) === 2);
  assert.equal(f.alerts.length, 1);
});

test("catch-up drains multiple bounded pages and groups retain at most twenty workspaces", async t => {
  const f = fixture(t);
  await until(() => f.reads.length > 0);
  f.rows.push(...Array.from({ length: 105 }, (_, i) => entry(i + 1)));
  f.refresh(); await until(() => f.alerts.flat().reduce((sum, group) => sum + group.count, 0) === 105);
  assert.deepEqual(f.reads, [undefined, 0, 100]);
  const groups = groupInboxAlerts(Array.from({ length: 40 }, (_, i) => entry(i + 1, `w${i}`)));
  assert.equal(groups.length, 20); assert.equal(groups[0]!.latest.workspaceId, "w20");
  assert.equal(groupInboxAlerts([entry(1), entry(1)]).length, 1);
  assert.equal(groupInboxAlerts([{ ...entry(1), readAt: "read" }]).length, 0);
});

function coordination() {
  const channels = new Set<InboxChannel>();
  const channel = (): InboxChannel => {
    const current: InboxChannel = {
      onmessage: null,
      postMessage(message) { for (const peer of channels) if (peer !== current) queueMicrotask(() => peer.onmessage?.({ data: structuredClone(message) } as MessageEvent)); },
      close() { channels.delete(current); current.onmessage = null; },
    };
    channels.add(current); return current;
  };
  let busy = false;
  const queue: (() => void)[] = [];
  const request = (_name: string, options: { signal: AbortSignal }, callback: () => Promise<void>) => new Promise<void>((resolve, reject) => {
    const run = () => {
      if (options.signal.aborted) { reject(new Error("aborted")); queue.shift()?.(); return; }
      busy = true;
      void callback().then(resolve, reject).finally(() => { busy = false; queue.shift()?.(); });
    };
    if (busy) queue.push(run); else run();
  });
  return { channel, locks: { request } as unknown as Pick<LockManager, "request"> };
}

test("one tab owns delivery, focused peers receive alerts and takeover shares the committed cursor", async t => {
  const c = coordination(), rows: InboxNotification[] = [], reads: (number | undefined)[] = [];
  const read: InboxDeliveryOptions["read"] = async cursor => {
    reads.push(cursor);
    return { cursor: rows.at(-1)?.sequence ?? 0, unreadTotal: rows.length, items: cursor === undefined ? [] : rows.filter(row => row.sequence > cursor), hasMore: false };
  };
  const a = fixture(t, { read, channel: c.channel(), locks: c.locks });
  await until(() => reads.length === 1);
  a.focus(false);
  const b = fixture(t, { id: "b", read, channel: c.channel(), locks: c.locks });
  await delay(150);
  assert.equal(reads.length, 1);
  rows.push(entry(1)); a.refresh(); await until(() => b.alerts.length === 1);
  assert.deepEqual(a.alerts, []); assert.deepEqual(a.desktops, []);
  a.controller.stop(); await until(() => reads.length === 3);
  assert.equal(reads.at(-1), 1); assert.equal(b.alerts.length, 1);
  rows.push(entry(2)); b.refresh(); await until(() => b.alerts.length === 2);
  assert.equal(b.alerts[1]![0]!.latest.sequence, 2);
});

test("identical previews reopen a dismissed notice only for a new arrival ID", () => {
  const store = createFeedbackStore();
  const input = { id: "workspace", title: "Workspace · Agent", message: "Ready", episode: "first" };
  store.getState().publish(input); store.getState().dismiss(input.id);
  store.getState().publish(input); assert.equal(store.getState().notices[0]!.dismissed, true);
  store.getState().publish({ ...input, episode: "second" }); assert.equal(store.getState().notices[0]!.dismissed, false);
});

test("refused Locks access falls back to independent delivery and closes its coordination channel", async t => {
  let closed = 0;
  const channel: InboxChannel = { onmessage: null, postMessage() {}, close() { closed++; } };
  const locks = { request: async () => { throw new Error("Access refused"); } } as unknown as Pick<LockManager, "request">;
  const f = fixture(t, { channel, locks });
  await until(() => f.reads.length === 1);
  assert.equal(closed, 1);
  f.rows.push(entry(1)); f.refresh(); await until(() => f.alerts.length === 1);
  assert.equal(f.alerts[0]![0]!.latest.sequence, 1);
});

test("a successor preserves grouped fallback messages while all tabs are in the background", async t => {
  const c = coordination(), rows: InboxNotification[] = [];
  const read: InboxDeliveryOptions["read"] = async cursor => ({
    cursor: rows.at(-1)?.sequence ?? 0, unreadTotal: rows.length,
    items: cursor === undefined ? [] : rows.filter(row => row.sequence > cursor), hasMore: false,
  });
  const a = fixture(t, { read, focused: () => false, channel: c.channel(), locks: c.locks });
  await delay(150);
  let focused = false;
  const b = fixture(t, { id: "b", read, focused: () => focused, channel: c.channel(), locks: c.locks });
  await delay(150);
  rows.push(entry(1), entry(2)); a.refresh(); await until(() => b.unread.at(-1) === 2);
  assert.deepEqual(a.alerts, []); assert.deepEqual(b.alerts, []);
  a.controller.stop(); await delay(10);
  focused = true; b.controller.presence(); await until(() => b.alerts.length === 1);
  assert.equal(b.alerts[0]![0]!.count, 2);
  b.controller.presence(); await delay(5); assert.equal(b.alerts.length, 1);
});
