import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h } from "react";
import { mountComponent } from "./component-helpers";
import {
  createSkillsStore,
  SkillsContext,
  defaultSkillFilters,
  skillPageKey,
} from "../src/skills-store";
import { AgentContext, createAgentStore } from "../src/agent-store";
import { UnsavedContext } from "../src/navigation-guard";
import type { SkillDetail, SkillSummary } from "../../server/src/skill-types";
const { AgentSkills } = await import("../src/components/AgentSkills");
const skill: SkillSummary = {
  id: "one",
  name: "example-skill",
  description: "Example reusable instructions.",
  builtIn: false,
  revision: 1,
  source: { kind: "editor" },
  enabled: true,
  error: null,
  createdAt: "now",
  updatedAt: "now",
};
const detail: SkillDetail = {
  ...skill,
  instructions: "Read the instructions.",
  path: "/example/skills/one",
  files: [{ path: "SKILL.md", size: 100 }],
  enabledAgents: [{ id: "a", name: "A", workspaceId: "w" }],
};
const page = (enabled = true) => ({
  items: [{ ...skill, enabled }],
  total: 1,
  path: "/example/skills",
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("skill caches separate shared records from independent enabled state and ignore stale reads", async (t) => {
  const pending = deferred<Response>();
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT")
        return Response.json({ ...skill, enabled: false });
      if (url.includes("/agents/b/")) return Response.json(page(false));
      if (calls++ === 0) return Response.json(page());
      if (calls === 2) return pending.promise;
      return Response.json(page(false));
    },
  );
  const store = createSkillsStore();
  await store.getState().load("a", defaultSkillFilters);
  const original = store.getState().library.one;
  await store.getState().load("b", defaultSkillFilters);
  assert.equal(store.getState().library.one, original);
  assert.equal(store.getState().enabled.a!.one, true);
  assert.equal(store.getState().enabled.b!.one, false);
  const stale = store.getState().load("a", defaultSkillFilters);
  await store.getState().toggle("a", "one", false);
  pending.resolve(Response.json(page(true)));
  await stale;
  assert.equal(store.getState().enabled.a!.one, false);
  await store.getState().load("a", defaultSkillFilters);
  assert.deepEqual(
    store.getState().pages[skillPageKey("a", defaultSkillFilters)]!.ids,
    ["one"],
  );
});

test("later skill searches cannot replace the active filtered page and pagination deduplicates IDs", async (t) => {
  const pending = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url.includes("query=old") ? pending.promise : Response.json(page()),
  );
  const store = createSkillsStore(),
    old = { ...defaultSkillFilters, query: "old" };
  const request = store.getState().load("a", old);
  await store.getState().load("a", defaultSkillFilters);
  pending.resolve(
    Response.json({ items: [], total: 0, path: "/example/skills" }),
  );
  await request;
  await store.getState().load("a", defaultSkillFilters, true);
  assert.deepEqual(
    store.getState().pages[skillPageKey("a", defaultSkillFilters)]!.ids,
    ["one"],
  );
});

async function setup(t: TestContext) {
  let enabled = true,
    revision = 1,
    dirty = false;
  const writes: unknown[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      if (url === "/api/skills/refresh")
        return Response.json({ refreshed: true });
      if (init?.method === "PUT") {
        enabled = JSON.parse(init.body as string).enabled;
        return Response.json({ ...skill, enabled });
      }
      if (init?.method === "PATCH") {
        writes.push(JSON.parse(init.body as string));
        return Response.json(
          { error: "This skill changed. Reload saved details." },
          { status: 409 },
        );
      }
      if (url.startsWith("/api/skills/one"))
        return Response.json({
          ...detail,
          enabled,
          revision,
          instructions:
            revision === 1 ? detail.instructions : "External change.",
        });
      if (url.includes("/agents/a/skills"))
        return Response.json({
          items: [{ ...skill, enabled, revision }],
          total: 1,
          path: "/example/skills",
        });
      throw new Error(`Unexpected request ${url}`);
    },
  );
  const store = createSkillsStore(),
    agents = createAgentStore();
  const p = await mountComponent(
    t,
    h(
      AgentContext.Provider,
      { value: agents },
      h(
        SkillsContext.Provider,
        { value: store },
        h(
          UnsavedContext.Provider,
          {
            value: {
              setDirty(value: boolean) {
                dirty = value;
              },
              attempt(action: () => void) {
                action();
                return true;
              },
            },
          },
          h(AgentSkills, { agentId: "a" }),
        ),
      ),
    ),
  );
  const button = (name: string) =>
    [...p.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === name,
    )!;
  return {
    ...p,
    store,
    agents,
    button,
    writes,
    dirty: () => dirty,
    external: () => {
      revision++;
    },
  };
}

test("skill switches do not open details, and a row opens a focused view with Back", async (t) => {
  const p = await setup(t);
  const toggle = p.document.querySelector<HTMLInputElement>(
    "input[role='switch']",
  )!;
  assert.ok(toggle);
  await p.click(toggle);
  assert.equal(p.document.querySelector("h3"), null);
  assert.equal(p.store.getState().enabled.a!.one, false);
  await p.click(p.document.querySelector("li button")!);
  assert.equal(p.document.querySelector("h3")?.textContent, "example-skill");
  assert.ok(p.document.body.textContent?.includes("Read the instructions."));
  await p.click(p.button("All skills"));
  assert.ok(p.document.querySelector("input[type=search]"));
});

test("editing preserves a draft and its original revision through SSE refresh, then reports conflicts", async (t) => {
  const p = await setup(t);
  await p.click(p.document.querySelector("li button")!);
  await p.click(p.button("Edit"));
  const textarea =
    p.document.querySelectorAll<HTMLTextAreaElement>("textarea")[1]!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      p.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, "Unsaved draft.");
    textarea.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  });
  p.external();
  await act(async () =>
    p.agents.setState((state) => ({ eventVersion: state.eventVersion + 1 })),
  );
  assert.equal(textarea.value, "Unsaved draft.");
  await act(async () =>
    p.document
      .querySelector("form")!
      .dispatchEvent(
        new p.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(
    (p.writes[0] as { expectedRevision: number }).expectedRevision,
    1,
  );
  assert.match(
    p.document.querySelector("[role=alert]")!.textContent!,
    /changed/,
  );
  assert.equal(textarea.value, "Unsaved draft.");
});

test("refresh retains the loaded pagination range for Back navigation", async (t) => {
  const rows = Array.from({ length: 75 }, (_, index) => ({
    ...skill,
    id: `skill-${index}`,
    name: `skill-${index}`,
  }));
  t.mock.method(globalThis, "fetch", async (path: string) => {
    const url = new URL(path, "http://localhost");
    const offset = Number(url.searchParams.get("offset")),
      limit = Number(url.searchParams.get("limit"));
    return Response.json({
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      path: "/example/skills",
    });
  });
  const store = createSkillsStore();
  await store.getState().load("a", defaultSkillFilters);
  await store.getState().load("a", defaultSkillFilters, true);
  const key = skillPageKey("a", defaultSkillFilters);
  assert.equal(store.getState().pages[key]!.ids.length, 75);
  await store.getState().load("a", defaultSkillFilters);
  assert.equal(store.getState().pages[key]!.ids.length, 75);
});
