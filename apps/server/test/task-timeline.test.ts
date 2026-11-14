import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { ConnectionService } from "../src/connection-service.js";
import { AgentExecution } from "../src/agent-execution.js";
import { taskTimeline } from "../src/task-timeline.js";
import { createApp } from "../src/app.js";

function setup(t: TestContext, path = ":memory:") {
  const db = openDatabase(path),
    stamp = "2026-01-01T00:00:00.000Z";
  const workspaceId = (
    db.prepare("SELECT id FROM workspaces").get() as { id: string }
  ).id;
  db.prepare(
    "INSERT INTO agents(id,workspaceId,name,instructions,createdAt,updatedAt) VALUES ('a',?,'Agent','',?,?)",
  ).run(workspaceId, stamp, stamp);
  const connections = new ConnectionService(db),
    execution = new AgentExecution(db, connections, { autoStart: false });
  const submitted = execution.submit("a", "new", "Start here", "request_00001");
  const task = execution.task(submitted.taskId!);
  db.prepare(
    "UPDATE agent_messages SET createdAt=? WHERE conversationId=?",
  ).run(stamp, task.conversationId);
  t.after(async () => {
    await execution.close();
    await connections.close();
    db.close();
  });
  const turnId = submitted.turnId;
  function item(id: string, kind: string, content: unknown, time = 1) {
    db.prepare(
      "INSERT INTO execution_items(id,workspaceId,agentId,taskId,turnId,kind,content,createdAt) VALUES (?,?,'a',?,?,?,?,?)",
    ).run(
      id,
      workspaceId,
      task.id,
      turnId,
      kind,
      typeof content === "string" ? content : JSON.stringify(content),
      `2026-01-01T00:00:0${time}.000Z`,
    );
  }
  function answer(content: string, state = "streaming") {
    db.prepare(
      "INSERT INTO agent_messages(id,conversationId,turnId,role,content,state,createdAt) VALUES ('answer',?,?,'assistant',?,?,?)",
    ).run(task.conversationId, turnId, content, state, stamp);
  }
  function call(
    id = "call",
    name = "files_read",
    args: Record<string, unknown> = { path: "guide.md" },
  ) {
    item(id, "tool_call", { id, name, arguments: args }, 2);
    db.prepare(
      "INSERT INTO tool_invocations VALUES (?,?,?,?,?,'running',NULL,?,?)",
    ).run(id, turnId, id, name, JSON.stringify(args), stamp, stamp);
  }
  const page = (limit = 50, before = "", watch: string[] = []) =>
    taskTimeline(db, execution, task.id, limit, before, watch);
  return {
    db,
    execution,
    connections,
    workspaceId,
    task,
    turnId,
    item,
    answer,
    call,
    page,
  };
}
test("text segments retain identity as live text becomes commentary; final follows tools", async (t) => {
  const s = setup(t);
  s.answer("I'll read the guide.");
  const live = s.page().items.at(-1)!;
  s.item("comment", "commentary", "I'll read the guide.");
  s.call();
  s.db.prepare("UPDATE agent_messages SET content='' WHERE id='answer'").run();
  const during = s.page();
  assert.equal(
    during.items.find((i) => i.message?.role === "assistant")?.id,
    live.id,
  );
  assert.deepEqual(
    during.items.map((i) => i.kind),
    ["message", "message", "action"],
  );
  s.db
    .prepare(
      "UPDATE tool_invocations SET state='completed',result=? WHERE callId='call'",
    )
    .run(JSON.stringify({ ok: true, text: "Guide" }));
  s.db
    .prepare(
      "UPDATE agent_messages SET content='Here is the answer.',state='complete' WHERE id='answer'",
    )
    .run();
  s.item("final", "final", "Here is the answer.", 3);
  const done = s.page();
  assert.equal(done.items.at(-1)?.message?.content, "Here is the answer.");
  assert.equal(
    done.items.filter((i) => i.message?.content === "Here is the answer.")
      .length,
    1,
  );
  assert.equal(
    done.items.find((i) => i.name === "files_read")?.status,
    "completed",
  );
});
test("terminal turn states settle unfinished tools and preserve redacted input", async (t) => {
  const s = setup(t);
  s.call("call", "process_input", { processId: "p", data: "[input omitted]" });
  s.db
    .prepare("UPDATE tool_invocations SET arguments=?")
    .run(JSON.stringify({ data: "SECRET" }));
  assert.equal(s.page().items.at(-1)?.status, "waiting");
  s.db.prepare("UPDATE agent_turns SET status='running'").run();
  assert.equal(s.page().items.at(-1)?.status, "running");
  s.db.prepare("UPDATE agent_turns SET status='cancelled'").run();
  assert.equal(s.page().items.at(-1)?.status, "cancelled");
  s.db
    .prepare("UPDATE tool_invocations SET state='interrupted',result=?")
    .run('{"ok":false,"error":"Interrupted"}');
  assert.equal(s.page().items.at(-1)?.status, "cancelled");
  s.db.prepare("UPDATE agent_turns SET status='superseded'").run();
  assert.equal(s.page().items.at(-1)?.status, "interrupted");
  assert.ok(!JSON.stringify(s.page()).includes("SECRET"));
});
test("keyset pagination visits each action once and watches old failures", async (t) => {
  const s = setup(t);
  for (let n = 0; n < 8; n++)
    s.item(
      `c${n}`,
      "tool_call",
      { id: `c${n}`, name: "files_list", arguments: { path: "." } },
      2,
    );
  const first = s.page(3),
    second = s.page(3, first.before!),
    third = s.page(3, second.before!);
  assert.equal(
    new Set([...first.items, ...second.items, ...third.items].map((i) => i.id))
      .size,
    9,
  );
  assert.equal(third.before, null);
  s.db.prepare("UPDATE agent_turns SET status='failed'").run();
  const refreshed = s.page(1, "", [third.items.at(-1)!.id]);
  assert.equal(refreshed.updates[0]?.status, "failed");
});
test("check-ins are associated with their scheduling action and remain cancellable", async (t) => {
  const s = setup(t);
  s.call("call", "task_schedule_checkin", { reason: "Follow up" });
  s.db
    .prepare(
      "INSERT INTO task_checkins(id,taskId,reason,dueAt,state,createdAt,updatedAt) VALUES ('check',?,'Follow up','2026-01-02T00:00:00.000Z','scheduled','2026-01-01T00:00:02.000Z','2026-01-01T00:00:02.000Z')",
    )
    .run(s.task.id);
  s.db
    .prepare("UPDATE tool_invocations SET state='completed',result=?")
    .run('{"ok":true,"checkinId":"check"}');
  assert.equal(s.page().items.filter((i) => i.checkin).length, 1);
  assert.equal(s.page().items.at(-1)?.checkin?.state, "scheduled");
});
test("endpoint is bounded, validates cursors and rejects cross-site reads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ufai-timeline-"));
  const s = setup(t, join(directory, "db.sqlite"));
  s.call();
  const app = createApp({
    databasePath: join(directory, "db.sqlite"),
    filesRoot: join(directory, "files"),
    serveStatic: false,
    execution: { autoStart: false },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = `/api/tasks/${s.task.id}/timeline`;
  assert.equal((await app.inject(url + "?limit=1")).json().items.length, 1);
  assert.equal((await app.inject(url + "?limit=101")).statusCode, 400);
  assert.equal((await app.inject(url + "?before=invalid")).statusCode, 400);
  assert.equal(
    (await app.inject({ url, headers: { "sec-fetch-site": "cross-site" } }))
      .statusCode,
    403,
  );
  assert.equal(
    (await app.inject("/api/tasks/missing/timeline")).statusCode,
    404,
  );
});
test("incoming communication batches keep individual authors and appear once after delivery", async (t) => {
  const s = setup(t);
  s.db
    .prepare(
      "INSERT INTO agent_requests(id,workspaceId,linkId,sourceAgentId,targetAgentId,sourceName,targetName,sourceTaskId,targetTaskId,rootWorkflowId,depth,kind,state,createdAt,updatedAt) VALUES ('req',?,'link','b','a','Researcher','Agent',NULL,?,'root',0,'request','open',?,?)",
    )
    .run(
      s.workspaceId,
      s.task.id,
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:01.000Z",
    );
  s.db
    .prepare(
      "INSERT INTO communication_messages(id,workspaceId,requestId,senderAgentId,senderName,recipientTaskId,kind,content,attachments,createdAt) VALUES ('comm',?,'req','b','Researcher',?,'progress','I found the guide.','[]','2026-01-01T00:00:02.000Z')",
    )
    .run(s.workspaceId, s.task.id);
  const before = s.page();
  assert.equal(before.items.at(-1)?.communication?.senderName, "Researcher");
  const input = (
    s.db
      .prepare("SELECT id FROM agent_messages WHERE conversationId=?")
      .get(s.task.conversationId) as { id: string }
  ).id;
  s.db
    .prepare(
      "INSERT INTO communication_deliveries(messageId,state,inputMessageId,turnId,createdAt) VALUES ('comm','delivered',?,?,?)",
    )
    .run(input, s.turnId, "2026-01-01T00:00:03.000Z");
  const after = s.page();
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0]?.communication?.content, "I found the guide.");
  assert.equal(after.items[0]?.id, before.items.at(-1)?.id);
});
test("outgoing communication during transit is represented by its tool action", async (t) => {
  const s = setup(t);
  s.call("send", "agent_send", { agentId: "b", content: "Read the guide." });
  s.db
    .prepare(
      "INSERT INTO agent_requests(id,workspaceId,linkId,sourceAgentId,targetAgentId,sourceName,targetName,sourceTaskId,rootWorkflowId,depth,kind,state,createdAt,updatedAt) VALUES ('req',?,'link','a','b','Agent','Researcher',?,'root',0,'request','open',?,?)",
    )
    .run(
      s.workspaceId,
      s.task.id,
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:03.000Z",
    );
  s.db
    .prepare(
      "INSERT INTO communication_messages(id,workspaceId,requestId,senderAgentId,senderName,senderTaskId,kind,content,attachments,createdAt) VALUES ('comm',?,'req','a','Agent',?,'request','Read the guide.','[]','2026-01-01T00:00:03.000Z')",
    )
    .run(s.workspaceId, s.task.id);
  assert.equal(
    s.page().items.filter((i) => i.kind === "communication").length,
    0,
  );
  assert.equal(s.page().items.filter((i) => i.name === "agent_send").length, 1);
});

test("execution sequence wins over a backwards wall clock", async (t) => {
  const s = setup(t);
  s.item(
    "first",
    "tool_call",
    { id: "one", name: "files_list", arguments: { path: "." } },
    4,
  );
  s.item("second", "commentary", "Read the notes.", 2);
  s.item(
    "third",
    "tool_call",
    { id: "two", name: "files_read", arguments: { path: "notes.md" } },
    3,
  );
  assert.deepEqual(
    s
      .page()
      .items.slice(1)
      .map((i) => i.name ?? i.message?.content),
    ["files_list", "Read the notes.", "files_read"],
  );
});
test("process lifetime stays distinct from the successful start action", async (t) => {
  const s = setup(t);
  s.call("start", "process_start", { command: "npm test" });
  s.db
    .prepare(
      "INSERT INTO owned_processes(id,workspaceId,agentId,taskId,turnId,command,cwd,pty,launchId,state,createdAt,updatedAt) VALUES ('process',?,'a',?,?,'npm test','/task',0,'launch','running','2026-01-01T00:00:03.000Z','2026-01-01T00:00:03.000Z')",
    )
    .run(s.workspaceId, s.task.id, s.turnId);
  assert.equal(s.page().items.at(-1)?.process?.state, "running");
  s.db
    .prepare("UPDATE tool_invocations SET state='completed',result=?")
    .run('{"ok":true,"process":{"id":"process"}}');
  assert.equal(s.page().items.at(-1)?.status, "completed");
  assert.equal(s.page().items.at(-1)?.process?.state, "running");
  s.db.prepare("UPDATE owned_processes SET state='exited',exitCode=1").run();
  assert.equal(s.page().items.at(-1)?.process?.exitCode, 1);
});
test("published output appears once on the final message and interrupted publication keeps its file", async (t) => {
  const s = setup(t);
  s.answer("File ready.", "complete");
  s.db
    .prepare(
      "INSERT INTO artifacts VALUES ('artifact',?,'notes.txt','2026-01-01T00:00:01.000Z')",
    )
    .run(s.workspaceId);
  s.db
    .prepare(
      "INSERT INTO artifact_versions(id,artifactId,workspaceId,producerAgentId,producerTaskId,provenance,name,mediaType,size,state,createdAt) VALUES ('version','artifact',?,'a',?,'published','notes.txt','text/plain',10,'ready','2026-01-01T00:00:02.000Z')",
    )
    .run(s.workspaceId, s.task.id);
  s.item("file", "artifact", { versionId: "version", name: "notes.txt" }, 2);
  assert.equal(s.page().items.filter((i) => i.kind === "file").length, 1);
  s.db
    .prepare(
      "INSERT INTO artifact_references(versionId,messageId,ordinal) VALUES ('version','answer',0)",
    )
    .run();
  s.item("final", "final", "File ready.", 3);
  const page = s.page();
  assert.equal(page.items.filter((i) => i.kind === "file").length, 0);
  assert.equal(
    page.items.at(-1)?.message?.parts?.filter((p) => p.type === "artifact")
      .length,
    1,
  );
});
