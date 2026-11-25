import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useState, StrictMode } from "react";
import { createFeedbackStore, type NoticeInput } from "../src/feedback-store";
import { request, RequestError } from "../src/api";
import { AgentContext, createAgentStore } from "../src/agent-store";
import type { Agent } from "../../server/src/contracts";
import { mountComponent } from "./component-helpers";
const { FeedbackProvider, FeedbackContext, FeedbackHost, useFeedbackStore, useNotice } = await import("../src/components/FeedbackProvider");
const { Feedback, BusyButton } = await import("../src/components/Feedback");
const { Dialog } = await import("../src/components/Dialog");
const { LiveConnectionFeedback, WorkspaceFeedback } = await import("../src/components/WorkspaceFeedback");

const failure: NoticeInput = { id: "settings", title: "Settings could not sync", message: "Try again when the connection is available." };

test("notices replace repeated failures, retain dismissal for the episode, and reset after resolution", () => {
  const store = createFeedbackStore();
  store.getState().publish(failure);
  store.getState().dismiss(failure.id);
  store.getState().publish({ ...failure, action: () => {} });
  assert.equal(store.getState().notices.length, 1);
  assert.equal(store.getState().notices[0]!.dismissed, true);
  store.getState().resolve(failure.id);
  store.getState().publish(failure);
  assert.equal(store.getState().notices[0]!.dismissed, false);
  store.getState().publish({ ...failure, message: "A different failure" });
  assert.equal(store.getState().notices.length, 1);
  store.getState().remove(failure.id);
  assert.deepEqual(store.getState().notices, []);
});

test("retry stays busy until settlement, blocks overlaps, and retains a retryable failure", async () => {
  const store = createFeedbackStore();
  let release!: () => void, calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  store.getState().publish({ ...failure, action: async () => { calls++; await pending; throw new Error("Still unavailable"); } });
  const retry = store.getState().run(failure.id);
  await store.getState().run(failure.id);
  store.getState().dismiss(failure.id);
  store.getState().resolve(failure.id);
  assert.equal(calls, 1);
  assert.equal(store.getState().notices[0]!.busy, true);
  assert.equal(store.getState().notices[0]!.dismissed, false);
  release(); await retry;
  assert.equal(store.getState().notices[0]!.busy, false);
  assert.equal(store.getState().notices[0]!.message, "Still unavailable");
  assert.equal(store.getState().notices[0]!.resolved, false);
});

test("successful retries await source resolution and old completions cannot overwrite a new source", async () => {
  const store = createFeedbackStore();
  store.getState().publish({ ...failure, action: async () => {} });
  await store.getState().run(failure.id);
  assert.equal(store.getState().notices.length, 1, "a swallowed error is not inferred to be success");
  let release!: () => void;
  store.getState().publish({ ...failure, action: () => new Promise<void>(resolve => { release = resolve; }) });
  const retry = store.getState().run(failure.id);
  store.getState().resolve(failure.id);
  assert.equal(store.getState().notices.length, 1, "keep the retry spinner while the request is pending");
  release(); await retry;
  assert.equal(store.getState().notices.length, 0);
  let reject!: (reason: Error) => void;
  store.getState().publish({ ...failure, action: () => new Promise<void>((_, no) => { reject = no; }) });
  const old = store.getState().run(failure.id);
  store.getState().remove(failure.id);
  store.getState().publish({ ...failure, message: "New failure" });
  reject(new Error("Old failure")); await old;
  assert.equal(store.getState().notices[0]!.message, "New failure");
});

test("HTTP fallbacks are readable and retain status details and server field errors", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("Bad gateway", { status: 502 }));
  await assert.rejects(request("/settings"), error => {
    assert.ok(error instanceof RequestError);
    assert.match(error.message, /temporarily unavailable/);
    assert.doesNotMatch(error.message, /502|Request failed/);
    assert.equal(error.details, "HTTP 502");
    return true;
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Choose a workspace name.", fields: { name: "Required" } }, { status: 400 }));
  await assert.rejects(request("/workspaces"), error => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.message, "Choose a workspace name.");
    assert.deepEqual(error.fields, { name: "Required" });
    return true;
  });
});

test("a failed read after an accepted message retries only that read and unrelated snapshots do not clear it", async t => {
  const agent: Agent = { id: "one", workspaceId: "workspace", name: "Ava", instructions: "", presetId: null,
    appearance: { kind: "pebble", color: "sage", accessories: [] }, x: 0, y: 0, revision: 1,
    createdAt: "now", updatedAt: "now", state: "idle", queuedCount: 0, runningTaskCount: 0, unfinishedTaskCount: 0, chatWorking: false,
    pendingUserInputCount: 0, issueCounts: { warning: 0, error: 0 } };
  let sent = 0, fail = true, reads = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { sent++; return Response.json({ taskId: null, turnId: "accepted" }); }
    if (url === "/api/agents/one/chat/messages") {
      reads++;
      if (fail) return new Response("Unavailable", { status: 502 });
    }
    return Response.json({ items: url.includes("/workspaces/workspace/agents?") ? [agent] : [], total: 0 });
  });
  const store = createAgentStore();
  store.setState({ agents: { one: agent }, refreshAgent: async () => {} });
  await store.getState().submit("one", null, "Hello", "same-request");
  assert.equal(store.getState().errorActionLabel, "Reload conversation");
  assert.equal(store.getState().errorWorkspaceId, "workspace");
  await store.getState().loadWorkspace("workspace");
  assert.ok(store.getState().error, "a different successful read must not hide this failure");
  fail = false;
  await store.getState().retryError!();
  assert.equal(store.getState().error, "");
  assert.equal(reads, 2);
  assert.equal(sent, 1, "the accepted message is never sent again");
});

test("notice viewport limits cards, exposes overflow, and leaves field focus and validation intact", async t => {
  let store!: ReturnType<typeof createFeedbackStore>;
  function Probe() { store = useFeedbackStore()!; return h("input", { "aria-label": "Draft", defaultValue: "Unsaved text" }); }
  const p = await mountComponent(t, h(FeedbackProvider, null, h(Probe)));
  const input = p.document.querySelector("input")!; input.focus();
  await act(async () => { for (let i = 0; i < 5; i++) store.getState().publish({ ...failure, id: String(i), title: `Failure ${i}` }); });
  const region = p.document.querySelector('[aria-label="Application notices"]')!;
  assert.equal(region.querySelectorAll('[data-notice-id]').length, 3);
  assert.equal(p.document.activeElement, input);
  assert.equal(input.value, "Unsaved text");
  await p.click([...region.querySelectorAll("button")].find(button => button.textContent === "View 2 more notices")!);
  assert.equal(region.querySelectorAll('[data-notice-id]').length, 5);
  await p.click(region.querySelector('[aria-label="Dismiss Failure 0"]')!);
  assert.equal(region.querySelectorAll('[data-notice-id]').length, 4);
  assert.equal(p.document.querySelectorAll("svg.lucide-loader-circle").length, 0, "errors do not show a spinner");
  const dismiss = region.querySelector<HTMLButtonElement>('[aria-label="Dismiss Failure 1"]')!;
  dismiss.focus(); await p.click(dismiss);
  assert.equal(p.document.activeElement, input, "dismissal restores the last content focus");
});

test("modal notices follow the top dialog, respect busy protection, and preserve focus and drafts", async t => {
  let store!: ReturnType<typeof createFeedbackStore>;
  let setNested!: (value: boolean) => void, setBusy!: (value: boolean) => void;
  let calls = 0;
  function Probe() {
    store = useFeedbackStore()!;
    const [nested, changeNested] = useState(false); setNested = changeNested;
    const [busy, changeBusy] = useState(false); setBusy = changeBusy;
    return h(Dialog, { title: "Editor", onClose() {} }, h("input", { defaultValue: "Keep my draft" }),
      nested && h(Dialog, { title: "Confirmation", busy, onClose() {} }, h("input", { defaultValue: "Nested draft" })));
  }
  const p = await mountComponent(t, h(FeedbackProvider, null, h(Probe), h(FeedbackHost, { kind: "panel" })));
  await act(async () => store.getState().publish({ ...failure, actionLabel: "Retry settings", action() { calls++; } }));
  const outer = p.document.querySelector("dialog")!;
  assert.ok(outer.querySelector('[aria-label="Application notices"]'));
  const announcement = outer.querySelector('[aria-live="polite"]')!.textContent;
  await act(async () => setNested(true));
  const inner = outer.querySelector("dialog")!;
  assert.ok(inner.querySelector('[aria-label="Application notices"]'));
  assert.equal(inner.querySelector('[aria-live="polite"]')!.textContent, announcement);
  assert.equal(p.document.querySelectorAll('[aria-live="polite"]').length, 1, "host changes retain one unchanged announcement");
  const input = inner.querySelector("input")!; input.focus();
  await act(async () => setBusy(true));
  assert.equal(p.document.activeElement, input);
  const retry = [...inner.querySelectorAll("button")].find(button => button.textContent === "Retry settings")!;
  assert.equal(retry.disabled, true);
  await store.getState().run(failure.id);
  assert.equal(calls, 0);
  await act(async () => setBusy(false));
  await p.click(retry);
  assert.equal(calls, 1);
  await act(async () => setNested(false));
  assert.equal(p.document.querySelectorAll('[aria-label="Application notices"]').length, 1);
  assert.equal(outer.querySelector("input")!.value, "Keep my draft");
});

test("agent-loading failures retry reads rather than layout saves and stay scoped to their workspace", async t => {
  const agents = createAgentStore();
  const loads: string[] = [];
  let saves = 0;
  agents.setState({ error: "Updates unavailable", errorWorkspaceId: "one", connectionWorkspaceId: "one", connected: true,
    loadWorkspace: async id => { loads.push(id); agents.setState({ error: "", errorWorkspaceId: null }); },
    retryPositions: async () => { saves++; } });
  const p = await mountComponent(t, h(FeedbackProvider, null, h(AgentContext.Provider, { value: agents }, h(WorkspaceFeedback, { workspaceId: "one" }))));
  await p.click([...p.document.querySelectorAll("button")].find(button => button.textContent === "Reload agents")!);
  assert.deepEqual(loads, ["one"]);
  assert.equal(saves, 0);
  assert.equal(p.document.querySelector('[aria-label="Application notices"]'), null);
  await act(async () => agents.setState({ error: "Old workspace failure", errorWorkspaceId: "two" }));
  assert.doesNotMatch(p.document.body.textContent!, /Old workspace failure/);
});

test("a source keeps its notice through retry loading and clears on success and unmount", async t => {
  let setError!: (value: string) => void, finish!: () => void;
  function Probe() {
    const [error, changeError] = useState("Could not save"); setError = changeError;
    useNotice(error ? { ...failure, message: error, action: async () => {
      changeError(""); await new Promise<void>(resolve => { finish = resolve; });
    } } : null, failure.id);
    return null;
  }
  const p = await mountComponent(t, h(StrictMode, null, h(FeedbackProvider, null, h(Probe))));
  await p.click([...p.document.querySelectorAll("button")].find(button => button.textContent === "Try again")!);
  assert.match(p.document.body.textContent!, /Retrying…/);
  assert.ok(p.document.querySelector("svg.lucide-loader-circle"));
  await act(async () => finish());
  assert.equal(p.document.querySelector('[aria-label="Application notices"]'), null);
  await act(async () => setError("Another failure"));
  assert.match(p.document.body.textContent!, /Another failure/);
  await act(async () => p.root.render(h(FeedbackProvider, null, h("span"))));
  assert.equal(p.document.querySelector('[aria-label="Application notices"]'), null);
});

test("short connection interruptions stay quiet; sustained interruptions recover and clean up across workspaces", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createFeedbackStore();
  const view = (workspaceId: string, connected: boolean) => h(FeedbackContext.Provider, { value: store },
    h(LiveConnectionFeedback, { key: workspaceId, workspaceId, connected }));
  const p = await mountComponent(t, view("one", true));
  await act(async () => p.root.render(view("one", false)));
  await act(async () => t.mock.timers.tick(500));
  await act(async () => p.root.render(view("one", true)));
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(store.getState().notices.length, 0);
  await act(async () => p.root.render(view("one", false)));
  await act(async () => t.mock.timers.tick(1000));
  assert.match(store.getState().notices[0]!.title, /Reconnecting/);
  assert.equal(store.getState().notices[0]!.tone, "loading");
  store.getState().dismiss("live-updates:one");
  assert.equal(store.getState().notices[0]!.dismissed, false);
  await act(async () => p.root.render(view("one", true)));
  assert.equal(store.getState().notices[0]!.title, "Live updates restored");
  await act(async () => t.mock.timers.tick(3000));
  assert.equal(store.getState().notices.length, 0);
  await act(async () => p.root.render(view("one", false)));
  await act(async () => t.mock.timers.tick(1000));
  await act(async () => p.root.render(view("two", false)));
  assert.equal(store.getState().notices.length, 0, "old workspace notices are removed");
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(store.getState().notices[0]!.id, "live-updates:two");
  assert.match(store.getState().notices[0]!.title, /Connecting/);
  await act(async () => p.root.render(h("span")));
  await act(async () => t.mock.timers.tick(10000));
  assert.equal(store.getState().notices.length, 0);
});

test("local feedback preserves field associations and uses an icon only while busy", async t => {
  const p = await mountComponent(t, h("form", null,
    h("input", { "aria-invalid": true, "aria-describedby": "field-error", defaultValue: "Draft" }),
    h("span", { id: "field-error", className: "fieldError" }, "Required"),
    h(Feedback, { title: "Save failed", details: "HTTP 502" }, "Try again."),
    h(BusyButton, { busy: true }, "Saving…")));
  assert.equal(p.document.querySelector("input")!.getAttribute("aria-describedby"), "field-error");
  assert.equal(p.document.querySelectorAll('[role="alert"]').length, 1);
  assert.match(p.document.querySelector("details")!.textContent!, /HTTP 502/);
  assert.equal(p.document.querySelector("button")!.disabled, true);
  assert.equal(p.document.querySelectorAll("svg.lucide-loader-circle").length, 1);
});
