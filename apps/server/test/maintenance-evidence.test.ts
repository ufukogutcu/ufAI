import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openDatabase } from "../src/database.js";
import { maintenanceEvidence } from "../src/maintenance-evidence.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const workspace = (
    db.prepare("SELECT id FROM workspaces").get() as { id: string }
  ).id;
  db.prepare(
    "INSERT INTO agents(id,workspaceId,name,createdAt,updatedAt) VALUES ('a',?,'A','now','now')",
  ).run(workspace);
  function turn(taskId: string, id: string, inputId = id + "-input") {
    if (!db.prepare("SELECT 1 FROM agent_tasks WHERE id=?").get(taskId)) {
      db.prepare(
        "INSERT INTO conversations(id,agentId,kind,createdAt) VALUES (?,'a','task','now')",
      ).run(taskId);
      db.prepare(
        "INSERT INTO agent_tasks(id,agentId,conversationId,title,status,createdAt,updatedAt) VALUES (?,'a',?,'Task','running','now','now')",
      ).run(taskId, taskId);
    }
    db.prepare(
      "INSERT INTO agent_turns(id,taskId,conversationId,agentId,inputMessageId,attempt,status,createdAt,updatedAt) VALUES (?,?,?,'a',?,1,'running','now','now')",
    ).run(id, taskId, taskId, inputId);
  }
  function tool(
    taskId: string,
    turnId: string,
    name: string,
    args: unknown,
    result: unknown,
    state = "completed",
  ) {
    const id = randomUUID(),
      stamp = new Date().toISOString();
    db.prepare("INSERT INTO tool_invocations VALUES (?,?,?,?,?,?,?,?,?)").run(
      id,
      turnId,
      id,
      name,
      JSON.stringify(args),
      state,
      JSON.stringify(result),
      stamp,
      stamp,
    );
    db.prepare(
      "INSERT INTO execution_items(id,workspaceId,agentId,taskId,turnId,kind,content,createdAt) VALUES (?,?,'a',?,?,'tool_result',?,?)",
    ).run(
      id,
      workspace,
      taskId,
      turnId,
      JSON.stringify({ callId: id, name, ...(result as object) }),
      stamp,
    );
    return id;
  }
  return { db, workspace, turn, tool };
}

test("completion evidence pairs successful and failed outcomes with their actual arguments", (t) => {
  const f = fixture(t);
  f.turn("task", "turn");
  f.tool(
    "task",
    "turn",
    "files_write",
    { path: "out.txt", text: "EXACT_MARKER", expectedSha256: null },
    { ok: true, path: "/task/out.txt", sha256: "a".repeat(64) },
  );
  f.tool(
    "task",
    "turn",
    "files_write",
    {
      path: "missing.txt",
      text: "never written",
      expectedSha256: "b".repeat(64),
    },
    { ok: false, error: "File changed" },
  );
  const evidence = maintenanceEvidence(
    f.db,
    "task",
    "turn",
    "turn-input",
    false,
    64000,
  );
  assert.equal(evidence.tools.length, 2);
  assert.deepEqual(evidence.tools[0].arguments, {
    path: "out.txt",
    text: "EXACT_MARKER",
    expectedSha256: null,
  });
  assert.equal((evidence.tools[0].result as any).ok, true);
  assert.equal((evidence.tools[1].result as any).ok, false);
  assert.equal((evidence.tools[1].result as any).error, "File changed");
  assert.equal(evidence.truncated, false);
});

test("automatic continuations retain prior-turn evidence while new user requests and other tasks stay isolated", (t) => {
  const f = fixture(t);
  f.turn("task", "old");
  f.turn("task", "new");
  f.turn("other", "foreign");
  f.tool("task", "old", "files_write", { path: "old.txt" }, { ok: true });
  f.tool(
    "task",
    "new",
    "files_read",
    { path: "new.txt" },
    { ok: true, text: "current" },
  );
  f.tool(
    "other",
    "foreign",
    "files_write",
    { path: "foreign.txt" },
    { ok: true },
  );
  const direct = maintenanceEvidence(
    f.db,
    "task",
    "new",
    "new-input",
    false,
    64000,
  );
  assert.equal(direct.tools.length, 1);
  assert.equal(direct.tools[0].currentTurn, true);
  const resumed = maintenanceEvidence(
    f.db,
    "task",
    "new",
    "new-input",
    true,
    64000,
  );
  assert.deepEqual(
    resumed.tools.map((item) => item.turnId),
    ["old", "new"],
  );
  f.turn("task", "retry", "old-input");
  assert.deepEqual(
    maintenanceEvidence(
      f.db,
      "task",
      "retry",
      "old-input",
      false,
      64000,
    ).tools.map((item) => item.turnId),
    ["old"],
  );
});

test("process evidence distinguishes a launch from observed successful or unsuccessful exit", (t) => {
  const f = fixture(t);
  f.turn("task", "turn");
  f.tool(
    "task",
    "turn",
    "process_start",
    { command: "example", env: { PRIVATE: "secret" } },
    { ok: true, process: { id: "p", state: "running" } },
  );
  for (const [id, state, exit] of [
    ["p", "running", null],
    ["finished", "exited", 0],
    ["bad", "exited", 7],
  ] as const)
    f.db
      .prepare(
        "INSERT INTO owned_processes(id,workspaceId,agentId,taskId,turnId,command,cwd,pty,launchId,state,exitCode,createdAt,updatedAt) VALUES (?,?,'a','task','turn','example','/task',0,?,?,?,'now','now')",
      )
      .run(id, f.workspace, id, state, exit);
  const evidence = maintenanceEvidence(
    f.db,
    "task",
    "turn",
    "turn-input",
    false,
    64000,
  );
  assert.equal((evidence.tools[0].result as any).process.state, "running");
  assert.deepEqual(
    evidence.processes.map((row) => [row.id, row.state, row.exitCode]),
    [
      ["p", "running", null],
      ["bad", "exited", 7],
      ["finished", "exited", 0],
    ],
  );
  assert.ok(!JSON.stringify(evidence).includes("secret"));
});

test("large results are explicitly excerpted within a context-scaled byte budget and terminal input stays omitted", (t) => {
  const f = fixture(t);
  f.turn("task", "turn");
  for (let i = 0; i < 40; i++)
    f.tool(
      "task",
      "turn",
      "files_read",
      { path: `file-${i}` },
      {
        ok: true,
        text: "界".repeat(20000),
        items: Array.from({ length: 50 }, () => ({ text: "x".repeat(1000) })),
      },
    );
  f.tool(
    "task",
    "turn",
    "process_input",
    { processId: "p", data: "PRIVATE_TERMINAL_INPUT" },
    { ok: true },
  );
  for (const window of [1024, 8000, 64000]) {
    const evidence = maintenanceEvidence(
      f.db,
      "task",
      "turn",
      "turn-input",
      false,
      window,
    );
    assert.equal(evidence.truncated, true);
    assert.ok(evidence.tools.length <= 32);
    assert.ok(
      Buffer.byteLength(JSON.stringify(evidence)) <=
        Math.max(512, Math.min(12000, Math.floor(window / 5))),
    );
    assert.ok(!JSON.stringify(evidence).includes("PRIVATE_TERMINAL_INPUT"));
  }
});
