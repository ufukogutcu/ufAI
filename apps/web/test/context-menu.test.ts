import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useCallback, useState } from "react";
import { mountComponent } from "./component-helpers";
const { ContextMenu } = await import("../src/components/ContextMenu");
import type { ContextMenuAnchor, ContextMenuItem } from "../src/components/ContextMenu";

function fixture(items: ContextMenuItem[], closed: string[], dialog = false) {
  return function Probe() {
    const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);
    const close = useCallback((reason: string) => { closed.push(reason); setAnchor(null); }, []);
    return h(dialog ? "dialog" : "section", { open: dialog || undefined, onKeyDown: () => { closed.push("panel-key"); } },
      h("button", { id: "before" }, "Before"),
      h("button", { id: "trigger", onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        setAnchor({ x: 395, y: 295, returnFocus: event.currentTarget });
      } }, "Trigger"),
      h("button", { id: "after" }, "After"),
      anchor && h(ContextMenu, { anchor, label: "Actions", items, onClose: close }));
  };
}

test("menu keyboard navigation skips disabled items, wraps, searches, and Escape stays inside the menu", async t => {
  const closed: string[] = [], selected: string[] = [];
  const Probe = fixture([
    { id: "disabled", label: "Unavailable", disabled: true, onSelect: () => selected.push("disabled") },
    { id: "open", label: "Open", onSelect: () => selected.push("open") },
    { id: "separator", separator: true },
    { id: "copy", label: "Copy path", onSelect: () => selected.push("copy") },
    { id: "delete", label: "Delete…", destructive: true, onSelect: () => selected.push("delete") },
  ], closed);
  const p = await mountComponent(t, h(Probe));
  const trigger = p.document.querySelector("#trigger")!;
  await p.click(trigger);
  const menu = p.document.querySelector('[role="menu"]')!;
  assert.equal(p.document.activeElement?.textContent, "Open");
  await p.key(menu, "ArrowUp"); assert.equal(p.document.activeElement?.textContent, "Delete…");
  await p.key(menu, "Home"); assert.equal(p.document.activeElement?.textContent, "Open");
  await p.key(menu, "c"); assert.equal(p.document.activeElement?.textContent, "Copy path");
  await p.key(menu, "End"); assert.equal(p.document.activeElement?.textContent, "Delete…");
  await p.click(p.document.querySelector('[aria-disabled="true"]')!);
  assert.deepEqual(selected, []);
  await p.key(menu, "Escape");
  assert.deepEqual(closed, ["escape"]);
  assert.equal(p.document.activeElement, trigger);
  assert.equal(p.document.querySelector('[role="menu"]'), null);
});

test("menu selection fires once, restores the trigger, and Tab resumes beside the trigger", async t => {
  const closed: string[] = [];
  let selected = 0;
  const Probe = fixture([{ id: "copy", label: "Copy", onSelect: () => selected++ }], closed);
  const p = await mountComponent(t, h(Probe));
  const trigger = p.document.querySelector("#trigger")!;
  await p.click(trigger);
  await p.key(p.document.querySelector('[role="menu"]')!, " ");
  assert.equal(selected, 1); assert.equal(p.document.activeElement, trigger);
  await p.click(trigger);
  await p.key(p.document.querySelector('[role="menu"]')!, "Tab");
  assert.equal(p.document.activeElement?.id, "after");
  await p.click(trigger);
  await p.key(p.document.querySelector('[role="menu"]')!, "Tab", { shiftKey: true });
  assert.equal(p.document.activeElement?.id, "before");
});

test("menu clamps to viewport, uses the open dialog host, and dismisses without stealing outside focus", async t => {
  const closed: string[] = [];
  const Probe = fixture([{ id: "download", label: "Download", href: "/download", download: "file.txt" }], closed, true);
  const p = await mountComponent(t, h(Probe));
  t.mock.method(p.window.HTMLElement.prototype, "getBoundingClientRect", () => ({ width: 200, height: 100 }) as DOMRect);
  const trigger = p.document.querySelector("#trigger")!;
  await p.click(trigger);
  let menu = p.document.querySelector<HTMLElement>('[role="menu"]')!;
  assert.equal(menu.parentElement?.tagName, "DIALOG");
  assert.equal(menu.style.left, "192px"); assert.equal(menu.style.top, "192px");
  assert.equal(menu.querySelector("a")?.getAttribute("download"), "file.txt");
  await act(async () => { (p.document.querySelector("#after") as HTMLElement).focus(); });
  assert.equal(p.document.activeElement?.id, "after");
  assert.equal(p.document.querySelector('[role="menu"]'), null);
  await p.click(trigger);
  menu = p.document.querySelector<HTMLElement>('[role="menu"]')!;
  await act(async () => { menu.querySelector("div")!.dispatchEvent(new p.window.Event("scroll", { bubbles: false })); });
  assert.ok(p.document.querySelector('[role="menu"]'));
  await act(async () => { p.document.dispatchEvent(new p.window.Event("scroll")); });
  assert.equal(p.document.querySelector('[role="menu"]'), null);
  await p.click(trigger);
  await act(async () => { trigger.remove(); });
  assert.equal(p.document.querySelector('[role="menu"]'), null);
});

test("menus with no enabled actions still focus safely and outside pointer/resize dismiss without restoring focus", async t => {
  const closed: string[] = [];
  const Probe = fixture([{ id: "busy", label: "Busy", disabled: true, href: "/download", download: "busy.txt" }], closed);
  const p = await mountComponent(t, h(Probe));
  const trigger = p.document.querySelector("#trigger")!;
  await p.click(trigger);
  assert.equal(p.document.activeElement?.getAttribute("role"), "menu");
  assert.equal(p.document.querySelector('[role="menuitem"]')?.getAttribute("href"), null);
  await p.key(p.document.querySelector('[role="menu"]')!, "Enter");
  await p.key(p.document.querySelector('[role="menu"]')!, "ArrowDown");
  assert.deepEqual(closed, []);
  await act(async () => { p.document.querySelector("#after")!.dispatchEvent(new p.window.Event("pointerdown", { bubbles: true })); });
  assert.equal(p.document.querySelector('[role="menu"]'), null);
  assert.deepEqual(closed, ["outside"]);
  await p.click(trigger);
  await act(async () => { p.window.dispatchEvent(new p.window.Event("resize")); });
  assert.deepEqual(closed, ["outside", "invalidated"]);
});
