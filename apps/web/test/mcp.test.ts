import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, StrictMode } from "react";
import { mountComponent } from "./component-helpers";
import { AgentContext, createAgentStore } from "../src/agent-store";
import { UnsavedContext } from "../src/navigation-guard";
import { createMcpStore } from "../src/mcp-store";
import type { McpServerDetail } from "../../server/src/mcp-types";
const { AgentMcp, mcpDraftInput } = await import("../src/components/AgentMcp");
const detail: McpServerDetail = {
  id: "server",
  name: "Example",
  transport: "http",
  revision: 1,
  enabled: true,
  status: "not_connected",
  error: null,
  authenticated: false,
  createdAt: "now",
  updatedAt: "now",
  command: "",
  args: [],
  cwd: "",
  url: "https://example.org/mcp",
  authentication: "headers",
  envKeys: [],
  headerKeys: ["authorization"],
  oauthClientId: "",
  hasOAuthClientSecret: false,
  enabledAgents: [{ id: "a", name: "Ava", workspaceId: "workspace" }],
};
test("MCP store rejects obsolete reads, preserves unchanged references and keeps enablement scoped", async (t) => {
  let resolveOld!: (r: Response) => void,
    calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls++;
    if (calls === 1)
      return new Promise<Response>((r) => {
        resolveOld = r;
      });
    return Response.json({
      items: [{ ...detail, enabled: url.includes("agentId=b") ? false : true }],
      total: 1,
    });
  });
  const a = createMcpStore("a"),
    b = createMcpStore("b");
  const old = a.getState().load("");
  a.getState().invalidate();
  await a.getState().load("");
  resolveOld(
    Response.json({
      items: [{ ...detail, name: "Stale", enabled: false }],
      total: 1,
    }),
  );
  await old;
  assert.equal(a.getState().items[0]?.name, "Example");
  const same = a.getState().items[0];
  await a.getState().load("");
  assert.equal(a.getState().items[0], same);
  await b.getState().load("");
  assert.equal(b.getState().items[0]?.enabled, false);
  assert.equal(a.getState().items[0]?.enabled, true);
  a.getState().dispose();
  b.getState().dispose();
});

test("MCP panel lists servers, toggles independently, browses capabilities and guards dirty forms", async (t) => {
  let current = { ...detail },
    allowed = true,
    dirty = false;
  const writes: { url: string; body: any }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (init?.method && init.method !== "GET") writes.push({ url, body });
      if (url.startsWith("/api/agents/") && init?.method === "PUT") {
        current = { ...current, enabled: body.enabled };
        return Response.json(current);
      }
      if (url.includes("/capabilities?"))
        return Response.json({
          items: [
            {
              name: "echo",
              description: "Read the schema",
              inputSchema: { type: "object" },
            },
          ],
        });
      if (url.startsWith("/api/mcp/servers?"))
        return Response.json({ items: [current], total: 1 });
      if (init?.method === "PATCH")
        return Response.json(
          {
            error:
              "MCP server changed. Reload the saved configuration before saving.",
          },
          { status: 409 },
        );
      return Response.json(current);
    },
  );
  const agents = createAgentStore();
  const p = await mountComponent(
    t,
    h(
      StrictMode,
      null,
      h(
        AgentContext.Provider,
        { value: agents },
        h(
          UnsavedContext.Provider,
          {
            value: {
              setDirty(v) {
                dirty = v;
              },
              attempt(action) {
                if (allowed) action();
                return allowed;
              },
            },
          },
          h(AgentMcp, { agentId: "a" }),
        ),
      ),
    ),
  );
  const button = (label: string) =>
    [...p.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === label,
    )!;
  const switchInput = p.document.querySelector<HTMLInputElement>(
    "input[role='switch']",
  )!;
  assert.equal(switchInput.checked, true);
  await p.click(switchInput);
  assert.equal(current.enabled, false);
  assert.equal(writes[0]?.url, "/api/agents/a/mcp/servers/server");
  await p.click(p.document.querySelector("[data-mcp-id='server']")!);
  assert.ok(
    p.document.querySelector("section[aria-label='MCP server details']"),
  );
  assert.ok(p.document.body.textContent?.includes("authorization"));
  assert.equal(p.document.querySelector("input[name='mcpClientSecret']"), null);
  await p.click(p.document.querySelector("input[role='switch']")!);
  await p.click(button("Load"));
  assert.ok(p.document.body.textContent?.includes("Read the schema"));
  assert.ok(p.document.body.textContent?.includes('"inputSchema"'));
  await p.click(button("Edit"));
  const name = p.document.querySelector<HTMLInputElement>(
    "input[name='mcpName']",
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      p.window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(name, "Edited draft");
    name.dispatchEvent(new p.window.Event("input", { bubbles: true }));
  });
  assert.equal(dirty, true);
  allowed = false;
  await p.click(button("All servers"));
  assert.ok(
    p.document.querySelector("section[aria-label='MCP server details']"),
  );
  current = { ...current, name: "Other session", revision: 2 };
  await act(async () => agents.setState({ eventVersion: 2 }));
  assert.equal(name.value, "Edited draft");
  await p.click(button("Save Server"));
  assert.equal(writes.at(-1)?.body.expectedRevision, 1);
  assert.ok(
    p.document
      .querySelector("[role='alert']")
      ?.textContent?.includes("changed"),
  );
  assert.equal(name.value, "Edited draft");
  allowed = true;
  await p.click(button("Reload saved"));
  assert.equal(
    p.document.querySelector<HTMLInputElement>("input[name='mcpName']")!.value,
    "Other session",
  );
  await p.click(button("Cancel"));
  current = {
    ...current,
    enabledAgents: [{ id: "b", name: "Ben", workspaceId: "other" }],
  };
  await p.click(button("Remove Shared Server"));
  assert.ok(
    p.document.querySelector("dialog[open]")?.textContent?.includes("Ben"),
  );
  assert.equal(p.document.activeElement?.textContent, "Cancel");
  await p.click(button("Cancel"));
  assert.equal(
    writes.some((w) => w.body?.confirmed),
    false,
  );
  await p.click(button("All servers"));
  await p.click(button("Add Server"));
  await act(async () => {
    for (const [selector, value] of [
      ["input[name='mcpName']", "New"],
      ["input[name='mcpCommand']", "node"],
    ]) {
      const target = p.document.querySelector<HTMLInputElement>(selector!)!;
      Object.getOwnPropertyDescriptor(
        p.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(target, value);
      target.dispatchEvent(new p.window.Event("input", { bubbles: true }));
    }
    const target = p.document.querySelector<HTMLTextAreaElement>(
      "textarea[name='mcpArguments']",
    )!;
    Object.getOwnPropertyDescriptor(
      p.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(target, "{");
    target.dispatchEvent(new p.window.Event("input", { bubbles: true }));
  });
  await p.click(button("Save Server"));
  const invalid = p.document.querySelector("textarea[name='mcpArguments']")!;
  assert.equal(invalid.getAttribute("aria-invalid"), "true");
  assert.equal(p.document.activeElement, invalid);
  assert.ok(
    p.document
      .getElementById(invalid.getAttribute("aria-describedby")!)
      ?.textContent?.includes("JSON array"),
  );
});

test("MCP forms preserve omitted secrets and explicitly remove null values", () => {
  const draft = {
    name: "Local",
    transport: "stdio" as const,
    command: "node",
    args: '["server.js"]',
    cwd: "",
    url: "",
    authentication: "none" as const,
    env: "",
    headers: "",
    oauthClientId: "",
    oauthClientSecret: "",
    removeClientSecret: false,
  };
  assert.equal(mcpDraftInput(draft).env, undefined);
  assert.equal(
    mcpDraftInput({
      ...draft,
      transport: "http",
      url: "https://example.org/mcp",
      args: "{",
      env: "{",
      headers: "{",
    }).url,
    "https://example.org/mcp",
  );
  assert.deepEqual(
    mcpDraftInput({ ...draft, env: '{"OLD":null,"TOKEN":"new"}' }).env,
    { OLD: null, TOKEN: "new" },
  );
  assert.throws(() => mcpDraftInput({ ...draft, args: "{}" }), /array/);
  assert.throws(
    () => mcpDraftInput({ ...draft, env: '{"TOKEN":42}' }),
    /strings/,
  );
});

test("OAuth feedback retains actionable errors, reuses sign-in links and hides completed links", async (t) => {
  let current: McpServerDetail = {
    ...detail,
    authentication: "oauth",
    headerKeys: [],
    status: "auth_required",
    error:
      "This server requires a registered OAuth client. Save its client ID in MCP settings.",
    authErrorCode: "client_registration_required",
    authPending: false,
  };
  const authorizationUrl = "https://example.org/authorize?state=fixture";
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth/sign-in") && init?.method === "POST") {
        current = {
          ...current,
          error: null,
          authErrorCode: undefined,
          authPending: true,
        };
        return Response.json({
          status: "auth_required",
          authenticated: false,
          authorizationUrl,
        });
      }
      return Response.json(
        url.includes("/servers?") ? { items: [current], total: 1 } : current,
      );
    },
  );
  const agents = createAgentStore();
  const p = await mountComponent(
    t,
    h(
      AgentContext.Provider,
      { value: agents },
      h(
        UnsavedContext.Provider,
        {
          value: {
            setDirty() {},
            attempt(action) {
              action();
              return true;
            },
          },
        },
        h(AgentMcp, { agentId: "a" }),
      ),
    ),
  );
  await p.click(p.document.querySelector("[data-mcp-id='server']")!);
  assert.match(
    p.document.querySelector("[role='alert']")?.textContent ?? "",
    /registered OAuth client/,
  );
  const button = [
    ...p.document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((b) => b.textContent === "Sign In")!;
  await p.click(button);
  const link = p.document.querySelector<HTMLAnchorElement>(
    "a[href^='https://example.org/authorize']",
  )!;
  assert.equal(link.textContent, "Continue MCP Sign-In");
  assert.equal(link.rel, "noopener noreferrer");
  assert.match(p.document.body.textContent ?? "", /connects automatically/);
  assert.match(p.document.body.textContent ?? "", /Waiting for sign-in/);
  current = {
    ...current,
    authenticated: true,
    status: "connected",
    authPending: false,
  };
  await act(async () => agents.setState({ eventVersion: 3 }));
  assert.equal(
    p.document.querySelector("a[href^='https://example.org/authorize']"),
    null,
  );
  assert.ok(p.document.body.textContent?.includes("OAuth signed in"));
});
