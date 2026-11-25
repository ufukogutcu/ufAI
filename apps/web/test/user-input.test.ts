import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useRef } from "react";
import { mountComponent } from "./component-helpers";
import { UnsavedContext } from "../src/navigation-guard";
import { AgentContext, createAgentStore } from "../src/agent-store";
import type { InputField, UserInputRequest } from "../../server/src/vault-types";
const { UserInputCard } = await import("../src/components/UserInputCard");
const { AgentInputBubble } = await import("../src/components/AgentInputBubble");
const base: UserInputRequest = { id: "r", kind: "text", workspaceId: "w", agentId: "a", taskId: "t", taskTitle: "Task", name: "Your approach", purpose: "Choose how to proceed", secretId: null, expectedRevision: null, state: "pending", definition: {}, answer: null, createdAt: "now", updatedAt: "now" };
const options = [{ id: "fast", label: "Fast", description: "Quick result" }, { id: "careful", label: "Careful" }];
const guard = (child: any, dirty: (v: boolean) => void = () => {}) => h(UnsavedContext.Provider, { value: { setDirty: dirty, attempt(action) { action(); return true; } } }, child);
async function input(p: any, selector: string, value: string) {
  await act(async () => { const e = p.document.querySelector(selector)!; const prototype = e.tagName === "TEXTAREA" ? p.window.HTMLTextAreaElement.prototype : p.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(e, value); e.dispatchEvent(new p.window.Event("input", { bubbles: true })); });
}
async function submit(p: any) { await act(async () => { p.document.querySelector("form")!.dispatchEvent(new p.window.Event("submit", { bubbles: true, cancelable: true })); }); }
function button(document: Document, label: string) { return [...document.querySelectorAll("button")].find(node => node.textContent === label)!; }

test("text cards focus validation errors and preserve drafts on failure and background refresh", async t => {
  let current = base, fail = true, dirty = false; const writes: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); if (fail) return Response.json({ error: "Try again", fields: { answer: "Check your answer" } }, { status: 400 }); current = { ...base, state: "fulfilled", answer: writes.at(-1).answer }; }
    return Response.json(current);
  });
  const p = await mountComponent(t, guard(h(UserInputCard, { requestId: "r" }), v => { dirty = v; }));
  await submit(p); assert.equal(writes.length, 0); assert.equal(p.document.activeElement?.tagName, "TEXTAREA");
  await input(p, "textarea", "Keep this draft"); assert.equal(dirty, true); await submit(p);
  assert.equal(p.document.querySelector("textarea")!.value, "Keep this draft");
  assert.equal(p.document.activeElement?.tagName, "TEXTAREA");
  await act(async () => { p.window.dispatchEvent(new p.window.Event("ufai-private-input-updated")); });
  assert.equal(p.document.querySelector("textarea")!.value, "Keep this draft"); fail = false; await submit(p);
  assert.equal(p.document.querySelector("form"), null); assert.equal(dirty, false); assert.match(p.document.body.textContent!, /Keep this draft/);
  const outcome = p.document.querySelector("details")!;
  assert.equal(outcome.open, false);
  await p.click(outcome.querySelector("summary")!);
  assert.equal(outcome.open, true);
});
for (const kind of ["single_choice", "multi_select"] as const) test(`${kind} supports custom answers alongside predefined options`, async t => {
  let current: UserInputRequest = { ...base, kind, definition: { options, allowOther: true } }, answer: any;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => { if (init?.method === "POST") { answer = JSON.parse(String(init.body)).answer; current = { ...current, state: "fulfilled", answer }; } return Response.json(current); });
  const p = await mountComponent(t, guard(h(UserInputCard, { requestId: "r" })));
  if (kind === "multi_select") await p.click(p.document.querySelector("input[value='fast']")!);
  await p.click(p.document.querySelectorAll("fieldset input")[2]!); await input(p, "textarea", "My approach"); await submit(p);
  assert.deepEqual(answer, { selected: kind === "single_choice" ? [] : ["fast"], other: "My approach" }); assert.match(p.document.body.textContent!, /My approach/);
});
test("forms preserve collapsed drafts and submit each typed field atomically", async t => {
  const fields: InputField[] = [
    { id: "text", type: "text", label: "Text", required: true, default: "Hello" },
    { id: "choice", type: "single_choice", label: "Choice", options, default: { selected: ["fast"] } },
    { id: "multi", type: "multi_select", label: "Multi", options, default: { selected: ["fast", "careful"] } },
    { id: "bool", type: "boolean", label: "Boolean", required: true, default: false },
    { id: "num", type: "number", label: "Number", default: 1.5 }, { id: "int", type: "integer", label: "Integer", default: 2 },
    { id: "email", type: "email", label: "Email", default: "a@example.com" }, { id: "url", type: "url", label: "URL", default: "https://example.com/" },
    { id: "date", type: "date", label: "Date", default: "2028-02-29" }, { id: "time", type: "date_time", label: "Time", default: "2028-02-29T12:30:30Z" }, { id: "optional", type: "text", label: "Optional" },
  ];
  let current: UserInputRequest = { ...base, kind: "form", definition: { fields } }, answer: any, dirty = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => { if (init?.method === "POST") { answer = JSON.parse(String(init.body)).answer; current = { ...current, state: "fulfilled", answer }; } return Response.json(current); });
  const p = await mountComponent(t, guard(h(UserInputCard, { requestId: "r" }), value => { dirty = value; }));
  assert.equal(p.document.querySelector("form"), null);
  const disclosure = button(p.document, "Answer");
  assert.equal(disclosure.getAttribute("aria-expanded"), "false");
  await p.click(disclosure);
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  await input(p, "textarea", "Updated answer");
  await p.click(disclosure);
  assert.equal(p.document.querySelector("form"), null);
  assert.equal(dirty, true);
  await p.click(disclosure);
  assert.equal(p.document.querySelector("textarea")!.value, "Updated answer");
  assert.equal(p.document.querySelector<HTMLInputElement>("input[name='bool'][value='false']")!.checked, true); assert.match(p.document.body.textContent!, /Time zone:/); await submit(p);
  assert.equal(answer.text, "Updated answer"); assert.equal(answer.bool, false); assert.equal(answer.num, 1.5); assert.equal(answer.int, 2); assert.equal(answer.date, "2028-02-29"); assert.equal(answer.time, "2028-02-29T12:30:30.000Z"); assert.ok(!("optional" in answer));
});
test("Other counts toward the inline choice limit", async t => {
  const current: UserInputRequest = {
    ...base, kind: "single_choice", definition: {
      options: [...options, { id: "later", label: "Later" }, { id: "now", label: "Now" }], allowOther: true,
    },
  };
  t.mock.method(globalThis, "fetch", async () => Response.json(current));
  const p = await mountComponent(t, guard(h(UserInputCard, { requestId: "r" })));
  assert.equal(p.document.querySelector("fieldset"), null);
  await p.click(button(p.document, "Answer"));
  assert.equal(p.document.querySelectorAll("fieldset input").length, 5);
});
test("external resolution replaces dirty drafts and decline needs no field answers", async t => {
  let current = base, body: any, dirty = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => { if (init?.method === "POST") { body = JSON.parse(String(init.body)); current = { ...current, state: "declined" }; } return Response.json(current); });
  const p = await mountComponent(t, guard(h(UserInputCard, { requestId: "r" }), v => { dirty = v; }));
  await input(p, "textarea", "Local draft"); current = { ...base, state: "fulfilled", answer: "Answered in Inbox" };
  await act(async () => { p.window.dispatchEvent(new p.window.Event("ufai-private-input-updated")); });
  assert.equal(p.document.querySelector("textarea"), null); assert.equal(dirty, false); assert.match(p.document.body.textContent!, /Answered in Inbox/);
  current = { ...base, id: "next" }; await act(async () => { p.root.render(guard(h(UserInputCard, { key: "next", requestId: "next" }))); });
  await p.click([...p.document.querySelectorAll("button")].find(b => b.textContent === "Decline")!); assert.deepEqual(body, { decline: true });
});
test("agent bubble opens an answer dialog, keeps the empty result and restores focus after removal", async t => {
  let current = base, count = 1; const store = createAgentStore();
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => { if (init?.method === "POST") { current = { ...base, state: "fulfilled", answer: JSON.parse(String(init.body)).answer }; count = 0; } return Response.json(url.includes("?") ? { items: count ? [current] : [], total: count } : current); });
  function Probe() { const fallback = useRef<HTMLButtonElement>(null); return h("div", null, h("button", { ref: fallback }, "Agent name"), h(AgentInputBubble, { agentId: "a", agentName: "Agent", count, fallbackRef: fallback })); }
  const element = () => guard(h(AgentContext.Provider, { value: store }, h(Probe)));
  const p = await mountComponent(t, element()); await p.click(p.document.querySelector("button[aria-haspopup='dialog']")!); assert.ok(p.document.querySelector("dialog[open]"));
  p.document.querySelector("textarea")!.focus();
  await input(p, "textarea", "Answer here"); await submit(p); await act(async () => { p.root.render(element()); });
  assert.equal(p.document.querySelector("button[aria-haspopup='dialog']"), null); assert.ok(p.document.querySelector("dialog[open]")); assert.match(p.document.body.textContent!, /No pending requests/);
  assert.equal(p.document.activeElement, p.document.querySelector("[data-input-list]"));
  await p.click(p.document.querySelector("button[aria-label='Close dialog']")!); assert.equal(p.document.activeElement?.textContent, "Agent name");
});

test("agent input dialog keeps loaded requests in place while refreshing", async t => {
  const store = createAgentStore();
  const next = { ...base, id: "next", name: "A new question" };
  let respondToPage!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", (url: string) => {
    if (url.includes("/user-input-requests?")) {
      return new Promise<Response>(resolve => { respondToPage = resolve; });
    }
    return Promise.resolve(Response.json(url.endsWith("/next") ? next : base));
  });
  function Probe() {
    const fallbackRef = useRef<HTMLButtonElement>(null);
    return h(AgentInputBubble, { agentId: "a", agentName: "Agent", count: 1, fallbackRef });
  }
  const p = await mountComponent(t, guard(h(AgentContext.Provider, { value: store }, h(Probe))));
  await p.click(p.document.querySelector("button[aria-haspopup='dialog']")!);
  const dialog = p.document.querySelector("dialog[open]")!;
  assert.match(dialog.textContent!, /Loading requests/);
  await act(async () => { respondToPage(Response.json({ items: [base], total: 1 })); });

  const answer = dialog.querySelector("textarea")!;
  answer.focus();
  await input(p, "textarea", "Keep this draft");
  await act(async () => { store.setState(state => ({ eventVersion: state.eventVersion + 1 })); });
  assert.doesNotMatch(dialog.textContent!, /Loading requests/);
  assert.equal(dialog.querySelector("textarea"), answer);
  assert.equal(p.document.activeElement, answer);

  await act(async () => { respondToPage(Response.json({ items: [base, next], total: 2 })); });
  assert.match(dialog.textContent!, /A new question/);
  assert.equal(answer.value, "Keep this draft");
  assert.equal(p.document.activeElement, answer);
});
