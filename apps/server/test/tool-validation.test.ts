import assert from "node:assert/strict";
import { test } from "node:test";
import { taskTools, validateTool } from "../src/agent-tools.js";
import { ConnectionError } from "../src/model-providers.js";

test("command wait schema explains effective bounds, default, cap and completion", () => {
  const tool = taskTools.find(t => t.name === "process_start")!;
  const schema = (tool.parameters.properties as Record<string, any>).yieldMs;
  assert.equal(schema.minimum, 0);
  assert.equal(schema.maximum, 1000);
  assert.equal(schema.default, 100);
  for (const description of [tool.description, schema.description]) {
    for (const text of ["milliseconds", "0–1000 ms inclusive", "100 ms", "capped at 1000 ms", "does not limit command runtime", "process_wait"])
      assert.ok(description.includes(text), text);
  }
});

test("command waits normalize safely without mutating supplied arguments", () => {
  for (const [yieldMs, expected] of [[0, 0], [100, 100], [999, 999], [1000, 1000], [1001, 1000], [10000, 1000], [Number.MAX_SAFE_INTEGER, 1000]]) {
    const args = Object.freeze({ command: "true", yieldMs, env: Object.freeze({ EXAMPLE: "value" }) });
    const normalized = validateTool("process_start", args);
    assert.notEqual(normalized, args);
    assert.equal(normalized.yieldMs, expected);
    assert.equal(args.yieldMs, yieldMs);
    assert.equal(normalized.env, args.env);
  }
  const args = Object.freeze({ command: "true" });
  assert.deepEqual(validateTool("process_start", args), args);
  assert.equal(Object.hasOwn(validateTool("process_start", args), "yieldMs"), false);
});

test("invalid command waits identify the argument and its correction", () => {
  for (const yieldMs of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "1000", null, true, {}, [], undefined]) {
    assert.throws(() => validateTool("process_start", { command: "true", yieldMs }), (error: unknown) => {
      assert.ok(error instanceof ConnectionError);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /^process_start\.yieldMs:/);
      assert.match(error.message, /nonnegative safe integer/);
      assert.match(error.message, /0–1000 ms inclusive/);
      assert.match(error.message, /capped at 1000 ms/);
      return true;
    });
  }
});

test("MCP discovery caps only oversized safe integer limits without mutating arguments", () => {
  for (const name of ["mcp_servers_list", "mcp_tools_list", "mcp_resources_list", "mcp_prompts_list"]) {
    const required = name === "mcp_servers_list" ? {} : { serverId: "s" };
    for (const limit of [1, 5, 50, 51, 100, 200, Number.MAX_SAFE_INTEGER]) {
      const args = Object.freeze({ ...required, limit });
      assert.equal(validateTool(name, args).limit, Math.min(limit, 50));
      assert.equal(args.limit, limit);
    }
    assert.equal(Object.hasOwn(validateTool(name, required), "limit"), false);
    for (const limit of [0, -1, 1.5, 100.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "100", null, true, {}, [], undefined])
      assert.throws(() => validateTool(name, { ...required, limit }), {
        message: `${name}.limit: Expected a safe integer from 1 to 50 inclusive. Supply a whole number within these bounds.`,
      });
  }
  assert.throws(() => validateTool("files_read", { path: "a", limit: 32769 }), /files_read.limit/);
});

test("shared validation identifies exact paths and corrective constraints without echoing values", () => {
  const secret = "secret-value-must-not-appear";
  const skill = { name: "example", description: "Example", instructions: "Do work" };
  const cases: [string, unknown, string, RegExp][] = [
    ["files_read", null, "files_read", /Expected object/],
    ["files_read", [], "files_read", /Expected object/],
    ["files_read", {}, "files_read.path", /Missing required argument.*Supply/],
    ["files_read", { path: 7 }, "files_read.path", /Expected string.*Supply/],
    ["files_write", { path: "a", text: "", expectedSha256: 7 }, "files_write.expectedSha256", /Expected string or null/],
    ["files_read", { path: "a", limit: 0 }, "files_read.limit", /safe integer from 1 to 32768 inclusive/],
    ["files_read", { path: "a", limit: 32769 }, "files_read.limit", /safe integer from 1 to 32768 inclusive/],
    ["files_read", { path: "a", limit: 1.5 }, "files_read.limit", /Supply a whole number/],
    ["files_read", { path: "a", limit: Number.MAX_SAFE_INTEGER + 1 }, "files_read.limit", /safe integer/],
    ["files_read", { path: "a", limit: secret }, "files_read.limit", /safe integer/],
    ["files_read", { path: "a", limit: Infinity }, "files_read.limit", /safe integer/],
    ["agent_send", { agentId: "a", content: "hi", kind: secret }, "agent_send.kind", /Use one of: "request", "notification"/],
    ["files_read", { path: "" }, "files_read.path", /at least 1 characters.*at most 4096 characters/],
    ["files_read", { path: secret.repeat(200) }, "files_read.path", /at most 4096 characters/],
    ["files_read", { path: `${secret}\0` }, "files_read.path", /Remove all NUL characters/],
    ["browser_upload", { paths: [] }, "browser_upload.paths", /at least 1 items.*at most 10 items/],
    ["task_set_outputs", { versionIds: Array(11).fill(secret) }, "task_set_outputs.versionIds", /at most 10 items/],
    ["agent_wait", { requestIds: ["a", "a"] }, "agent_wait.requestIds", /Remove duplicates/],
    ["browser_upload", { paths: ["a", 7] }, "browser_upload.paths[1]", /Expected string/],
    ["process_start", { command: "true", env: { API_KEY: 7 } }, "process_start.env.API_KEY", /Expected string/],
    ["process_start", { command: "true", env: { "API.KEY": 7 } }, 'process_start.env["API.KEY"]', /Expected string/],
    ["process_start", { command: "true", env: { TOKEN: secret.repeat(200) } }, "process_start.env.TOKEN", /at most 4096 characters/],
    ["process_start", { command: "true", env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`KEY_${i}`, secret])) }, "process_start.env", /at most 32 properties.*remove extra/],
    ["mcp_tool_call", { serverId: "s", name: "t", arguments: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`key${i}`, secret])) }, "mcp_tool_call.arguments", /at most 100 properties/],
    ["skill_create", { skill: { description: "Example", instructions: "Work" } }, "skill_create.skill.name", /Missing required argument/],
    ["skill_create", { skill: { ...skill, metadata: { example: 7 } } }, "skill_create.skill.metadata.example", /Expected string/],
    ["files_read", { path: "a", unexpected: secret }, "files_read.unexpected", /Unknown argument.*Remove this field/],
    ["skill_create", { skill: { ...skill, extra: secret } }, "skill_create.skill.extra", /Unknown argument.*Remove this field/],
  ];
  for (const [name, args, path, correction] of cases) {
    assert.throws(() => validateTool(name, args), (error: unknown) => {
      assert.ok(error instanceof ConnectionError, path);
      assert.equal(error.statusCode, 400);
      assert.ok(error.message.startsWith(`${path}: `), error.message);
      assert.match(error.message, correction);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const args = { command: "true", env: JSON.parse(`{"${key}":"${secret}"}`) };
    assert.throws(() => validateTool("process_start", args), {
      message: `process_start.env.${key}: Prohibited property. Remove this field.`,
    });
  }
});

test("validation preserves nullable and free-form fields and reports the first failure consistently", () => {
  const nullable = { path: "a", text: "", expectedSha256: null };
  assert.deepEqual(validateTool("files_write", nullable), nullable);
  const mcp = { serverId: "s", name: "t", arguments: { external: { arbitrary: [1, null, true] } } };
  assert.deepEqual(validateTool("mcp_tool_call", mcp), mcp);
  for (const args of [{ command: "true", rows: 0, cols: 0 }, { cols: 0, command: "true", rows: 0 }])
    assert.throws(() => validateTool("process_start", args), /^Error: process_start\.cols: Expected a safe integer from 20 to 500 inclusive/);
  assert.throws(() => validateTool("not_a_tool", {}), /not_a_tool: Unknown tool.*supplied tool definitions/);
});
