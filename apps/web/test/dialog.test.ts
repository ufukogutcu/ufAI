import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h, useState } from "react";
import { createPortal } from "react-dom";
import { mountComponent } from "./component-helpers";
const { Dialog } = await import("../src/components/Dialog");
const { UnsavedChangesProvider } = await import("../src/components/UnsavedChanges");
const { useNavigationGuard, useUnsavedChanges } = await import("../src/navigation-guard");

type Mounted = Awaited<ReturnType<typeof mountComponent>>;
const outside = { clientX: 20, clientY: 20 };
const inside = { clientX: 200, clientY: 150 };

function bounds(t: TestContext, dialog: Element) {
  t.mock.method(dialog, "getBoundingClientRect", () => ({
    left: 100, top: 50, right: 300, bottom: 250, width: 200, height: 200, x: 100, y: 50,
  }) as DOMRect);
}
async function pointer(p: Mounted, target: Element, type: string, options: PointerEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new p.window.PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: "mouse",
      button: 0, ...outside, ...options,
    }));
  });
}
async function clickAt(p: Mounted, target: Element, options: MouseEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new p.window.MouseEvent("click", {
      bubbles: true, cancelable: true, detail: 1, button: 0, ...outside, ...options,
    }));
  });
}
async function tap(p: Mounted, target: Element, options: PointerEventInit = {}) {
  await pointer(p, target, "pointerdown", options);
  await pointer(p, target, "pointerup", options);
  await clickAt(p, target, options);
}

test("backdrop clicks on every side and touch/pen taps close once without reaching the page", async t => {
  let closed = 0, pageClicks = 0;
  const p = await mountComponent(t, h("section", { onClick: () => pageClicks++ },
    h(Dialog, { title: "Usage", onClose: () => closed++ }, h("input", { type: "checkbox" }))));
  const dialog = p.document.querySelector("dialog")!;
  bounds(t, dialog);
  const gestures: PointerEventInit[] = [
    outside, { clientX: 350, clientY: 150 }, { clientX: 200, clientY: 10 },
    { clientX: 200, clientY: 280 }, { pointerType: "touch" }, { pointerType: "pen" },
  ];
  for (const [index, gesture] of gestures.entries()) {
    await tap(p, dialog, gesture);
    assert.equal(closed, index + 1);
    await clickAt(p, dialog, gesture);
    assert.equal(closed, index + 1, "a click without another gesture must not close twice");
  }
  assert.equal(pageClicks, 0);
});

test("dialog surfaces, padding, edges, and child controls remain interactive", async t => {
  let closed = 0, actions = 0;
  const p = await mountComponent(t, h(Dialog, { title: "Content", onClose: () => closed++ },
    h("button", { id: "action", onClick: () => actions++ }, "Action")));
  const dialog = p.document.querySelector("dialog")!;
  bounds(t, dialog);
  for (const point of [inside, { clientX: 100, clientY: 50 }, { clientX: 300, clientY: 250 }])
    await tap(p, dialog, point);
  await tap(p, p.document.querySelector("h2")!);
  await tap(p, p.document.querySelector("#action")!, inside);
  assert.equal(actions, 1);
  assert.equal(closed, 0);
});

test("dragging between content and backdrop or releasing inside never dismisses", async t => {
  let closed = 0;
  const p = await mountComponent(t, h(Dialog, { title: "Drag", onClose: () => closed++ }, h("input", { type: "checkbox" })));
  const dialog = p.document.querySelector("dialog")!, input = dialog.querySelector("input")!;
  bounds(t, dialog);
  await pointer(p, input, "pointerdown", inside);
  await pointer(p, dialog, "pointerup");
  await clickAt(p, dialog);
  await pointer(p, dialog, "pointerdown", inside);
  await pointer(p, dialog, "pointerup");
  await clickAt(p, dialog);
  await pointer(p, dialog, "pointerdown");
  await pointer(p, input, "pointerup", inside);
  await clickAt(p, dialog, inside);
  await pointer(p, dialog, "pointerdown");
  await pointer(p, dialog, "pointerup", inside);
  await clickAt(p, dialog);
  assert.equal(closed, 0);
  await tap(p, dialog);
  assert.equal(closed, 1);
});

test("canceled, secondary, mismatched, and incomplete pointer gestures do not dismiss", async t => {
  let closed = 0;
  const p = await mountComponent(t, h(Dialog, { title: "Pointers", onClose: () => closed++ }, "Content"));
  const dialog = p.document.querySelector("dialog")!;
  bounds(t, dialog);
  await tap(p, dialog, { button: 2 });
  await tap(p, dialog, { button: 1 });
  await tap(p, dialog, { isPrimary: false, pointerType: "touch" });
  await pointer(p, dialog, "pointerdown");
  await pointer(p, dialog, "pointercancel");
  await pointer(p, dialog, "pointerup");
  await clickAt(p, dialog);
  await pointer(p, dialog, "pointerdown");
  await pointer(p, dialog, "pointerup", { pointerId: 2 });
  await clickAt(p, dialog);
  await pointer(p, dialog, "pointerdown");
  await clickAt(p, dialog);
  await pointer(p, dialog, "pointerup");
  await clickAt(p, dialog);
  assert.equal(closed, 0);
  await tap(p, dialog);
  assert.equal(closed, 1);
});

test("busy dialogs block backdrop, Close, Escape, and native cancel with current props", async t => {
  let closed = 0;
  const onClose = () => closed++;
  const view = (busy: boolean) => h(Dialog, { title: "Saving", busy, onClose }, "Content");
  const p = await mountComponent(t, view(true));
  const dialog = p.document.querySelector("dialog")!;
  bounds(t, dialog);
  await tap(p, dialog);
  await p.click(dialog.querySelector("button")!);
  await p.key(dialog, "Escape");
  await act(async () => {
    assert.equal(dialog.dispatchEvent(new p.window.Event("cancel", { cancelable: true })), false);
  });
  assert.equal(closed, 0);
  await pointer(p, dialog, "pointerdown");
  await act(async () => p.root.render(view(false)));
  await pointer(p, dialog, "pointerup");
  await clickAt(p, dialog);
  assert.equal(closed, 0, "a gesture begun while busy must stay blocked");
  await pointer(p, dialog, "pointerdown");
  await act(async () => p.root.render(view(true)));
  await pointer(p, dialog, "pointerup");
  await clickAt(p, dialog);
  assert.equal(closed, 0);
  await act(async () => p.root.render(view(false)));
  await pointer(p, dialog, "pointerdown");
  await pointer(p, dialog, "pointerup");
  await act(async () => p.root.render(view(true)));
  await clickAt(p, dialog);
  assert.equal(closed, 0);
  await act(async () => p.root.render(view(false)));
  await tap(p, dialog);
  await p.key(dialog, "Escape");
  await p.click(dialog.querySelector("button")!);
  assert.equal(closed, 3);
});

for (const portaled of [false, true]) {
  test(`${portaled ? "portaled" : "nested"} child dismissal leaves its parent open and restores focus`, async t => {
    const closed: string[] = [];
    function Probe() {
      const [childOpen, setChildOpen] = useState(false);
      const child = childOpen && h(Dialog, {
        title: "Confirmation", initialFocusSelector: "[data-cancel]",
        onClose: () => { closed.push("child"); setChildOpen(false); },
      }, h("button", { "data-cancel": true }, "Cancel"));
      return h(Dialog, { title: "Parent", onClose: () => closed.push("parent") },
        h("button", { id: "trigger", onClick: () => setChildOpen(true) }, "Open child"),
        child && (portaled ? createPortal(child, document.body) : child));
    }
    const p = await mountComponent(t, h(Probe));
    const parent = p.document.querySelector("dialog")!, trigger = p.document.querySelector<HTMLButtonElement>("#trigger")!;
    bounds(t, parent);
    await act(async () => trigger.focus());
    await p.click(trigger);
    const child = p.document.querySelectorAll("dialog")[1]!;
    bounds(t, child);
    assert.equal(p.document.activeElement, child.querySelector("[data-cancel]"));
    await tap(p, child);
    assert.deepEqual(closed, ["child"]);
    assert.equal(p.document.querySelectorAll("dialog").length, 1);
    assert.equal(p.document.activeElement, trigger);
    await tap(p, parent);
    assert.deepEqual(closed, ["child", "parent"]);
  });
}

test("outside dismissal restores the opener or its configured focus fallback", async t => {
  function Probe() {
    const [open, setOpen] = useState(false);
    return h("section", null,
      h("button", { id: "opener", onClick: () => setOpen(true) }, "Open"),
      open && h(Dialog, { title: "Focus", onClose: () => setOpen(false) }, h("input", { type: "checkbox" })));
  }
  const p = await mountComponent(t, h(Probe));
  const opener = p.document.querySelector<HTMLButtonElement>("#opener")!;
  await act(async () => opener.focus());
  await p.click(opener);
  const dialog = p.document.querySelector("dialog")!;
  bounds(t, dialog);
  assert.equal(p.document.activeElement, dialog.querySelector("input"));
  await tap(p, dialog);
  assert.equal(p.document.querySelector("dialog"), null);
  assert.equal(p.document.activeElement, opener);
  const fallback = p.document.createElement("button");
  const missingOpener = p.document.createElement("button");
  p.document.body.append(fallback, missingOpener);
  await act(async () => missingOpener.focus());
  await act(async () => p.root.render(h(Dialog, {
    title: "Fallback", onClose: () => p.root.render(null),
    returnFocusFallbackRef: { current: fallback },
  }, h("input", { type: "checkbox" }))));
  missingOpener.remove();
  const second = p.document.querySelector("dialog")!;
  bounds(t, second);
  await tap(p, second);
  assert.equal(p.document.activeElement, fallback);
  // An asynchronous preflight can disable/blur the opener before the modal mounts.
  fallback.blur();
  assert.equal(p.document.activeElement,p.document.body);
  await act(async () => p.root.render(h(Dialog, {
    title: "After preflight", onClose() {}, returnFocusFallbackRef: {current:fallback},
  },h("input"))));
  await act(async () => p.root.render(null));
  assert.equal(p.document.activeElement,fallback);
});

test("outside clicks use unsaved-change guards and dismissing the warning keeps the draft", async t => {
  function Editor() {
    const [open, setOpen] = useState(true);
    useUnsavedChanges(open);
    const guard = useNavigationGuard();
    return open && h(Dialog, { title: "Editor", initialFocusSelector: "button", onClose: () => guard(() => setOpen(false)) },
      h("input", { defaultValue: "Unsaved draft" }));
  }
  const p = await mountComponent(t, h(UnsavedChangesProvider, null, h(Editor)));
  const editor = p.document.querySelector("dialog")!;
  bounds(t, editor);
  await tap(p, editor);
  const warning = p.document.querySelectorAll("dialog")[1]!;
  bounds(t, warning);
  assert.match(warning.textContent!, /Discard unsaved changes/);
  await tap(p, warning);
  assert.equal(p.document.querySelectorAll("dialog").length, 1);
  assert.equal(editor.querySelector("input")!.value, "Unsaved draft");
  await tap(p, editor);
  const discard = [...p.document.querySelectorAll("button")].find(button => button.textContent === "Discard changes")!;
  await p.click(discard);
  assert.equal(p.document.querySelector("dialog"), null);
});
