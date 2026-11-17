import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useCallback, useState } from "react";
import { mountComponent } from "./component-helpers";
import type { Workspace, WorkspaceDuplication } from "../../server/src/contracts";
const { WorkspaceTab } = await import("../src/components/WorkspaceTab");
const { ContextMenu } = await import("../src/components/ContextMenu");
const { WorkspaceDuplicate } = await import("../src/components/WorkspaceDuplicate");
import type { ContextMenuAnchor } from "../src/components/ContextMenu";
const workspaces: Workspace[] = ["one", "two"].map(id => ({ id, sortOrder: 0, name: id, description: "Description", createdAt: "2026-01-01", updatedAt: "2026-01-01" }));

test("workspace menus target inactive tabs without selecting and preserve ordinary keyboard navigation", async t => {
  const selected: string[] = [], actions: string[] = [];
  function Probe() {
    const [menu, setMenu] = useState<{ workspace: Workspace; anchor: ContextMenuAnchor } | null>(null);
    const close = useCallback(() => setMenu(null), []);
    return h("section", null,
      h("div", { role: "tablist" }, workspaces.map(workspace => h(WorkspaceTab, { key: workspace.id, workspace, tabs: workspaces, activeId: "one", menuOpen: menu?.workspace.id === workspace.id,
        onSelect: id => selected.push(id), onMenu: (workspace, anchor) => setMenu({ workspace, anchor }) }))),
      menu && h(ContextMenu, { anchor: menu.anchor, label: `Actions for ${menu.workspace.name}`, onClose: close,
        items: [{ id: "edit", label: "Edit…", onSelect: () => actions.push(`edit:${menu.workspace.id}`) },
          { id: "duplicate", label: "Duplicate…", onSelect: () => actions.push(`duplicate:${menu.workspace.id}`) },
          { id: "delete", label: "Delete…", destructive: true, onSelect: () => actions.push(`delete:${menu.workspace.id}`) }] }));
  }
  const p = await mountComponent(t, h(Probe));
  const second = p.document.getElementById("tab-two")!;
  await act(async () => { second.dispatchEvent(new p.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 390, clientY: 290 })); });
  assert.deepEqual(selected, []);
  assert.equal(p.document.querySelector('[role="menu"]')?.getAttribute("aria-label"), "Actions for two");
  await p.key(p.document.querySelector('[role="menu"]')!, "Escape");
  assert.equal(p.document.activeElement, second);
  await p.key(second, "F10", { shiftKey: true });
  await p.key(p.document.querySelector('[role="menu"]')!, "ArrowDown");
  await p.key(p.document.querySelector('[role="menu"]')!, "Enter");
  assert.deepEqual(actions, ["duplicate:two"]); assert.deepEqual(selected, []);
  await p.key(second, "ContextMenu");
  await p.click([...p.document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === "Delete…")!);
  assert.deepEqual(actions, ["duplicate:two", "delete:two"]);
  await p.key(second, "Home"); assert.deepEqual(selected, ["one"]);
  await p.click(second); assert.deepEqual(selected, ["one", "two"]);
});

test("Duplicate defaults, independent options, field validation and request-id reuse", async t => {
  const payloads: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    payloads.push(JSON.parse(init!.body as string));
    return Response.json({ error: "Choose a name", fields: { name: "Choose a name" } }, { status: 400 });
  });
  const p = await mountComponent(t, h(WorkspaceDuplicate, { source: { ...workspaces[0], name: "x".repeat(120) }, onClose() {}, onCompleted() {} }));
  assert.equal(p.document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value.length, 120);
  const checkboxes = [...p.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.deepEqual(checkboxes.map(input => input.checked), [true, true, true, false, false, false, false]);
  await p.click(checkboxes[4]);
  const form = p.document.querySelector("form")!;
  const submit = () => act(async () => { form.dispatchEvent(new p.window.Event("submit", { bubbles: true, cancelable: true })); });
  await submit();
  assert.equal(payloads[0].includeWorkspaceFiles, true); assert.equal(payloads[0].includeAgentFiles, false);
  assert.ok(p.document.querySelector('[aria-invalid="true"]'));
  await submit(); assert.equal(payloads[0].requestId, payloads[1].requestId);
  await p.click(checkboxes[5]);
  await submit(); assert.notEqual(payloads[1].requestId, payloads[2].requestId);
});

test("resumed operations poll, retry failures, and open completed workspaces once", async t => {
  const opened: string[] = [], calls: string[] = [];
  const operation: WorkspaceDuplication = { id: "operation", sourceWorkspaceId: "one", name: "Copy", state: "failed", phase: "failed", error: "Files changed", workspaceId: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return Response.json(url.endsWith("/retry") ? { ...operation, state: "running", phase: "copying", error: null } : { ...operation, state: "completed", phase: "completed", workspaceId: "new", error: null });
  });
  const p = await mountComponent(t, h(WorkspaceDuplicate, { initialOperation: operation, onClose() {}, onCompleted: id => opened.push(id) }));
  assert.match(p.document.body.textContent!, /Files changed/);
  const retry = [...p.document.querySelectorAll("button")].find(button => button.textContent === "Retry duplication")!;
  await p.click(retry);
  assert.match(p.document.body.textContent!, /Copying workspace/);
  assert.equal(p.document.querySelector('button[aria-label="Close dialog"]')?.hasAttribute("disabled"), true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  assert.deepEqual(opened, ["new"]); assert.equal(calls.length, 2);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  assert.deepEqual(opened, ["new"]);
});

test("lost status reads allow closing and explicit retry without starting another duplication", async t => {
  let reads = 0;
  const operation: WorkspaceDuplication = { id: "network-copy", sourceWorkspaceId: "one", name: "Copy", state: "running", phase: "copying", error: null, workspaceId: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    if (reads === 1) throw new Error("Disconnected");
    return Response.json({ ...operation, state: "completed", phase: "completed", workspaceId: "copy" });
  });
  const opened: string[] = [];
  const p = await mountComponent(t, h(WorkspaceDuplicate, { initialOperation: operation, onClose() {}, onCompleted: id => opened.push(id) }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  assert.ok([...p.document.querySelectorAll("button")].some(button => button.textContent === "Retry status"));
  assert.equal(p.document.querySelector('button[aria-label="Close dialog"]')?.hasAttribute("disabled"), false);
  await p.click([...p.document.querySelectorAll("button")].find(button => button.textContent === "Retry status")!);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  assert.equal(reads, 2); assert.deepEqual(opened, ["copy"]);
});
