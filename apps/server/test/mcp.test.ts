import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { ManagedFiles } from "../src/managed-files.js";
import { AgentTools, taskTools } from "../src/agent-tools.js";
import { AgentExecution } from "../src/agent-execution.js";
import { ConnectionService } from "../src/connection-service.js";
import { ProcessService, type ToolOwner } from "../src/process-service.js";
import { ArtifactService } from "../src/artifact-service.js";
import { ConnectionSecrets } from "../src/connection-secrets.js";
import { McpService } from "../src/mcp-service.js";
import { mcpClient } from "../src/mcp-client.js";
import { mcpAuthError } from "../src/mcp-auth-errors.js";
import { taskTimeline } from "../src/task-timeline.js";
import { OAuthError } from "@modelcontextprotocol/client";
import type { McpServerInput } from "../src/mcp-types.js";
const script = fileURLToPath(
  new URL("fixtures/mcp-server.cjs", import.meta.url),
);
const local: McpServerInput = {
  name: "Fixture",
  transport: "stdio",
  command: process.execPath,
  args: [script],
  env: { MCP_VALUE: "encrypted-value" },
};
const callback = "http://127.0.0.1:3000/api/mcp/oauth/callback";
async function fixture(
  t: TestContext,
  options: ConstructorParameters<typeof McpService>[5] = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ufai-mcp-test-")),
    db = openDatabase(join(root, "db.sqlite"));
  const workspaceId = (
      db.prepare("SELECT id FROM workspaces").get() as { id: string }
    ).id,
    stamp = new Date().toISOString();
  db.prepare(
    "INSERT INTO connections(id,provider,name,createdAt,updatedAt,draft) VALUES('connection','openai-compatible','Local',?,?,0)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES('connection','model','Model',1,128000)",
  ).run();
  db.prepare(
    "INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES('preset','Preset','connection','model',?,?)",
  ).run(stamp, stamp);
  for (const id of ["a", "b"])
    db.prepare(
      "INSERT INTO agents(id,workspaceId,name,instructions,presetId,createdAt,updatedAt) VALUES(?,?,?,'Helpful','preset',?,?)",
    ).run(id, workspaceId, id, stamp, stamp);
  const connections = new ConnectionService(db),
    files = new ManagedFiles(db),
    events: string[] = [];
  const changed = (id: string) => events.push(id),
    processes = new ProcessService(db, files, changed),
    artifacts = new ArtifactService(db, files, changed);
  const tools = new AgentTools(db, files, processes, artifacts, changed),
    mcp = new McpService(
      db,
      files,
      connections.secrets,
      changed,
      artifacts,
      options,
    );
  tools.mcp = mcp;
  tools.mcpRedirectUrl = () => callback;
  files.mcp = mcp;
  const engine = new AgentExecution(
    db,
    connections,
    { autoStart: false },
    files,
    tools,
  );
  files.bind(engine);
  await files.start();
  await artifacts.start();
  tools.ready = true;
  const task = engine.submit("a", "chat", "Use MCP", randomUUID());
  const owner: ToolOwner = {
    agentId: "a",
    workspaceId,
    taskId: task.taskId!,
    turnId: task.turnId,
  };
  await tools.locations(owner);
  t.after(async () => {
    await engine.close();
    await mcp.close();
    await processes.close();
    await artifacts.close();
    await files.close();
    await connections.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const dispatch = (
    name: string,
    args: Record<string, unknown>,
    id = randomUUID(),
    signal = new AbortController().signal,
  ) =>
    tools.dispatch(
      owner,
      { id, name, arguments: args },
      signal,
      async () => {},
    );
  return {
    root,
    db,
    mcp,
    files,
    tools,
    engine,
    connections,
    artifacts,
    events,
    owner,
    dispatch,
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Fixture did not settle");
}

test("journaled management installs, inspects, enables and updates shared configuration with safe removal", async (t) => {
  const f = await fixture(t);
  const { env: _env, ...config } = local;
  const callId = randomUUID();
  const installed = await f.dispatch(
    "mcp_server_install",
    { server: config },
    callId,
  );
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const s = installed.server as any;
  assert.equal(s.enabled, true);
  assert.equal(
    taskTimeline(f.db, f.engine, f.owner.taskId).items.find(
      (i) => i.name === "mcp_server_install",
    )?.contextName,
    local.name,
  );
  assert.equal(f.mcp.detail(s.id, "b").enabled, false);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM owned_processes").get()!.n,
    0,
  );
  assert.deepEqual(
    await f.dispatch("mcp_server_install", { server: config }, callId),
    JSON.parse(JSON.stringify(installed)),
  );
  assert.equal(f.mcp.list().total, 1);
  assert.equal(
    (await f.dispatch("mcp_server_install", { server: config })).ok,
    false,
  );
  await f.dispatch("mcp_server_set_enabled", {
    serverId: s.id,
    enabled: false,
  });
  assert.equal((await f.dispatch("mcp_servers_list", {})).total, 0);
  assert.equal(
    (await f.dispatch("mcp_servers_list", { includeDisabled: true })).total,
    1,
  );
  const inspected = await f.dispatch("mcp_server_inspect", { serverId: s.id });
  assert.equal((inspected.server as any).enabled, false);
  assert.equal(
    (await f.dispatch("mcp_server_connect", { serverId: s.id })).ok,
    false,
  );
  await f.dispatch("mcp_server_set_enabled", { serverId: s.id, enabled: true });
  const connected = await f.dispatch("mcp_server_connect", { serverId: s.id });
  assert.equal((connected.server as any).status, "connected");
  await f.mcp.setEnabled("b", s.id, true);
  const updated = await f.dispatch("mcp_server_update", {
    serverId: s.id,
    expectedRevision: 1,
    server: { ...config, name: "Renamed" },
  });
  assert.equal((updated.server as any).revision, 2);
  assert.equal(f.mcp.detail(s.id, "b").enabled, true);
  assert.equal(
    (
      await f.dispatch("mcp_server_update", {
        serverId: s.id,
        expectedRevision: 1,
        server: config,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await f.dispatch("mcp_server_remove", {
        serverId: s.id,
        expectedRevision: 2,
        confirmed: true,
        affectedAgentIds: ["a"],
      })
    ).ok,
    false,
  );
  const removed = await f.dispatch("mcp_server_remove", {
    serverId: s.id,
    expectedRevision: 2,
    confirmed: true,
    affectedAgentIds: ["b", "a"],
  });
  assert.equal(removed.removed, true);
  assert.equal(f.mcp.list().total, 0);
});

test("management inspection and updates preserve saved secrets without exposing values", async (t) => {
  const f = await fixture(t),
    s = await f.mcp.create("a", local);
  const inspected = await f.dispatch("mcp_server_inspect", { serverId: s.id });
  assert.ok(!JSON.stringify(inspected).includes("encrypted-value"));
  assert.deepEqual((inspected.server as any).envKeys, ["MCP_VALUE"]);
  const updated = await f.dispatch("mcp_server_update", {
    serverId: s.id,
    expectedRevision: 1,
    server: {
      name: "Renamed",
      transport: "stdio",
      command: local.command,
      args: local.args,
    },
  });
  assert.equal(updated.ok, true);
  assert.deepEqual((updated.server as any).envKeys, ["MCP_VALUE"]);
  assert.equal(
    (
      await f.dispatch("mcp_server_install", {
        server: { ...local, name: "No secret inputs" },
      })
    ).ok,
    false,
  );
});

test("OAuth failures expose only safe actionable categories", () => {
  for (const [code, expected] of [
    ["invalid_client", "invalid_client"],
    ["unauthorized_client", "invalid_client"],
    ["invalid_scope", "invalid_scope"],
    ["invalid_grant", "sign_in_expired"],
    ["access_denied", "sign_in_denied"],
  ]) {
    const error = mcpAuthError(
      new OAuthError(code!, "private-token-and-upstream-body"),
    );
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes("private-token"));
  }
  assert.equal(
    mcpAuthError(new Error("private upstream body")).code,
    "oauth_discovery_failed",
  );
});

test("MCP migration, shared library, agent enablement, encrypted and redacted secrets, revisions", async (t) => {
  const f = await fixture(t),
    server = await f.mcp.create("a", local);
  assert.equal(f.db.pragma("user_version", { simple: true }), 29);
  assert.equal(server.enabled, true);
  assert.equal(f.mcp.list("b").items[0]!.enabled, false);
  assert.deepEqual(server.envKeys, ["MCP_VALUE"]);
  assert.ok(!JSON.stringify(server).includes("encrypted-value"));
  const stored = f.db.prepare("SELECT secrets FROM mcp_servers").get() as {
    secrets: string;
  };
  assert.ok(!stored.secrets.includes("encrypted-value"));
  await assert.rejects(f.mcp.connect(server.id, "b", callback), /Enable/);
  await assert.rejects(
    f.mcp.update(server.id, "a", server.revision + 1, local),
    /changed/,
  );
  const updated = await f.mcp.update(server.id, "a", server.revision, {
    ...local,
    env: { OTHER: "value", MCP_VALUE: null },
  });
  assert.deepEqual(updated.envKeys, ["OTHER"]);
  await f.mcp.setEnabled("b", server.id, true);
  assert.equal(f.mcp.detail(server.id).enabledAgents.length, 2);
  await assert.rejects(f.mcp.remove(server.id, server.revision), /changed/);
  assert.ok(f.events.length);
  await assert.rejects(
    f.mcp.create("a", {
      name: "Bad header",
      transport: "http",
      url: "https://example.org/mcp",
      authentication: "headers",
      headers: { __PROTO__: "value" },
    }),
    /Invalid/,
  );
  const bounded = await f.mcp.create("a", {
    ...local,
    name: "Bounded",
    env: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`KEY_${i}`, ""]),
    ),
  });
  await assert.rejects(
    f.mcp.update(bounded.id, "a", bounded.revision, {
      ...local,
      name: "Bounded",
      env: { EXTRA: "value" },
    }),
    /at most 100 saved/,
  );
});

test("stdio tools, resources, templates, prompts, schemas, pagination, journal replay and failure results", async (t) => {
  const f = await fixture(t),
    server = await f.mcp.create("a", local),
    serverId = server.id;
  assert.deepEqual(
    taskTools.filter((x) => x.name.startsWith("mcp_")).map((x) => x.name),
    [
      "mcp_servers_list",
      "mcp_server_inspect",
      "mcp_server_install",
      "mcp_server_update",
      "mcp_server_set_enabled",
      "mcp_server_remove",
      "mcp_server_connect",
      "mcp_server_disconnect",
      "mcp_authenticate",
      "mcp_sign_out",
      "mcp_tools_list",
      "mcp_tool_call",
      "mcp_resources_list",
      "mcp_resource_read",
      "mcp_prompts_list",
      "mcp_prompt_get",
    ],
  );
  assert.equal((await f.dispatch("mcp_servers_list", {})).total, 1);
  const tools = await f.dispatch("mcp_tools_list", { serverId, limit: 2 });
  assert.equal(tools.ok, true, JSON.stringify(tools));
  assert.equal((tools.mcp as any).items.length, 2);
  assert.ok((tools.mcp as any).nextCursor);
  const more = await f.dispatch("mcp_tools_list", {
    serverId,
    limit: 2,
    cursor: (tools.mcp as any).nextCursor,
  });
  assert.equal((more.mcp as any).items[0].name, "large");
  const callId = randomUUID(),
    call = await f.dispatch(
      "mcp_tool_call",
      { serverId, name: "count" },
      callId,
    );
  assert.equal((call.mcp as any).structuredContent.count, 1);
  assert.deepEqual(
    await f.dispatch("mcp_tool_call", { serverId, name: "count" }, callId),
    call,
  );
  assert.equal(
    (
      (await f.dispatch("mcp_tool_call", { serverId, name: "count" }))
        .mcp as any
    ).structuredContent.count,
    2,
  );
  assert.equal(
    (await f.dispatch("mcp_tool_call", { serverId, name: "failure" })).ok,
    false,
  );
  assert.equal(
    (await f.dispatch("mcp_tool_call", { serverId, name: "broken" })).ok,
    false,
  );
  assert.equal(
    ((await f.dispatch("mcp_resources_list", { serverId })).mcp as any).items[0]
      .uri,
    "fixture://text",
  );
  assert.equal(
    (
      (await f.dispatch("mcp_resources_list", { serverId, templates: true }))
        .mcp as any
    ).items[0].uriTemplate,
    "fixture://text/{id}",
  );
  assert.equal(
    (
      (
        await f.dispatch("mcp_resource_read", {
          serverId,
          uri: "fixture://text",
        })
      ).mcp as any
    ).contents[0].text,
    "Resource content",
  );
  assert.equal(
    ((await f.dispatch("mcp_prompts_list", { serverId })).mcp as any).items[0]
      .arguments[0].required,
    true,
  );
  assert.equal(
    (
      (
        await f.dispatch("mcp_prompt_get", {
          serverId,
          name: "greeting",
          arguments: { name: "Ava" },
        })
      ).mcp as any
    ).messages[0].content.text,
    "Hello Ava",
  );
  const timeline = f.db
    .prepare(
      "SELECT content FROM execution_items WHERE kind='tool_result' AND json_extract(content,'$.name')='mcp_tool_call'",
    )
    .all();
  assert.ok(timeline.length >= 4);
});

test("MCP binary and oversized results use immutable artifacts and supported native media", async (t) => {
  const f = await fixture(t),
    s = await f.mcp.create("a", local);
  f.mcp.mediaCapabilities = () => ({
    image: "supported",
    pdf: "unsupported",
    limits: {},
  });
  const image = await f.dispatch("mcp_resource_read", {
    serverId: s.id,
    uri: "fixture://image",
  });
  assert.equal(image.ok, true, JSON.stringify(image));
  assert.equal(image.media?.[0]?.mediaType, "image/png");
  assert.equal(
    (image.artifacts as any)[0].versionId,
    image.media?.[0]?.versionId,
  );
  const large = await f.dispatch("mcp_tool_call", {
    serverId: s.id,
    name: "large",
  });
  assert.equal(large.ok, true, JSON.stringify(large));
  assert.ok((large.artifacts as any)[0].versionId);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 65536);
});

test("stdio sessions isolate agents, default cwd, curated environment and idle cleanup", async (t) => {
  const f = await fixture(t, { idleMs: 40 });
  const prior = process.env.UFAI_MCP_UNRELATED_SECRET;
  process.env.UFAI_MCP_UNRELATED_SECRET = "never-inherit";
  t.after(() => {
    if (prior === undefined) delete process.env.UFAI_MCP_UNRELATED_SECRET;
    else process.env.UFAI_MCP_UNRELATED_SECRET = prior;
  });
  const s = await f.mcp.create("a", local);
  const result = await f.dispatch("mcp_tool_call", {
    serverId: s.id,
    name: "environment",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const env = JSON.parse((result.mcp as any).content[0].text);
  assert.equal(env.cwd, f.files.location("agent", "a").path);
  assert.equal(env.value, "encrypted-value");
  assert.equal(env.inheritedSecret, undefined);
  await f.mcp.setEnabled("b", s.id, true);
  await f.files.repair("agent", "b");
  const b = await f.mcp.execute(
    { ...f.owner, agentId: "b" },
    "mcp_tool_call",
    { serverId: s.id, name: "count" },
    new AbortController().signal,
    callback,
  );
  assert.equal((b.mcp as any).structuredContent.count, 1);
  await until(() => f.mcp.detail(s.id, "a").status === "not_connected");
  await until(() => {
    try {
      process.kill(env.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("disable, edits, agent cleanup and caller cancellation interrupt requests without replay", async (t) => {
  const f = await fixture(t),
    s = await f.mcp.create("a", local),
    args = { serverId: s.id, name: "slow" };
  await f.mcp.connect(s.id, "a", callback);
  const id = randomUUID(),
    running = f.dispatch("mcp_tool_call", args, id);
  await delay(20);
  await f.mcp.setEnabled("a", s.id, false);
  assert.equal((await running).ok, false);
  assert.equal(
    (await f.dispatch("mcp_tool_call", { serverId: s.id, name: "count" })).ok,
    false,
  );
  await f.mcp.setEnabled("a", s.id, true);
  const controller = new AbortController(),
    otherId = randomUUID();
  const other = f.dispatch("mcp_tool_call", args, otherId, controller.signal);
  const rejected = assert.rejects(other);
  await delay(30);
  controller.abort();
  await rejected;
  assert.equal((await f.dispatch("mcp_tool_call", args, otherId)).ok, false);
  const active = f.dispatch("mcp_tool_call", args);
  await delay(20);
  await f.mcp.update(s.id, "a", s.revision, { ...local, name: "Changed" });
  assert.equal((await active).ok, false);
  const again = f.dispatch("mcp_tool_call", args);
  await delay(20);
  await f.mcp.settleAgents(["a"]);
  assert.equal((await again).ok, false);
});

test("MCP import previews validate safely, preserve secrets, require explicit revisioned replacement", async (t) => {
  const f = await fixture(t),
    s = await f.mcp.create("a", local);
  const marker = join(f.root, "not-launched");
  const preview = f.mcp.preview("a", {
    mcpServers: {
      Fixture: {
        command: process.execPath,
        args: [script],
        env: { MCP_MARKER: marker },
      },
      Invalid: { url: "http://example.org/mcp" },
      Placeholder: { command: "node", env: { TOKEN: "${TOKEN}" } },
    },
  });
  assert.equal(preview.candidates[1]!.error?.includes("HTTPS"), true);
  assert.ok(preview.candidates[2]!.error?.includes("placeholders"));
  await assert.rejects(readFile(marker));
  await assert.rejects(
    f.mcp.commitPreview(preview.id, "b", preview.candidates[0]!.key),
    /another agent/,
  );
  await assert.rejects(
    f.mcp.commitPreview(preview.id, "a", preview.candidates[0]!.key),
    /confirm/,
  );
  const updated = await f.mcp.commitPreview(
    preview.id,
    "a",
    preview.candidates[0]!.key,
    s.id,
    s.revision,
  );
  assert.equal(updated.revision, 2);
  assert.equal(updated.enabled, true);
  await assert.rejects(readFile(marker));
});

test("SDK no-deadline compatibility intercepts only timeout zero", async () => {
  const client = mcpClient(),
    setup = Reflect.get(client, "_setupTimeout");
  Reflect.apply(setup, client, [
    1,
    0,
    undefined,
    () => assert.fail("no deadline"),
  ]);
  const map = Reflect.get(client, "_timeoutInfo") as Map<unknown, unknown>;
  assert.equal(map.size, 0);
  Reflect.apply(setup, client, [2, 1000, undefined, () => {}]);
  assert.equal(map.size, 1);
  Reflect.apply(Reflect.get(client, "_cleanupTimeout"), client, [2]);
  await client.close();
});
async function httpFixture(t: TestContext, oauth = false, registration = true) {
  let validAccess = "first-token",
    refreshes = 0,
    tokenCalls = 0,
    clientRegistrations = 0,
    expectedChallenge = "";
  let headerLeak = false;
  let failInitialize = false;
  let tokenDelay = 0;
  const messages: any[] = [],
    tokenBodies: URLSearchParams[] = [];
  let base = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString(),
      path = req.url?.split("?")[0];
    if (path !== "/mcp" && req.headers["x-fixture-key"]) headerLeak = true;
    function json(status: number, value: unknown) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    }
    if (path?.startsWith("/.well-known/oauth-protected-resource"))
      return json(200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ["tools"],
      });
    if (path === "/.well-known/oauth-authorization-server")
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(registration ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
    if (path === "/register") {
      clientRegistrations++;
      return json(201, { ...JSON.parse(text), client_id: "registered-client" });
    }
    if (path === "/token") {
      tokenCalls++;
      const p = new URLSearchParams(text);
      tokenBodies.push(p);
      if (tokenDelay) await delay(tokenDelay);
      if (p.get("grant_type") === "refresh_token") {
        refreshes++;
        validAccess = `refreshed-${refreshes}`;
      } else {
        const { createHash } = await import("node:crypto");
        if (
          createHash("sha256")
            .update(p.get("code_verifier") ?? "")
            .digest("base64url") !== expectedChallenge
        )
          return json(400, { error: "invalid_grant" });
      }
      return json(200, {
        access_token: validAccess,
        refresh_token: "refresh-private",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "tools",
      });
    }
    if (path !== "/mcp") return json(404, {});
    if (oauth && req.headers.authorization !== `Bearer ${validAccess}`) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      );
      return json(401, { error: "unauthorized" });
    }
    if (req.method === "GET") {
      res.writeHead(405);
      return res.end();
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      return res.end();
    }
    const message = JSON.parse(text);
    messages.push({ ...message, authorization: req.headers.authorization });
    if (message.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    let result: unknown;
    if (message.method === "initialize" && failInitialize)
      return json(503, { error: "fixture unavailable" });
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "HTTP fixture", version: "1" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
            },
          },
        ],
      };
    else if (message.method === "tools/call")
      result = {
        content: [
          {
            type: "text",
            text: message.params.arguments?.value ?? "HTTP works",
          },
        ],
        structuredContent: { echoed: true },
      };
    else if (message.method === "resources/list")
      result = {
        resources: [{ name: "HTTP resource", uri: "http-fixture://resource" }],
      };
    else if (message.method === "resources/read")
      result = {
        contents: [{ uri: message.params.uri, text: "HTTP resource text" }],
      };
    else if (message.method === "resources/templates/list")
      result = {
        resourceTemplates: [
          { name: "HTTP template", uriTemplate: "http-fixture://{id}" },
        ],
      };
    else if (message.method === "prompts/list")
      result = { prompts: [{ name: "HTTP prompt", arguments: [] }] };
    else if (message.method === "prompts/get")
      result = {
        messages: [
          {
            role: "assistant",
            content: { type: "text", text: "External prompt" },
          },
        ],
      };
    else
      return json(200, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unknown method" },
      });
    return json(200, { jsonrpc: "2.0", id: message.id, result });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    base,
    messages,
    tokenBodies,
    delayTokens(ms: number) {
      tokenDelay = ms;
    },
    failConnections(value: boolean) {
      failInitialize = value;
    },
    challenge(v: string) {
      expectedChallenge = v;
    },
    expire() {
      validAccess = "expired-access";
    },
    counts: () => ({ refreshes, tokenCalls, clientRegistrations, headerLeak }),
  };
}

test("Streamable HTTP uses saved headers and supports tools, resources and prompts", async (t) => {
  const h = await httpFixture(t),
    f = await fixture(t);
  const s = await f.mcp.create("a", {
    name: "HTTP",
    transport: "http",
    url: `${h.base}/mcp`,
    authentication: "headers",
    headers: { Authorization: "Bearer header-private" },
  });
  assert.deepEqual(s.headerKeys, ["authorization"]);
  assert.ok(!JSON.stringify(s).includes("header-private"));
  const result = await f.dispatch("mcp_tool_call", {
    serverId: s.id,
    name: "echo",
    arguments: { value: "Hello" },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((result.mcp as any).content[0].text, "Hello");
  assert.ok(
    h.messages.every((m) => m.authorization === "Bearer header-private"),
  );
  for (const kind of ["tools", "resources", "templates", "prompts"] as const)
    assert.equal(
      (await f.mcp.capabilities(s.id, "a", kind, undefined, 25, callback)).items
        .length,
      1,
    );
  assert.equal(
    (
      (
        await f.dispatch("mcp_prompt_get", {
          serverId: s.id,
          name: "HTTP prompt",
        })
      ).mcp as any
    ).messages[0].role,
    "assistant",
  );
  await f.mcp.disconnect(s.id, "a");
  assert.equal(f.mcp.detail(s.id, "a").status, "not_connected");
});

test("chat OAuth reports a missing registration prerequisite, retains its status, then completes with registered credentials", async (t) => {
  const h = await httpFixture(t, true, false),
    f = await fixture(t);
  const config = {
    name: "GitHub-like",
    transport: "http",
    url: `${h.base}/mcp`,
    authentication: "oauth",
  };
  const installed = await f.dispatch("mcp_server_install", { server: config });
  const s = installed.server as any;
  const connection = await f.dispatch("mcp_server_connect", { serverId: s.id });
  assert.equal(connection.code, "client_registration_required");
  const failure = await f.dispatch("mcp_authenticate", { serverId: s.id });
  assert.equal(failure.ok, false);
  assert.equal(failure.code, "client_registration_required");
  assert.match(
    String(failure.error),
    /does not support automatic OAuth client registration/,
  );
  assert.match(String(failure.error), /do not need to switch/);
  const observed = (await f.dispatch("mcp_servers_list", {})).items as any[];
  assert.equal(observed[0].authErrorCode, "client_registration_required");
  assert.equal(observed[0].status, "auth_required");
  assert.equal(f.mcp.list("a").items[0]!.error, failure.error);
  assert.equal(f.mcp.detail(s.id, "b").error, null);
  await f.dispatch("mcp_server_update", {
    serverId: s.id,
    expectedRevision: 1,
    server: { ...config, oauthClientId: "registered-app" },
  });
  assert.equal(f.mcp.detail(s.id, "a").error, null);
  const startId = randomUUID();
  const start = await f.dispatch(
    "mcp_authenticate",
    { serverId: s.id },
    startId,
  );
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.authenticated, false);
  const u = new URL(String(start.authorizationUrl));
  assert.equal(u.searchParams.get("client_id"), "registered-app");
  assert.equal(f.mcp.detail(s.id, "a").authPending, true);
  // Retry and committed journal replay keep the user's current sign-in link valid.
  assert.equal(
    (await f.dispatch("mcp_authenticate", { serverId: s.id })).authorizationUrl,
    start.authorizationUrl,
  );
  assert.deepEqual(
    await f.dispatch("mcp_authenticate", { serverId: s.id }, startId),
    start,
  );
  h.challenge(u.searchParams.get("code_challenge")!);
  const result = await f.mcp.callback(
    new URLSearchParams({
      state: u.searchParams.get("state")!,
      code: "fixture-code",
      iss: h.base,
    }),
  );
  assert.equal(result.status, "connected");
  assert.equal(f.mcp.detail(s.id, "a").authPending, false);
  assert.equal(f.mcp.detail(s.id, "a").error, null);
  const signedIn = await f.dispatch("mcp_authenticate", { serverId: s.id });
  assert.equal(signedIn.authenticated, true);
  assert.equal(signedIn.authorizationUrl, undefined);
  assert.equal(h.counts().clientRegistrations, 0);
  assert.equal(h.counts().tokenCalls, 1);
  assert.equal(
    (await f.dispatch("mcp_server_connect", { serverId: s.id })).ok,
    true,
  );
  assert.equal(
    (await f.dispatch("mcp_sign_out", { serverId: s.id, expectedRevision: 2 }))
      .authenticated,
    false,
  );
});

test("post-consent auto-connect cannot connect a server edited after the code exchange", async (t) => {
  const h = await httpFixture(t, true),
    other = await httpFixture(t),
    f = await fixture(t);
  const config: McpServerInput = {
    name: "Revision-bound consent",
    transport: "http",
    url: `${h.base}/mcp`,
    authentication: "oauth",
  };
  const s = await f.mcp.create("a", config);
  const start = await f.mcp.signIn(s.id, "a", callback),
    u = new URL(start.authorizationUrl!);
  h.challenge(u.searchParams.get("code_challenge")!);
  let reachedConnect = false,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const connect = f.mcp.connect.bind(f.mcp);
  f.mcp.connect = async (...args) => {
    reachedConnect = true;
    await gate;
    return connect(...args);
  };
  const completing = f.mcp.callback(
    new URLSearchParams({
      state: u.searchParams.get("state")!,
      code: "fixture-code",
      iss: h.base,
    }),
  );
  const rejected = assert.rejects(completing, /configuration changed/);
  await until(() => reachedConnect);
  await f.mcp.update(s.id, "a", s.revision, {
    ...config,
    url: `${other.base}/mcp`,
  });
  release();
  await rejected;
  assert.equal(other.messages.length, 0);
  assert.equal(f.mcp.detail(s.id).authenticated, false);
});

test("callback connection failure preserves completed OAuth and permits a transport-only retry", async (t) => {
  const h = await httpFixture(t, true),
    f = await fixture(t);
  const s = await f.mcp.create("a", {
    name: "Unavailable after consent",
    transport: "http",
    url: `${h.base}/mcp`,
    authentication: "oauth",
  });
  const start = await f.dispatch("mcp_authenticate", { serverId: s.id });
  const u = new URL(String(start.authorizationUrl));
  h.challenge(u.searchParams.get("code_challenge")!);
  h.failConnections(true);
  const result = await f.mcp.callback(
    new URLSearchParams({
      state: u.searchParams.get("state")!,
      code: "fixture-code",
      iss: h.base,
    }),
  );
  assert.equal(result.authenticated, true);
  assert.equal(result.status, "error");
  assert.equal(f.mcp.detail(s.id, "a").authenticated, true);
  assert.equal(f.mcp.detail(s.id, "a").authPending, false);
  assert.match(f.mcp.detail(s.id, "a").error!, /Cannot connect/);
  h.failConnections(false);
  assert.equal(
    (await f.dispatch("mcp_server_connect", { serverId: s.id })).ok,
    true,
  );
  assert.equal(h.counts().tokenCalls, 1);
});

test("OAuth setup is cancellable and late failures cannot restore status after revocation", async (t) => {
  let started = false;
  const f = await fixture(t, {
    fetcher: async (_url, init) => {
      init?.signal?.throwIfAborted();
      started = true;
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true },
        ),
      );
    },
  });
  const s = await f.mcp.create("a", {
    name: "Slow OAuth",
    transport: "http",
    url: "https://example.org/mcp",
    authentication: "oauth",
  });
  const controller = new AbortController();
  const pending = f.dispatch(
    "mcp_authenticate",
    { serverId: s.id },
    randomUUID(),
    controller.signal,
  );
  const rejected = assert.rejects(pending, /abort/i);
  await until(() => started);
  controller.abort();
  await rejected;
  assert.equal(f.mcp.detail(s.id, "a").authPending, false);
  started = false;
  const revoking = f.dispatch("mcp_authenticate", { serverId: s.id });
  await until(() => started);
  await f.mcp.setEnabled("a", s.id, false);
  assert.equal((await revoking).ok, false);
  assert.equal(f.mcp.detail(s.id, "a").error, null);
});

test("OAuth PKCE registration, callback state/replay, token refresh, persistence and sign-out", async (t) => {
  const h = await httpFixture(t, true),
    f = await fixture(t);
  const s = await f.mcp.create("a", {
    name: "OAuth",
    transport: "http",
    url: `${h.base}/mcp`,
    authentication: "oauth",
    headers: { "X-Fixture-Key": "resource-private" },
  });
  const start = await f.mcp.signIn(s.id, "a", callback);
  assert.equal(start.status, "auth_required");
  assert.ok(start.authorizationUrl);
  const authorize = new URL(start.authorizationUrl!);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("redirect_uri"), callback);
  h.challenge(authorize.searchParams.get("code_challenge")!);
  const params = new URLSearchParams({
    state: authorize.searchParams.get("state")!,
    code: "fixture-code",
    iss: h.base,
  });
  await assert.rejects(
    f.mcp.callback(new URLSearchParams({ state: "wrong", code: "code" })),
    /invalid/,
  );
  await f.mcp.callback(params);
  assert.equal(f.mcp.detail(s.id).authenticated, true);
  await assert.rejects(f.mcp.callback(params), /invalid|already used/);
  assert.equal(h.counts().clientRegistrations, 1);
  assert.equal(
    (await f.dispatch("mcp_tool_call", { serverId: s.id, name: "echo" })).ok,
    true,
  );
  h.expire();
  const refresh = await f.dispatch("mcp_tool_call", {
    serverId: s.id,
    name: "echo",
  });
  assert.equal(refresh.ok, true, JSON.stringify(refresh));
  assert.equal(h.counts().refreshes, 1);
  assert.equal(h.counts().headerLeak, false);
  const raw = f.db
    .prepare("SELECT secrets FROM mcp_servers WHERE id=?")
    .get(s.id) as { secrets: string };
  assert.ok(!raw.secrets.includes("refresh-private"));
  const fresh = new McpService(
    f.db,
    f.files,
    new ConnectionSecrets(`${f.db.name}.connections`),
    () => {},
    f.artifacts,
  );
  try {
    assert.equal(fresh.detail(s.id).authenticated, true);
    const restored = await fresh.execute(
      f.owner,
      "mcp_tool_call",
      { serverId: s.id, name: "echo" },
      new AbortController().signal,
      callback,
    );
    assert.equal(restored.ok, true);
  } finally {
    await fresh.close();
  }
  await f.mcp.signOut(s.id, s.revision);
  assert.equal(f.mcp.detail(s.id).authenticated, false);
  assert.equal(f.mcp.detail(s.id, "a").status, "not_connected");
});

test("OAuth denial, expiry, issuer binding and configuration edits reject stale callbacks", async (t) => {
  let clock = Date.now();
  const h = await httpFixture(t, true),
    f = await fixture(t, { now: () => clock });
  const input: McpServerInput = {
    name: "OAuth",
    transport: "http",
    url: `${h.base}/mcp`,
    authentication: "oauth",
  };
  let s = await f.mcp.create("a", input);
  async function start() {
    const result = await f.mcp.signIn(s.id, "a", callback);
    const u = new URL(result.authorizationUrl!);
    h.challenge(u.searchParams.get("code_challenge")!);
    return u.searchParams.get("state")!;
  }
  await assert.rejects(
    f.mcp.callback(
      new URLSearchParams({ state: await start(), error: "access_denied" }),
    ),
    /denied/,
  );
  const expired = await start();
  clock += 600001;
  await assert.rejects(
    f.mcp.callback(new URLSearchParams({ state: expired, code: "code" })),
    /expired/,
  );
  const wrongIssuer = await start();
  await assert.rejects(
    f.mcp.callback(
      new URLSearchParams({
        state: wrongIssuer,
        code: "code",
        iss: "https://other.example",
      }),
    ),
    /could not be completed/,
  );
  assert.equal(h.counts().tokenCalls, 0);
  const stale = await start();
  s = await f.mcp.update(s.id, "a", s.revision, { ...input, name: "Updated" });
  await assert.rejects(
    f.mcp.callback(new URLSearchParams({ state: stale, code: "code" })),
    /invalid/,
  );
  const disabled = await start();
  await f.mcp.setEnabled("a", s.id, false);
  await assert.rejects(
    f.mcp.callback(new URLSearchParams({ state: disabled, code: "code" })),
    /invalid/,
  );
  assert.equal(f.mcp.detail(s.id).authenticated, false);
});

test("MCP HTTP routes enforce origin guards and revisioned CRUD/import contracts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ufai-mcp-api-"));
  const app = createApp({
    databasePath: join(root, "app.sqlite"),
    execution: { autoStart: false },
    serveStatic: false,
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = (await app.inject("/api/workspaces")).json().items[0];
  const agent = (
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/agents`,
      payload: { name: "Agent" },
    })
  ).json();
  const forbidden = await app.inject({
    method: "POST",
    url: "/api/mcp/servers",
    headers: { origin: "https://outside.example" },
    payload: { agentId: agent.id, server: local },
  });
  assert.equal(forbidden.statusCode, 403);
  const created = await app.inject({
    method: "POST",
    url: "/api/mcp/servers",
    payload: { agentId: agent.id, server: local },
  });
  assert.equal(created.statusCode, 201, created.body);
  const server = created.json();
  assert.equal(created.headers["cache-control"], "no-store");
  assert.ok(!created.body.includes("encrypted-value"));
  const patch = await app.inject({
    method: "PATCH",
    url: `/api/mcp/servers/${server.id}`,
    payload: { agentId: agent.id, server: local, expectedRevision: 99 },
  });
  assert.equal(patch.statusCode, 409);
  const connected = await app.inject({
    method: "POST",
    url: `/api/mcp/servers/${server.id}/connect`,
    payload: { agentId: agent.id },
  });
  assert.equal(connected.statusCode, 200, connected.body);
  const list = await app.inject(
    `/api/mcp/servers/${server.id}/capabilities?agentId=${agent.id}&kind=tools&limit=2`,
  );
  assert.equal(list.json().items.length, 2, list.body);
  const invalid = await app.inject({
    method: "POST",
    url: "/api/mcp/imports",
    payload: { agentId: agent.id, config: "{" },
  });
  assert.equal(invalid.statusCode, 400);
  const cb = await app.inject({
    url: "/api/mcp/oauth/callback?state=invalid&code=secret",
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(cb.statusCode, 400);
  const oauth = await httpFixture(t, true, false);
  const oauthConfig = {
    name: "OAuth API",
    transport: "http",
    url: `${oauth.base}/mcp`,
    authentication: "oauth",
  };
  const authServer = (
    await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: { agentId: agent.id, server: oauthConfig },
    })
  ).json();
  const signInPath = `/api/mcp/servers/${authServer.id}/oauth/sign-in`;
  const authFailure = await app.inject({
    method: "POST",
    url: signInPath,
    payload: { agentId: agent.id },
  });
  assert.equal(authFailure.statusCode, 400);
  assert.equal(authFailure.json().code, "client_registration_required");
  const observedAuth = (
    await app.inject(`/api/mcp/servers/${authServer.id}?agentId=${agent.id}`)
  ).json();
  assert.equal(observedAuth.authErrorCode, "client_registration_required");
  assert.equal(observedAuth.status, "auth_required");
  await app.inject({
    method: "PATCH",
    url: `/api/mcp/servers/${authServer.id}`,
    payload: {
      agentId: agent.id,
      expectedRevision: 1,
      server: { ...oauthConfig, oauthClientId: "registered" },
    },
  });
  const started = (
    await app.inject({
      method: "POST",
      url: signInPath,
      payload: { agentId: agent.id },
    })
  ).json();
  const authorization = new URL(started.authorizationUrl);
  oauth.challenge(authorization.searchParams.get("code_challenge")!);
  const completed = await app.inject({
    url: `/api/mcp/oauth/callback?${new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code", iss: oauth.base })}`,
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.match(completed.body, /completed and the server is connected/);
  assert.equal(completed.headers["cache-control"], "no-store");
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/mcp/servers/${server.id}`,
    payload: { expectedRevision: 1, confirmed: true },
  });
  assert.equal(removed.statusCode, 200, removed.body);
});

for (const provider of ["openai-compatible", "codex"] as const) {
  test(`${provider}: normal agent turns discover and call MCP through the journaled bridge`, async (t) => {
    const f = await fixture(t);
    if (provider === "codex")
      f.db
        .prepare(
          "UPDATE connections SET provider='codex' WHERE id='connection'",
        )
        .run();
    const s = await f.mcp.create("a", local);
    f.connections.countTokens = async () => 100;
    f.connections.generate = async () => ({
      text: JSON.stringify({
        status: "completed",
        summary: "Used MCP",
        memories: [],
      }),
      finishReason: "stop",
      usage: null,
    });
    let rounds = 0;
    const finish = {
      text: "MCP completed.",
      finishReason: "stop",
      usage: null,
    };
    if (provider === "codex") {
      f.connections.executeTask = async (_snapshot, r) => {
        assert.ok(r.tools.some((x) => x.name === "mcp_tool_call"));
        assert.ok(r.tools.some((x) => x.name === "mcp_authenticate"));
        assert.match(r.instructions, /external data/);
        assert.match(r.instructions, /mcp_server_\* management tools/);
        const installed = await r.onTool({
          id: "install",
          name: "mcp_server_install",
          arguments: {
            server: {
              name: "From chat",
              transport: "stdio",
              command: local.command,
              args: local.args,
            },
          },
        });
        assert.equal(installed.ok, true, JSON.stringify(installed));
        const discovery = await r.onTool({
          id: "discover",
          name: "mcp_servers_list",
          arguments: {},
        });
        assert.equal((discovery.items as any)[0].id, s.id);
        const result = await r.onTool({
          id: "call",
          name: "mcp_tool_call",
          arguments: { serverId: s.id, name: "count" },
        });
        assert.equal((result.mcp as any).structuredContent.count, 1);
        rounds++;
        return finish;
      };
    } else {
      f.connections.toolRound = async (_snapshot, r) => {
        assert.ok(r.tools.some((x) => x.name === "mcp_tool_call"));
        assert.ok(r.tools.some((x) => x.name === "mcp_authenticate"));
        if (rounds++ === 0)
          return {
            text: "",
            calls: [
              {
                id: "install",
                name: "mcp_server_install",
                arguments: {
                  server: {
                    name: "From chat",
                    transport: "stdio",
                    command: local.command,
                    args: local.args,
                  },
                },
              },
              {
                id: "call",
                name: "mcp_tool_call",
                arguments: { serverId: s.id, name: "count" },
              },
            ],
            continuation: [],
            usage: null,
          };
        assert.equal(
          (r.continuation as any)[0].results[1].result.mcp.structuredContent
            .count,
          1,
        );
        return { text: finish.text, calls: [], continuation: [], usage: null };
      };
    }
    f.engine.pump();
    await until(() => {
      const turn = f.db
        .prepare("SELECT status,error FROM agent_turns WHERE id=?")
        .get(f.owner.turnId) as { status: string; error: string };
      if (["failed", "blocked"].includes(turn.status))
        assert.fail(JSON.stringify(turn));
      return turn.status === "completed";
    });
    assert.ok(rounds > 0);
    assert.equal(f.mcp.list().total, 2);
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT count(*) n FROM tool_invocations WHERE name='mcp_tool_call' AND state='completed'",
          )
          .get() as { n: number }
      ).n,
      1,
    );
  });
}

test("cancelling a queued MCP request settles promptly without releasing another request's lock", async (t) => {
  const f = await fixture(t),
    s = await f.mcp.create("a", local);
  await f.mcp.connect(s.id, "a", callback);
  const active = new AbortController(),
    queued = new AbortController();
  const first = f.dispatch(
    "mcp_tool_call",
    { serverId: s.id, name: "slow" },
    randomUUID(),
    active.signal,
  );
  const firstRejected = assert.rejects(first);
  await delay(20);
  const second = f.dispatch(
    "mcp_tools_list",
    { serverId: s.id },
    randomUUID(),
    queued.signal,
  );
  const secondRejected = assert.rejects(second);
  queued.abort();
  await Promise.race([
    secondRejected,
    delay(500).then(() =>
      assert.fail("Queued cancellation waited for the active tool"),
    ),
  ]);
  let thirdFinished = false;
  const third = f.dispatch("mcp_tools_list", { serverId: s.id }).then((r) => {
    thirdFinished = true;
    return r;
  });
  await delay(20);
  assert.equal(thirdFinished, false);
  active.abort();
  await firstRejected;
  assert.equal((await third).ok, true);
});

test("an imported disabled server starts disabled without changing other agents' switches", async (t) => {
  const f = await fixture(t);
  const p = f.mcp.preview("a", {
    mcpServers: {
      Disabled: { command: process.execPath, args: [script], disabled: true },
    },
  });
  assert.equal(p.candidates[0]!.disabled, true);
  const saved = await f.mcp.commitPreview(p.id, "a", p.candidates[0]!.key);
  assert.equal(saved.enabled, false);
  assert.equal(f.mcp.detail(saved.id, "b").enabled, false);
});

test("pre-registered OAuth credentials skip registration and edits fence an in-flight token exchange", async (t) => {
  const h = await httpFixture(t, true),
    f = await fixture(t);
  const input: McpServerInput = {
    name: "Registered",
    transport: "http",
    url: `${h.base}/mcp`,
    authentication: "oauth",
    oauthClientId: "pre-registered",
    oauthClientSecret: "client-private",
  };
  const s = await f.mcp.create("a", input);
  assert.equal(s.hasOAuthClientSecret, true);
  assert.ok(!JSON.stringify(s).includes("client-private"));
  const start = await f.mcp.signIn(s.id, "a", callback),
    u = new URL(start.authorizationUrl!);
  assert.equal(u.searchParams.get("client_id"), "pre-registered");
  assert.equal(h.counts().clientRegistrations, 0);
  h.challenge(u.searchParams.get("code_challenge")!);
  h.delayTokens(150);
  const exchange = f.mcp.callback(
    new URLSearchParams({
      state: u.searchParams.get("state")!,
      code: "fixture-code",
      iss: h.base,
    }),
  );
  const rejected = assert.rejects(exchange, /timed out or was interrupted/);
  await until(() => h.counts().tokenCalls === 1);
  await f.mcp.update(s.id, "a", s.revision, {
    ...input,
    oauthClientSecret: "replacement-private",
  });
  await rejected;
  assert.equal(h.tokenBodies[0]?.get("client_id"), "pre-registered");
  assert.equal(h.tokenBodies[0]?.get("client_secret"), "client-private");
  assert.equal(f.mcp.detail(s.id).authenticated, false);
});

test("ordinary structured MCP data is preserved and invalid catalog cursors return conflicts", async (t) => {
  const f = await fixture(t),
    s = await f.mcp.create("a", local);
  const result = await f.dispatch("mcp_tool_call", {
    serverId: s.id,
    name: "structured",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((result.mcp as any).structuredContent, {
    blob: "ordinary string",
    nested: { type: "image", data: "opaque" },
  });
  assert.equal(result.artifacts, undefined);
  await assert.rejects(
    f.mcp.capabilities(s.id, "a", "tools", "invalid", 25, callback),
    (e: any) => e.statusCode === 409,
  );
});
