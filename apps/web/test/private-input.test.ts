import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { mountComponent } from "./component-helpers";
import { UnsavedContext } from "../src/navigation-guard";
import type { UserInputRequest } from "../../server/src/vault-types";
const { PrivateInputCard } = await import("../src/components/PrivateInputCard");
const pending: UserInputRequest = { id: "r", kind: "secret", workspaceId: "w", agentId: "a", taskId: "t", name: "API Key", purpose: "Sign in", state: "pending", secretId: null, expectedRevision: null, createdAt: "now", updatedAt: "now" };

test("private input preserves failed drafts and submits plaintext only through the private endpoint", async t => {
  const writes: { url: string; body: unknown }[] = [];
  let fail = true, dirty = false;
  let current = pending;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      if (fail) return Response.json({ error: "Secret changed. Reload it before saving." }, { status: 409 });
      current = { ...pending, state: "fulfilled", secretId: "saved", updatedAt: "later" };
      return Response.json(current);
    }
    return Response.json(url.includes("vault/secrets") ? { items: [], total: 0 } : current);
  });
  const p = await mountComponent(t, h(UnsavedContext.Provider, { value: { setDirty: value => { dirty = value; }, attempt: action => { action(); return true; } } }, h(PrivateInputCard, { requestId: "r" })));
  const textarea = p.document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(p.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "private-ui-canary");
    textarea.dispatchEvent(new p.window.Event("input", { bubbles: true }));
  });
  assert.equal(dirty, true);
  async function submit() { await act(async () => { p.document.querySelector("form")!.dispatchEvent(new p.window.Event("submit", { bubbles: true, cancelable: true })); }); }
  await submit();
  assert.equal(textarea.value, "private-ui-canary"); assert.match(p.document.querySelector("[role='alert']")!.textContent!, /changed/);
  fail = false; await submit();
  assert.equal(p.document.querySelector("textarea"), null); assert.equal(dirty, false);
  assert.ok(writes.every(w => w.url === "/api/user-input-requests/r/resolve"));
  assert.deepEqual(writes[0]!.body, { value: "private-ui-canary" });
  assert.ok(!p.document.body.textContent!.includes("private-ui-canary"));
});
