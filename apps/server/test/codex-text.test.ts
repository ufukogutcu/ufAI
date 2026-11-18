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
import { setTimeout as delay } from "node:timers/promises";
const fixture = fileURLToPath(
  new URL("./fixtures/codex-text-process.cjs", import.meta.url),
);
const base: TextRequest = {
  modelId: "model",
  instructions: "Only text.",
  messages: [{ role: "user", content: "Hello" }],
  contextWindow: 32000,

  signal: new AbortController().signal,
};

test("Codex journals queued callbacks before execution and withholds replies until the freeze gate opens",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"ufai-codex-freeze-"));
  const r=new CodexRuntime(directory,()=>spawn(process.execPath,[fileURLToPath(new URL("./fixtures/codex-tools-process.cjs",import.meta.url))],{stdio:["pipe","pipe","pipe"]}),1000,1000);
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  t.after(async()=>{release();await r.close();await rm(directory,{recursive:true,force:true});});
  const queued:string[]=[],executed:string[]=[];
  let continuations = 0;
  let finished=false;
  const answer=r.executeTask("connection",{...base,messages:[{role:"user",content:"parallel-freeze"}],tools:taskTools,
    onToolQueued:call=>{queued.push(call.id);},
    onTool:async call=>{executed.push(call.id);return {ok:true,text:"Observed"};},
    beforeToolReply:()=>gate,
    beforeToolContinuation: async () => { continuations++; },
  }).then(result=>{finished=true;return result;});
  for(let i=0;i<200 && queued.length<2;i++) await delay(5);
  assert.equal(queued.length,2);
  assert.equal(executed.length,1);
  assert.equal(continuations, 0);
  assert.equal(finished,false);
  release();
  assert.equal((await answer).text,"Final answer.");
  assert.deepEqual(executed,queued);
  assert.equal(continuations, 2);
});
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
test("Codex text-only generation still rejects a completed empty reply", async t => {
  const r = await runtime(t);
  await assert.rejects(r.executeText("connection", {
    ...base, messages: [{ role: "user", content: "empty-reply" }],
  }), /did not complete a text reply/);
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

test("Codex transports initial connection awareness and replacement observations on failed dynamic results", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-codex-awareness-"));
  const runtime = new CodexRuntime(directory, () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/codex-tools-process.cjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] }), 1000, 1000);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await runtime.executeTask("connection", {
    ...base,
    instructions: 'awareness-fixture\nConnected agents: {"items":[{"id":"helper","name":"Helper","description":"Research"}]}',
    messages: [{ role: "user", content: "awareness-fixture" }],
    tools: taskTools,
    onTool: async () => ({ ok: false, error: "The connection was removed.", connectedAgents: { capturedAt: new Date().toISOString(), items: [] } }),
  });
  assert.equal(result.text, "Final answer.");
});

test("Codex accepts silent completed tool turns only after a successful reply is delivered", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-codex-silent-"));
  const runtime = new CodexRuntime(directory, () => spawn(process.execPath,
    [fileURLToPath(new URL("./fixtures/codex-tools-process.cjs", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"] }), 1000, 1000);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const comments: string[] = [];
  const request = {
    ...base, tools: taskTools,
    messages: [{ role: "user" as const, content: "silent-success" }],
    onTool: async () => ({ ok: true }),
    onCommentary: (text: string) => comments.push(text),
  };
  const answer = await runtime.executeTask("connection", request);
  assert.equal(answer.text, "");
  assert.equal(answer.finishReason, "stop");
  assert.deepEqual(comments, ["Reading the file.", "Checking the result."]);
  for (const mode of ["silent-no-tool", "silent-failed-turn", "silent-interrupted-turn", "silent-failed-tool"]) {
    await assert.rejects(runtime.executeTask("connection", {
      ...request, messages: [{ role: "user", content: mode }],
      onTool: async () => ({ ok: mode !== "silent-failed-tool" }),
    }), /did not complete a text reply/);
  }
  await assert.rejects(runtime.executeTask("connection", {
    ...request, onTool: async () => { throw new Error("Synthetic tool callback failure"); },
  }), /Synthetic tool callback failure/);
});

test("Codex silent completion waits for pending tool callbacks and respects cancellation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-codex-silent-gate-"));
  const runtime = new CodexRuntime(directory, () => spawn(process.execPath,
    [fileURLToPath(new URL("./fixtures/codex-tools-process.cjs", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"] }), 1000, 1000);
  let release = () => {};
  t.after(async () => { release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  for (const cancelled of [false, true]) {
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false, finished = false;
    const controller = new AbortController();
    const answer = runtime.executeTask("connection", {
      ...base, signal: controller.signal, tools: taskTools,
      messages: [{ role: "user", content: "silent-early-complete" }],
      onTool: async () => { entered = true; return { ok: true }; },
      beforeToolReply: () => gate,
    }).then(result => { finished = true; return result; });
    void answer.catch(() => {});
    for (let i = 0; i < 200 && !entered; i++) await delay(5);
    assert.equal(entered, true);
    await delay(10);
    assert.equal(finished, false);
    if (cancelled) controller.abort();
    release();
    if (cancelled) {
      await assert.rejects(answer, /cancelled/);
      assert.equal(finished, false);
    } else {
      assert.equal((await answer).text, "");
      assert.equal(finished, true);
    }
  }
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
      ...taskTools.filter((t) => t.name !== "files_read"),
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
  assert.deepEqual(calls[0].arguments, { agentId: "helper", content: "Help" });
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

test("Codex completes text beyond its former reply ceiling", async (t) => {
  const r = await runtime(t);
  const reply = await r.executeText("connection", {
    ...base,
    messages: [{ role: "user", content: "large-reply" }],
  });
  assert.equal(reply.text.length, 80 * 4096);
});

test("Codex executes more than 32 dynamic tool rounds", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ufai-codex-rounds-"));
  const r = new CodexRuntime(
    dir,
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
    await r.close();
    await rm(dir, { recursive: true, force: true });
  });
  let calls = 0;
  const reply = await r.executeTask("connection", {
    ...base,
    messages: [{ role: "user", content: "many-tools" }],
    tools: [taskTools.find((t) => t.name === "files_read")!],
    onTool: async () => {
      calls++;
      return { ok: true, text: "Contents" };
    },
  });
  assert.equal(calls, 130);
  assert.equal(reply.text, "Final answer.");
});

test("Codex acknowledges a yielded tool, interrupts its session and leaves unrelated execution usable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-codex-yield-"));
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
  let yielded = false,
    calls = 0;
  const deltas: string[] = [];
  const result = await runtime.executeTask("connection", {
    ...base,
    messages: [{ role: "user", content: "yield-fixture" }],
    tools: taskTools,
    shouldYield: () => yielded,
    onDelta: (text) => deltas.push(text),
    onTool: async (call) => {
      assert.equal(call.name, "task_yield");
      calls++;
      yielded = true;
      return { ok: true, taskYield: true, summary: "Waiting for messages" };
    },
  });
  assert.equal(result.finishReason, "yield");
  assert.equal(result.text, "");
  assert.equal(calls, 1);
  assert.ok(!deltas.join("").includes("late output"));
  const answer = await runtime.executeTask("connection", {
    ...base,
    tools: taskTools,
    onTool: async () => ({ ok: true }),
  });
  assert.equal(answer.text, "Final answer.");
});
