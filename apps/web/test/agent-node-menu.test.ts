import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h } from "react";
import { ReactFlowProvider, useStoreApi, type NodeProps } from "@xyflow/react";
import { mountComponent } from "./component-helpers";
import { AgentContext, createAgentStore } from "../src/agent-store";
import { SettingsContext, createSettingsStore } from "../src/settings-store";
import { UnsavedContext } from "../src/navigation-guard";
import { initialSettings } from "./helpers";
import type { AgentFlowNode } from "../src/canvas-layout";
import type { Agent } from "../../server/src/contracts";
const { AgentNode } = await import("../src/components/CanvasNodes");
const { ConnectionRingsProvider } = await import("../src/components/ConnectionRings");

const node: AgentFlowNode = { id: "one", type: "agent", data: { agentId: "one" }, position: { x: 0, y: 0 } };
const agent: Agent = {
  id: "one", workspaceId: "workspace", name: "Ava", instructions: "", presetId: null,
  appearance: { kind: "pebble", color: "sage", accessories: [] },
  x: 0, y: 0, revision: 1, createdAt: "now", updatedAt: "now", state: "idle",
  queuedCount: 0, runningTaskCount: 0, unfinishedTaskCount: 0, chatWorking: false, pendingUserInputCount: 0, issueCounts: { warning: 0, error: 0 },
};

async function setup(t: TestContext, characterAnimationsPaused = false) {
  const store = createAgentStore();
  const removed: string[] = [], moves: number[][] = [];
  let allowed = true, failDelete = false, bubbled = 0;
  store.setState({ agents: { one: agent }, selected: { workspace: "other" }, panelTabs: { one: "Memory" },
    refreshAgent: async () => {},
    moveAgent: async (_id, x, y) => { moves.push([x, y]); },
    remove: async id => { if (failDelete) throw Error("Files busy"); removed.push(id); },
    update: async (_id, input) => ({ ...agent, ...input }),
  });
  let flow!: ReturnType<typeof useStoreApi>;
  function Probe() {
    flow = useStoreApi();
    return h(AgentNode, { id: "one", data: { agentId: "one" }, type: "agent", dragging: false,
      selected: false, isConnectable: false, zIndex: 1, selectable: true, deletable: false,
      draggable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 } satisfies NodeProps<AgentFlowNode>);
  }
  const settings = initialSettings();
  settings.settings.characterAnimationsPaused = characterAnimationsPaused;
  const settingsStore = createSettingsStore(settings);
  const p = await mountComponent(t, h(AgentContext.Provider, { value: store },
    h(SettingsContext.Provider, { value: settingsStore },
      h(UnsavedContext.Provider, { value: { setDirty() {}, attempt(action) { if (allowed) action(); return allowed; } } },
        h(ReactFlowProvider, { initialNodes: [node] }, h(ConnectionRingsProvider, { workspaceId: "workspace", children:
          h("div", { onClick() { bubbled++; }, onContextMenu() { bubbled++; } }, h(Probe)) }))))));
  const name = () => p.document.querySelector<HTMLButtonElement>('button[data-move]')!;
  return { ...p, store, settingsStore, removed, moves, name,
    allow(value: boolean) { allowed = value; }, failDelete(value: boolean) { failDelete = value; }, bubbled: () => bubbled,
    menu: () => p.document.querySelector('[role="menu"]')!,
    item: (label: string) => [...p.document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === label)!,
    open: async () => act(async () => { name().dispatchEvent(new p.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 100 })); }),
    pan: () => act(async () => flow.setState({ transform: [1, 1, 1] })),
    drag: (dragging: boolean) => act(async () => flow.getState().setNodes([{ ...node, dragging }])),
  };
}

test("drag carries the canvas character independently of execution status and respects the saved motion preference", async t => {
  const p = await setup(t);
  const working: Agent = { ...agent, state: "running" };
  const character = p.document.querySelector("svg[data-frozen]")!;
  await act(async () => p.store.setState({ agents: { one: working } }));
  assert.ok(character.querySelector(".laptop"));

  await p.drag(true);
  assert.equal(character.getAttribute("data-carry"), "animated");
  assert.equal(character.querySelector(".laptop"), null);
  assert.ok(p.document.querySelector('button[aria-label="Ava, Working"]'));
  await p.drag(false);
  assert.equal(character.hasAttribute("data-carry"), false);
  assert.ok(character.querySelector(".laptop"));

  await p.drag(true);
  await act(async () => {
    const { snapshot } = p.settingsStore.getState();
    p.settingsStore.setState({ snapshot: { ...snapshot, settings: { ...snapshot.settings, characterAnimationsPaused: true } } });
    p.store.setState({ agents: { one: { ...working, executionControl: {
      state: "frozen", revision: 1, requestedAt: null, frozenAt: null, queuedTriggerCount: 0,
      backlogPending: false, workspaceHeld: false,
    } } } });
  });
  assert.equal(character.getAttribute("data-carry"), "static");
  assert.ok(character.querySelector(".actor .frost"));
  assert.ok(character.querySelector(".actor > .snowflakes"));
  assert.ok(p.document.querySelector('button[aria-label="Ava, Frozen"]'));
  await p.drag(false);
  assert.equal(character.hasAttribute("data-carry"), false);
  assert.equal(character.getAttribute("data-frozen"), "true");
  assert.ok(character.querySelector(":scope > .snowflakes"));
});

test("the canvas activity tooltip stays in sync with the character while motion is paused", async t => {
  const p = await setup(t, true);
  const bubble = p.document.querySelector<HTMLButtonElement>('button[aria-label="Ava, Idle"]')!;
  const character = p.document.querySelector("svg[data-frozen]")!;
  const tooltip = () => p.document.querySelector('[role="tooltip"]');
  assert.equal(character.getAttribute("data-paused"), "true");
  await p.click(bubble);
  for (const [state, execution, counts, pose, title, frozen] of [
    ["idle", "active", {}, "idle", "Idle", false],
    ["queued", "active", { queuedCount: 1, unfinishedTaskCount: 1 }, "idle", "Idle", false],
    ["running", "active", { runningTaskCount: 1, unfinishedTaskCount: 1 }, "working", "Working", false],
    ["running", "active", { chatWorking: true }, "working", "Working", false],
    ["waiting", "active", { chatWorking: true }, "working", "Working", false],
    ["waiting", "freezing", {}, "working", "Working", false],
    ["idle", "freezing", {}, "idle", "Idle", false],
    ["waiting", "frozen", {}, "working", "Frozen", true],
    ["waiting", "resuming", {}, "working", "Preparing resume…", true],
    ["running", "active", {}, "working", "Working", false],
  ] as const) {
    await act(async () => p.store.setState({ agents: { one: { ...agent, ...counts, state, executionControl: {
      state: execution, revision: 1, requestedAt: null, frozenAt: null, queuedTriggerCount: 0,
      backlogPending: false, workspaceHeld: false,
    } } } }));
    assert.equal(character.getAttribute("data-activity"), pose);
    assert.equal(character.getAttribute("data-frozen"), String(frozen));
    assert.equal(bubble.getAttribute("aria-label"), `Ava, ${title}`);
    assert.equal(bubble.firstElementChild?.getAttribute("data-activity"), frozen ? execution : pose);
    assert.equal(tooltip()?.querySelector("strong")?.textContent, title);
    assert.equal(!!p.name().querySelector('[aria-label="Freezing…"]'), execution === "freezing");
  }
  assert.match(tooltip()?.textContent ?? "", /working on tasks or Chat/);
  await p.key(bubble, "Escape");
  assert.equal(tooltip(), null);
  bubble.scrollIntoView = () => {};
  await act(async () => {
    bubble.focus();
    await new Promise<void>(resolve => p.window.requestAnimationFrame(() => resolve()));
  });
  assert.equal(tooltip()?.querySelector("strong")?.textContent, "Working");
  assert.equal(p.store.getState().selected.workspace, "other");
  assert.equal(p.bubbled(), 0);
});

test("right-click targets an agent without selecting it; shortcuts use guarded tabs", async t => {
  const p = await setup(t);
  await p.open();
  assert.equal(p.menu().getAttribute("aria-label"), "Actions for Ava");
  assert.equal(p.name().getAttribute("aria-expanded"), "true");
  assert.equal(p.store.getState().selected.workspace, "other");
  assert.equal(p.bubbled(), 0);
  for (const [label, tab] of [["Open Chat", "Chat"], ["Edit details…", "Details"], ["Open Tasks", "Tasks"], ["Open Files", "Files"]] as const) {
    if (!p.menu()) await p.open();
    await p.click(p.item(label));
    assert.equal(p.store.getState().selected.workspace, "one");
    assert.equal(p.store.getState().panelTabs.one, tab);
    assert.equal(p.menu(), null);
  }
  assert.equal(p.bubbled(), 0, "portal actions must not click the canvas");
});

test("Menu and Shift+F10 open actions; Escape restores focus and arrows still move the node", async t => {
  const p = await setup(t);
  for (const [key, options] of [["ContextMenu", {}], ["F10", { shiftKey: true }]] as const) {
    await p.key(p.name(), key, options);
    assert.equal(p.document.activeElement?.textContent, "Open Chat");
    await p.key(p.menu(), "ArrowDown");
    assert.equal(p.document.activeElement?.textContent, "Edit details…");
    await p.key(p.menu(), "Escape");
    assert.equal(p.document.activeElement, p.name());
    assert.equal(p.menu(), null);
  }
  await p.key(p.name(), "ArrowRight");
  assert.deepEqual(p.moves, [[16, 0]]);
  await p.open();
  await p.pan();
  assert.equal(p.menu(), null, "viewport movement invalidates the anchor");
});

test("declining unsaved-change navigation preserves selection, tabs and dialogs", async t => {
  const p = await setup(t);
  p.allow(false);
  for (const label of ["Open Chat", "Edit details…", "Edit character…", "Delete Agent…"]) {
    await p.open(); await p.click(p.item(label));
    assert.equal(p.document.querySelector("dialog"), null);
    assert.equal(p.store.getState().selected.workspace, "other");
    assert.equal(p.store.getState().panelTabs.one, "Memory");
  }
});

test("deletion requires confirmation, focuses Keep Agent and retains failure for retry", async t => {
  const p = await setup(t);
  await p.open(); await p.click(p.item("Delete Agent…"));
  assert.equal(p.document.activeElement?.textContent, "Keep Agent");
  assert.deepEqual(p.removed, []);
  await p.click(p.document.activeElement!);
  assert.equal(p.document.querySelector("dialog"), null);
  assert.equal(p.document.activeElement, p.name());
  await p.open(); await p.click(p.item("Delete Agent…"));
  p.failDelete(true);
  const confirm = () => [...p.document.querySelectorAll("button")].find(item => item.textContent === "Delete Agent and files")!;
  await p.click(confirm());
  assert.match(p.document.querySelector('[role="alert"]')!.textContent!, /Files busy/);
  assert.deepEqual(p.removed, []);
  p.failDelete(false);
  await p.click(confirm());
  assert.deepEqual(p.removed, ["one"]);
  assert.equal(p.document.querySelector("dialog"), null);
});

test("character editing opens the existing editor without selecting the agent", async t => {
  const p = await setup(t);
  await p.open(); await p.click(p.item("Edit character…"));
  assert.equal(p.document.querySelector("dialog h2")?.textContent, "Edit character");
  assert.equal(p.store.getState().selected.workspace, "other");
  await act(async () => { p.document.querySelector("dialog h2")!.dispatchEvent(new p.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  assert.equal(p.menu(), null, "portalled editors retain their own context-menu behavior");
  await p.click([...p.document.querySelectorAll("button")].find(button => button.textContent === "Cancel")!);
  assert.equal(p.document.activeElement, p.name());
});
