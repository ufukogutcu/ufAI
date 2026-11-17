import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { mountComponent } from "./component-helpers";
import { initialSettings } from "./helpers";
import { createSettingsStore, SettingsContext } from "../src/settings-store";
const { default: SettingsPage } = await import("../src/pages/Settings");

async function setup(t: any, permission: NotificationPermission, result: NotificationPermission) {
  const p = await mountComponent(t, h("span"));
  const settings = createSettingsStore(initialSettings());
  let requests = 0, writes = 0;
  const native = { permission, async requestPermission() { requests++; native.permission = result; return result; } };
  Object.defineProperty(p.window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(p.window, "Notification", { configurable: true, value: native });
  const original = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: native });
  t.after(() => { if (original) Object.defineProperty(globalThis, "Notification", original); else Reflect.deleteProperty(globalThis, "Notification"); });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    writes++;
    return Response.json({ ...initialSettings(), settings: { ...settings.getState().snapshot.settings, ...JSON.parse(String(init.body)) } });
  });
  await act(async () => p.root.render(h(SettingsContext.Provider, { value: settings }, h(SettingsPage))));
  const button = (label: string) => [...p.document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);
  return { ...p, settings, button, requests: () => requests, writes: () => writes };
}

test("desktop permission is requested only by Enable and preferences wait for the server", async t => {
  const p = await setup(t, "default", "granted");
  assert.equal(p.requests(), 0); assert.equal(p.writes(), 0);
  assert.equal(p.settings.getState().snapshot.settings.inboxDesktopAlertsEnabled, false);
  await act(async () => p.button("Enable desktop alerts")!.click());
  assert.equal(p.requests(), 1); assert.equal(p.writes(), 1);
  assert.equal(p.settings.getState().snapshot.settings.inboxDesktopAlertsEnabled, true);
  await act(async () => p.button("Disable desktop alerts")!.click());
  assert.equal(p.settings.getState().snapshot.settings.inboxDesktopAlertsEnabled, false);
  assert.equal(p.requests(), 1);
  const toggle = p.document.querySelector<HTMLInputElement>("input[role='switch']")!;
  await act(async () => toggle.click());
  assert.equal(p.settings.getState().snapshot.settings.inboxInAppAlertsEnabled, false);
});

test("permission denial explains recovery and never repeatedly prompts", async t => {
  const p = await setup(t, "default", "denied");
  await act(async () => p.button("Enable desktop alerts")!.click());
  assert.equal(p.requests(), 1); assert.equal(p.writes(), 0);
  assert.match(p.document.body.textContent!, /Desktop alerts are blocked/);
  assert.equal(p.button("Enable desktop alerts"), undefined);
  await act(async () => p.window.dispatchEvent(new p.window.Event("focus")));
  assert.equal(p.requests(), 1);
});
