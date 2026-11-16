import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h, StrictMode, useState } from "react";
import { mountComponent } from "./component-helpers";
import { createAgentStore, AgentContext } from "../src/agent-store";
import { createSettingsStore, SettingsContext } from "../src/settings-store";
import { createDashboardStore, DashboardContext } from "../src/store";
import { UnsavedContext } from "../src/navigation-guard";
import { initialSettings } from "./helpers";
import type { AgentAppearance } from "../../server/src/contracts";
const { AddAgentButton } = await import("../src/components/AddAgentButton");
const { AgentForm } = await import("../src/components/AgentPanel");

const appearance: AgentAppearance = { kind: "sprout", color: "sage", accessories: ["bowtie"] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function setup(t: TestContext, getAppearance: () => Promise<Response>) {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/appearance-suggestion")) { reads++; return getAppearance(); }
    if (url.endsWith("/name-suggestion")) return Response.json({ name: "Ava" });
    throw new Error(`Unexpected request: ${url}`);
  });
  const store = createAgentStore(), settings = createSettingsStore(initialSettings());
  const dashboard = createDashboardStore(settings);
  dashboard.setState({ loadPresets: async () => {}, loadDefaultPreset: async () => null });
  const saved: AgentAppearance[] = [];
  function Probe() {
    const [open, setOpen] = useState(false);
    return h(StrictMode, null,
      h(AgentContext.Provider, { value: store },
        h(SettingsContext.Provider, { value: settings },
          h(DashboardContext.Provider, { value: dashboard },
            h(UnsavedContext.Provider, { value: { setDirty() {}, attempt(action) { action(); return true; } } },
              h(AddAgentButton, { workspaceId: "one", onClick: () => setOpen(true) }),
              open && h("section", { id: "creation" },
                h("button", { onClick: () => setOpen(false) }, "Close creation"),
                h(AgentForm, { workspaceId: "one", onSave: async values => { saved.push(values.appearance!); } })))))));
  }
  const p = await mountComponent(t, h(Probe));
  const button = p.document.querySelector("button")!;
  return { ...p, button, store, settings, saved, reads: () => reads };
}

test("button and form share a pending suggestion through Strict Mode and cancellation", async t => {
  const response = deferred<Response>();
  const p = await setup(t, () => response.promise);
  assert.equal(p.button.textContent, "Add Agent");
  assert.equal(p.button.disabled, false);
  const badge = p.button.querySelector(".badge")!;
  const preview = p.button.querySelector(".preview")!;
  assert.equal(badge.parentElement, preview);
  assert.equal(p.button.querySelector(".character")?.parentElement, preview);
  assert.equal(preview.getAttribute("aria-hidden"), "true");
  assert.equal(badge.getAttribute("aria-hidden"), "true");
  assert.equal(badge.querySelector("svg")?.getAttribute("aria-hidden"), "true");
  assert.equal(p.button.querySelector("svg[data-kind]"), null);
  await p.click(p.button);
  assert.equal(p.reads(), 1);
  await act(async () => { response.resolve(Response.json({ appearance })); });
  const buttonCharacter = p.button.querySelector("svg[data-kind]")!;
  assert.equal(p.button.querySelector(".badge"), badge);
  assert.equal(buttonCharacter.getAttribute("aria-hidden"), "true");
  const formCharacter = p.document.querySelector("#creation svg[data-kind]")!;
  assert.equal(formCharacter.getAttribute("data-kind"), buttonCharacter.getAttribute("data-kind"));
  const form = p.document.querySelector("#creation form")!;
  await act(async () => { form.dispatchEvent(new p.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.deepEqual(p.saved, [appearance]);
  await p.click([...p.document.querySelectorAll("button")].find(b => b.textContent === "Close creation")!);
  await p.click(p.button);
  assert.equal(p.reads(), 1);
  assert.equal(p.document.querySelector("#creation svg[data-kind]")?.getAttribute("data-kind"), "sprout");
  await act(async () => {
    p.settings.setState(s => ({ snapshot: { ...s.snapshot,
      settings: { ...s.snapshot.settings, characterAnimationsPaused: true } } }));
  });
  assert.equal(p.button.getAttribute("data-paused"), "true");
  assert.equal(p.button.querySelector("svg[data-kind]")?.getAttribute("data-paused"), "true");
});

test("failed preview keeps creation usable and Retry character updates both previews", async t => {
  let fail = true;
  const p = await setup(t, async () => fail ? Response.json({ error: "Offline" }, { status: 503 }) : Response.json({ appearance }));
  assert.equal(p.button.textContent, "Add Agent");
  assert.ok(p.button.querySelector(".badge svg"));
  assert.equal(p.button.querySelectorAll("svg").length, 1);
  assert.equal(p.button.querySelector("svg[data-kind]"), null);
  await p.click(p.button);
  assert.match(p.document.querySelector('[role="alert"]')!.textContent!, /Offline/);
  assert.equal(p.reads(), 1);
  fail = false;
  await p.click([...p.document.querySelectorAll("button")].find(b => b.textContent === "Retry character")!);
  assert.equal(p.reads(), 2);
  assert.equal(p.button.querySelector("svg[data-kind]")?.getAttribute("data-kind"), "sprout");
  assert.ok(p.button.querySelector(".badge svg"));
  assert.equal(p.document.querySelector("#creation svg[data-kind]")?.getAttribute("data-kind"), "sprout");
});

test("a late suggestion cannot overwrite a manually selected character", async t => {
  const response = deferred<Response>();
  const p = await setup(t, () => response.promise);
  await p.click(p.button);
  await p.click([...p.document.querySelectorAll("button")].find(b => b.textContent?.includes("Edit character"))!);
  await p.click([...p.document.querySelectorAll("button[data-character-choice]")].find(b => b.textContent === "Tiny bot")!);
  const editor = p.document.querySelector("dialog form")!;
  await act(async () => { editor.dispatchEvent(new p.window.Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { response.resolve(Response.json({ appearance })); });
  assert.equal(p.button.querySelector("svg[data-kind]")?.getAttribute("data-kind"), "sprout");
  assert.equal(p.document.querySelector("#creation svg[data-kind]")?.getAttribute("data-kind"), "bot");
  const form = p.document.querySelector("#creation form")!;
  await act(async () => { form.dispatchEvent(new p.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(p.saved[0]?.kind, "bot");
});
