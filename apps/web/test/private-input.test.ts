import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { mountComponent } from "./component-helpers";
import { UnsavedContext } from "../src/navigation-guard";
import type { UserInputRequest } from "../../server/src/vault-types";
const { UserInputCard } = await import("../src/components/UserInputCard");
const pending: UserInputRequest = { id: "r", kind: "secret", workspaceId: "w", agentId: "a", taskId: "t", name: "API Key", purpose: "Sign in", state: "pending", secretId: null, expectedRevision: null, createdAt: "now", updatedAt: "now" };
const savedSecret = { id: "saved", name: "Saved key", revision: 4 };

function button(document: Document, label: string) { return [...document.querySelectorAll("button")].find(node => node.textContent === label)!; }
function guarded(onDirty: (value: boolean) => void = () => {}) {
  return h(UnsavedContext.Provider, { value: { setDirty: onDirty, attempt: action => { action(); return true; } } }, h(UserInputCard, { requestId: "r" }));
}
async function enterSecret(page: Awaited<ReturnType<typeof mountComponent>>, value: string) {
  const textarea = page.document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  });
}

test("private input preserves masked replacement drafts and retries with the latest revision", async t => {
  const writes: { url: string; body: unknown }[] = [];
  let fail = true, dirty = false;
  let current: UserInputRequest = { ...pending, secretId: savedSecret.id, expectedRevision: 3 };
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      if (fail) return Response.json({ error: "Secret changed. Reload it before saving." }, { status: 409 });
      current = { ...current, state: "fulfilled", updatedAt: "later" };
    }
    return Response.json(url.endsWith("/vault/secrets/saved") ? savedSecret : current);
  });
  const p = await mountComponent(t, guarded(value => { dirty = value; }));
  assert.equal(p.document.querySelector("form"), null);
  const disclosure = button(p.document, "Open private request");
  await p.click(disclosure);
  await enterSecret(p, "private-ui-canary");
  assert.equal(dirty, true);
  await p.click(button(p.document, "Save secret"));
  assert.equal(p.document.querySelector("textarea")!.value, "private-ui-canary");
  assert.match(p.document.querySelector("[role='alert']")!.textContent!, /changed/);
  await p.click(disclosure);
  assert.equal(p.document.querySelector("textarea"), null);
  assert.equal(dirty, true);
  await p.click(disclosure);
  await p.click(button(p.document, "Use latest revision"));
  fail = false;
  await p.click(button(p.document, "Save secret"));
  assert.equal(p.document.querySelector("textarea"), null);
  assert.equal(dirty, false);
  assert.ok(writes.every(w => w.url === "/api/user-input-requests/r/resolve"));
  assert.deepEqual(writes[0]!.body, { value: "private-ui-canary" });
  assert.deepEqual(writes[1]!.body, { value: "private-ui-canary", expectedRevision: 4 });
  assert.ok(!p.document.body.textContent!.includes("private-ui-canary"));
  assert.match(p.document.body.textContent!, /Secret provided/);
});

test("private picker loads on demand and sends only a saved secret reference", async t => {
  const reads: string[] = [];
  let current = pending, payload: unknown;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      payload = JSON.parse(String(init.body));
      current = { ...current, state: "fulfilled", secretId: savedSecret.id };
    } else {
      reads.push(url);
      if (url.includes("/vault/secrets?")) return Response.json({ total: 1, items: url.endsWith("offset=0") ? [savedSecret] : [] });
    }
    return Response.json(current);
  });
  const p = await mountComponent(t, guarded());
  await p.click(button(p.document, "Open private request"));
  assert.ok(!reads.some(url => url.includes("/vault/secrets")));
  await enterSecret(p, "unsent-draft");
  await p.click(button(p.document, "Use a saved secret"));
  assert.equal(p.document.querySelector("textarea"), null);
  const picker = p.document.querySelector("select")!;
  await act(async () => { picker.value = savedSecret.id; picker.dispatchEvent(new p.window.Event("change", { bubbles: true })); });
  await p.click(button(p.document, "Enter a new secret"));
  assert.equal(p.document.querySelector("textarea")!.value, "unsent-draft");
  await p.click(button(p.document, "Use a saved secret"));
  assert.equal(p.document.querySelector("select")!.value, savedSecret.id);
  await p.click(button(p.document, "Use secret"));
  assert.deepEqual(payload, { secretId: savedSecret.id });
});
