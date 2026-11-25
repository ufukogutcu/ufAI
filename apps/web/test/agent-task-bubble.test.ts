import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h } from "react";
import { mountComponent } from "./component-helpers";
import { AgentContext, createAgentStore } from "../src/agent-store";
import { UnsavedContext } from "../src/navigation-guard";
const { AgentTaskBubble } = await import("../src/components/AgentTaskBubble");

async function setup(t: TestContext) {
  const store = createAgentStore();
  store.setState({ selected: { workspace: "other" }, panelTabs: { one: "Memory", other: "Details" }, refreshAgent: async () => {} });
  let allowed = true, bubbled = 0;
  function view(count: number, chatWorking = false) {
    return h(AgentContext.Provider, { value: store },
      h(UnsavedContext.Provider, { value: { setDirty() {}, attempt(action) {
        if (allowed) action();
        return allowed;
      } } }, h("div", { onClick() { bubbled++; }, onPointerDown() { bubbled++; } },
        h(AgentTaskBubble, { agentId: "one", workspaceId: "workspace", agentName: "Ava", count, chatWorking }))));
  }
  const p = await mountComponent(t, view(0));
  return { ...p, store, button: () => p.document.querySelector("button")!,
    allow(value: boolean) { allowed = value; }, bubbled: () => bubbled,
    update: (count: number, chatWorking = false) => act(async () => p.root.render(view(count, chatWorking))),
  };
}

test("task bubble includes zero and exact counts, opens Tasks, and isolates canvas input", async t => {
  const p = await setup(t);
  assert.equal(p.button().textContent, "0");
  assert.equal(p.button().getAttribute("aria-label"), "0 ongoing tasks for Ava. Open Tasks");
  await act(async () => { p.button().dispatchEvent(new p.window.MouseEvent("pointerdown", { bubbles: true })); });
  await p.click(p.button());
  assert.equal(p.bubbled(), 0);
  assert.equal(p.store.getState().selected.workspace, "one");
  assert.equal(p.store.getState().panelTabs.one, "Tasks");
  assert.equal(p.store.getState().panelTabs.other, "Details");
  await p.update(123456);
  assert.equal(p.button().textContent, "123456");
  await p.update(1);
  assert.equal(p.button().getAttribute("aria-label"), "1 ongoing task for Ava. Open Tasks");
  p.store.getState().setPanelTab("one", "Memory");
  await p.click(p.button());
  assert.equal(p.store.getState().panelTabs.one, "Tasks", "already selected agent returns to Tasks");
});

test("active Chat contributes a separate one alongside the ordinary task count", async t => {
  const p = await setup(t);
  await p.update(0, true);
  assert.equal(p.button().textContent, "0 + 1");
  assert.equal(p.button().getAttribute("aria-label"), "0 ongoing tasks plus active Chat for Ava. Open Tasks");
  await p.update(2, true);
  assert.equal(p.button().textContent, "2 + 1");
  await p.click(p.button());
  assert.equal(p.store.getState().panelTabs.one, "Tasks");
  await p.update(2, false);
  assert.equal(p.button().textContent, "2");
});

test("declining the navigation guard changes neither selected agent nor remembered tab", async t => {
  const p = await setup(t);
  p.allow(false);
  await p.click(p.button());
  assert.equal(p.store.getState().selected.workspace, "other");
  assert.equal(p.store.getState().panelTabs.one, "Memory");
  p.allow(true);
  await p.click(p.button());
  assert.equal(p.store.getState().selected.workspace, "one");
  assert.equal(p.store.getState().panelTabs.one, "Tasks");
});
