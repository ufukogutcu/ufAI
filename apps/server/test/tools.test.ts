import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID, createHash } from "node:crypto";
import { openDatabase } from "../src/database.js";
import { ManagedFiles } from "../src/managed-files.js";
import { ProcessService, type ToolOwner } from "../src/process-service.js";
import { ArtifactService } from "../src/artifact-service.js";
import { AgentTools } from "../src/agent-tools.js";
import { AgentExecution } from "../src/agent-execution.js";
import { ConnectionService } from "../src/connection-service.js";
import type { TaskRequest, ToolRound } from "../src/execution-types.js";
import { createApp } from "../src/app.js";
import { removeToolTables } from "./legacy-schema.js";
async function until(fn: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (fn()) return;
    await delay(10);
  }
  assert.fail("Timed out");
}
async function setup(
  t: any,
  options: { logBytes?: number; maxStorageBytes?: number; run?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "ufai-tools-")),
    path = join(directory, "app.sqlite"),
    db = openDatabase(path),
    files = new ManagedFiles(db, join(directory, "files"));
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as any).id,
    stamp = new Date().toISOString();
  db.prepare(
    "INSERT INTO connections(id,provider,name,createdAt,updatedAt,draft) VALUES ('connection','openai-compatible','Local',?,?,0)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES ('connection','model','Model',1,64000)",
  ).run();
  db.prepare(
    "INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES ('preset','Preset','connection','model',?,?)",
  ).run(stamp, stamp);
  for (const id of ["a", "b"])
    db.prepare(
      "INSERT INTO agents(id,workspaceId,name,instructions,presetId,createdAt,updatedAt) VALUES (?,?,?,'Use tools','preset',?,?)",
    ).run(id, workspaceId, id, stamp, stamp);
  const connections = new ConnectionService(db);
  connections.generate = async () => ({
    text: JSON.stringify({
      status: "completed",
      summary: "Done",
      memories: [],
    }),
    finishReason: "stop",
    usage: null,
  });
  connections.countTokens = async () => 100;
  const changed = () => {},
    processes = new ProcessService(db, files, changed, {
      logBytes: options.logBytes,
    }),
    artifacts = new ArtifactService(db, files, changed, {
      maxStorageBytes: options.maxStorageBytes,
    }),
    tools = new AgentTools(db, files, processes, artifacts, changed);
  const engine = new AgentExecution(
    db,
    connections,
    { autoStart: options.run ?? false },
    files,
    tools,
  );
  files.bind(engine);
  await files.start();
  await artifacts.start();
  tools.ready = true;
  const submitted = engine.submit("a", "new", "Make a file", randomUUID());
  const owner: ToolOwner = {
    workspaceId,
    agentId: "a",
    taskId: submitted.taskId!,
    turnId: submitted.turnId,
  };
  await tools.locations(owner);
  t.after(async () => {
    await engine.close();
    await processes.close();
    await artifacts.close();
    await connections.close();
    await files.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path,
    db,
    files,
    processes,
    artifacts,
    tools,
    engine,
    connections,
    owner,
    signal: new AbortController().signal,
  };
}
test("pipe commands sanitize environment, accept stdin, preserve task cwd and stop descendants", async (t) => {
  const s = await setup(t);
  process.env.UFAI_TEST_SECRET = "private";
  t.after(() => delete process.env.UFAI_TEST_SECRET);
  const p = await s.processes.start(
    s.owner,
    {
      command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.cwd()+"\\n"+String(process.env.UFAI_TEST_SECRET)+"\\n");process.stdin.once("data",d=>{process.stdout.write(d);process.exit(0)})'`,
    },
    s.signal,
  );
  await until(() => s.processes.get(p.id).state === "running");
  s.processes.input(p.id, "hello\n");
  await s.processes.wait(p.id, s.signal);
  const output = Buffer.from(
    (await s.processes.output(p.id)).data,
    "base64",
  ).toString();
  assert.match(output, /undefined/);
  assert.match(output, /hello/);
  assert.ok(output.includes(s.files.location("task", s.owner.taskId).path));
  assert.equal(s.processes.get(p.id).exitCode, 0);
  const parent = await s.processes.start(
    s.owner,
    { command: "sleep 60 & wait", background: true },
    s.signal,
  );
  await s.processes.stop(parent.id);
  assert.equal(s.processes.get(parent.id).state, "stopped");
});
test("real PTY supports terminal detection, input and resize", async (t) => {
  const s = await setup(t);
  const p = await s.processes.start(
    s.owner,
    {
      command: `${JSON.stringify(process.execPath)} -e 'console.log("TTY",process.stdin.isTTY);process.stdin.once("data",d=>{console.log("INPUT",d.toString());process.exit(0)})'`,
      pty: true,
      background: true,
    },
    s.signal,
  );
  await until(() => s.processes.get(p.id).state === "running");
  s.processes.resize(p.id, 90, 25);
  s.processes.input(p.id, "from terminal\r");
  await s.processes.wait(p.id, s.signal);
  const text = Buffer.from(
    (await s.processes.output(p.id)).data,
    "base64",
  ).toString();
  assert.match(text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""), /TTY true/);
  assert.match(text, /from terminal/);
});
test("process logs rotate with explicit cursor gaps and commands stop explicitly", async (t) => {
  const s = await setup(t, { logBytes: 1024 });
  const p = await s.processes.start(
    s.owner,
    {
      command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(131072))'`,
    },
    s.signal,
  );
  await s.processes.wait(p.id, s.signal);
  const output = await s.processes.output(p.id);
  assert.equal(output.truncated, true);
  assert.equal(Buffer.from(output.data, "base64").length, 1024);
  assert.equal(output.end, 131072);
  const timed = await s.processes.start(
    s.owner,
    { command: "sleep 60" },
    s.signal,
  );
  await until(() => s.processes.get(timed.id).state === "running");
  await s.processes.stop(timed.id);
  assert.equal(s.processes.get(timed.id).state, "stopped");
});
test("tool calls are journaled, deduplicated, validate ownership and optimistic file writes", async (t) => {
  const s = await setup(t),
    call = {
      id: "write",
      name: "files_write",
      arguments: { path: "report.txt", text: "one", expectedSha256: null },
    };
  const dispatch = (c: any) =>
    s.tools.dispatch(s.owner, c, s.signal, async () => ({}));
  const first = await dispatch(call);
  assert.equal(first.ok, true);
  assert.deepEqual(await dispatch(call), first);
  assert.equal(
    (
      await dispatch({
        ...call,
        id: "conflict",
        arguments: { ...call.arguments, text: "two" },
      })
    ).ok,
    false,
  );
  const read = await dispatch({
    id: "read",
    name: "files_read",
    arguments: { path: "report.txt" },
  });
  assert.equal(read.sha256, createHash("sha256").update("one").digest("hex"));
  const replaced = await dispatch({
    ...call,
    id: "replace",
    arguments: { ...call.arguments, text: "two", expectedSha256: read.sha256 },
  });
  assert.equal(replaced.ok, true);
  await assert.rejects(
    () =>
      dispatch({
        ...call,
        arguments: { ...call.arguments, text: "different" },
      }),
    /reused/,
  );
  assert.equal(
    (
      await dispatch({
        id: "impersonate",
        name: "process_start",
        arguments: { command: "true", agentId: "b" },
      })
    ).ok,
    false,
  );
  const p = await s.processes.start(
    { ...s.owner, agentId: "b" },
    { command: "sleep 60", background: true },
    s.signal,
  );
  assert.equal(
    (
      await dispatch({
        id: "foreign",
        name: "process_stop",
        arguments: { processId: p.id },
      })
    ).ok,
    false,
  );
  await s.processes.stop(p.id);
});
test("artifacts snapshot bytes, publish versions, materialize, and survive producer deletion", async (t) => {
  const s = await setup(t),
    file = join(s.files.location("task", s.owner.taskId).path, "report.txt");
  await writeFile(file, "original");
  const v = await s.artifacts.publish(s.owner, { path: file }, s.signal);
  await writeFile(file, "changed");
  assert.equal(v.sha256, createHash("sha256").update("original").digest("hex"));
  const next = await s.artifacts.publish(
    s.owner,
    { path: file, artifactId: v.artifactId, sourceVersionId: v.id },
    s.signal,
  );
  assert.notEqual(next.id, v.id);
  const copy = await s.artifacts.materialize(s.owner, v.id);
  assert.equal(await readFile(copy.path, "utf8"), "original");
  await assert.rejects(() => s.artifacts.materialize(s.owner, v.id), /EEXIST/);
  s.db.prepare("DELETE FROM agents WHERE id=?").run("a");
  assert.equal(s.artifacts.get(v.id).producerAgentId, null);
  const download = await s.artifacts.download(v.id);
  const chunks = [];
  for await (const chunk of download.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "original");
});
test("artifact quotas, source links, managed symlinks and failed ingest are explicit", async (t) => {
  const s = await setup(t, { maxStorageBytes: 8 }),
    file = join(s.files.location("task", s.owner.taskId).path, "small.txt");
  await writeFile(file, "12345678");
  await s.artifacts.publish(s.owner, { path: file }, s.signal);
  await assert.rejects(
    () => s.artifacts.publish(s.owner, { path: file }, s.signal),
    /storage limit/,
  );
  await symlink(file, file + "-link");
  await assert.rejects(
    () => s.artifacts.publish(s.owner, { path: file + "-link" }, s.signal),
    /regular file/,
  );
});
test("waiting releases agent and connection slots, completion before wait is not lost", async (t) => {
  const s = await setup(t),
    steps = new Map<string, number>();
  let sawWaiting = false, sawResumedEvent = false;
  s.engine.events.on("change", () => {
    const turn = s.db.prepare("SELECT status FROM agent_turns WHERE id=?").get(s.owner.turnId) as { status: string };
    if (turn.status === "waiting") sawWaiting = true;
    if (sawWaiting && turn.status === "running") sawResumedEvent = true;
  });
  s.connections.toolRound = async (
    _snapshot,
    r: TaskRequest,
  ): Promise<ToolRound> => {
    const key = r.messages.at(-1)!.content,
      n = steps.get(key) ?? 0;
    steps.set(key, n + 1);
    if (key === "other")
      return {
        text: "Other task completed",
        calls: [],
        continuation: [],
        usage: null,
      };
    if (n === 0)
      return {
        text: "Starting work",
        calls: [
          {
            id: "start",
            name: "process_start",
            arguments: { command: "sleep 1", background: true },
          },
        ],
        continuation: [],
        usage: null,
      };
    if (n === 1) {
      const last = (r.continuation!.at(-1) as any).results[0].result.process;
      return {
        text: "Waiting",
        calls: [
          {
            id: "wait",
            name: "process_wait",
            arguments: { processId: last.id },
          },
        ],
        continuation: [],
        usage: null,
      };
    }
    assert.ok(sawResumedEvent, "resumption must invalidate the UI before the next model round produces output");
    return {
      text: "Finished after wait",
      calls: [],
      continuation: [],
      usage: null,
    };
  };
  // Enable pumping after setup has installed deterministic adapters.
  (s.engine as any).options.autoStart = true;
  s.engine.wake();
  await until(() => s.engine.task(s.owner.taskId).status === "waiting");
  const other = s.engine.submit("a", "new", "other", randomUUID());
  await until(() => s.engine.task(other.taskId!).status === "completed");
  assert.equal(s.engine.task(s.owner.taskId).status, "waiting");
  await until(() => s.engine.task(s.owner.taskId).status === "completed");
  const p = s.db.prepare("SELECT id FROM owned_processes").get() as {
    id: string;
  };
  assert.equal((await s.processes.wait(p.id, s.signal)).state, "exited");
});
test("populated v11 upgrade retains task content and managed paths", async (t) => {
  const s = await setup(t);
  const old = s.files.location("task", s.owner.taskId).relativePath;
  removeToolTables(s.db);
  s.db.pragma("user_version=11");
  const upgraded = openDatabase(s.path);
  assert.equal(upgraded.pragma("user_version", { simple: true }), 23);
  assert.equal(
    (
      upgraded
        .prepare(
          "SELECT content FROM agent_messages WHERE id=(SELECT inputMessageId FROM agent_turns WHERE id=?)",
        )
        .get(s.owner.turnId) as any
    ).content,
    "Make a file",
  );
  assert.equal(
    (
      upgraded
        .prepare(
          "SELECT relativePath FROM managed_locations WHERE kind='task' AND ownerId=?",
        )
        .get(s.owner.taskId) as any
    ).relativePath,
    old,
  );
  upgraded.close();
});
test("artifact HTTP routes reject foreign origins and expose no path download route", async (t) => {
  const app = createApp({
    databasePath: ":memory:",
    execution: { autoStart: false },
  });
  t.after(() => app.close());
  await app.ready();
  assert.equal(
    (
      await app.inject({
        url: "/api/artifact-versions/missing/content",
        headers: { origin: "https://foreign.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject("/api/artifact-versions/missing/content")).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/tools/execute",
        payload: { command: "echo unsafe" },
      })
    ).statusCode,
    404,
  );
});

test("guardian disconnect settles owned commands without relaunch or stale PID signals", async (t) => {
  const s = await setup(t);
  const p = await s.processes.start(
    s.owner,
    { command: "sleep 60", background: true },
    s.signal,
  );
  const guardian = (s.processes as any).live.get(p.id).child;
  guardian.disconnect();
  await s.processes.wait(p.id, s.signal);
  assert.equal(s.processes.get(p.id).state, "failed");
  assert.match(s.processes.get(p.id).error ?? "", /supervisor/);
});
test("cancelling a waiting task stops its process and fences automatic continuation", async (t) => {
  const s = await setup(t);
  let n = 0;
  s.connections.toolRound = async (_snapshot, r) => {
    if (n++ === 0)
      return {
        text: "",
        calls: [
          {
            id: "start",
            name: "process_start",
            arguments: { command: "sleep 60", background: true },
          },
        ],
        continuation: [],
        usage: null,
      };
    const p = (r.continuation!.at(-1) as any).results[0].result.process;
    return {
      text: "",
      calls: [
        { id: "wait", name: "process_wait", arguments: { processId: p.id } },
      ],
      continuation: [],
      usage: null,
    };
  };
  (s.engine as any).options.autoStart = true;
  s.engine.wake();
  await until(() => s.engine.task(s.owner.taskId).status === "waiting");
  await s.engine.cancelTask(s.owner.taskId);
  assert.equal(s.engine.task(s.owner.taskId).status, "cancelled");
  assert.equal(
    (s.db.prepare("SELECT state FROM owned_processes").get() as any).state,
    "stopped",
  );
  assert.equal(n, 2);
});
test("restart fences parked turns queued for resumption and interrupted tool effects", async (t) => {
  const s = await setup(t);
  s.db
    .prepare(
      "UPDATE agent_turns SET status='queued',phase='waiting' WHERE id=?",
    )
    .run(s.owner.turnId);
  s.db
    .prepare(
      "INSERT INTO tool_invocations VALUES ('effect',?,'call','process_start','{}','running',NULL,?,?)",
    )
    .run(s.owner.turnId, new Date().toISOString(), new Date().toISOString());
  const secondConnections = new ConnectionService(s.db),
    second = new AgentExecution(s.db, secondConnections, { autoStart: false });
  assert.equal(
    (
      s.db
        .prepare("SELECT status FROM agent_turns WHERE id=?")
        .get(s.owner.turnId) as any
    ).status,
    "interrupted",
  );
  new AgentTools(s.db, s.files, s.processes, s.artifacts, () => {});
  assert.equal(
    (
      s.db
        .prepare("SELECT state FROM tool_invocations WHERE id='effect'")
        .get() as any
    ).state,
    "interrupted",
  );
  await second.close();
  await secondConnections.close();
});
test("confirmed agent and workspace deletions quiesce processes and preserve published file policy", async (t) => {
  const s = await setup(t),
    source = join(s.files.location("task", s.owner.taskId).path, "output.txt");
  await writeFile(source, "keep output");
  const v = await s.artifacts.publish(s.owner, { path: source }, s.signal);
  const p = await s.processes.start(
    s.owner,
    { command: "sleep 60", background: true },
    s.signal,
  );
  const operation = s.files.requestDeletion("agent", "a", true);
  await until(() => s.files.deletion(operation.id).state === "completed");
  assert.equal(
    s.db.prepare("SELECT id FROM agents WHERE id='a'").get(),
    undefined,
  );
  assert.equal(s.artifacts.get(v.id).producerAgentId, null);
  await s.artifacts.ready(v.id);
  const workspace = s.files.requestDeletion(
    "workspace",
    s.owner.workspaceId,
    true,
  );
  await until(() => s.files.deletion(workspace.id).state === "completed");
  assert.throws(() => s.artifacts.get(v.id), /not found/);
  assert.equal((s.processes as any).live.size, 0);
});

test("same-size artifact corruption is unavailable and interrupted staging is reconciled", async (t) => {
  const s = await setup(t),
    source = join(s.files.location("task", s.owner.taskId).path, "source.txt");
  await writeFile(source, "original");
  const version = await s.artifacts.publish(
    s.owner,
    { path: source },
    s.signal,
  );
  const root = join(
      s.files.root,
      "workspaces",
      s.owner.workspaceId,
      "artifacts",
    ),
    bytes = join(root, version.id, "bytes");
  await writeFile(bytes, "tampered");
  await assert.rejects(() => s.artifacts.ready(version.id), /not available/);
  assert.equal(s.artifacts.get(version.id).state, "unavailable");
  const stagingId = randomUUID();
  s.db
    .prepare(
      "INSERT INTO artifact_versions(id,artifactId,workspaceId,provenance,name,mediaType,size,state,createdAt) VALUES (?,?,?,'{}','pending','application/octet-stream',4,'staging',?)",
    )
    .run(
      stagingId,
      version.artifactId,
      s.owner.workspaceId,
      new Date().toISOString(),
    );
  await writeFile(join(root, `.staging-${stagingId}`), "test");
  await mkdir(join(root, stagingId));
  await writeFile(join(root, stagingId, "bytes"), "test");
  await s.artifacts.start();
  assert.equal(s.artifacts.get(stagingId).state, "failed");
  await assert.rejects(
    () => readFile(join(root, stagingId, "bytes")),
    /ENOENT/,
  );
  await assert.rejects(
    () => readFile(join(root, `.staging-${stagingId}`)),
    /ENOENT/,
  );
});
test("managed artifact symlinks cannot publish or clean external data", async (t) => {
  const s = await setup(t),
    external = join(s.directory, "external"),
    root = join(s.files.root, "workspaces", s.owner.workspaceId, "artifacts");
  await mkdir(external);
  await writeFile(join(external, "keep"), "outside");
  await symlink(external, root);
  const source = join(
    s.files.location("task", s.owner.taskId).path,
    "source.txt",
  );
  await writeFile(source, "input");
  await assert.rejects(
    () => s.artifacts.publish(s.owner, { path: source }, s.signal),
    /linked/,
  );
  assert.equal(await readFile(join(external, "keep"), "utf8"), "outside");
});

test("restart resumes confirmed workspace deletion without artifact recovery racing owner removal", async (t) => {
  const s = await setup(t),
    source = join(s.files.location("task", s.owner.taskId).path, "output.txt");
  await writeFile(source, "ready");
  const v = await s.artifacts.publish(s.owner, { path: source }, s.signal),
    id = randomUUID(),
    stamp = new Date().toISOString();
  s.db
    .prepare(
      "INSERT INTO deletion_operations(id,kind,ownerId,workspaceId,relativePath,state,createdAt,updatedAt) VALUES (?,'workspace',?,?,?,'pending',?,?)",
    )
    .run(
      id,
      s.owner.workspaceId,
      s.owner.workspaceId,
      `workspaces/${s.owner.workspaceId}`,
      stamp,
      stamp,
    );
  const app = createApp({
    databasePath: s.path,
    filesRoot: s.files.root,
    execution: { autoStart: false },
  });
  try {
    await app.ready();
    await until(
      () =>
        (
          s.db
            .prepare("SELECT state FROM deletion_operations WHERE id=?")
            .get(id) as any
        ).state === "completed",
    );
    assert.equal(
      s.db.prepare("SELECT id FROM artifact_versions WHERE id=?").get(v.id),
      undefined,
    );
  } finally {
    await app.close();
  }
});
test("workspace cleanup closes active artifact streams and forbids new downloads after quiesce", async (t) => {
  const s = await setup(t),
    source = join(s.files.location("task", s.owner.taskId).path, "output.txt");
  await writeFile(source, "published");
  const v = await s.artifacts.publish(s.owner, { path: source }, s.signal),
    download = await s.artifacts.download(v.id);
  await s.artifacts.settleWorkspace(s.owner.workspaceId);
  assert.equal(download.stream.closed, true);
  await s.artifacts.quiesce();
  await assert.rejects(() => s.artifacts.download(v.id), /shutting down/);
});

test("activity API pages newest-first and refreshes by validated ascending sequence cursor", async (t) => {
  const s = await setup(t);
  for (const text of ["first", "second", "third"])
    s.tools.item(s.owner, "commentary", text);
  const app = createApp({
    databasePath: s.path,
    filesRoot: s.files.root,
    execution: { autoStart: false },
  });
  try {
    await app.ready();
    const initial = (
      await app.inject(`/api/tasks/${s.owner.taskId}/activity?limit=1`)
    ).json();
    assert.equal(initial.items[0].content, "third");
    assert.equal(initial.total, 3);
    const first = (
      s.db.prepare("SELECT min(sequence) AS n FROM execution_items").get() as {
        n: number;
      }
    ).n;
    const update = (
      await app.inject(`/api/tasks/${s.owner.taskId}/activity?after=${first}`)
    ).json();
    assert.deepEqual(
      update.items.map((i: any) => i.content),
      ["second", "third"],
    );
    assert.equal(
      (await app.inject(`/api/tasks/${s.owner.taskId}/activity?after=-1`))
        .statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});

test("instruction updates are owned, bounded, recorded, replay-safe and clearable", async (t) => {
  const s = await setup(t);
  const before = s.engine.requiredAgent("a");
  const events: string[] = [];
  (s.tools as any).changed = (id: string) => events.push(id);
  const call = { id: "instructions", name: "agent_update_instructions", arguments: { instructions: "Keep responses concise.", expectedRevision: before.revision } };
  const result = await s.tools.dispatch(s.owner, call, s.signal, async () => {});
  assert.equal(result.ok, true);
  assert.equal(s.engine.requiredAgent("a").instructions, call.arguments.instructions);
  assert.equal(s.engine.requiredAgent("a").revision, before.revision + 1);
  assert.equal(s.engine.requiredAgent("b").instructions, "Use tools");
  assert.deepEqual(events, [s.owner.workspaceId, s.owner.workspaceId, s.owner.workspaceId]);
  assert.deepEqual(await s.tools.dispatch(s.owner, call, s.signal, async () => {}), result);
  assert.equal(events.length, 3);
  assert.equal(s.engine.requiredAgent("a").revision, before.revision + 1);
  assert.equal((s.db.prepare("SELECT state FROM tool_invocations WHERE callId='instructions'").get() as any).state, "completed");
  const reopened = openDatabase(s.path);
  try { assert.equal((reopened.prepare("SELECT instructions FROM agents WHERE id='a'").get() as any).instructions, call.arguments.instructions); }
  finally { reopened.close(); }
  for (const [i, args] of [
    { instructions: "x".repeat(8001) },
    { instructions: null },
    { instructions: "Other", agentId: "b" },
  ].entries()) {
    const bad = await s.tools.dispatch(s.owner, { ...call, id: `invalid-${i}`, arguments: args }, s.signal, async () => {});
    assert.equal(bad.ok, false);
  }
  const spoofed = await s.tools.dispatch({ ...s.owner, agentId: "b" }, { ...call, id: "foreign" }, s.signal, async () => {});
  assert.equal(spoofed.ok, false);
  assert.equal(s.engine.requiredAgent("b").instructions, "Use tools");
  const foreign = s.engine.submit("b", "new", "Foreign task", randomUUID());
  const statusResult = await s.tools.dispatch({ ...s.owner, turnId: foreign.turnId }, { ...call, id: "foreign-turn" }, s.signal, async () => {});
  assert.equal(statusResult.ok, false);
  const boundary = await s.tools.dispatch(s.owner, { ...call, id: "boundary", arguments: { instructions: "x".repeat(8000), expectedRevision: s.engine.requiredAgent("a").revision } }, s.signal, async () => {});
  assert.equal(boundary.ok, true);
  const clear = await s.tools.dispatch(s.owner, { ...call, id: "clear", arguments: { instructions: "", expectedRevision: s.engine.requiredAgent("a").revision } }, s.signal, async () => {});
  assert.equal(clear.ok, true);
  assert.equal(s.engine.requiredAgent("a").instructions, "");
});

test("self-updated instructions keep the running snapshot and reach subsequent ordinary turns", async (t) => {
  const s = await setup(t);
  const seen: string[] = [];
  let round = 0;
  s.connections.toolRound = async (snapshot, request): Promise<ToolRound> => {
    seen.push(snapshot.instructions);
    assert.ok(request.tools.some((tool) => tool.name === "agent_update_instructions"));
    return {
      text: "Done",
      calls: round++ === 0 ? [{ id: "self-update", name: "agent_update_instructions", arguments: { instructions: "Use short paragraphs.", expectedRevision: s.engine.requiredAgent("a").revision } }] : [],
      continuation: [], usage: null,
    };
  };
  (s.engine as any).options.autoStart = true;
  s.engine.wake();
  await until(() => s.engine.task(s.owner.taskId).status === "completed");
  assert.deepEqual(seen, ["Use tools", "Use tools"]);
  const next = s.engine.submit("a", "new", "Follow up", randomUUID());
  await until(() => s.engine.task(next.taskId!).status === "completed");
  assert.equal(seen.at(-1), "Use short paragraphs.");
});

test("Chat executes tools alongside work, inspects current tasks and saves its own instructions", async t => {
  const s = await setup(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let workStarted = false;
  const chatInputs: string[] = [];
  s.connections.toolRound = async (_snapshot, request): Promise<ToolRound> => {
    if (!request.instructions.includes("Main agent Chat")) {
      workStarted = true;
      await gate;
      return { text: "Work done", calls: [], continuation: [], usage: null };
    }
    chatInputs.push(request.messages.at(-1)!.content);
    const info = await request.onTool({ id: "inspect", name: "agent_inspect", arguments: { limit: 1 } });
    assert.equal(info.ok, true);
    assert.equal((info.tasks as any[])[0].id, s.owner.taskId);
    assert.equal((info.tasks as any[])[0].status, "running");
    assert.match(request.instructions, new RegExp(s.owner.taskId));
    const written = await request.onTool({ id: "write", name: "files_write", arguments: { path: "chat.txt", text: "Made in Chat", expectedSha256: null } });
    assert.equal(written.ok, true);
    const updated = await request.onTool({ id: "role", name: "agent_update_instructions", arguments: { instructions: "Be a helpful researcher.", expectedRevision: (info.agent as any).revision } });
    assert.equal(updated.ok, true);
    return { text: "Done in Chat", calls: [], continuation: [], usage: null };
  };
  (s.engine as any).options.autoStart = true;
  s.engine.wake();
  await until(() => workStarted);
  const chat = s.engine.submit("a", "chat", "Set your role and make a file", randomUUID());
  await until(() => s.engine.task(chat.taskId!).status === "completed");
  assert.equal(s.engine.task(s.owner.taskId).status, "running");
  assert.equal(s.engine.requiredAgent("a").runningTaskCount, 1);
  assert.equal(s.engine.requiredAgent("a").instructions, "Be a helpful researcher.");
  assert.equal(await readFile(join(s.files.location("task", chat.taskId!).path, "chat.txt"), "utf8"), "Made in Chat");
  assert.deepEqual(chatInputs, ["Set your role and make a file"]);
  release();
  await until(() => s.engine.task(s.owner.taskId).status === "completed");
});

test("inspection is fresh, paginated and agent-owned; stale instruction tools cannot overwrite changes", async t => {
  const s = await setup(t);
  const dispatch = (id: string, name: string, args: Record<string, unknown>) => s.tools.dispatch(s.owner, { id, name, arguments: args }, s.signal, async () => ({}));
  const first = await dispatch("initial", "agent_inspect", { limit: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.total, 1);
  const revision = (first.agent as any).revision;
  s.db.prepare("UPDATE agent_tasks SET status='completed',summary='Finished externally' WHERE id=?").run(s.owner.taskId);
  s.db.prepare("UPDATE agents SET instructions='Saved in Configuration',revision=revision+1 WHERE id='a'").run();
  const stale = await dispatch("stale", "agent_update_instructions", { instructions: "Old change", expectedRevision: revision });
  assert.equal(stale.ok, false);
  assert.match(String(stale.error), /changed/);
  assert.equal(s.engine.requiredAgent("a").instructions, "Saved in Configuration");
  const fresh = await dispatch("fresh", "agent_inspect", { limit: 1 });
  assert.equal((fresh.tasks as any[])[0].status, "completed");
  assert.equal((fresh.agent as any).instructions, "Saved in Configuration");
  const own = await dispatch("read-own", "agent_task_read", { taskId: s.owner.taskId, limit: 1 });
  assert.equal(own.ok, true);
  assert.equal((own.messages as any[])[0].content, "Make a file");
  const next = await dispatch("read-later", "agent_task_read", { taskId: s.owner.taskId, afterSequence: (own.messages as any[])[0].sequence });
  assert.deepEqual(next.messages, []);
  const foreign = s.engine.submit("b", "new", "Private work", randomUUID());
  assert.equal((await dispatch("read-foreign", "agent_task_read", { taskId: foreign.taskId })).ok, false);
  assert.deepEqual((await dispatch("next-page", "agent_inspect", { offset: 1, limit: 1 })).tasks, []);
});

test("commands have no elapsed deadline and more than eight processes can run together", async t => {
  const s = await setup(t);
  const processes = [];
  for (let i = 0; i < 9; i++) processes.push(await s.processes.start(s.owner, { command: "sleep 60", yieldMs: 0 }, s.signal));
  await until(() => processes.every(p => s.processes.get(p.id).state === "running"));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    t.mock.timers.tick(7 * 86400000);
    assert.ok(processes.every(p => s.processes.get(p.id).state === "running"));
  } finally { t.mock.timers.reset(); }
  await Promise.all(processes.map(p => s.processes.stop(p.id)));
  assert.ok(processes.every(p => s.processes.get(p.id).state === "stopped"));
});

test("a turn can execute more than 32 rounds and 128 validated tools", async t => {
  const s = await setup(t);
  s.db.exec("UPDATE provider_models SET contextWindowOverride=2000000");
  let calls = 0;
  s.connections.toolRound = async () => ({
    text: calls >= 130 ? "Done" : "",
    calls: calls >= 130 ? [] : [{ id: `unbounded-${calls++}`, name: "files_list", arguments: { path: ".", limit: 1 } }],
    continuation: [], usage: null,
  });
  s.engine.pump();
  await until(() => s.engine.task(s.owner.taskId).status === "completed");
  assert.equal(calls, 130);
  assert.equal((s.db.prepare("SELECT count(*) n FROM tool_invocations WHERE turnId=?").get(s.owner.turnId) as any).n, 130);
});

for (const successful of [true,false]) test(`completion classifier receives ${successful ? "successful" : "failed"} file evidence despite a terse final answer`,async t=>{
  const s=await setup(t);
  let inspected=false;
  s.connections.toolRound=async (_snapshot,request)=>({
    text:request.continuation?.length ? "DONE_TOKEN" : "",
    calls:request.continuation?.length ? [] : [{id:"write-evidence",name:"files_write",arguments:{path:"completion.txt",text:"EXACT_CONTENT",expectedSha256:successful ? null : "0".repeat(64)}}],
    continuation:[],usage:null,
  });
  s.connections.generate=async (_snapshot,request)=>{
    assert.ok(request.instructions.startsWith("Maintain this task"));
    assert.match(request.instructions,/Committed successful tool results/);
    assert.match(request.instructions,/cannot establish preferences/);
    const data=JSON.parse(request.messages[0]!.content);
    assert.equal(data.messages[1].content,"DONE_TOKEN");
    assert.equal(data.toolEvidence.tools.length,1);
    const evidence=data.toolEvidence.tools[0];
    assert.equal(evidence.name,"files_write");
    assert.equal(evidence.arguments.path,"completion.txt");
    assert.equal(evidence.arguments.text,"EXACT_CONTENT");
    assert.equal(evidence.result.ok,successful);
    assert.equal(evidence.currentTurn,true);
    assert.ok(!("tools" in request));
    inspected=true;
    return {text:JSON.stringify({status:successful ? "completed" : "awaiting_user",summary:successful ? "File write succeeded" : "The file was not written",memories:[]}),finishReason:"stop",usage:null};
  };
  (s.engine as any).options.autoStart=true;s.engine.wake();
  await until(()=>["completed","awaiting_user"].includes(s.engine.task(s.owner.taskId).status));
  assert.equal(inspected,true);
  assert.equal(s.engine.task(s.owner.taskId).status,successful ? "completed" : "awaiting_user");
  if(successful) assert.equal(await readFile(join(s.files.location("task",s.owner.taskId).path,"completion.txt"),"utf8"),"EXACT_CONTENT");
  else await assert.rejects(readFile(join(s.files.location("task",s.owner.taskId).path,"completion.txt")),/ENOENT/);
});
