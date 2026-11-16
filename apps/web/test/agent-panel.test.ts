import { SkillsContext, createSkillsStore } from "../src/skills-store";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h, StrictMode } from "react";
import { mountComponent } from "./component-helpers";
import { AgentContext, createAgentStore, useAgents } from "../src/agent-store";
import { DashboardContext, createDashboardStore } from "../src/store";
import { SettingsContext, createSettingsStore } from "../src/settings-store";
import { UnsavedContext } from "../src/navigation-guard";
import { initialSettings } from "./helpers";
import type { Agent } from "../../server/src/contracts";
const { AgentPanel } = await import("../src/components/AgentPanel");

const agent: Agent = {
  id: "one", workspaceId: "workspace", name: "Ava", instructions: "", presetId: null,
  appearance: { kind: "pebble", color: "sage", accessories: [] },
  x: 0, y: 0, revision: 1, createdAt: "now", updatedAt: "now", state: "idle",
  queuedCount: 0, runningTaskCount: 0, issueCounts: { warning: 0, error: 0 },
};

async function setup(t: TestContext) {
  let kind = "task", allowed = true;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/tasks/linked") return Response.json({
      task: { id: "linked", agentId: "one", kind, title: "Linked task", status: "completed" }, turns: [],
    });
    return Response.json({ items: [], total: 0 });
  });
  const store = createAgentStore(), settings = createSettingsStore(initialSettings());
  const dashboard = createDashboardStore(settings);
  const skills = createSkillsStore();
  skills.setState({ enabled: { one: {"builtin-browser": true}, two: {"builtin-browser": true} }, load: async () => {} });
  store.setState({
    agents: { one: agent, two: { ...agent, id: "two", name: "Ben", workspaceId: "other" } },
    selected: { workspace: "one" }, refreshAgent: async () => {},
  });
  dashboard.setState({ loadPresets: async () => {} });
  function Probe() {
    const selected = useAgents(s => s.selected.workspace);
    const current = useAgents(s => selected ? s.agents[selected] : undefined);
    return current ? h(AgentPanel, { key: current.id, agent: current,
      onClose: () => store.getState().select("workspace", null) }) : null;
  }
  const p = await mountComponent(t, h(StrictMode, null,
    h(AgentContext.Provider, { value: store },
      h(SettingsContext.Provider, { value: settings },
        h(DashboardContext.Provider, { value: dashboard },
          h(UnsavedContext.Provider, { value: { setDirty() {}, attempt(action) {
            if (allowed) action();
            return allowed;
          } } }, h(SkillsContext.Provider, { value: skills }, h(Probe))))))));
  return { ...p, store, skills,
    tab: (name: string) => [...p.document.querySelectorAll<HTMLButtonElement>("nav[aria-label='Agent sections'] button")].find(b => b.textContent === name)!,
    active: () => p.document.querySelector("nav [aria-current]")?.textContent,
    allow: (value: boolean) => { allowed = value; },
    kind: (value: string) => { kind = value; },
  };
}

test("panels default to Chat, use the requested order, and retain independent agent tabs after remount and reload", async t => {
  const p = await setup(t);
  assert.deepEqual([...p.document.querySelectorAll("nav button")].map(b => b.textContent),
    ["Details", "Chat", "Skills", "Browser", "Tasks", "Memory", "Files"]);
  assert.equal(p.active(), "Chat");
  await p.click(p.tab("Memory"));
  await p.click(p.document.querySelector("button[aria-label='Close agent panel']")!);
  assert.equal(p.active(), undefined);
  await act(async () => p.store.getState().select("workspace", "two"));
  assert.equal(p.active(), "Chat");
  await p.click(p.tab("Tasks"));
  await act(async () => p.store.getState().select("workspace", "one"));
  assert.equal(p.active(), "Memory");
  const reloaded = createAgentStore();
  assert.deepEqual(reloaded.getState().panelTabs, { one: "Memory", two: "Tasks" });
  p.window.sessionStorage.clear();
  assert.deepEqual(createAgentStore().getState().panelTabs, {});
});

test("rejected navigation preserves the active tab and panel; Escape remains available", async t => {
  const p = await setup(t);
  await p.click(p.tab("Details"));
  p.allow(false);
  await p.click(p.tab("Chat"));
  await p.click(p.document.querySelector("button[aria-label='Close agent panel']")!);
  assert.equal(p.active(), "Details");
  assert.equal(p.store.getState().panelTabs.one, "Details");
  p.allow(true);
  await p.key(p.document.querySelector("[data-agent-panel]")!, "Escape");
  assert.equal(p.active(), undefined);
  assert.equal(p.store.getState().panelTabs.one, "Details");
});

test("explicit task and Chat links override and update the remembered tab", async t => {
  const p = await setup(t);
  await p.click(p.tab("Memory"));
  await act(async () => p.store.setState({ requestedTask: { agentId: "one", taskId: "linked" } }));
  assert.equal(p.active(), "Tasks");
  assert.equal(createAgentStore().getState().panelTabs.one, "Tasks");
  assert.ok([...p.document.querySelectorAll("button")].some(b => b.textContent?.includes("All tasks")));
  p.kind("chat");
  await act(async () => p.store.setState({ requestedTask: { agentId: "one", taskId: "linked" } }));
  assert.equal(p.active(), "Chat");
  assert.equal(createAgentStore().getState().panelTabs.one, "Chat");
});

test("invalid session data is ignored and unavailable storage falls back to scoped memory", async t => {
  const p = await mountComponent(t, h("span"));
  for (const value of ["{", "null", "[]", "42"]) {
    p.window.sessionStorage.setItem("ufai.agent-panel-tabs.v1", value);
    assert.deepEqual(createAgentStore().getState().panelTabs, {});
  }
  p.window.sessionStorage.setItem("ufai.agent-panel-tabs.v1", JSON.stringify({ one: "Memory", two: "Unknown", three: 2 }));
  assert.deepEqual(createAgentStore().getState().panelTabs, { one: "Memory" });
  t.mock.method(p.window.sessionStorage, "setItem", () => { throw new Error("Quota exceeded"); });
  const readOnly = createAgentStore();
  readOnly.getState().setPanelTab("one", "Tasks");
  assert.equal(readOnly.getState().panelTabs.one, "Tasks");
  Object.defineProperty(p.window, "sessionStorage", { configurable: true, get() { throw new Error("Blocked"); } });
  const store = createAgentStore();
  store.getState().setPanelTab("one", "Files");
  assert.equal(store.getState().panelTabs.one, "Files");
  assert.deepEqual(createAgentStore().getState().panelTabs, {});
});

test("confirmed deletion clears remembered tabs while failed deletion preserves them", async t => {
  await mountComponent(t, h("span"));
  let failed = true;
  t.mock.method(globalThis, "fetch", async () => failed
    ? Response.json({ error: "Deletion failed" }, { status: 500 })
    : Response.json({ state: "completed" }));
  const store = createAgentStore();
  store.setState({ agents: { one: agent } });
  store.getState().setPanelTab("one", "Memory");
  store.getState().setPanelTab("two", "Details");
  await assert.rejects(store.getState().remove("one"), /Deletion failed/);
  assert.equal(store.getState().panelTabs.one, "Memory");
  failed = false;
  await store.getState().remove("one");
  assert.deepEqual(createAgentStore().getState().panelTabs, { two: "Details" });
});

test("workspace refresh clears tabs only after confirming that an agent is gone", async t => {
  await mountComponent(t, h("span"));
  t.mock.method(globalThis, "fetch", async () => Response.json({ items: [], total: 0 }));
  const store = createAgentStore();
  store.setState({ agents: { one: agent } });
  store.getState().setPanelTab("one", "Memory");
  store.getState().setPanelTab("two", "Details");
  const generation = store.getState().beginCanvasInteraction();
  await store.getState().loadWorkspace("workspace");
  assert.equal(store.getState().panelTabs.one, "Memory");
  store.getState().endCanvasInteraction(generation);
  await store.getState().loadWorkspace("workspace");
  assert.deepEqual(createAgentStore().getState().panelTabs, { two: "Details" });
});


test("Browser tab follows confirmed skill enablement and disabling a selected browser returns to Chat", async t => {
  const p = await setup(t);
  assert.ok(p.tab("Browser"));
  await act(async () => p.skills.setState({ enabled: { one: {"builtin-browser": false} } }));
  assert.equal(p.tab("Browser"), undefined);
  await act(async () => p.store.getState().setPanelTab("one", "Browser"));
  assert.equal(p.active(), "Chat");
  await act(async () => p.skills.setState({ enabled: { one: {"builtin-browser": true} } }));
  assert.ok(p.tab("Browser"));
});
