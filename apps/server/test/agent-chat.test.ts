import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { removeChat } from "./legacy-schema.js";

test("Chat is created once, persists across restarts, paginates and stays separate from Tasks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ufai-chat-"));
  const databasePath = join(root, "app.sqlite");
  let app = createApp({
    databasePath,
    serveStatic: false,
    execution: { autoStart: false },
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const agent = (
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace}/agents`,
      payload: { name: "Assistant" },
    })
  ).json();
  const base = `/api/agents/${agent.id}`;
  assert.deepEqual((await app.inject(`${base}/chat`)).json(), {
    task: null,
    turns: [],
  });
  assert.deepEqual((await app.inject(`${base}/chat/messages`)).json(), {
    items: [],
    total: 0,
  });
  assert.equal(
    (await app.inject(`${base}/chat/messages?limit=0`)).statusCode,
    400,
  );
  const send = (content: string, requestId: string) =>
    app.inject({
      method: "POST",
      url: `${base}/chat/messages`,
      payload: { content, requestId },
    });
  const [one, two] = await Promise.all([
    send("Hello", "chat_input_one"),
    send("Do something", "chat_input_two"),
  ]);
  assert.equal(one.statusCode, 202, one.body);
  assert.equal(two.json().taskId, one.json().taskId);
  assert.deepEqual((await send("Hello", "chat_input_one")).json(), one.json());
  assert.equal((await send("Changed", "chat_input_one")).statusCode, 409);
  const chat = (await app.inject(`${base}/chat`)).json();
  assert.equal(chat.task.kind, "chat");
  assert.equal(chat.turns.length, 2);
  assert.deepEqual((await app.inject(`${base}/tasks`)).json(), {
    items: [],
    total: 0,
  });
  const messages = (await app.inject(`${base}/chat/messages?limit=1`)).json();
  assert.equal(messages.items[0].content, "Do something");
  const earlier = (
    await app.inject(
      `${base}/chat/messages?before=${messages.items[0].sequence}`,
    )
  ).json();
  assert.equal(earlier.items[0].content, "Hello");
  for (const method of ["GET", "POST"] as const)
    assert.equal(
      (
        await app.inject({
          method,
          url: `${base}/status/messages`,
          ...(method === "POST"
            ? { payload: { content: "Hi", requestId: "legacy_input" } }
            : {}),
        })
      ).statusCode,
      410,
    );
  assert.equal(
    (
      await app.inject({
        url: `${base}/chat`,
        headers: { origin: "https://evil.example" },
      })
    ).statusCode,
    403,
  );
  await app.close();
  app = createApp({
    databasePath,
    serveStatic: false,
    execution: { autoStart: false },
  });
  assert.equal((await app.inject(`${base}/chat`)).json().task.id, chat.task.id);
  assert.equal((await app.inject(`${base}/chat/messages`)).json().total, 2);
  const task = (
    await app.inject({
      method: "POST",
      url: `${base}/tasks`,
      payload: { content: "Separate work", requestId: "separate_input" },
    })
  ).json();
  assert.notEqual(task.taskId, chat.task.id);
  assert.equal((await app.inject(`${base}/tasks`)).json().total, 1);
});

test("configuration instruction writes reject stale revisions and preserve saved guidance", async (t) => {
  const app = createApp({
    databasePath: ":memory:",
    serveStatic: false,
    execution: { autoStart: false },
  });
  t.after(() => app.close());
  const workspace = (await app.inject("/api/workspaces")).json().items[0].id;
  const agent = (
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace}/agents`,
      payload: { name: "Assistant", instructions: "Original" },
    })
  ).json();
  const patch = (payload: unknown) =>
    app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, payload });
  const updated = await patch({
    instructions: "New role",
    expectedRevision: agent.revision,
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(
    (
      await patch({
        instructions: "Stale role",
        expectedRevision: agent.revision,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await app.inject(`/api/agents/${agent.id}`)).json().instructions,
    "New role",
  );
  assert.equal(
    (await patch({ instructions: "x".repeat(8001) })).statusCode,
    400,
  );
  assert.equal((await patch({ expectedRevision: -1 })).statusCode, 400);
  const cleared = await patch({
    instructions: "",
    expectedRevision: updated.json().revision,
  });
  assert.equal(cleared.json().instructions, "");
});

test("v17 upgrade preserves work and status history while fencing unfinished status attempts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ufai-chat-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "app.sqlite");
  let db = openDatabase(path);
  const workspace = (
    db.prepare("SELECT id FROM workspaces").get() as { id: string }
  ).id;
  db.prepare(
    "INSERT INTO agents(id,workspaceId,name,instructions,createdAt,updatedAt) VALUES ('a',?,'Agent','Keep me','then','then')",
  ).run(workspace);
  db.exec(`INSERT INTO conversations(id,agentId,kind,createdAt) VALUES ('old','a','status','then'),('work','a','task','then');
    INSERT INTO agent_tasks(id,agentId,conversationId,title,status,createdAt,updatedAt) VALUES ('work','a','work','Existing work','queued','then','then');
    INSERT INTO agent_turns(id,taskId,conversationId,agentId,inputMessageId,attempt,status,createdAt,updatedAt) VALUES
      ('old-turn',NULL,'old','a','old-input',1,'queued','then','then'),('work-turn','work','work','a','work-input',1,'queued','then','then');
    INSERT INTO agent_messages(id,conversationId,turnId,role,content,state,createdAt) VALUES
      ('old-input','old','old-turn','user','What are you doing?','complete','then'),('work-input','work','work-turn','user','Do work','complete','then');`);
  removeChat(db);
  db.pragma("user_version=17");
  db.close();
  db = openDatabase(path);
  try {
    assert.equal(
      (db.prepare("SELECT kind FROM agent_tasks WHERE id='work'").get() as any)
        .kind,
      "task",
    );
    assert.equal(
      (
        db
          .prepare("SELECT status FROM agent_turns WHERE id='old-turn'")
          .get() as any
      ).status,
      "cancelled",
    );
    assert.equal(
      (
        db
          .prepare("SELECT generation FROM agent_turns WHERE id='old-turn'")
          .get() as any
      ).generation,
      1,
    );
    assert.equal(
      (
        db
          .prepare("SELECT status FROM agent_turns WHERE id='work-turn'")
          .get() as any
      ).status,
      "queued",
    );
    assert.equal(
      (
        db
          .prepare("SELECT content FROM agent_messages WHERE id='old-input'")
          .get() as any
      ).content,
      "What are you doing?",
    );
    assert.equal(
      (db.prepare("SELECT instructions FROM agents WHERE id='a'").get() as any)
        .instructions,
      "Keep me",
    );
    assert.equal(db.pragma("user_version", { simple: true }), 19);
  } finally {
    db.close();
  }
});
