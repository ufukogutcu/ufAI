import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import { ArtifactService } from "../src/artifact-service.js";
import { openDatabase } from "../src/database.js";
import { ManagedFiles } from "../src/managed-files.js";
import { retiredFileEvent } from "../src/workspace-folder-migration.js";
import { validateWhen } from "../src/trigger-schedule.js";

test("legacy workspace files survive import, collisions, interrupted startup and trigger retirement", async t => {
  const root = await mkdtemp(join(tmpdir(), "ufai-import-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "data.sqlite"), filesRoot = join(root, "files");
  const db = openDatabase(databasePath);
  const { id: workspaceId } = db.prepare("SELECT id FROM workspaces").get() as { id: string };
  const createdAt = "2025-04-01T10:00:00.000Z";
  db.prepare(`INSERT INTO agents(id,workspaceId,name,instructions,createdAt,updatedAt)
    VALUES ('source',?,'Source','',?,?),('trigger-agent',?,'Trigger agent','',?,?)`)
    .run(workspaceId, createdAt, createdAt, workspaceId, createdAt, createdAt);
  const files = new ManagedFiles(db, filesRoot);
  await files.start();
  const shared = (await files.repair("workspace", workspaceId)).path;
  const original = join(root, "source.txt");
  const artifacts = new ArtifactService(db, files, () => {});
  async function seed(bytes: string) {
    await writeFile(original, bytes);
    const version = await artifacts.createAttachment({ workspaceId, agentId: "source" }, {
      stream: createReadStream(original), size: Buffer.byteLength(bytes), name: "report.txt",
    }, AbortSignal.timeout(10000));
    db.prepare("UPDATE artifact_versions SET origin='published',createdAt=? WHERE id=?").run(createdAt, version.id);
    return version.id;
  }
  const first = await seed("first"), second = await seed("second"), corrupt = await seed("bad"), missing = await seed("missing");
  await artifacts.close();
  await files.close();

  const store = join(filesRoot, "workspaces", workspaceId, "artifacts");
  await writeFile(join(store, corrupt, "bytes"), "BAD");
  await unlink(join(store, missing, "bytes"));
  db.exec("DELETE FROM agents WHERE id='source'");
  db.exec(`
    INSERT INTO conversations(id,agentId,kind,createdAt) VALUES ('older-conversation','trigger-agent','task','2025-04-01');
    INSERT INTO agent_tasks(id,agentId,conversationId,title,status,createdAt,updatedAt)
      VALUES ('older-task','trigger-agent','older-conversation','Older task','completed','2025-04-01','2025-04-01');
    INSERT INTO agent_turns(id,taskId,conversationId,agentId,inputMessageId,attempt,status,phase,createdAt,updatedAt)
      VALUES ('older-turn','older-task','older-conversation','trigger-agent','older-input',1,'completed','completed','2025-04-01','2025-04-01');
    INSERT INTO agent_messages(id,conversationId,role,content,state,createdAt)
      VALUES ('older-input','older-conversation','user','Open a file','complete','2025-04-01');
  `);
  db.prepare("INSERT INTO media_open_references VALUES ('older-turn','open-old-file',?)").run(first);
  db.prepare("INSERT INTO task_output_selections VALUES ('older-turn',?)").run(JSON.stringify([second]));
  const triggerInput = { name: "Old file rule", instructions: "Handle a file", enabled: true, paused: false, requiredSkillIds: [],
    when: { kind: "event", eventType: retiredFileEvent } };
  db.prepare("INSERT INTO agent_triggers(id,agentId,workspaceId,revision,input,createdAt,updatedAt) VALUES ('rule','trigger-agent',?,1,?,?,?)")
    .run(workspaceId, JSON.stringify(triggerInput), createdAt, createdAt);
  db.prepare("INSERT INTO trigger_revisions(sequence,triggerId,revision,input,startedAt) VALUES (1,'rule',1,?,?)")
    .run(JSON.stringify(triggerInput), createdAt);
  db.exec("UPDATE trigger_clock SET value=2");
  db.prepare(`INSERT INTO trigger_events(sequence,id,workspaceId,sourceKey,eventId,eventType,occurredAt,receivedAt,data,fingerprint)
    VALUES (2,'old-file-event',?,'builtin','old-file-event',?,?,?,'{}','fixture')`).run(workspaceId, retiredFileEvent, createdAt, createdAt);
  const oldFiles = [{ versionId: first, mode: "file" }];
  const oldFileMetadata = { mode: "file", name: "report.txt", sha256: createHash("sha256").update("first").digest("hex"), size: 5 };
  const oldPayload = { attachments: oldFiles, data: {}, eventId: "received", eventType: "fixture" };
  const fingerprint = createHash("sha256").update(JSON.stringify({ data: {}, eventType: "fixture", files: [oldFileMetadata], occurredAt: null })).digest("hex");
  const token = "legacy-source-token";
  db.prepare("INSERT INTO trigger_event_sources(id,workspaceId,name,tokenHash,enabled,createdAt,updatedAt) VALUES ('source-id',?,'Source',?,1,?,?)")
    .run(workspaceId, createHash("sha256").update(token).digest("hex"), createdAt, createdAt);
  db.prepare(`INSERT INTO trigger_events(sequence,id,workspaceId,sourceId,sourceKey,eventId,eventType,occurredAt,receivedAt,data,attachments,fingerprint,processed)
    VALUES (3,'old-receipt',?,'source-id','source-id','received','fixture',?,?,'{}',?,?,1)`)
    .run(workspaceId, createdAt, createdAt, JSON.stringify(oldFiles), fingerprint);
  db.exec("UPDATE trigger_clock SET value=3");
  for (const state of ["queued", "completed"])
    db.prepare(`INSERT INTO trigger_occurrences(id,triggerId,revision,occurrenceKey,kind,scheduledAt,createdAt,state,eventId)
      VALUES (?,'rule',1,?,'event',?,?,?,'old-file-event')`).run(state, state, createdAt, createdAt, state);
  db.pragma("user_version=45");
  db.close();

  const migrated = openDatabase(databasePath);
  assert.equal(migrated.pragma("user_version", { simple: true }), 47);
  const grants = migrated.prepare("SELECT versionId FROM artifact_grants WHERE taskId='older-task' ORDER BY versionId").pluck().all();
  assert.deepEqual(grants, [first, second].sort());
  assert.deepEqual(migrated.prepare("SELECT id,state FROM trigger_occurrences ORDER BY id").all(), [
    { id: "completed", state: "completed" }, { id: "queued", state: "cancelled" },
  ]);
  const oldRule = migrated.prepare("SELECT input,revision FROM agent_triggers WHERE id='rule'").get() as { input: string; revision: number };
  assert.equal(JSON.parse(oldRule.input).enabled, false);
  assert.equal(oldRule.revision, 2);
  assert.equal(migrated.prepare("SELECT processed FROM trigger_events WHERE id='old-file-event'").pluck().get(), 1);
  assert.throws(() => validateWhen(triggerInput.when, createdAt), /retired/);
  const group = join("Imported files", "2025", "04");
  const targetDirectory = join(shared, group);
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(join(targetDirectory, `report [${first}].txt`), "keep existing");
  const stagingName = ".ufai-import-interrupted";
  migrated.prepare("UPDATE workspace_file_imports SET destination=?,stagingName=? WHERE versionId=?")
    .run(join(group, `report [${second}].txt`), stagingName, second);
  await writeFile(join(targetDirectory, stagingName), "unfinished staging");
  migrated.close();

  const app = createApp({ databasePath, filesRoot, execution: { autoStart: false } });
  try {
    assert.equal((await app.inject("/api/health")).statusCode, 200);
    const listing = await app.inject(`/api/workspaces/${workspaceId}/files?path=Imported%20files%2F2025%2F04`);
    assert.equal(listing.json().total, 3);
    assert.equal(await readFile(join(targetDirectory, `report [${first}].txt`), "utf8"), "keep existing");
    assert.equal(await readFile(join(targetDirectory, `report [${first}-2].txt`), "utf8"), "first");
    assert.equal(await readFile(join(targetDirectory, `report [${second}].txt`), "utf8"), "second");
    assert.equal((await app.inject(`/api/artifact-versions/${first}/content`)).body, "first");
    assert.equal((await app.inject(`/api/artifact-versions/${first}`)).json().producerAgentId, null);
    assert.equal((await app.inject(`/api/artifact-versions/${corrupt}/content`)).statusCode, 409);
    assert.equal((await app.inject(`/api/artifact-versions/${missing}/content`)).statusCode, 409);
    const events = (payload: object) => app.inject({ method: "POST", url: "/api/event-sources/source-id/events",
      headers: { authorization: `Bearer ${token}` }, payload });
    assert.equal((await events(oldPayload)).json().id, "old-receipt");
    assert.equal((await events({ ...oldPayload, eventId: "new" })).statusCode, 403);
  } finally {
    await app.close();
  }

  await unlink(join(targetDirectory, `report [${second}].txt`));
  const restarted = createApp({ databasePath, filesRoot, execution: { autoStart: false } });
  try {
    await restarted.ready();
    assert.equal((await readdir(targetDirectory)).length, 2, "completed imports are never repeated");
    assert.equal((await restarted.inject(`/api/artifact-versions/${second}/content`)).body, "second");
  } finally {
    await restarted.close();
  }
});
