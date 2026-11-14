import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  symlink,
  mkdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import type { ManagedLocation, DeletionOperation } from "../src/contracts.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "ufai-locations-test-"));
  const app = createApp({
    databasePath: join(root, "test.sqlite"),
    execution: { autoStart: false },
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = (await app.inject("/api/workspaces")).json().items[0];
  async function location(kind: string, id: string) {
    for (let i = 0; i < 100; i++) {
      const r = await app.inject(`/api/${kind}/${id}/locations`);
      assert.equal(r.statusCode, 200, r.body);
      const value = r.json() as ManagedLocation;
      if (value.state !== "pending") return value;
      await delay(5);
    }
    throw Error("Folder provisioning timed out");
  }
  async function deleted(kind: string, id: string) {
    const r = await app.inject({
      method: "DELETE",
      url: `/api/${kind}/${id}`,
      payload: { confirmFilesDeletion: true },
    });
    assert.equal(r.statusCode, 202, r.body);
    const op = r.json() as DeletionOperation;
    for (let i = 0; i < 100; i++) {
      const value = (
        await app.inject(`/api/deletions/${op.id}`)
      ).json() as DeletionOperation;
      if (value.state === "completed" || value.state === "failed") return value;
      await delay(5);
    }
    throw Error("Deletion timed out");
  }
  async function agent(name = "Agent") {
    const r = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/agents`,
      payload: { name },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  }
  async function cluster(name = "Department") {
    const r = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/clusters`,
      payload: { name },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  }
  return { app, root, workspace, location, deleted, agent, cluster };
}

test("managed locations persist, task follow-ups reuse directories, names and membership never move files", async (t) => {
  const f = await fixture(t),
    a = await f.agent(),
    c = await f.cluster();
  const home = await f.location("agents", a.id);
  assert.equal(home.state, "ready");
  await writeFile(join(home.path, "keep.txt"), "original");
  const submit = async (
    content: string,
    requestId: string,
    path = `/api/agents/${a.id}/tasks`,
  ) =>
    (
      await f.app.inject({
        method: "POST",
        url: path,
        payload: { content, requestId },
      })
    ).json();
  const first = await submit("one", "request_one"),
    second = await submit("two", "request_two");
  const firstLocation = await f.location("tasks", first.taskId),
    secondLocation = await f.location("tasks", second.taskId);
  assert.notEqual(firstLocation.path, secondLocation.path);
  await submit(
    "follow up",
    "request_three",
    `/api/tasks/${first.taskId}/messages`,
  );
  assert.equal(
    (await f.location("tasks", first.taskId)).path,
    firstLocation.path,
  );
  const updated = await f.app.inject({
    method: "PATCH",
    url: `/api/agents/${a.id}`,
    payload: { name: "Renamed", clusterId: c.id, x: 24, y: 72 },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal((await f.location("agents", a.id)).path, home.path);
  assert.equal(await readFile(join(home.path, "keep.txt"), "utf8"), "original");
});

test("Clusters have stable least-used colors and atomic member movement with workspace enforcement", async (t) => {
  const f = await fixture(t),
    a = await f.agent(),
    colors = [];
  for (let i = 0; i < 17; i++) colors.push(await f.cluster(`Department ${i}`));
  assert.equal(new Set(colors.slice(0, 16).map((c) => c.colorSlot)).size, 16);
  assert.equal(colors[16].colorSlot, 0);
  const c = colors[0];
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/agents/${a.id}`,
        payload: { clusterId: c.id, x: 24, y: 72 },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/clusters/${c.id}`,
        payload: { x: 200, y: 100 },
      })
    ).statusCode,
    200,
  );
  const moved = (await f.app.inject(`/api/agents/${a.id}`)).json();
  assert.equal(moved.x, 224);
  assert.equal(moved.y, 172);
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/agents/${a.id}`,
        payload: { x: 750 },
      })
    ).statusCode,
    400,
  );
  const other = (
    await f.app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Other" },
    })
  ).json();
  const foreign = (
    await f.app.inject({
      method: "POST",
      url: `/api/workspaces/${other.id}/clusters`,
      payload: { name: "Other department" },
    })
  ).json();
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/agents/${a.id}`,
        payload: { clusterId: foreign.id },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/agents/${a.id}`,
        payload: { clusterId: null, x: 750 },
      })
    ).statusCode,
    200,
  );
});

test("confirmed Cluster deletion deletes shared files but preserves agents and their files", async (t) => {
  const f = await fixture(t),
    a = await f.agent(),
    c = await f.cluster();
  await f.app.inject({
    method: "PATCH",
    url: `/api/agents/${a.id}`,
    payload: { clusterId: c.id, x: 24, y: 72 },
  });
  const home = await f.location("agents", a.id),
    shared = await f.location("clusters", c.id);
  await writeFile(join(home.path, "own.txt"), "agent");
  await writeFile(join(shared.path, "shared.txt"), "department");
  assert.equal(
    (await f.app.inject({ method: "DELETE", url: `/api/clusters/${c.id}` }))
      .statusCode,
    400,
  );
  assert.equal((await f.deleted("clusters", c.id)).state, "completed");
  assert.equal(
    (await f.app.inject(`/api/agents/${a.id}`)).json().clusterId,
    null,
  );
  assert.equal(await readFile(join(home.path, "own.txt"), "utf8"), "agent");
  await assert.rejects(stat(shared.path), { code: "ENOENT" });
});

test("deletion never follows interior symlinks, and workspace removal deletes all managed trees", async (t) => {
  const f = await fixture(t),
    a = await f.agent(),
    home = await f.location("agents", a.id);
  const external = join(f.root, "external");
  await mkdir(external);
  await writeFile(join(external, "keep.txt"), "external");
  await symlink(external, join(home.path, "outside"));
  assert.equal((await f.deleted("agents", a.id)).state, "completed");
  assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "external");
  const shared = await f.location("workspaces", f.workspace.id);
  assert.equal(
    (await f.deleted("workspaces", f.workspace.id)).state,
    "completed",
  );
  await assert.rejects(stat(shared.path), { code: "ENOENT" });
  assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "external");
});

test("symlinked managed ancestors fail safely and can be repaired without altering external files", async (t) => {
  const f = await fixture(t),
    a = await f.agent(),
    home = await f.location("agents", a.id);
  const base = join(home.path, ".."),
    external = join(f.root, "external");
  await mkdir(external);
  await writeFile(join(external, "keep.txt"), "safe");
  await rm(base, { recursive: true });
  await symlink(external, base);
  const bad = await f.app.inject({
    method: "POST",
    url: `/api/locations/agent/${a.id}/repair`,
  });
  assert.equal(bad.json().state, "error");
  // Deleting this agent unlinks the symlink itself; it cannot descend into its target.
  assert.equal((await f.deleted("agents", a.id)).state, "completed");
  assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "safe");
});

test("root ownership is verified and traversal in registry is rejected", async (t) => {
  const f = await fixture(t);
  const db = openDatabase(join(f.root, "test.sqlite"));
  db.prepare(
    "UPDATE managed_locations SET relativePath='../escape' WHERE kind='workspace'",
  ).run();
  db.close();
  assert.equal(
    (await f.app.inject(`/api/workspaces/${f.workspace.id}/locations`))
      .statusCode,
    500,
  );
  const foreign = createApp({
    databasePath: join(f.root, "other.sqlite"),
    filesRoot: join(f.root, "test.sqlite.files"),
  });
  await assert.rejects(foreign.ready(), /another installation/);
  await foreign.close();
});

test("v10 upgrade backfills folders without altering Phase 1 history and memory, then reopens with the same paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ufai-upgrade-test-")),
    databasePath = join(root, "test.sqlite");
  const { removeLocationTables } = await import("./legacy-schema.js");
  let db = openDatabase(databasePath);
  const workspace = (
    db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }
  ).id;
  removeLocationTables(db);
  db.pragma("user_version = 10");
  db.prepare(
    "INSERT INTO agents(id,workspaceId,name,createdAt,updatedAt) VALUES ('legacy-agent',?,'Legacy','old','old')",
  ).run(workspace);
  db.exec(`INSERT INTO conversations(id,agentId,kind,createdAt) VALUES ('conversation','legacy-agent','task','old');
    INSERT INTO agent_tasks(id,agentId,conversationId,title,status,createdAt,updatedAt) VALUES ('legacy-task','legacy-agent','conversation','Kept','completed','old','old');
    INSERT INTO agent_messages(id,conversationId,role,content,state,createdAt) VALUES ('message','conversation','user','Original input','complete','old');
    INSERT INTO agent_memories(id,agentId,key,content,kind,sources,createdAt,updatedAt) VALUES ('memory','legacy-agent','topic','Keep me','finding','["message"]','old','old');`);
  db.close();
  let app = createApp({ databasePath, execution: { autoStart: false } });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.ready();
  const original = (await app.inject("/api/agents/legacy-agent")).json();
  assert.equal(original.name, "Legacy");
  assert.equal(original.clusterId, null);
  assert.equal(
    (await app.inject("/api/tasks/legacy-task/messages")).json().items[0]
      .content,
    "Original input",
  );
  assert.equal(
    (await app.inject("/api/agents/legacy-agent/memories")).json().items[0]
      .content,
    "Keep me",
  );
  const path = (await app.inject("/api/tasks/legacy-task/locations")).json()
    .path;
  await app.close();
  app = createApp({ databasePath, execution: { autoStart: false } });
  await app.ready();
  assert.equal(
    (await app.inject("/api/tasks/legacy-task/locations")).json().path,
    path,
  );
  db = openDatabase(databasePath);
  assert.equal(db.pragma("user_version", { simple: true }), 21);
  db.close();
});

test("failed confirmed deletion fences execution and mutations, and restart retries after the ancestor is repaired", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ufai-delete-recovery-")),
    databasePath = join(root, "test.sqlite"),
    filesRoot = join(root, "custom-files");
  let app = createApp({
    databasePath,
    filesRoot,
    execution: { autoStart: false },
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
      payload: { name: "Recovery" },
    })
  ).json();
  const ancestor = join(filesRoot, "workspaces", workspace.id, "agents");
  for (let i = 0; i < 100; i++) {
    if (
      (await app.inject(`/api/agents/${agent.id}/locations`)).json().state ===
      "ready"
    )
      break;
    await delay(5);
  }
  await rm(ancestor, { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "untouched");
  await symlink(outside, ancestor);
  const accepted = await app.inject({
    method: "DELETE",
    url: `/api/agents/${agent.id}`,
    payload: { confirmFilesDeletion: true },
  });
  assert.equal(accepted.statusCode, 202);
  const id = accepted.json().id;
  for (let i = 0; i < 100; i++) {
    if ((await app.inject(`/api/deletions/${id}`)).json().state === "failed")
      break;
    await delay(5);
  }
  assert.equal(
    (await app.inject(`/api/deletions/${id}`)).json().state,
    "failed",
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/agents/${agent.id}`,
        payload: { name: "No" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/tasks`,
        payload: { content: "Do not run", requestId: "blocked_request" },
      })
    ).statusCode,
    409,
  );
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "untouched");
  await app.close();
  await unlink(ancestor);
  await mkdir(ancestor);
  app = createApp({ databasePath, filesRoot, execution: { autoStart: false } });
  await app.ready();
  for (let i = 0; i < 100; i++) {
    if ((await app.inject(`/api/deletions/${id}`)).json().state === "completed")
      break;
    await delay(5);
  }
  assert.equal(
    (await app.inject(`/api/deletions/${id}`)).json().state,
    "completed",
  );
  assert.equal((await app.inject(`/api/agents/${agent.id}`)).statusCode, 404);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "untouched");
});

test("Cluster shrinking cannot exclude member centers and stale cross-workspace membership is rejected by SQLite", async (t) => {
  const f = await fixture(t),
    a = await f.agent(),
    c = await f.cluster();
  await f.app.inject({
    method: "PATCH",
    url: `/api/agents/${a.id}`,
    payload: { clusterId: c.id, x: 450, y: 240 },
  });
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/clusters/${c.id}`,
        payload: { width: 320 },
      })
    ).statusCode,
    400,
  );
  const other = (
    await f.app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Other" },
    })
  ).json();
  const db = openDatabase(join(f.root, "test.sqlite"));
  assert.throws(
    () =>
      db
        .prepare("UPDATE agents SET workspaceId=? WHERE id=?")
        .run(other.id, a.id),
    /Cluster must belong/,
  );
  db.close();
});

test(
  "agent deletion settles an active generation before removing files and records",
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ufai-active-delete-")),
      databasePath = join(root, "test.sqlite");
    const db = openDatabase(databasePath),
      workspace = (
        db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }
      ).id;
    db.exec(`INSERT INTO connections(id,provider,name,endpoint,createdAt,updatedAt) VALUES ('connection','ollama','Local','http://127.0.0.1:11434','old','old');
    INSERT INTO provider_models(connectionId,id,name,contextWindowOverride) VALUES ('connection','model','Model',32000);
    INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES ('preset','Preset','connection','model','old','old');`);
    db.close();
    let started!: () => void,
      aborted = false;
    const called = new Promise<void>((r) => {
      started = r;
    });
    const app = createApp({
      databasePath,
      connections: {
        fetcher: async (_url, init) => {
          started();
          return new Promise<Response>((_resolve, reject) => {
            const cancel = () => {
              aborted = true;
              reject(new DOMException("Cancelled", "AbortError"));
            };
            if (init?.signal?.aborted) cancel();
            else
              init?.signal?.addEventListener("abort", cancel, { once: true });
          });
        },
      },
    });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const agent = (
      await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspace}/agents`,
        payload: { name: "Running", presetId: "preset" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tasks`,
      payload: { content: "Wait for cancellation", requestId: "running_task" },
    });
    await called;
    const deletion = (
      await app.inject({
        method: "DELETE",
        url: `/api/agents/${agent.id}`,
        payload: { confirmFilesDeletion: true },
      })
    ).json();
    for (let i = 0; i < 200; i++) {
      if (
        (await app.inject(`/api/deletions/${deletion.id}`)).json().state ===
        "completed"
      )
        break;
      await delay(5);
    }
    assert.equal(aborted, true);
    assert.equal(
      (await app.inject(`/api/deletions/${deletion.id}`)).json().state,
      "completed",
    );
    assert.equal((await app.inject(`/api/agents/${agent.id}`)).statusCode, 404);
  },
);
