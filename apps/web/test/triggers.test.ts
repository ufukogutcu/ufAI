import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h } from "react";
import { mountComponent } from "./component-helpers";
import { createTriggerStore, TriggerContext } from "../src/trigger-store";
import { AgentContext, createAgentStore } from "../src/agent-store";
import { UnsavedContext } from "../src/navigation-guard";
import type { Trigger } from "../../server/src/trigger-types";
const { TriggersView, SkillAutomationsPanel } = await import(
  "../src/components/Triggers"
);
const trigger: Trigger = {
  id: "pulse",
  agentId: "a",
  workspaceId: "w",
  revision: 1,
  name: "Pulse",
  instructions: "Review this occurrence",
  when: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
  enabled: true,
  paused: false,
  requiredSkillIds: [],
  createdAt: "now",
  updatedAt: "now",
  state: "active",
  blocker: null,
  nextAt: "2027-01-01T09:00:00.000Z",
  queued: 0,
  oldestPendingAt: null,
  collectingBacklog: false,
  currentTaskId: null,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
test("trigger caches preserve entity references and reject stale responses after mutations", async (t) => {
  const pending = deferred<Response>();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 2
      ? pending.promise
      : Response.json({ items: [trigger], total: 1 }),
  );
  const s = createTriggerStore();
  await s.getState().load("/agents/a/triggers");
  const original = s.getState().entities.pulse;
  const stale = s.getState().load("/agents/a/triggers");
  s.getState().put({ ...trigger, name: "Updated", revision: 2 });
  pending.resolve(Response.json({ items: [trigger], total: 1 }));
  await stale;
  assert.equal(s.getState().entities.pulse.name, "Updated");
  await s.getState().load("/agents/a/triggers");
  const same = s.getState().entities.pulse;
  await s.getState().load("/agents/a/triggers");
  assert.equal(s.getState().entities.pulse, same);
  assert.equal(original?.name, "Pulse");
});
async function setup(t: TestContext) {
  const store = createTriggerStore(),
    agents = createAgentStore();
  let dirty = false;
  const calls: { method: string; url: string; body: any }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET",
        body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, method, body });
      if (url === "/api/triggers/preview")
        return Response.json({ times: ["2027-01-01T09:00:00.000Z"] });
      if (url === "/api/triggers/pulse") return Response.json(trigger);
      if (url.includes("/agents/a/triggers"))
        return Response.json({ items: [trigger], total: 1 });
      return Response.json({ items: [], total: 0 });
    },
  );
  const p = await mountComponent(
    t,
    h(
      AgentContext.Provider,
      { value: agents },
      h(
        TriggerContext.Provider,
        { value: store },
        h(
          UnsavedContext.Provider,
          {
            value: {
              setDirty(v: boolean) {
                dirty = v;
              },
              attempt(fn: () => void) {
                fn();
                return true;
              },
            },
          },
          h(TriggersView, { agentId: "a", workspaceId: "w" }),
        ),
      ),
    ),
  );
  const button = (name: string) =>
    [...p.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === name,
    )!;
  return { ...p, store, agents, calls, button, dirty: () => dirty };
}
test("trigger editor preserves dirty instructions through remote updates and exposes a revision conflict", async (t) => {
  const p = await setup(t);
  await p.click(
    p.document.querySelector<HTMLButtonElement>("button.identity")!,
  );
  const textarea = p.document.querySelector("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      p.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, "Unsaved instructions");
    textarea.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  });
  assert.equal(p.dirty(), true);
  await act(async () =>
    p.store
      .getState()
      .put({ ...trigger, revision: 2, instructions: "Remote update" }),
  );
  assert.equal(textarea.value, "Unsaved instructions");
  assert.match(p.document.body.textContent!, /changed elsewhere/);
  assert.equal(p.button("Save").disabled, true);
  await p.click(p.button("Reload saved version"));
  assert.equal(
    (p.document.querySelector("textarea") as HTMLTextAreaElement).value,
    "Remote update",
  );
  assert.equal(p.dirty(), false);
});
test("creating a trigger is explicit and preview performs no trigger mutation", async (t) => {
  const p = await setup(t);
  await p.click(p.button("New trigger"));
  assert.equal(p.button("Save and enable").type, "submit");
  await p.click(p.button("Preview next occurrences"));
  assert.equal(
    p.calls.filter(
      (c) => c.method === "POST" && c.url === "/api/agents/a/triggers",
    ).length,
    0,
  );
  assert.equal(
    p.calls.filter((c) => c.url === "/api/triggers/preview").length,
    1,
  );
});

test("trigger page caches stay bounded without evicting an open editor", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    Response.json({ items: [{ ...trigger, id: url }], total: 1 }),
  );
  const s = createTriggerStore();
  await s.getState().load("/initial");
  const release = s.getState().retain("/api/initial");
  for (let n = 0; n < 30; n++) await s.getState().load(`/page-${n}`);
  assert.ok(Object.keys(s.getState().pages).length <= 20);
  assert.ok(s.getState().entities["/api/initial"]);
  release();
  await s.getState().load("/final");
  assert.equal(s.getState().entities["/api/initial"], undefined);
});

test("overlapping agent and workspace reads cannot regress a trigger entity", async (t) => {
  const older = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url.includes("agents")
      ? older.promise
      : Response.json({
          items: [{ ...trigger, revision: 2, name: "Current" }],
          total: 1,
        }),
  );
  const store = createTriggerStore();
  const pending = store.getState().load("/agents/a/triggers");
  await store.getState().load("/workspaces/w/triggers");
  older.resolve(Response.json({ items: [trigger], total: 1 }));
  await pending;
  assert.equal(store.getState().entities.pulse.name, "Current");
  assert.equal(store.getState().entities.pulse.revision, 2);
});

test("skill template setup preserves its timezone and sends edited settings with the reviewed fingerprint", async (t) => {
  const agents = createAgentStore();
  let submitted: any;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        submitted = JSON.parse(String(init.body));
        return Response.json(trigger);
      }
      return Response.json({
        fingerprint: "reviewed-package",
        templates: [
          {
            id: "daily",
            name: "Daily report",
            description: "Scheduled report",
            instructions: "Original instructions",
            when: {
              kind: "cron",
              expression: "0 9 * * *",
              timezone: "Asia/Tokyo",
            },
            requiredSkills: [],
          },
        ],
        instances: [],
        setups: [],
        compatibility: "Native triggers",
        error: null,
      });
    },
  );
  let dirty = false;
  const p = await mountComponent(
    t,
    h(
      AgentContext.Provider,
      { value: agents },
      h(
        UnsavedContext.Provider,
        {
          value: {
            setDirty(v: boolean) {
              dirty = v;
            },
            attempt(fn: () => void) {
              fn();
              return true;
            },
          },
        },
        h(SkillAutomationsPanel, { agentId: "a", skillId: "skill" }),
      ),
    ),
  );
  const button = (text: string) =>
    [...p.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === text,
    )!;
  await p.click(button("Set up trigger"));
  const dialog = p.document.querySelector("dialog")!;
  const inputs = [...dialog.querySelectorAll<HTMLInputElement>("input")];
  assert.ok(inputs.some((i) => i.value === "Asia/Tokyo"));
  assert.equal(dirty, true);
  const textarea = dialog.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      p.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "Customized instructions");
    textarea.dispatchEvent(new p.window.Event("input", { bubbles: true }));
  });
  await p.click(
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      /Create/.test(b.textContent!),
    )!,
  );
  assert.equal(submitted.fingerprint, "reviewed-package");
  assert.equal(submitted.overrides.instructions, "Customized instructions");
  assert.equal(submitted.overrides.when.timezone, "Asia/Tokyo");
  assert.equal(submitted.overrides.enabled, false);
  assert.equal(dirty, false);
});

test("stale template setup preserves edits and refreshes the package for an explicit reopened review", async (t) => {
  let fingerprint = "before",
    posted: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)).fingerprint);
        if (posted.length === 1) {
          fingerprint = "after";
          return Response.json(
            { error: "Skill changed during setup. Inspect again." },
            { status: 409 },
          );
        }
        return Response.json(trigger);
      }
      return Response.json({
        fingerprint,
        templates: [
          {
            id: "daily",
            name: "Daily",
            description: "Daily",
            instructions: "Saved task instructions",
            when: {
              kind: "cron",
              expression: "0 9 * * *",
              timezone: "Europe/London",
            },
          },
        ],
        instances: [],
        setups: [],
        compatibility: "Native",
        error: null,
      });
    },
  );
  const p = await mountComponent(
    t,
    h(
      AgentContext.Provider,
      { value: createAgentStore() },
      h(
        UnsavedContext.Provider,
        {
          value: {
            setDirty() {},
            attempt(fn: () => void) {
              fn();
              return true;
            },
          },
        },
        h(SkillAutomationsPanel, { agentId: "a", skillId: "skill" }),
      ),
    ),
  );
  const button = (text: string) =>
    [...p.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === text,
    )!;
  await p.click(button("Set up trigger"));
  const textarea = p.document.querySelector("dialog textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      p.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "Preserve my unsaved setup");
    textarea.dispatchEvent(new p.window.Event("input", { bubbles: true }));
  });
  await p.click(button("Create disabled trigger"));
  assert.equal(
    (textarea as HTMLTextAreaElement).value,
    "Preserve my unsaved setup",
  );
  assert.match(
    p.document.querySelector("dialog")!.textContent!,
    /changed during setup/,
  );
  await p.click(button("Cancel"));
  await p.click(button("Set up trigger"));
  await p.click(button("Create disabled trigger"));
  assert.deepEqual(posted, ["before", "after"]);
});
