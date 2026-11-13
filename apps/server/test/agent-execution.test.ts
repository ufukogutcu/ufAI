import { deleteOwner } from "./deletion-helper.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../src/database.js";
import { ConnectionService } from "../src/connection-service.js";
import { AgentExecution } from "../src/agent-execution.js";
import { createApp } from "../src/app.js";
import type {
  ExecutionSnapshot,
  TextRequest,
  TextResult,
} from "../src/execution-types.js";

const result = (text: string): TextResult => ({
  text,
  finishReason: "stop",
  usage: null,
});
const maintenance = JSON.stringify({
  status: "completed",
  summary: "Finished the requested answer.",
  memories: [],
});
function setup(
  generate: (r: TextRequest) => Promise<TextResult>,
  autoStart = true,
) {
  const db = openDatabase(":memory:");
  const ts = new Date().toISOString();
  const workspace = (
    db.prepare("SELECT id FROM workspaces LIMIT 1").get() as any
  ).id;
  db.prepare(
    "INSERT INTO connections(id,provider,name,createdAt,updatedAt,draft) VALUES ('connection','openai-compatible','Local',?,?,0)",
  ).run(ts, ts);
  db.prepare(
    "INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES ('connection','model','Model',1,32000)",
  ).run();
  db.prepare(
    "INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES ('preset','Preset','connection','model',?,?)",
  ).run(ts, ts);
  for (const id of ["a", "b"])
    db.prepare(
      "INSERT INTO agents(id,workspaceId,name,instructions,presetId,createdAt,updatedAt) VALUES (?,?,?,'Be useful.','preset',?,?)",
    ).run(id, workspace, id, ts, ts);
  const connections = new ConnectionService(db);
  connections.generate = async (_s: ExecutionSnapshot, r: TextRequest) =>
    r.instructions.startsWith("Maintain this task")
      ? result(maintenance)
      : generate(r);
  connections.countTokens = async (_s, r) =>
    Buffer.byteLength(JSON.stringify([r.instructions, r.messages]));
  const engine = new AgentExecution(db, connections, {
    autoStart,
    callTimeoutMs: 2000,
  });
  return {
    db,
    connections,
    engine,
    workspace,
    async close() {
      await engine.close();
      await connections.close();
      db.close();
    },
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for execution.");
}

test("submissions are durable, deduplicated, and task contexts include prior replies even when follow-ups were queued early", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const calls: TextRequest[] = [];
  const f = setup(async (r) => {
    calls.push(r);
    if (calls.length === 1) await gate;
    r.onDelta?.("Answer");
    return result("Answer");
  });
  t.after(() => f.close());
  const first = f.engine.submit("a", "new", "First question", "request_first");
  assert.deepEqual(
    f.engine.submit("a", "new", "First question", "request_first"),
    first,
  );
  assert.throws(
    () => f.engine.submit("a", "new", "Different question", "request_first"),
    /different input/,
  );
  await until(() => calls.length === 1);
  f.engine.submit("a", first.taskId!, "Follow up", "request_second");
  assert.equal(calls.length, 1);
  release();
  await until(() => f.engine.task(first.taskId!).status === "completed");
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1]!.messages.map((m) => m.content),
    ["First question", "Answer", "Follow up"],
  );
});

test("a reserved read-only status lane answers while ordinary work is running", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const calls: TextRequest[] = [];
  const f = setup(async (r) => {
    calls.push(r);
    if (!r.instructions.includes("Read-only workload")) await gate;
    return result("Status or answer");
  });
  t.after(() => f.close());
  const task = f.engine.submit("a", "new", "Work now", "work_request");
  await until(() => calls.length === 1);
  const status = f.engine.submit(
    "a",
    "status",
    "What are you doing?",
    "status_request",
  );
  await until(
    () =>
      (
        f.db
          .prepare("SELECT status FROM agent_turns WHERE id=?")
          .get(status.turnId) as any
      ).status === "completed",
  );
  assert.equal(f.engine.task(task.taskId!).status, "running");
  assert.match(calls[1]!.instructions, /Work now/);
  assert.equal(f.engine.memories("a").length, 0);
  release();
});

test("task isolation, per-agent serialization, cross-connection concurrency, and live preset snapshots", async (t) => {
  const calls: TextRequest[] = [];
  const f = setup(async (r) => {
    calls.push(r);
    return result("Answer");
  });
  t.after(() => f.close());
  const first = f.engine.submit(
    "a",
    "new",
    "Secret from task one",
    "first_request",
  );
  await until(() => f.engine.task(first.taskId!).status === "completed");
  f.db
    .prepare(
      "UPDATE agents SET instructions='Updated instructions',revision=revision+1 WHERE id='a'",
    )
    .run();
  const second = f.engine.submit(
    "a",
    "new",
    "Different work",
    "second_request",
  );
  await until(() => f.engine.task(second.taskId!).status === "completed");
  assert.equal(calls[1]!.messages.length, 1);
  assert.match(calls[1]!.instructions, /Updated instructions/);
  const snapshot = JSON.parse(
    (
      f.db
        .prepare("SELECT snapshot FROM agent_turns WHERE id=?")
        .get(first.turnId) as any
    ).snapshot,
  );
  assert.equal(snapshot.instructions, "Be useful.");
  assert.ok(!("credential" in snapshot));
});

test("cancellation rejects late results and preserves partial output", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const f = setup(async (r) => {
    r.onDelta?.("partial");
    await gate;
    return result("late complete");
  });
  t.after(() => f.close());
  const x = f.engine.submit("a", "new", "Question", "cancel_request");
  await until(
    () =>
      !!f.db
        .prepare("SELECT id FROM agent_messages WHERE role='assistant'")
        .get(),
  );
  const stopping = f.engine.cancelTask(x.taskId!);
  release();
  await stopping;
  assert.equal(f.engine.task(x.taskId!).status, "cancelled");
  const m = f.db
    .prepare("SELECT state FROM agent_messages WHERE role='assistant'")
    .get() as any;
  assert.equal(m.state, "incomplete");
});

test("queued jobs survive reopening and interrupted generations require explicit retry", async (t) => {
  const f = setup(async () => result("Answer"), false);
  t.after(() => f.close());
  const x = f.engine.submit("a", "new", "Queued", "restart_request");
  f.db
    .prepare("UPDATE agent_turns SET status='running' WHERE id=?")
    .run(x.turnId);
  const recovered = new AgentExecution(f.db, f.connections, {
    autoStart: false,
  });
  assert.equal(recovered.task(x.taskId!).status, "failed");
  const retry = recovered.retry(x.taskId!);
  assert.notEqual(retry.turnId, x.turnId);
  assert.equal(
    (
      f.db
        .prepare("SELECT inputMessageId FROM agent_turns WHERE id=?")
        .get(x.turnId) as any
    ).inputMessageId,
    (
      f.db
        .prepare("SELECT inputMessageId FROM agent_turns WHERE id=?")
        .get(retry.turnId) as any
    ).inputMessageId,
  );
  await recovered.close();
});

test("missing/disabled configuration blocks tasks and retry resolves the current preset", async (t) => {
  const f = setup(async () => result("Answer"));
  t.after(() => f.close());
  f.db.prepare("UPDATE model_presets SET modelId=NULL WHERE id='preset'").run();
  const x = f.engine.submit("a", "new", "Question", "blocked_request");
  await until(() => f.engine.task(x.taskId!).status === "blocked");
  f.db
    .prepare("UPDATE model_presets SET modelId='model' WHERE id='preset'")
    .run();
  f.engine.retry(x.taskId!);
  await until(() => f.engine.task(x.taskId!).status === "completed");
});

test("agent APIs validate private access, relationships, pagination, and workspace deletion", async (t) => {
  const app = createApp({
    databasePath: ":memory:",
    serveStatic: false,
    execution: { autoStart: false },
  });
  t.after(() => app.close());
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const created = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspace}/agents`,
    payload: { name: "Researcher" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const agent = created.json();
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}`,
        headers: { origin: "https://evil.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/agents/${agent.id}`,
        payload: { x: 22, y: 33 },
      })
    ).json().x,
    22,
  );
  const task = await app.inject({
    method: "POST",
    url: `/api/agents/${agent.id}/tasks`,
    payload: { content: "Hello", requestId: "unique_request" },
  });
  assert.equal(task.statusCode, 202, task.body);
  assert.equal(
    (await app.inject(`/api/tasks/${task.json().taskId}/messages`)).json()
      .total,
    1,
  );
  assert.equal(
    (await deleteOwner(app, `/api/workspaces/${workspace}`)).statusCode,
    202,
  );
  assert.equal((await app.inject(`/api/agents/${agent.id}`)).statusCode, 404);
});

test("automatic memory retains evidence, recall crosses task boundaries, and deleted memories do not return", async (t) => {
  const calls: TextRequest[] = [];
  const f = setup(async (r) => {
    calls.push(r);
    return result("You prefer concise answers.");
  });
  t.after(() => f.close());
  f.connections.generate = async (_s, r) => {
    if (r.instructions.startsWith("Maintain this task")) {
      const data = JSON.parse(r.messages[0]!.content);
      return result(
        JSON.stringify({
          status: "completed",
          summary: "User prefers concise replies.",
          memories: [
            {
              key: "answer length",
              kind: "preference",
              content: "Prefer concise replies.",
              sources: [data.messages[0].id],
            },
          ],
        }),
      );
    }
    if (r.instructions.startsWith("Select up to"))
      return result('{"taskIds":[]}');
    calls.push(r);
    return result("You prefer concise answers.");
  };
  const first = f.engine.submit(
    "a",
    "new",
    "Please keep answers concise",
    "memory_request",
  );
  await until(() => f.engine.task(first.taskId!).status === "completed");
  const m = f.engine.memories("a")[0]!;
  assert.equal(m.kind, "preference");
  assert.equal(m.sources.length, 1);
  const second = f.engine.submit(
    "a",
    "new",
    "Now answer another question",
    "memory_request2",
  );
  await until(() => f.engine.task(second.taskId!).status === "completed");
  assert.match(calls[1]!.instructions, /Prefer concise replies/);
  f.db
    .prepare(
      "UPDATE agent_memories SET deleted=1,revision=revision+1 WHERE id=?",
    )
    .run(m.id);
  const third = f.engine.submit(
    "a",
    "new",
    "Continue please",
    "memory_request3",
  );
  await until(() => f.engine.task(third.taskId!).status === "completed");
  assert.equal(f.engine.memories("a").length, 0);
});

test("maintenance validates schema, repairs once, and preserves answers if repair fails", async (t) => {
  let maintenanceCalls = 0;
  const f = setup(async () => result("Good answer"));
  t.after(() => f.close());
  f.connections.generate = async (_s, r) =>
    r.instructions.startsWith("Maintain this task")
      ? (maintenanceCalls++, result('{"status":"invented","memories":[]}'))
      : result("Good answer");
  const x = f.engine.submit("a", "new", "Question", "maintenance_request");
  await until(() => f.engine.task(x.taskId!).status === "awaiting_user");
  assert.equal(maintenanceCalls, 2);
  assert.equal(f.engine.memories("a").length, 0);
  assert.equal(
    (
      f.db
        .prepare("SELECT content FROM agent_messages WHERE role='assistant'")
        .get() as any
    ).content,
    "Good answer",
  );
});

test("manual memory edits during maintenance win over stale automatic output", async (t) => {
  const f = setup(async () => result("Answer"));
  t.after(() => f.close());
  const ts = new Date().toISOString();
  f.db
    .prepare(
      "INSERT INTO agent_memories(id,agentId,key,content,kind,sources,createdAt,updatedAt) VALUES ('memory','a','style','Old','preference','[]',?,?)",
    )
    .run(ts, ts);
  f.connections.generate = async (_s, r) => {
    if (r.instructions.startsWith("Maintain this task")) {
      const data = JSON.parse(r.messages[0]!.content);
      f.db
        .prepare(
          "UPDATE agent_memories SET content='Manual correction',revision=revision+1 WHERE id='memory'",
        )
        .run();
      return result(
        JSON.stringify({
          status: "completed",
          summary: "Done",
          memories: [
            {
              key: "style",
              kind: "preference",
              content: "Stale output",
              sources: [data.messages[0].id],
            },
          ],
        }),
      );
    }
    return result("Answer");
  };
  const x = f.engine.submit("a", "new", "Question", "manual_memory_request");
  await until(() => f.engine.task(x.taskId!).status === "completed");
  assert.equal(f.engine.memories("a")[0]!.content, "Manual correction");
});

test("compaction preserves full transcripts and covers complete exchanges before a later turn", async (t) => {
  const f = setup(async () => result("A".repeat(700)));
  t.after(() => f.close());
  f.db.prepare("UPDATE provider_models SET contextWindowOverride=8000").run();
  f.db
    .prepare(
      "UPDATE model_presets SET compactionMode='tokens',compactionValue=2200",
    )
    .run();
  let compactions = 0,
    sawAttachmentMetadata = false;
  f.connections.generate = async (_s, r) => {
    if (r.instructions.startsWith("Summarize earlier")) {
      compactions++;
      sawAttachmentMetadata ||=
        r.messages[0]!.content.includes("retained-version");
      return result("Earlier questions were answered.");
    }
    if (r.instructions.startsWith("Maintain this task"))
      return result(maintenance);
    if (r.instructions.startsWith("Select up to"))
      return result('{"taskIds":[]}');
    return result("A".repeat(700));
  };
  const x = f.engine.submit(
    "a",
    "new",
    "Question ".repeat(40),
    "compact_request",
  );
  await until(() => f.engine.task(x.taskId!).status === "completed");
  f.db
    .prepare("INSERT INTO artifacts VALUES ('artifact',?,'report',?)")
    .run(f.workspace, new Date().toISOString());
  f.db
    .prepare(
      "INSERT INTO artifact_versions(id,artifactId,workspaceId,producerAgentId,producerTaskId,provenance,name,mediaType,size,state,createdAt) VALUES ('retained-version','artifact',?,'a',?,'{}','report','text/plain',1,'ready',?)",
    )
    .run(f.workspace, x.taskId, new Date().toISOString());
  const output = f.db
    .prepare(
      "SELECT id FROM agent_messages WHERE turnId=? AND role='assistant'",
    )
    .get(x.turnId) as { id: string };
  f.db
    .prepare(
      "INSERT INTO artifact_references(versionId,messageId,ordinal) VALUES ('retained-version',?,0)",
    )
    .run(output.id);
  f.db
    .prepare(
      "INSERT INTO artifact_versions(id,artifactId,workspaceId,provenance,name,mediaType,size,state,createdAt,origin) SELECT 'delegated-version',artifactId,workspaceId,'{}','received.bin','application/octet-stream',1,'ready',createdAt,'inspection' FROM artifact_versions WHERE id='retained-version'",
    )
    .run();
  f.db
    .prepare("INSERT INTO artifact_grants VALUES (?,'delegated-version',NULL)")
    .run(x.taskId);
  for (let i = 0; i < 4; i++) {
    f.engine.submit(
      "a",
      x.taskId!,
      "Follow up ".repeat(30),
      `compact_follow_${i}`,
    );
    await until(() => f.engine.task(x.taskId!).status === "completed");
  }
  assert.ok(compactions > 0);
  assert.equal(sawAttachmentMetadata, true);
  assert.match(
    (
      f.db
        .prepare(
          "SELECT content FROM agent_context_summaries ORDER BY version DESC LIMIT 1",
        )
        .get() as { content: string }
    ).content,
    /retained-version/,
  );
  assert.match(
    (
      f.db
        .prepare(
          "SELECT content FROM agent_context_summaries ORDER BY version DESC LIMIT 1",
        )
        .get() as any
    ).content,
    /delegated-version/,
  );
  assert.equal(
    (f.db.prepare("SELECT count(*) AS n FROM agent_messages").get() as any).n,
    10,
  );
  assert.ok(
    (
      f.db
        .prepare("SELECT count(*) AS n FROM agent_context_summaries")
        .get() as any
    ).n > 0,
  );
});

test("a committed answer resumes maintenance after recovery without generating another reply", async (t) => {
  let ordinary = 0;
  const f = setup(async () => {
    ordinary++;
    return result("Answer");
  }, false);
  t.after(() => f.close());
  const x = f.engine.submit("a", "new", "Question", "recover_maintenance");
  const snapshot = f.connections.snapshot(f.engine.requiredAgent("a"));
  f.db
    .prepare(
      "UPDATE agent_turns SET status='running',phase='maintenance',snapshot=? WHERE id=?",
    )
    .run(JSON.stringify(snapshot), x.turnId);
  f.db
    .prepare(
      "INSERT INTO agent_messages(id,conversationId,turnId,role,content,state,createdAt) SELECT 'saved-reply',conversationId,id,'assistant','Already saved','complete',createdAt FROM agent_turns WHERE id=?",
    )
    .run(x.turnId);
  const recovered = new AgentExecution(f.db, f.connections);
  t.after(() => recovered.close());
  await until(() => recovered.task(x.taskId!).status === "completed");
  assert.equal(ordinary, 0);
});

test("ordinary work on different connections runs concurrently and the same agent stays serial", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let active = 0,
    max = 0;
  const f = setup(async () => {
    active++;
    max = Math.max(max, active);
    await gate;
    active--;
    return result("Answer");
  });
  t.after(() => f.close());
  f.db
    .prepare(
      "INSERT INTO connections SELECT 'connection2',provider,name,endpoint,credential,createdAt,updatedAt,draft FROM connections WHERE id='connection'",
    )
    .run();
  f.db
    .prepare(
      "INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES ('connection2','model','Model',1,32000)",
    )
    .run();
  f.db
    .prepare(
      "INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES ('preset2','Other','connection2','model','now','now')",
    )
    .run();
  f.db.prepare("UPDATE agents SET presetId='preset2' WHERE id='b'").run();
  f.engine.submit("a", "new", "A one", "concurrent_a1");
  f.engine.submit("a", "new", "A two", "concurrent_a2");
  f.engine.submit("b", "new", "B one", "concurrent_b1");
  await until(() => active === 2);
  assert.equal(max, 2);
  release();
});

test("SSE reconnects replay changes and expired cursors request a snapshot resync", async (t) => {
  const app = createApp({
    databasePath: ":memory:",
    serveStatic: false,
    execution: { autoStart: false },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const url = app.listeningOrigin;
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const agent = (
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace}/agents`,
      payload: { name: "Live" },
    })
  ).json();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${url}/api/events?workspaceId=${workspace}`, {
    signal: controller.signal,
  });
  assert.match(response.headers.get("content-type") ?? "", /event-stream/);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: resync/);
  const cursor = Number(first.match(/id: (\d+)/)![1]);
  await app.inject({
    method: "PATCH",
    url: `/api/agents/${agent.id}`,
    payload: { name: "Updated" },
  });
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /event: change/);
  assert.match(next, /changed/);
  await reader.cancel();
  const replay = await fetch(
    `${url}/api/events?workspaceId=${workspace}&after=${cursor}`,
  );
  const replayReader = replay.body!.getReader();
  assert.match(
    new TextDecoder().decode((await replayReader.read()).value),
    /event: change/,
  );
  await replayReader.cancel();
  const expired = await fetch(
    `${url}/api/events?workspaceId=${workspace}&after=999999`,
  );
  const expiredReader = expired.body!.getReader();
  assert.match(
    new TextDecoder().decode((await expiredReader.read()).value),
    /event: resync/,
  );
  await expiredReader.cancel();
});
