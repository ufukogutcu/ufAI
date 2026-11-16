import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { ManagedFiles } from "../src/managed-files.js";
import { Skills } from "../src/skills.js";
import { AgentTools, validateTool } from "../src/agent-tools.js";
import { AgentExecution } from "../src/agent-execution.js";
import { ConnectionService } from "../src/connection-service.js";
import { ProcessService, type ToolOwner } from "../src/process-service.js";
import { ArtifactService } from "../src/artifact-service.js";
import { parseSkill, skillDocument } from "../src/skill-packages.js";
import type {
  SkillDetail,
  SkillInstallation,
  SkillPage,
  SkillInput,
} from "../src/skill-types.js";

const input: SkillInput = {
  name: "test-skill",
  description: "Use this skill to test reusable guidance.",
  instructions: "Use the bundled reference and follow the user's request.",
  metadata: { author: "Example", version: "1" },
};
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ufai-skills-test-"));
  const databasePath = join(root, "app.sqlite");
  const launches: { command: string; args: string[] }[] = [];
  const options = {
    databasePath,
    serveStatic: false,
    execution: { autoStart: false },
    agentFiles: {
      platform: "linux" as const,
      env: { DISPLAY: ":test" },
      launch: async (command: string, args: string[]) => {
        launches.push({ command, args });
      },
    },
  };
  let app = createApp(options);
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = (await app.inject("/api/workspaces")).json().items[0];
  async function agent(name: string, workspaceId = workspace.id) {
    return (
      await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/agents`,
        payload: { name },
      })
    ).json();
  }
  const a = await agent("A"),
    b = await agent("B");
  async function list(agentId = a.id, query = "") {
    const response = await app.inject(`/api/agents/${agentId}/skills${query}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<SkillPage>();
  }
  async function create(skill = input) {
    const response = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { agentId: a.id, skill },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<SkillDetail>();
  }
  async function upload(bytes: Buffer, filename = "skills.zip") {
    const form = new FormData();
    form.append("agentId", a.id);
    form.append("file", new Blob([new Uint8Array(bytes)]), filename);
    const request = new Request("http://localhost/api/skills/installations", {
      method: "POST",
      body: form,
    });
    return app.inject({
      method: "POST",
      url: "/api/skills/installations",
      headers: { "content-type": request.headers.get("content-type")! },
      payload: Buffer.from(await request.arrayBuffer()),
    });
  }
  return {
    root,
    databasePath,
    workspace,
    a,
    b,
    agent,
    list,
    create,
    upload,
    launches,
    get app() {
      return app;
    },
    async restart() {
      await app.close();
      app = createApp(options);
      await app.ready();
    },
  };
}
// Small uncompressed ZIP fixture, including Unix file modes, without external test commands.
function zip(entries: { path: string; contents: string; mode?: number }[]) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path),
      data = Buffer.from(entry.contents);
    let crc = 0xffffffff;
    for (const value of data) {
      crc ^= value;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("skills are shared across workspaces, per-agent defaults persist, and built-ins are protected", async (t) => {
  const f = await fixture(t);
  const defaults = await f.list();
  assert.equal(defaults.total, 3);
  assert.equal(
    defaults.items.find((s) => s.name === "skill-creation")!.enabled,
    false,
  );
  assert.equal(
    defaults.items.find((s) => s.name === "ufai-help")!.enabled,
    false,
  );
  const custom = await f.create();
  assert.equal(custom.enabled, true);
  assert.equal(
    (await f.list(f.b.id)).items.find((s) => s.id === custom.id)!.enabled,
    false,
  );
  const workspace = (
    await f.app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Other" },
    })
  ).json();
  const other = await f.agent("Other", workspace.id);
  assert.equal(
    (await f.list(other.id)).items.find((s) => s.id === custom.id)!.enabled,
    false,
  );
  assert.equal(
    (await f.list(other.id)).items.find((s) => s.name === "skill-creation")!
      .enabled,
    false,
  );
  const toggle = await f.app.inject({
    method: "PUT",
    url: `/api/agents/${f.b.id}/skills/${custom.id}`,
    payload: { enabled: true },
  });
  assert.equal(toggle.statusCode, 200, toggle.body);
  const builtin = defaults.items[0]!;
  for (const method of ["PATCH", "DELETE"] as const) {
    const response = await f.app.inject({
      method,
      url: `/api/skills/${builtin.id}`,
      payload:
        method === "PATCH"
          ? {
              expectedRevision: builtin.revision,
              skill: { ...input, name: builtin.name },
            }
          : { expectedRevision: builtin.revision, confirmed: true },
    });
    assert.equal(response.statusCode, 403, response.body);
  }
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url: `/api/agents/${f.a.id}/skills/${builtin.id}`,
        payload: { enabled: true },
      })
    ).statusCode,
    200,
  );
  await f.restart();
  assert.equal(
    (await f.list()).items.find((s) => s.id === builtin.id)!.enabled,
    true,
  );
  assert.equal(
    (await f.list(f.b.id)).items.find((s) => s.id === custom.id)!.enabled,
    true,
  );
  assert.equal(
    (await f.list(f.b.id, "?query=test&status=enabled&origin=custom&limit=1"))
      .total,
    1,
  );
  assert.equal(
    (await f.list(f.b.id, "?status=disabled&origin=custom")).total,
    0,
  );
  for (const query of ["?status=bad", "?origin=bad", "?limit=0"])
    assert.equal(
      (await f.app.inject(`/api/agents/${f.a.id}/skills${query}`)).statusCode,
      400,
    );
  assert.equal(
    (
      await f.app.inject({
        url: "/api/skills",
        headers: { origin: "https://example.com" },
      })
    ).statusCode,
    403,
  );
});

test("editor revisions preserve external edits, invalidate malformed packages and retain resources", async (t) => {
  const f = await fixture(t);
  const custom = await f.create();
  await mkdir(join(custom.path, "references"));
  await writeFile(join(custom.path, "references/guide.md"), "Reference.");
  const external = { ...input, instructions: "Edited outside ufAI." };
  await writeFile(join(custom.path, "SKILL.md"), skillDocument(external));
  const conflict = await f.app.inject({
    method: "PATCH",
    url: `/api/skills/${custom.id}`,
    payload: { expectedRevision: custom.revision, skill: input },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  const fresh = (
    await f.app.inject(`/api/skills/${custom.id}?agentId=${f.a.id}`)
  ).json<SkillDetail>();
  assert.equal(fresh.instructions, external.instructions);
  assert.equal(fresh.files.length, 2);
  const update = await f.app.inject({
    method: "PATCH",
    url: `/api/skills/${custom.id}`,
    payload: {
      agentId: f.a.id,
      expectedRevision: fresh.revision,
      skill: { ...input, instructions: "Updated." },
    },
  });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(
    await readFile(join(custom.path, "references/guide.md"), "utf8"),
    "Reference.",
  );
  await writeFile(join(custom.path, "SKILL.md"), "broken");
  await f.app.inject({ method: "POST", url: "/api/skills/refresh" });
  assert.match(
    (await f.list()).items.find((s) => s.id === custom.id)!.error!,
    /frontmatter/,
  );
  await writeFile(join(custom.path, "SKILL.md"), skillDocument(input));
  await f.app.inject({ method: "POST", url: "/api/skills/refresh" });
  assert.equal(
    (await f.list()).items.find((s) => s.id === custom.id)!.error,
    null,
  );
  const response = await f.app.inject({
    method: "POST",
    url: `/api/skills/${custom.id}/open-folder`,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(f.launches[0], { command: "xdg-open", args: [custom.path] });
});

test("ZIP previews select one skill; identical imports and explicit replacement preserve enablement", async (t) => {
  const f = await fixture(t);
  const bytes = zip([
    { path: "repo/first/SKILL.md", contents: skillDocument(input) },
    {
      path: "repo/first/scripts/run.sh",
      contents: "echo hello\n",
      mode: 0o100755,
    },
    {
      path: "repo/second/SKILL.md",
      contents: skillDocument({ ...input, name: "second" }),
    },
  ]);
  const response = await f.upload(bytes);
  assert.equal(response.statusCode, 201, response.body);
  const preview = response.json<SkillInstallation>();
  assert.equal(preview.candidates.length, 2);
  assert.equal((await f.list()).total, 3);
  const commit = async (id: string, key: string, extra = {}) =>
    f.app.inject({
      method: "POST",
      url: `/api/skills/installations/${id}/commit`,
      payload: { agentId: f.a.id, candidateKey: key, ...extra },
    });
  const first = await commit(preview.id, preview.candidates[0]!.key);
  assert.equal(first.statusCode, 200, first.body);
  const installed = first.json<SkillDetail>();
  assert.equal(installed.files.length, 2);
  assert.equal(
    (await commit(preview.id, preview.candidates[0]!.key)).json().id,
    installed.id,
  );
  assert.equal((await f.list()).total, 4);
  const replacement = (
    await f.upload(
      zip([
        {
          path: "SKILL.md",
          contents: skillDocument({ ...input, instructions: "Replacement." }),
        },
      ]),
    )
  ).json<SkillInstallation>();
  assert.equal(
    (await commit(replacement.id, replacement.candidates[0]!.key)).statusCode,
    409,
  );
  const replaced = await commit(
    replacement.id,
    replacement.candidates[0]!.key,
    { replaceId: installed.id, expectedRevision: installed.revision },
  );
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().id, installed.id);
  assert.equal(replaced.json().enabled, true);
  assert.equal(
    (await f.list(f.b.id)).items.find((s) => s.id === installed.id)!.enabled,
    false,
  );
  const standalone = await f.upload(
    Buffer.from(skillDocument({ ...input, name: "standalone" })),
    "SKILL.md",
  );
  assert.equal(standalone.statusCode, 201, standalone.body);
  assert.match(standalone.json().candidates[0].warnings[0], /Only SKILL.md/);
  const protectedPreview = (
    await f.upload(
      Buffer.from(skillDocument({ ...input, name: "skill-creation" })),
      "SKILL.md",
    )
  ).json<SkillInstallation>();
  assert.equal(
    (await commit(protectedPreview.id, protectedPreview.candidates[0]!.key))
      .statusCode,
    403,
  );
});

test("unsafe ZIPs, malformed input, links and private-network imports are rejected without installing", async (t) => {
  const f = await fixture(t);
  for (const entries of [
    [{ path: "../escape", contents: "bad" }],
    [
      { path: "SKILL.md", contents: skillDocument(input) },
      { path: "link", contents: "/tmp", mode: 0o120777 },
    ],
    [{ path: "SKILL.md", contents: "invalid" }],
  ]) {
    const response = await f.upload(zip(entries));
    assert.equal(response.statusCode >= 400, true, response.body);
  }
  for (const url of [
    "https://127.0.0.1/file.zip",
    "https://[::1]/SKILL.md",
    "file:///tmp/SKILL.md",
    "https://user:password@example.com/skill.zip",
  ]) {
    const response = await f.app.inject({
      method: "POST",
      url: "/api/skills/installations",
      payload: { agentId: f.a.id, url },
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal((await f.list()).total, 3);
  assert.throws(
    () => parseSkill("---\nname: Mixed\ndescription: Test\n---\nHello"),
    /lowercase/,
  );
  assert.throws(
    () =>
      parseSkill(
        "---\nname: test\ndescription: &a test\nmetadata: *a\n---\nHello",
      ),
    /YAML|metadata/,
  );
  assert.throws(
    () =>
      parseSkill(skillDocument({ ...input, instructions: "x".repeat(33000) })),
    /32 KiB/,
  );
  assert.throws(
    () =>
      validateTool("skill_set_enabled", {
        skillId: "test",
        enabled: true,
        agentId: "someone-else",
      }),
    /Unknown/,
  );
});

async function runtimeFixture(t: TestContext, provider = "openai-compatible") {
  const root = await mkdtemp(join(tmpdir(), "ufai-skills-runtime-"));
  const db = openDatabase(join(root, "db.sqlite"));
  const workspaceId = (
      db.prepare("SELECT id FROM workspaces").get() as { id: string }
    ).id,
    stamp = new Date().toISOString();
  db.prepare(
    "INSERT INTO connections(id,provider,name,createdAt,updatedAt,draft) VALUES('connection',?,'Local',?,?,0)",
  ).run(provider, stamp, stamp);
  db.prepare(
    "INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES('connection','model','Model',1,64000)",
  ).run();
  db.prepare(
    "INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES('preset','Preset','connection','model',?,?)",
  ).run(stamp, stamp);
  for (const id of ["a", "b"])
    db.prepare(
      "INSERT INTO agents(id,workspaceId,name,instructions,presetId,createdAt,updatedAt) VALUES(?,?,?,'Be helpful','preset',?,?)",
    ).run(id, workspaceId, id, stamp, stamp);
  const connections = new ConnectionService(db),
    files = new ManagedFiles(db),
    changed = () => {},
    processes = new ProcessService(db, files, changed),
    artifacts = new ArtifactService(db, files, changed),
    tools = new AgentTools(db, files, processes, artifacts, changed);
  const skills = new Skills(db, files, changed);
  tools.skills = skills;
  const engine = new AgentExecution(
    db,
    connections,
    { autoStart: false },
    files,
    tools,
  );
  files.bind(engine);
  connections.countTokens = async () => 100;
  connections.generate = async () => ({
    text: JSON.stringify({
      status: "completed",
      summary: "Done",
      memories: [],
    }),
    finishReason: "stop",
    usage: null,
  });
  await files.start();
  await skills.start();
  await artifacts.start();
  tools.ready = true;
  t.after(async () => {
    await engine.close();
    await skills.close();
    await processes.close();
    await artifacts.close();
    await files.close();
    await connections.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = engine.submit(
    "a",
    "chat",
    "Install and use a skill",
    randomUUID(),
  );
  const owner: ToolOwner = {
    workspaceId,
    agentId: "a",
    taskId: task.taskId!,
    turnId: task.turnId,
  };
  const dispatch = (
    name: string,
    args: Record<string, unknown>,
    id = randomUUID(),
  ) =>
    tools.dispatch(
      owner,
      { id, name, arguments: args },
      new AbortController().signal,
      async () => {},
    );
  return {
    root,
    db,
    files,
    tools,
    engine,
    connections,
    skills,
    owner,
    dispatch,
  };
}

test("other built-ins require explicit enablement in filters, details, catalogs and activation", async (t) => {
  const f = await runtimeFixture(t);
  const creator = "builtin-skill-creation";
  assert.equal(f.skills.list("a", { status: "enabled" }).total, 1);
  assert.equal(f.skills.list("a", { status: "disabled" }).total, 2);
  assert.deepEqual(f.skills.catalog("a").map(skill => skill.id), ["builtin-browser"]);
  for (const skillId of [creator, "builtin-ufai-help"]) {
    const detail = await f.skills.detail(skillId, "a");
    assert.equal(detail.enabled, false);
    assert.deepEqual(detail.enabledAgents, []);
    assert.equal((await f.dispatch("skill_activate", { skillId })).ok, false);
  }
  f.skills.setEnabled("a", creator, true);
  assert.equal(f.skills.list("a", { status: "enabled" }).total, 2);
  assert.deepEqual(f.skills.catalog("a").map(skill => skill.id), ["builtin-browser", creator]);
  assert.deepEqual((await f.skills.detail(creator, "a")).enabledAgents.map(agent => agent.id), ["a"]);
  assert.equal((await f.dispatch("skill_activate", { skillId: creator })).ok, true);
  assert.equal(f.skills.activeContext("a", f.owner.taskId).length, 1);
  f.skills.setEnabled("a", creator, false);
  assert.deepEqual(f.skills.catalog("a").map(skill => skill.id), ["builtin-browser"]);
  assert.deepEqual(f.skills.activeContext("a", f.owner.taskId), []);
  assert.deepEqual((await f.skills.detail(creator, "a")).enabledAgents, []);
});

test("agent management is journaled, disabled activation fails, and global removal requires confirmation", async (t) => {
  const f = await runtimeFixture(t);
  const created = await f.dispatch("skill_create", { skill: input }, "create");
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(
    (await f.dispatch("skill_create", { skill: input }, "create")).id,
    created.id,
  );
  assert.equal(f.skills.list("a").total, 4);
  const activated = await f.dispatch("skill_activate", { skillId: created.id });
  assert.equal(activated.ok, true);
  assert.equal(activated.instructions, input.instructions);
  await f.dispatch("skill_set_enabled", {
    skillId: created.id,
    enabled: false,
  });
  assert.equal(
    (await f.dispatch("skill_activate", { skillId: created.id })).ok,
    false,
  );
  assert.deepEqual(f.skills.activeContext("a", f.owner.taskId), []);
  assert.equal(
    (
      await f.dispatch("skill_update", {
        skillId: "builtin-skill-creation",
        expectedRevision: 1,
        skill: { ...input, name: "skill-creation" },
      })
    ).ok,
    false,
  );
  const current = await f.skills.detail(created.id as string, "a");
  assert.equal(
    (
      await f.dispatch("skill_remove", {
        skillId: created.id,
        expectedRevision: current.revision,
        confirmed: false,
      })
    ).ok,
    false,
  );
  const removed = await f.dispatch(
    "skill_remove",
    {
      skillId: created.id,
      expectedRevision: current.revision,
      confirmed: true,
    },
    "remove",
  );
  assert.equal(removed.ok, true);
  assert.deepEqual(
    await f.dispatch(
      "skill_remove",
      {
        skillId: created.id,
        expectedRevision: current.revision,
        confirmed: true,
      },
      "remove",
    ),
    removed,
  );
});

test("agents install local full packages, reject symlinks, and installation survives deleting the installer", async (t) => {
  const f = await runtimeFixture(t);
  const source = join(f.root, "custom");
  await mkdir(join(source, "references"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), skillDocument(input));
  await writeFile(join(source, "references/note.md"), "Read this.");
  await writeFile(join(source, "run.sh"), "echo example\n", { mode: 0o744 });
  const installed = await f.dispatch("skill_install", { path: source });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal((await f.skills.detail(installed.id as string)).files.length, 3);
  await symlink("/tmp", join(source, "linked"));
  assert.equal((await f.dispatch("skill_install", { path: source })).ok, false);
  f.db.prepare("DELETE FROM agents WHERE id='a'").run();
  assert.equal(
    f.skills.list("b").items.find((s) => s.id === installed.id)!.enabled,
    false,
  );
});

for (const provider of ["openai-compatible", "codex"])
  test(`${provider}: an agent creates and activates a skill in one request; later context retains activation`, async (t) => {
    const f = await runtimeFixture(t);
    if (provider === "codex")
      f.db
        .prepare(
          "UPDATE connections SET provider='codex' WHERE id='connection'",
        )
        .run();
    let rounds = 0,
      createdId = "";
    const finished = {
      text: "Used the skill.",
      finishReason: "stop",
      usage: null,
    };
    if (provider === "codex") {
      // Use the runtime boundary with the same dynamic callbacks as a Codex session.
      f.connections.executeTask = async (_snapshot, request) => {
        assert.doesNotMatch(request.instructions, /skill-creation/);
        if (rounds > 0) {
          assert.ok(request.instructions.includes(input.instructions));
          rounds++;
          return finished;
        }
        const created = await request.onTool({
          id: "create",
          name: "skill_create",
          arguments: { skill: input },
        });
        assert.equal(created.ok, true);
        createdId = created.id as string;
        assert.equal(
          (created.skills as { items: { id: string }[] }).items.some(
            (s) => s.id === createdId,
          ),
          true,
        );
        const activated = await request.onTool({
          id: "activate",
          name: "skill_activate",
          arguments: { skillId: createdId },
        });
        assert.equal(activated.instructions, input.instructions);
        rounds++;
        return finished;
      };
    } else {
      f.connections.toolRound = async (_snapshot, request) => {
        if (createdId && !request.continuation?.length)
          assert.ok(request.instructions.includes(input.instructions));
        if (rounds++ === 0) {
          assert.doesNotMatch(request.instructions, /skill-creation/);
          return {
            text: "",
            calls: [
              {
                id: "create",
                name: "skill_create",
                arguments: { skill: input },
              },
            ],
            continuation: [],
            usage: null,
          };
        }
        const previous = request.continuation as {
          results: { result: Record<string, unknown> }[];
        }[];
        if (rounds === 2) {
          const created = previous[0]!.results[0]!.result;
          createdId = created.id as string;
          assert.equal(
            (created.skills as { items: { id: string }[] }).items.some(
              (s) => s.id === createdId,
            ),
            true,
          );
          return {
            text: "",
            calls: [
              {
                id: "activate",
                name: "skill_activate",
                arguments: { skillId: createdId },
              },
            ],
            continuation: [],
            usage: null,
          };
        }
        return {
          text: finished.text,
          calls: [],
          continuation: [],
          usage: null,
        };
      };
    }
    f.engine.pump();
    for (let n = 0; n < 300; n++) {
      const status = (
        f.db
          .prepare("SELECT status FROM agent_turns WHERE id=?")
          .get(f.owner.turnId) as { status: string }
      ).status;
      if (status === "completed") break;
      if (["failed", "blocked"].includes(status))
        assert.fail(
          JSON.stringify(
            f.db
              .prepare("SELECT * FROM agent_turns WHERE id=?")
              .get(f.owner.turnId),
          ),
        );
      await delay(10);
    }
    assert.equal(
      (
        f.db
          .prepare("SELECT status FROM agent_turns WHERE id=?")
          .get(f.owner.turnId) as { status: string }
      ).status,
      "completed",
    );
    assert.equal(f.skills.activeContext("a", f.owner.taskId).length, 1);
    f.db
      .prepare(
        "UPDATE model_presets SET compactionMode='tokens',compactionValue=1000 WHERE id='preset'",
      )
      .run();
    f.connections.countTokens = async (_snapshot, request) =>
      request.messages.length > 3 ? 4000 : 100;
    for (let index = 0; index < 2; index++) {
      const next = f.engine.submit(
        "a",
        "chat",
        `Follow up ${index}`,
        randomUUID(),
      );
      f.engine.pump();
      for (let n = 0; n < 300; n++) {
        const state = (
          f.db
            .prepare("SELECT status FROM agent_turns WHERE id=?")
            .get(next.turnId) as { status: string }
        ).status;
        if (state === "completed") break;
        if (["failed", "blocked"].includes(state))
          assert.fail(
            JSON.stringify(
              f.db
                .prepare("SELECT * FROM agent_turns WHERE id=?")
                .get(next.turnId),
            ),
          );
        await delay(10);
      }
      assert.equal(
        (
          f.db
            .prepare("SELECT status FROM agent_turns WHERE id=?")
            .get(next.turnId) as { status: string }
        ).status,
        "completed",
      );
    }
    assert.ok(
      (
        f.db
          .prepare(
            "SELECT count(*) n FROM agent_context_summaries WHERE taskId=?",
          )
          .get(f.owner.taskId) as { n: number }
      ).n > 0,
    );
    const current = await f.skills.detail(createdId, "a");
    await f.skills.update(
      createdId,
      current.revision,
      { ...input, instructions: "New shared instructions." },
      "a",
    );
    assert.equal(
      (
        f.skills.activeContext("a", f.owner.taskId)[0] as {
          instructions: string;
        }
      ).instructions,
      "New shared instructions.",
    );
  });

test("v26 agents receive built-in defaults without changing existing records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ufai-skills-upgrade-"));
  const path = join(root, "db.sqlite");
  let db = openDatabase(path);
  const workspace = (
    db.prepare("SELECT id FROM workspaces").get() as { id: string }
  ).id;
  db.prepare(
    "INSERT INTO agents(id,workspaceId,name,instructions,createdAt,updatedAt) VALUES('old',?,'Existing','Keep this role','old','old')",
  ).run(workspace);
  db.exec(
    "DROP TABLE task_skill_activations; DROP TABLE skill_installations; DROP TABLE agent_skills; DROP TABLE skills; PRAGMA user_version=26",
  );
  db.close();
  const app = createApp({
    databasePath: path,
    execution: { autoStart: false },
    serveStatic: false,
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const response = await app.inject("/api/agents/old/skills");
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json<SkillPage>().items;
  assert.equal(
    items.find((skill) => skill.name === "skill-creation")!.enabled,
    false,
  );
  assert.equal(
    items.find((skill) => skill.name === "ufai-help")!.enabled,
    false,
  );
  db = openDatabase(path);
  assert.equal(
    (
      db.prepare("SELECT instructions FROM agents WHERE id='old'").get() as {
        instructions: string;
      }
    ).instructions,
    "Keep this role",
  );
  assert.equal(db.pragma("foreign_key_check").length, 0);
  db.close();
});

test("cancelled imports clean staging, changed previews cannot commit, and expired previews are reclaimed", async (t) => {
  const f = await runtimeFixture(t);
  const source = join(f.root, "source");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), skillDocument(input));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.skills.prepare("a", { path: source }, controller.signal),
    /cancelled/,
  );
  assert.equal(f.skills.list("a").total, 3);
  const preview = await f.skills.prepare("a", { path: source });
  const staging = f.db
    .prepare("SELECT candidates FROM skill_installations WHERE id=?")
    .get(preview.id) as { candidates: string };
  const candidate = JSON.parse(staging.candidates)[0] as { folder: string };
  await writeFile(
    join(candidate.folder, "SKILL.md"),
    skillDocument({ ...input, instructions: "Changed staged content" }),
  );
  await assert.rejects(
    f.skills.commit("a", preview.id, preview.candidates[0]!.key),
    /Staged skill files changed/,
  );
  f.db
    .prepare(
      "UPDATE skill_installations SET expiresAt='2000-01-01T00:00:00.000Z' WHERE id=?",
    )
    .run(preview.id);
  await assert.rejects(
    f.skills.commit("a", preview.id, preview.candidates[0]!.key),
    /expired/,
  );
  await f.skills.prepare("a", { path: source });
  assert.equal(
    f.db
      .prepare("SELECT id FROM skill_installations WHERE id=?")
      .get(preview.id),
    undefined,
  );
  await assert.rejects(readFile(join(candidate.folder, "SKILL.md")), /ENOENT/);
});
