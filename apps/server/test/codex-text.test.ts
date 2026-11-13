import { taskTools } from "../src/agent-tools.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CodexRuntime } from "../src/codex-runtime.js";
import type { TextRequest } from "../src/execution-types.js";
const fixture = fileURLToPath(
  new URL("./fixtures/codex-text-process.cjs", import.meta.url),
);
const base: TextRequest = {
  modelId: "model",
  instructions: "Only text.",
  messages: [{ role: "user", content: "Hello" }],
  contextWindow: 32000,
  outputTokens: 4096,
  signal: new AbortController().signal,
};
async function runtime(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "ufai-codex-text-"));
  const r = new CodexRuntime(
    dir,
    () =>
      spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] }),
    1000,
    1000,
  );
  t.after(async () => {
    await r.close();
    await rm(dir, { recursive: true, force: true });
  });
  return r;
}
test("Codex isolates two text threads and cancelling one does not terminate the other", async (t) => {
  const r = await runtime(t),
    controller = new AbortController();
  const hanging = r.executeText("connection", {
    ...base,
    messages: [{ role: "user", content: "hang" }],
    signal: controller.signal,
  });
  void hanging.catch(() => {});
  const deltas: string[] = [];
  const answer = await r.executeText("connection", {
    ...base,
    onDelta: (d) => deltas.push(d),
  });
  controller.abort();
  await assert.rejects(hanging);
  assert.equal(answer.text, "Hello world");
  assert.equal(deltas.join(""), "Hello world");
  assert.equal((await r.executeText("connection", base)).text, "Hello world");
});
test("Codex rejects tool activity without killing an unrelated text thread", async (t) => {
  const r = await runtime(t);
  await assert.rejects(
    r.executeText("connection", {
      ...base,
      messages: [{ role: "user", content: "tool" }],
    }),
    /unsupported action/,
  );
  assert.equal((await r.executeText("connection", base)).text, "Hello world");
});
test("a model test can finish without terminating a concurrent ordinary turn", async (t) => {
  const r = await runtime(t),
    controller = new AbortController();
  const hanging = r.executeText("connection", {
    ...base,
    messages: [{ role: "user", content: "hang" }],
    signal: controller.signal,
  });
  void hanging.catch(() => {});
  assert.equal(
    await r.test("connection", "model", new AbortController().signal),
    "Hello world",
  );
  assert.equal((await r.executeText("connection", base)).text, "Hello world");
  controller.abort();
  await assert.rejects(hanging);
});
test("Codex retains final message items that arrive without deltas and reports usage", async (t) => {
  const r = await runtime(t);
  const answer = await r.executeText("connection", {
    ...base,
    messages: [{ role: "user", content: "multiple-items" }],
  });
  assert.equal(answer.text, "Preparing an answer.\n\nFinal answer.");
  assert.deepEqual(answer.usage, { inputTokens: 12, outputTokens: 8 });
});

test("Codex dynamic tools use ufAI callbacks, isolate commentary, and preserve cancellation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-codex-tools-"));
  const runtime = new CodexRuntime(
    directory,
    () =>
      spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./fixtures/codex-tools-process.cjs", import.meta.url),
          ),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      ),
    1000,
    1000,
  );
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const calls: any[] = [],
    comments: string[] = [];
  const result = await runtime.executeTask("connection", {
    ...base,
    messages: [
      {
        role: "user",
        content: "Inspect",
        media: [
          {
            versionId: "image",
            name: "a.png",
            mediaType: "image/png",
            size: 3,
          },
        ],
      },
    ],
    resolveMedia: async (refs) => refs.map((ref) => ({ ...ref, data: "AQID" })),
    tools: [
      ...taskTools.filter(t=>t.name!=="files_read"),
      {
        name: "files_read",
        description: "Read file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
    onTool: async (call) => {
      calls.push(call);
      return {
        ok: true,
        text: "Contents",
        media: [
          {
            versionId: "image",
            name: "a.png",
            mediaType: "image/png",
            size: 3,
          },
        ],
      };
    },
    onCommentary: (text) => comments.push(text),
  });
  assert.equal(result.text, "Final answer.");
  assert.equal(calls[0].name, "agent_send");
  assert.deepEqual(calls[0].arguments, {agentId:"helper",content:"Help"});
  assert.deepEqual(comments, ["Reading the file.", "Checking the result."]);
  assert.equal(result.usage?.inputTokens, 20);
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const waiting = runtime.executeTask("connection", {
    ...base,
    signal: controller.signal,
    tools: [
      {
        name: "files_read",
        description: "Read",
        parameters: { type: "object" },
      },
    ],
    onTool: async () => {
      entered();
      await new Promise((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("Cancelled")),
          { once: true },
        ),
      );
      return { ok: true };
    },
  });
  void waiting.catch(() => {});
  await started;
  controller.abort();
  await assert.rejects(() => waiting, /cancelled/i);
});
