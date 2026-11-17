import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useState } from "react";
import { mountComponent } from "./component-helpers";
import type { Workspace } from "../../server/src/contracts";
const { WorkspaceTabs } = await import("../src/components/WorkspaceTabs");
const tabs: Workspace[] = ["one", "a wider second tab", "three"].map((name, sortOrder) => ({ id: String(sortOrder), name,
  description: "", sortOrder, createdAt: "2026-01-01", updatedAt: "2026-01-01" }));

async function setup(t: Parameters<typeof mountComponent>[0]) {
  const moves: unknown[] = [], selections: string[] = [];
  let parentRenders = 0;
  function Probe() {
    parentRenders++;
    const [items, setItems] = useState(tabs);
    return h(WorkspaceTabs, { tabs: items, activeId: "0", disabled: false,
      onSelect: id => selections.push(id), onMenu() {}, onMove: async (id, relativeToId, placement) => {
        moves.push({ id, relativeToId, placement });
        setItems(current => {
          const source = current.find(tab => tab.id === id)!;
          const next = current.filter(tab => tab.id !== id);
          next.splice(next.findIndex(tab => tab.id === relativeToId) + (placement === "after" ? 1 : 0), 0, source);
          return next;
        });
        return true;
      } });
  }
  const p = await mountComponent(t, h(Probe));
  const container = p.document.querySelector<HTMLElement>('[role="tablist"]')!;
  const widths = [80, 160, 100];
  const box = (left: number, width: number) => ({ left, x: left, right: left + width, y: 10, top: 10, bottom: 50, height: 40, width, toJSON() {} });
  container.getBoundingClientRect = () => box(10, 348) as DOMRect;
  for (const element of container.querySelectorAll<HTMLElement>('[role="tab"]')) {
    const id = Number(element.id.slice(4));
    element.getBoundingClientRect = () => {
      const ordered = [...container.children];
      const index = ordered.indexOf(element);
      const left = 10 + ordered.slice(0, index).reduce((sum, el) => sum + widths[Number(el.id.slice(4))]! + 4, 0);
      return box(left + parseFloat(element.style.getPropertyValue("--tab-shift") || "0"), widths[id]!) as DOMRect;
    };
    let captured = false;
    element.setPointerCapture = () => { captured = true; };
    element.hasPointerCapture = () => captured;
    element.releasePointerCapture = () => { captured = false; };
  }
  async function pointer(type: string, id: string, x: number, extra: Record<string, unknown> = {}) {
    await act(async () => {
      const event = new p.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 25 });
      for (const [key, value] of Object.entries({ pointerId: 1, isPrimary: true, pointerType: "mouse", ...extra })) Object.defineProperty(event, key, { value });
      p.document.getElementById(`tab-${id}`)!.dispatchEvent(event);
    });
  }
  return { ...p, moves, selections, pointer, container, get parentRenders() { return parentRenders; } };
}

test("threshold preserves clicks; dragging an inactive, variable-width tab moves once without selecting it", async t => {
  const p = await setup(t);
  await p.pointer("pointerdown", "1", 130);
  await p.pointer("pointermove", "1", 133);
  assert.equal(p.container.hasAttribute("data-dragging"), false);
  await p.pointer("pointerup", "1", 133);
  await p.click(p.document.getElementById("tab-1")!);
  assert.deepEqual(p.selections, ["1"]);
  const parentRenders = p.parentRenders;
  await p.pointer("pointerdown", "1", 130);
  await p.pointer("pointermove", "1", -5);
  assert.equal(p.parentRenders, parentRenders, "Pointer movement does not rerender the parent");
  assert.equal(p.container.getAttribute("data-dragging"), "true");
  assert.equal(p.document.getElementById("tab-1")!.getAttribute("data-drag-source"), "true");
  assert.deepEqual(p.moves, []);
  await p.pointer("pointerup", "1", -5);
  await act(async () => { p.document.getElementById("tab-1")!.dispatchEvent(new p.window.MouseEvent("click", { bubbles: true, detail: 1 })); });
  assert.deepEqual(p.moves, [{ id: "1", relativeToId: "0", placement: "before" }]);
  assert.deepEqual(p.selections, ["1"]);
  assert.deepEqual([...p.container.children].map(tab => tab.id), ["tab-1", "tab-0", "tab-2"]);
  assert.equal(p.document.querySelector('[role="status"]')!.textContent, "a wider second tab moved to position 1.");
});

test("Escape, cancellation, lost capture, and window blur clear drag presentation without saving", async t => {
  const p = await setup(t);
  for (const end of ["escape", "pointercancel", "lostpointercapture", "blur"]) {
    await p.pointer("pointerdown", "2", 300);
    await p.pointer("pointermove", "2", 30);
    assert.equal(p.container.hasAttribute("data-dragging"), true);
    if (end === "escape") await p.key(p.document.getElementById("tab-2")!, "Escape");
    else if (end === "blur") await act(async () => { p.window.dispatchEvent(new p.window.Event("blur")); });
    else await p.pointer(end, "2", 30);
    assert.equal(p.container.hasAttribute("data-dragging"), false);
    assert.equal(p.container.querySelector('[data-drag-source]'), null);
  }
  assert.deepEqual(p.moves, []);
});

test("touch uses a movement threshold, and keyboard navigation continues to select tabs", async t => {
  const p = await setup(t);
  await p.pointer("pointerdown", "2", 300, { pointerType: "touch" });
  await p.pointer("pointermove", "2", 293, { pointerType: "touch" });
  assert.equal(p.container.hasAttribute("data-dragging"), false);
  await p.pointer("pointermove", "2", 40, { pointerType: "touch" });
  assert.equal(p.container.hasAttribute("data-dragging"), true);
  await p.pointer("pointercancel", "2", 40, { pointerType: "touch" });
  await p.key(p.document.getElementById("tab-0")!, "ArrowRight");
  assert.deepEqual(p.selections, ["1"]);
  assert.deepEqual(p.moves, []);
});
