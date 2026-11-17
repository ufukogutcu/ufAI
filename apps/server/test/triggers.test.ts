import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import type { Triggers } from "../src/triggers.js";
import {
  nextTime,
  validateWhen,
  wallTime,
  matches,
} from "../src/trigger-schedule.js";
import { parseSkill, skillDocument } from "../src/skill-packages.js";
import { AgentTools } from "../src/agent-tools.js";
import { removeTriggers } from "./legacy-schema.js";
import { migrateTriggers } from "../src/trigger-schema.js";

async function setup(t: TestContext, extra: any = {}) {
  const root = await mkdtemp(join(tmpdir(), "ufai-triggers-")),
    databasePath = join(root, "db.sqlite"),
    db = openDatabase(databasePath);
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as any).id;
  let clock = Date.parse("2027-01-04T08:00:00.000Z");
  db.exec(`INSERT INTO connections(id,provider,name,endpoint,createdAt,updatedAt,draft) VALUES('c','openai-compatible','Fixture','http://127.0.0.1:9999/v1','seed','seed',0);
    INSERT INTO provider_models(connectionId,id,name,contextWindowOverride,enabled) VALUES('c','m','Fixture',200000,1);
    INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES('p','Fixture','c','m','seed','seed');`);
  for (const id of ["a", "b"])
    db.prepare(
      "INSERT INTO agents(id,workspaceId,name,presetId,createdAt,updatedAt) VALUES(?,?,?,'p','seed','seed')",
    ).run(id, workspaceId, id);
  db.close();
  let app = createApp({
    databasePath,
    filesRoot: join(root, "files"),
    serveStatic: false,
    execution: { autoStart: false },
    triggers: { autoStart: false, now: () => clock },
    ...extra,
  });
  await app.ready();
  const service = () => (app as any).triggers as Triggers;
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const send = async (
    method: string,
    url: string,
    payload?: any,
    headers?: any,
  ) => app.inject({ method: method as any, url, payload, headers });
  const create = async (when: any, patch: any = {}, agentId = "a") => {
    const r = await send("POST", `/api/agents/${agentId}/triggers`, {
      trigger: {
        name: "Fixture trigger",
        instructions: "Handle this occurrence once.",
        when,
        enabled: true,
        paused: false,
        requiredSkillIds: [],
        ...patch,
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  return {
    root,
    databasePath,
    workspaceId,
    get app() {
      return app;
    },
    get service() {
      return service();
    },
    get db() {
      return service().db;
    },
    send,
    create,
    now: () => new Date(clock).toISOString(),
    advance: (ms: number) => (clock += ms),
    async reopen() {
      await app.close();
      app = createApp({
        databasePath,
        filesRoot: join(root, "files"),
        serveStatic: false,
        execution: { autoStart: false },
        triggers: { autoStart: false, now: () => clock },
        ...extra,
      });
      await app.ready();
    },
  };
}
function multipart(
  event: any,
  bytes = Buffer.from("invoice"),
  filename = "invoice.txt",
) {
  const boundary = "ufai-trigger-test";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="event"\r\n\r\n${JSON.stringify({ ...event, attachments: [{ name: filename, size: bytes.length, mode: "file" }] })}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file0"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test("cron preview shares execution calculation, explicit zones and DST rules", () => {
  assert.ok(
    matches([{ path: "object", operator: "eq", value: { b: 2, a: 1 } }], {
      object: { a: 1, b: 2 },
    }),
  );
  const now = "2027-01-01T00:00:00.000Z",
    w = validateWhen(
      { kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/London" },
      now,
    );
  assert.equal(nextTime(w, now), "2027-01-01T09:00:00.000Z");
  assert.throws(
    () =>
      validateWhen(
        { kind: "cron", expression: "0 0 30 2 *", timezone: "UTC" },
        now,
      ),
    /future|Invalid/,
  );
  assert.throws(
    () =>
      validateWhen(
        { kind: "cron", expression: "* * * * *", timezone: "Not/AZone" },
        now,
      ),
    /timezone/,
  );
  assert.throws(
    () =>
      validateWhen({ kind: "cron", expression: "* * *", timezone: "UTC" }, now),
    /fields/,
  );
  const fixed = validateWhen(
    { kind: "cron", expression: "30 1 * * *", timezone: "Europe/London" },
    now,
  );
  assert.equal(
    nextTime(fixed, "2027-03-28T00:59:00.000Z"),
    "2027-03-28T01:00:00.000Z",
  );
  assert.equal(
    nextTime(fixed, "2027-10-31T00:00:00.000Z"),
    "2027-10-31T00:30:00.000Z",
  );
  assert.equal(
    nextTime(fixed, "2027-10-31T00:30:00.000Z"),
    "2027-11-01T01:30:00.000Z",
  );
  const interval = validateWhen(
    { kind: "cron", expression: "* * * * *", timezone: "Europe/London" },
    now,
  );
  assert.equal(
    nextTime(interval, "2027-10-31T00:59:00.000Z"),
    "2027-10-31T01:00:00.000Z",
  );
  assert.throws(
    () => wallTime("2027-03-28T01:30", "Europe/London"),
    /does not exist/,
  );
  assert.equal(
    wallTime("2027-10-31T01:30", "Europe/London"),
    "2027-10-31T00:30:00.000Z",
  );
  const leap = validateWhen(
    { kind: "cron", expression: "0 0 29 2 *", timezone: "UTC" },
    now,
  );
  assert.equal(nextTime(leap, now), "2028-02-29T00:00:00.000Z");
});
test("durable unbounded catch-up rotates batches, survives restart and pause differs from disable", async (t) => {
  const s = await setup(t),
    a = await s.create({ kind: "every", everyMs: 1000 }, { paused: true }),
    b = await s.create({ kind: "every", everyMs: 1000 }, { paused: true }, "b");
  s.advance(2001 * 1000);
  await s.service.tick();
  assert.equal(s.service.get(a.id).queued, 32);
  assert.equal(s.service.get(b.id).queued, 32);
  await s.reopen();
  for (let i = 0; i < 64; i++) await s.service.tick();
  assert.equal(s.service.get(a.id).queued, 2001);
  assert.equal(s.service.get(b.id).queued, 2001);
  assert.equal(s.service.get(a.id).collectingBacklog, false);
  let current = s.service.get(a.id);
  current = await s.service.toggle(a.id, current.revision, { enabled: false });
  s.advance(60000);
  await s.service.tick();
  assert.equal(s.service.get(a.id).queued, 2001);
  await s.service.toggle(a.id, current.revision, { enabled: true });
  s.advance(1000);
  await s.service.tick();
  assert.equal(s.service.get(a.id).queued, 2002);
  await s.reopen();
  await s.service.tick();
  assert.equal(s.service.get(a.id).queued, 2002);
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM agent_tasks").get() as any) &&
      (s.db.prepare("SELECT count(*) n FROM agent_tasks").get() as any).n,
    0,
  );
});
test("one occurrence per trigger, waiting tasks hold queue, delayed context and failed attempts notify once", async (t) => {
  const s = await setup(t),
    a = await s.create({ kind: "every", everyMs: 1000 });
  s.advance(5000);
  await s.service.tick();
  let occurrences = s.service.occurrences(s.workspaceId, a.id).items;
  const started = occurrences.find((o) => o.state === "submitted")!;
  assert.ok(started.taskId);
  assert.equal(occurrences.length, 5);
  const message = s.db
    .prepare(
      "SELECT content FROM agent_messages WHERE turnId=? AND role='user'",
    )
    .get(started.turnId) as any;
  assert.match(message.content, /running later/);
  assert.match(message.content, /2027-01-04T08:00:01/);
  s.db
    .prepare("UPDATE agent_tasks SET status='waiting' WHERE id=?")
    .run(started.taskId);
  await s.service.tick();
  assert.equal(
    s.service.occurrences(s.workspaceId, a.id).items.filter((o) => o.taskId)
      .length,
    1,
  );
  await s.reopen();
  await s.service.tick();
  assert.equal(
    s.service.occurrences(s.workspaceId, a.id).items.filter((o) => o.taskId)
      .length,
    1,
  );
  s.db
    .prepare(
      "UPDATE agent_tasks SET status='failed',error='fixture failure' WHERE id=?",
    )
    .run(started.taskId);
  await s.service.tick();
  await s.service.tick();
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM workspace_inbox").get() as any).n,
    1,
  );
  const arrivals = (await s.send("GET", "/api/inbox/notifications?after=0")).json();
  assert.equal(arrivals.items.length, 1);
  assert.equal(arrivals.items[0].workspaceId, s.workspaceId);
  assert.ok(arrivals.items[0].preview.length > 0);
  assert.equal(
    s.service.occurrences(s.workspaceId, a.id).items.filter((o) => o.taskId)
      .length,
    2,
  );
  const next = s.service
    .occurrences(s.workspaceId, a.id)
    .items.find((o) => o.state === "submitted")!;
  s.db
    .prepare("UPDATE agent_tasks SET status='completed' WHERE id=?")
    .run(next.taskId);
  await s.service.tick();
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM workspace_inbox").get() as any).n,
    1,
  );
});
test("schedule edits preserve old catch-up and queued cancellation covers unenumerated schedules", async (t) => {
  const s = await setup(t),
    a = await s.create(
      { kind: "every", everyMs: 1000 },
      { paused: true, instructions: "Old instructions" },
    );
  s.advance(100000);
  const updated = await s.service.save(
    "a",
    {
      ...a,
      instructions: "New instructions",
      when: { kind: "every", everyMs: 10000 },
    },
    a.id,
    a.revision,
  );
  for (let i = 0; i < 5; i++) await s.service.tick();
  assert.equal(s.service.get(a.id).queued, 100);
  s.advance(20000);
  await s.service.tick();
  assert.equal(s.service.get(a.id).queued, 102);
  assert.equal(
    (
      s.db
        .prepare(
          "SELECT input FROM trigger_revisions WHERE triggerId=? AND revision=1",
        )
        .get(a.id) as any
    ).input.includes("Old instructions"),
    true,
  );
  s.advance(1000000);
  s.service.cancelQueued(a.id, true);
  await s.service.tick();
  assert.equal(s.service.get(a.id).queued, 0);
  s.advance(10000);
  await s.service.tick();
  assert.equal(s.service.get(a.id).queued, 1);
  assert.rejects(
    () => s.service.save("a", updated, a.id, a.revision),
    /changed/,
  );
});
test("custom events have durable fan-out, matching revisions, deterministic filters and idempotency", async (t) => {
  const s = await setup(t),
    source = s.service.saveSource(s.workspaceId, { name: "Invoices" });
  const when = {
    kind: "event",
    eventType: "invoice.received",
    sourceId: source.source.id,
    filters: [{ path: "amount", operator: "gt", value: 1000 }],
  };
  const a = await s.create(when, { paused: true }),
    b = await s.create(when, { paused: true }, "b");
  const payload = {
    eventId: "invoice-001",
    eventType: "invoice.received",
    data: { amount: 1200 },
  };
  const receipt = s.service.accept(
    s.workspaceId,
    source.source.id,
    source.source.id,
    s.service.eventInput(payload),
  );
  await s.service.save(
    "a",
    {
      ...a,
      when: {
        ...when,
        filters: [{ path: "amount", operator: "lt", value: 0 }],
      },
    },
    a.id,
    a.revision,
  );
  await s.reopen();
  await s.service.tick();
  assert.equal(s.service.receipt(receipt.id).matched, 2);
  assert.equal(s.service.get(a.id).queued, 1);
  assert.equal(s.service.get(b.id).queued, 1);
  const again = s.service.accept(
    s.workspaceId,
    source.source.id,
    source.source.id,
    s.service.eventInput(payload),
  );
  assert.equal(again.id, receipt.id);
  assert.throws(
    () =>
      s.service.accept(
        s.workspaceId,
        source.source.id,
        source.source.id,
        s.service.eventInput({ ...payload, data: { amount: 1201 } }),
      ),
    /different/,
  );
  assert.throws(
    () =>
      s.service.eventInput({ ...payload, eventType: "ufai.task.completed" }),
    /reserved/,
  );
  assert.ok(
    matches(
      [
        { path: "a.b", operator: "exists" },
        { path: "a.b", operator: "in", value: [1, 2] },
      ],
      { a: { b: 2 } },
    ),
  );
});
test("ingestion credentials are separate from local management, rotate and never appear in reads", async (t) => {
  const s = await setup(t),
    created = await s.send(
      "POST",
      `/api/workspaces/${s.workspaceId}/event-sources`,
      { name: "Ingress" },
    );
  assert.equal(created.statusCode, 201, created.body);
  const { source, token } = created.json();
  const payload = {
      eventId: "event-1",
      eventType: "custom.test",
      data: { ok: true },
    },
    url = `/api/event-sources/${source.id}/events`;
  assert.equal((await s.send("POST", url, payload)).statusCode, 401);
  assert.equal(
    (await s.send("POST", url, payload, { authorization: `Bearer ${token}` }))
      .statusCode,
    202,
  );
  const reads = await s.send("GET", `/api/event-sources/${source.id}`);
  assert.ok(!reads.body.includes(token));
  assert.ok(!reads.body.includes("tokenHash"));
  const cross = await s.send(
    "POST",
    `/api/workspaces/${s.workspaceId}/event-sources`,
    { name: "Bad" },
    { origin: "https://unrelated.invalid", host: "localhost" },
  );
  assert.equal(cross.statusCode, 403);
  const rotated = await s.send(
    "POST",
    `/api/event-sources/${source.id}/rotate`,
    { expectedRevision: source.revision },
  );
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.equal(
    (await s.send("POST", url, payload, { authorization: `Bearer ${token}` }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await s.send("POST", url, payload, {
        authorization: `Bearer ${rotated.json().token}`,
      })
    ).statusCode,
    202,
  );
});
test("multipart event files are stored once, replay checked by bytes, shared with tasks, and not published events", async (t) => {
  const s = await setup(t, { artifacts: { maxStorageBytes: 7 } }),
    source = s.service.saveSource(s.workspaceId, { name: "Files" }),
    event = {
      eventId: "file-1",
      eventType: "invoice.received",
      data: { amount: 1200 },
    };
  const a = await s.create({ kind: "event", eventType: event.eventType }),
    b = await s.create({ kind: "event", eventType: event.eventType }, {}, "b");
  async function upload(bytes?: Buffer) {
    const m = multipart(event, bytes);
    return s.app.inject({
      method: "POST",
      url: `/api/event-sources/${source.source.id}/events`,
      ...m,
      headers: { ...m.headers, authorization: `Bearer ${source.token}` },
    });
  }
  const first = await upload();
  assert.equal(first.statusCode, 202, first.body);
  const receipt = first.json();
  assert.equal(receipt.attachments.length, 1);
  const second = await upload();
  assert.equal(second.statusCode, 202, second.body);
  assert.equal(second.json().id, receipt.id);
  const changed = await upload(Buffer.from("changed"));
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(
    (
      s.db
        .prepare(
          "SELECT count(*) n FROM artifact_versions WHERE origin='event_upload'",
        )
        .get() as any
    ).n,
    1,
  );
  assert.equal(
    (
      s.db
        .prepare(
          "SELECT count(*) n FROM trigger_events WHERE eventType='ufai.artifact.published'",
        )
        .get() as any
    ).n,
    0,
  );
  await s.reopen();
  await s.service.tick();
  for (const id of [a.id, b.id]) {
    const o = s.service.occurrences(s.workspaceId, id).items[0];
    assert.ok(o.taskId);
    assert.equal(
      (
        s.db
          .prepare(
            "SELECT count(*) n FROM artifact_references r JOIN agent_messages m ON m.id=r.messageId JOIN agent_tasks t ON t.conversationId=m.conversationId WHERE t.id=? AND r.versionId=?",
          )
          .get(o.taskId, receipt.attachments[0].versionId) as any
      ).n,
      1,
    );
  }
});
test("event size limits and cancelled uploads leave no receipt or staged file", async (t) => {
  const s = await setup(t, { uploads: { maxFiles: 1, maxBytes: 4 } }),
    source = s.service.saveSource(s.workspaceId, { name: "Limits" });
  const m = multipart(
    { eventId: "too-large", eventType: "custom.file", data: {} },
    Buffer.from("too large"),
  );
  const r = await s.app.inject({
    method: "POST",
    url: `/api/event-sources/${source.source.id}/events`,
    ...m,
    headers: { ...m.headers, authorization: `Bearer ${source.token}` },
  });
  assert.equal(r.statusCode, 413, r.body);
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM trigger_events").get() as any).n,
    0,
  );
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM trigger_ingests").get() as any).n,
    0,
  );
});
test("built-in lifecycle events are transactional and causal cycles are suppressed", async (t) => {
  const s = await setup(t),
    trigger = await s.create({
      kind: "event",
      eventType: "ufai.task.completed",
    });
  const root = s.service.execution.submit("a", "new", "Root", randomUUID());
  s.db
    .prepare("UPDATE agent_tasks SET status='completed' WHERE id=?")
    .run(root.taskId);
  await s.service.tick();
  const o = s.service.occurrences(s.workspaceId, trigger.id).items[0];
  assert.ok(o.taskId);
  s.db
    .prepare("UPDATE agent_tasks SET status='completed' WHERE id=?")
    .run(o.taskId);
  await s.service.tick();
  const all = s.service.occurrences(s.workspaceId, trigger.id).items;
  assert.equal(all.filter((x) => x.state === "suppressed").length, 1);
  assert.equal(all.filter((x) => x.taskId).length, 1);
  const before = (
    s.db.prepare("SELECT count(*) n FROM trigger_events").get() as any
  ).n;
  assert.throws(() =>
    s.db.transaction(() => {
      s.db
        .prepare("UPDATE agent_tasks SET status='failed' WHERE id=?")
        .run(root.taskId);
      throw new Error("rollback");
    })(),
  );
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM trigger_events").get() as any).n,
    before,
  );
});
test("skill templates, setup consent, updates and exact review preserve queue and manual state", async (t) => {
  const s = await setup(t),
    folder = join(s.root, "package");
  await mkdir(folder);
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: scheduled-skill\ndescription: Scheduled skill\nmetadata:\n  openclaw:\n    requires:\n      bins: [example]\nuser-invocable: true\n---\nUse this skill for a report.\n",
  );
  await writeFile(
    join(folder, "ufai.triggers.json"),
    JSON.stringify({
      version: 1,
      templates: [
        {
          id: "daily",
          name: "Daily report",
          description: "Report daily",
          instructions: "Prepare report",
          when: { kind: "cron", expression: "0 9 * * *" },
        },
      ],
    }),
  );
  const preview = await s.service.skills.prepare("a", { path: folder });
  const detail = await s.service.skills.commit(
    "a",
    preview.id,
    preview.candidates[0].key,
  );
  await s.service.tick();
  const info = await s.service.automation!.inspect("a", detail.id),
    review = info.setups.find((x) => x.kind === "setup")!;
  assert.equal(info.templates.length, 1);
  assert.ok(review.taskId);
  assert.equal(s.service.list(s.workspaceId).total, 0);
  const turn = s.db
    .prepare("SELECT id FROM agent_turns WHERE taskId=? ORDER BY rowid LIMIT 1")
    .get(review.taskId) as any;
  const owner = {
    workspaceId: s.workspaceId,
    agentId: "a",
    taskId: review.taskId!,
    turnId: turn.id,
  };
  assert.throws(
    () => s.service.automation!.assertMutation(owner),
    /user reply/,
  );
  assert.throws(
    () =>
      s.service.automation!.review(
        review.id,
        review.fingerprint,
        "approved",
        owner,
      ),
    /user reply/,
  );
  s.service.execution.submit(
    "a",
    review.taskId!,
    "Yes, set up the daily report",
    randomUUID(),
  );
  s.service.automation!.review(
    review.id,
    review.fingerprint,
    "approved",
    owner,
  );
  const trigger = await s.service.automation!.fromTemplate(
    "a",
    detail.id,
    "daily",
    { enabled: true, paused: true, when: { kind: "every", everyMs: 1000 } },
    owner,
  );
  const before = await s.service.skills.detail(detail.id, "a");
  const changed = await s.service.skills.update(
    detail.id,
    before.revision,
    {
      name: before.name,
      description: before.description,
      instructions: "Changed report instructions",
    },
    "a",
  );
  assert.equal(changed.frontmatter?.["user-invocable"], true);
  s.advance(1000);
  await s.service.tick();
  assert.equal(s.service.get(trigger.id).queued, 1);
  let current = s.service.get(trigger.id);
  await s.service.toggle(trigger.id, current.revision, { paused: false });
  assert.equal(s.service.get(trigger.id).state, "review_required");
  const updated = await s.service.automation!.inspect("a", detail.id),
    update = updated.setups.find((x) => x.kind === "review")!;
  assert.ok(update.previousSnapshot);
  assert.notEqual(
    update.previousSnapshot!.instructions,
    updated.snapshot.instructions,
  );
  assert.throws(
    () => s.service.automation!.review(update.id, "stale", "approved", owner),
    /changed/,
  );
  s.service.automation!.review(
    update.id,
    update.fingerprint,
    "approved",
    owner,
  );
  await s.service.tick();
  assert.ok(s.service.occurrences(s.workspaceId, trigger.id).items[0].taskId);
  const same = await s.service.skills.prepare("a", { path: changed.path });
  await s.service.skills.commit("a", same.id, same.candidates[0].key);
  assert.equal(
    s.service
      .automation!.list("a", detail.id)
      .items.filter(
        (x) => x.fingerprint === update.fingerprint && x.kind === "setup",
      ).length,
    1,
  );
});
test("invalid optional manifests do not invalidate instruction skills; foreign frontmatter round-trips", async (t) => {
  const s = await setup(t),
    folder = join(s.root, "bad-manifest");
  await mkdir(folder);
  const input = parseSkill(
    "---\nname: portable\ndescription: Portable\nmetadata:\n  openclaw: {requires: {bins: [tool]}}\nhomepage: https://example.invalid\n---\nInstructions",
  );
  assert.equal(
    parseSkill(skillDocument(input)).frontmatter?.homepage,
    "https://example.invalid",
  );
  await writeFile(join(folder, "SKILL.md"), skillDocument(input));
  await writeFile(join(folder, "ufai.triggers.json"), "{invalid");
  const p = await s.service.skills.prepare("a", { path: folder }),
    d = await s.service.skills.commit("a", p.id, p.candidates[0].key);
  const inspected = await s.service.automation!.inspect("a", d.id);
  assert.ok(inspected.error);
  assert.equal(d.error, null);
  assert.ok(s.service.skills.isEnabled("a", d.id));
});
test("version 29 upgrades preserve tasks and trigger management scopes agents and workspaces", async (t) => {
  const s = await setup(t),
    task = s.service.execution.submit("a", "new", "Keep task", randomUUID());
  await s.app.close();
  const old = openDatabase(s.databasePath);
  removeTriggers(old);
  old.pragma("user_version=29");
  old.close();
  // Reopen without closing an already closed app a second time.
  await s.reopen();
  assert.ok(
    s.db.prepare("SELECT 1 FROM agent_tasks WHERE id=?").get(task.taskId),
  );
  const a = await s.create({
    kind: "cron",
    expression: "0 9 * * *",
    timezone: "UTC",
  });
  const owner = {
    workspaceId: s.workspaceId,
    agentId: "b",
    taskId: "none",
    turnId: "none",
  };
  assert.throws(() => s.service.assertOwned(a.id, owner), /another agent/);
  const filtered = await s.send(
    "GET",
    `/api/workspaces/${s.workspaceId}/triggers?kind=event`,
  );
  assert.equal(filtered.json().total, 0);
  const stale = await s.send("PATCH", `/api/triggers/${a.id}`, {
    expectedRevision: 0,
    trigger: a,
  });
  assert.equal(stale.statusCode, 400);
});

test("agent trigger mutations are owned, journaled and fenced during skill setup", async (t) => {
  const s = await setup(t);
  const submitted = s.service.execution.submit(
    "a",
    "new",
    "Create requested automation",
    randomUUID(),
  );
  const owner = {
    workspaceId: s.workspaceId,
    agentId: "a",
    taskId: submitted.taskId!,
    turnId: submitted.turnId,
  };
  const tools = (s.service.execution as any).tools as AgentTools;
  await tools.locations(owner);
  const call = {
    id: "create-once",
    name: "trigger_create",
    arguments: {
      trigger: {
        name: "Owned",
        instructions: "Do work",
        when: { kind: "every", everyMs: 1000 },
        enabled: false,
        paused: false,
        requiredSkillIds: [],
      },
    },
  };
  const first = await tools.dispatch(
    owner,
    call,
    new AbortController().signal,
    async () => ({}),
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await tools.dispatch(
    owner,
    call,
    new AbortController().signal,
    async () => ({}),
  );
  assert.deepEqual(second, first);
  assert.equal(s.service.list(s.workspaceId, "a").total, 1);
  const foreign = s.service.execution.submit(
    "b",
    "new",
    "Other task",
    randomUUID(),
  );
  const otherOwner = {
    workspaceId: s.workspaceId,
    agentId: "b",
    taskId: foreign.taskId!,
    turnId: foreign.turnId,
  };
  await tools.locations(otherOwner);
  const denied = await tools.dispatch(
    otherOwner,
    {
      id: "inspect-foreign",
      name: "trigger_inspect",
      arguments: { triggerId: (first as any).trigger.id },
    },
    new AbortController().signal,
    async () => ({}),
  );
  assert.equal(denied.ok, false);
  assert.match(String(denied.error), /another agent/);
  const skill = await s.service.skills.create("a", {
    name: "setup-consent",
    description: "Needs setup",
    instructions: "Offer scheduling setup",
  });
  s.service.automation!.claim("a", skill.id, owner.taskId);
  const gated = await tools.dispatch(
    owner,
    { ...call, id: "no-consent" },
    new AbortController().signal,
    async () => ({}),
  );
  assert.equal(gated.ok, false);
  assert.match(String(gated.error), /user reply/);
});

test("queued historical definitions retain required skills after a future-definition edit", async (t) => {
  const s = await setup(t),
    skill = await s.service.skills.create("a", {
      name: "historical",
      description: "Historical requirement",
      instructions: "Keep the old queued task guidance",
    });
  const trigger = await s.create(
    { kind: "every", everyMs: 1000 },
    { paused: true, requiredSkillIds: [skill.id] },
  );
  s.advance(2000);
  await s.service.tick();
  const edited = await s.service.save(
    "a",
    { ...trigger, paused: false, requiredSkillIds: [] },
    trigger.id,
    trigger.revision,
  );
  await s.service.tick();
  const occurrence = s.service
    .occurrences(s.workspaceId, edited.id)
    .items.find((x) => x.taskId)!;
  assert.ok(occurrence.taskId);
  assert.ok(
    s.db
      .prepare(
        "SELECT 1 FROM task_skill_activations WHERE taskId=? AND skillId=?",
      )
      .get(occurrence.taskId, skill.id),
  );
});

test("manual built-in samples execute only their selected trigger without forging a built-in fan-out", async (t) => {
  const s = await setup(t),
    trigger = await s.create({
      kind: "event",
      eventType: "ufai.task.completed",
    });
  const result = s.service.run(trigger.id, "manual-built-in", {
    eventId: "sample",
    eventType: "ufai.task.completed",
    data: { taskId: "sample-task" },
  });
  await s.service.tick();
  const occurrence = s.service
    .occurrences(s.workspaceId, trigger.id)
    .items.find((o) => o.id === result.occurrenceId)!;
  assert.equal(occurrence.kind, "manual");
  assert.ok(occurrence.taskId);
  assert.equal(s.service.occurrences(s.workspaceId, trigger.id).total, 1);
  assert.throws(
    () =>
      s.service.eventInput({
        eventId: "external-spoof",
        eventType: "ufai.task.completed",
        data: {},
      }),
    /reserved/,
  );
});

test("skill review also fences a submitted task before its first model start without starving the agent lane", async (t) => {
  const s = await setup(t),
    skill = await s.service.skills.create("a", {
      name: "start-fence",
      description: "Start fence",
      instructions: "Approved initial guidance",
    });
  const trigger = await s.create(
    { kind: "every", everyMs: 1000 },
    { requiredSkillIds: [skill.id] },
  );
  s.advance(1000);
  await s.service.tick();
  const occurrence = s.service
    .occurrences(s.workspaceId, trigger.id)
    .items.find((o) => o.taskId)!;
  const setupTask = s.service
    .automation!.list("a", skill.id)
    .items.find((x) => x.kind === "setup")?.taskId;
  if (setupTask) await s.service.execution.cancelTask(setupTask);
  await s.service.skills.update(
    skill.id,
    skill.revision,
    {
      name: skill.name,
      description: skill.description,
      instructions: "Unreviewed changed guidance",
    },
    "a",
  );
  const manual = s.service.execution.submit(
    "a",
    "new",
    "Independent requested work",
    randomUUID(),
  );
  const started: string[] = [];
  t.mock.method(
    s.service.execution as any,
    "run",
    async (turn: any, active: any) => {
      started.push(turn.taskId);
      await new Promise<void>((resolve) =>
        active.controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
    },
  );
  s.service.execution.pump();
  assert.deepEqual(started, [manual.taskId]);
  assert.equal(
    (
      s.db
        .prepare("SELECT status FROM agent_tasks WHERE id=?")
        .get(occurrence.taskId) as any
    ).status,
    "queued",
  );
});

test(
  "workspace teardown aborts a stalled multipart event before its first file",
  { timeout: 10000 },
  async (t) => {
    const s = await setup(t),
      source = s.service.saveSource(s.workspaceId, {
        name: "Stalled transfer",
      });
    const { request } = await import("node:http");
    await s.app.listen({ host: "127.0.0.1", port: 0 });
    const address = s.app.server.address() as { port: number };
    const req = request({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: `/api/event-sources/${source.source.id}/events`,
      headers: {
        authorization: `Bearer ${source.token}`,
        "content-type": "multipart/form-data; boundary=stalled",
      },
    });
    const ended = new Promise<void>((resolve) => {
      req.once("error", () => resolve());
      req.once("response", (res) => {
        res.resume();
        res.once("end", resolve);
      });
    });
    req.flushHeaders();
    req.write(
      '--stalled\r\nContent-Disposition: form-data; name="event"\r\n\r\n',
    );
    try {
      for (
        let i = 0;
        i < 100 && !s.db.prepare("SELECT 1 FROM trigger_ingests").get();
        i++
      )
        await new Promise((r) => setTimeout(r, 5));
      assert.ok(s.db.prepare("SELECT 1 FROM trigger_ingests").get());
      await s.service.files.triggerUploads!.settleWorkspace(s.workspaceId);
      await ended;
      assert.equal(
        (s.db.prepare("SELECT count(*) n FROM trigger_ingests").get() as any).n,
        0,
      );
      assert.equal(
        (s.db.prepare("SELECT count(*) n FROM trigger_events").get() as any).n,
        0,
      );
    } finally {
      req.destroy();
    }
  },
);

test("schedule revisions take effect at commit and clock rollback cannot replay collected dates", async (t) => {
  const s = await setup(t);
  const skill = await s.service.skills.create("a", {
    name: "commit-fence",
    description: "Commit fixture",
    instructions: "Use this guidance",
  });
  const trigger = await s.create(
    { kind: "every", everyMs: 1000 },
    { paused: true },
  );
  const original = s.service.skills.refresh.bind(s.service.skills);
  let advanced = false;
  const mock = t.mock.method(
    s.service.skills,
    "refresh",
    async (...args: Parameters<typeof original>) => {
      if (!advanced) {
        advanced = true;
        s.advance(5000);
      }
      return original(...args);
    },
  );
  const updated = await s.service.save(
    "a",
    { ...trigger, instructions: "New guidance", requiredSkillIds: [skill.id] },
    trigger.id,
    trigger.revision,
  );
  mock.mock.restore();
  await s.service.tick();
  let rows = s.service.occurrences(s.workspaceId, trigger.id).items;
  assert.equal(rows.length, 5);
  assert.ok(rows.every((o) => o.revision === 1));
  s.advance(1000);
  await s.service.tick();
  assert.equal(
    s.service.occurrences(s.workspaceId, trigger.id).items[0].revision,
    2,
  );
  s.advance(-4000);
  await s.service.save(
    "a",
    { ...updated, name: "After clock rollback" },
    trigger.id,
    updated.revision,
  );
  s.advance(5000);
  await s.service.tick();
  rows = s.service.occurrences(s.workspaceId, trigger.id).items;
  assert.equal(new Set(rows.map((o) => o.scheduledAt)).size, rows.length);
  assert.equal(rows.length, 7);
});

test("failure notices are coupled to every processed receipt under rotating fan-out", async (t) => {
  const s = await setup(t);
  const triggers = [];
  for (let i = 0; i < 12; i++)
    triggers.push(await s.create({ kind: "every", everyMs: 1000 }));
  s.advance(1000);
  await s.service.tick();
  await s.service.tick();
  const occurrences = s.service
    .occurrences(s.workspaceId)
    .items.filter((o) => o.taskId);
  assert.equal(occurrences.length, 12);
  for (const o of occurrences)
    s.db
      .prepare(
        "UPDATE agent_tasks SET status='failed',error='Fixture failure' WHERE id=?",
      )
      .run(o.taskId);
  // Fan-out may rotate past the oldest receipts while their matching scan is unfinished.
  (s.service as any).eventCursor = (
    s.db
      .prepare(
        "SELECT sequence FROM trigger_events ORDER BY sequence LIMIT 1 OFFSET 7",
      )
      .get() as any
  ).sequence;
  for (let i = 0; i < 5; i++) await s.service.tick();
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM workspace_inbox").get() as any).n,
    12,
  );
  await s.reopen();
  await s.service.tick();
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM workspace_inbox").get() as any).n,
    12,
  );
});

test("a previously approved package fingerprint can receive a fresh review after reverting", async (t) => {
  const s = await setup(t);
  let skill = await s.service.skills.create("a", {
    name: "review-rounds",
    description: "Review fixture",
    instructions: "Version A",
  });
  const trigger = await s.create(
    { kind: "every", everyMs: 1000 },
    { paused: true, requiredSkillIds: [skill.id] },
  );
  const reviewedIds = new Set<string>();
  for (const instructions of ["Version B", "Version A", "Version B"]) {
    skill = await s.service.skills.update(
      skill.id,
      skill.revision,
      { name: skill.name, description: skill.description, instructions },
      "a",
    );
    await s.service.tick();
    const review = s.service
      .automation!.list("a", skill.id)
      .items.find(
        (r) =>
          r.kind === "review" &&
          r.fingerprint ===
            (
              s.db
                .prepare("SELECT fingerprint FROM skills WHERE id=?")
                .get(skill.id) as any
            ).fingerprint &&
          r.state !== "approved",
      );
    assert.ok(review, `Missing review for ${instructions}`);
    assert.ok(!reviewedIds.has(review.id));
    reviewedIds.add(review.id);
    s.service.automation!.review(review.id, review.fingerprint, "approved");
    assert.equal(s.service.get(trigger.id).blocker, null);
    assert.equal(s.service.get(trigger.id).paused, true);
  }
  assert.equal(reviewedIds.size, 3);
});

test("deleting a trigger cancels never-started submitted tasks but preserves tasks that started", async (t) => {
  const s = await setup(t);
  const trigger = await s.create({ kind: "every", everyMs: 1000 });
  const started = await s.create({ kind: "every", everyMs: 1000 });
  s.advance(1000);
  await s.service.tick();
  const one = s.service.occurrences(s.workspaceId, trigger.id).items[0];
  const two = s.service.occurrences(s.workspaceId, started.id).items[0];
  s.db
    .prepare("UPDATE agent_turns SET snapshot='{}',status='waiting' WHERE id=?")
    .run(two.turnId);
  s.db
    .prepare("UPDATE agent_tasks SET status='waiting' WHERE id=?")
    .run(two.taskId);
  s.service.remove(trigger.id, trigger.revision, true);
  s.service.remove(started.id, started.revision, true);
  assert.equal(s.service.execution.task(one.taskId!).status, "cancelled");
  assert.equal(s.service.execution.task(two.taskId!).status, "waiting");
  await s.reopen();
  await s.service.tick();
  assert.equal(s.service.execution.task(one.taskId!).status, "cancelled");
});

test("shutdown fences dispatch that was awaiting skill validation", async (t) => {
  const s = await setup(t);
  const skill = await s.service.skills.create("a", {
    name: "stop-fence",
    description: "Stop fixture",
    instructions: "Use guidance",
  });
  const trigger = await s.create(
    { kind: "every", everyMs: 1000 },
    { requiredSkillIds: [skill.id] },
  );
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const original = s.service.skills.refresh.bind(s.service.skills);
  t.mock.method(
    s.service.skills,
    "refresh",
    async (...args: Parameters<typeof original>) => {
      entered();
      await gate;
      return original(...args);
    },
  );
  s.advance(1000);
  const ticking = s.service.tick();
  await waiting;
  const closing = s.service.close();
  release();
  await Promise.all([ticking, closing]);
  assert.equal(
    s.service.occurrences(s.workspaceId, trigger.id).items[0].taskId,
    null,
  );
});

test("artifact events retain the publishing turn's lineage when a newer task input exists", async (t) => {
  const s = await setup(t);
  const trigger = await s.create({ kind: "every", everyMs: 1000 });
  s.advance(1000);
  await s.service.tick();
  const occurrence = s.service.occurrences(s.workspaceId, trigger.id).items[0];
  s.service.execution.submit(
    "a",
    occurrence.taskId!,
    "Later user input",
    randomUUID(),
  );
  const file = join(s.root, "publication.txt");
  await writeFile(file, "Published fixture");
  const version = await s.service.artifacts.publish(
    {
      workspaceId: s.workspaceId,
      agentId: "a",
      taskId: occurrence.taskId!,
      turnId: occurrence.turnId!,
    },
    { path: file },
    new AbortController().signal,
  );
  const event = s.db
    .prepare("SELECT lineage FROM trigger_events WHERE eventId=?")
    .get(`artifact:${version.id}`) as any;
  assert.deepEqual(JSON.parse(event.lineage), [trigger.id]);
});

test("template creation rejects an outdated reviewed fingerprint and requires a missing timezone", async (t) => {
  const s = await setup(t);
  const skill = await s.service.skills.create("a", {
    name: "template-fence",
    description: "Template fixture",
    instructions: "Review this template",
  });
  await writeFile(
    join(skill.path, "ufai.triggers.json"),
    JSON.stringify({
      version: 1,
      templates: [
        {
          id: "daily",
          name: "Daily",
          description: "Daily work",
          instructions: "Do daily work",
          when: { kind: "cron", expression: "0 9 * * *" },
        },
      ],
    }),
  );
  const info = await s.service.automation!.inspect("a", skill.id);
  assert.equal(info.templates[0].timezoneRequired, true);
  await assert.rejects(
    s.service.automation!.fromTemplate("a", skill.id, "daily", {}),
    /timezone/,
  );
  await s.service.skills.update(
    skill.id,
    (await s.service.skills.detail(skill.id, "a")).revision,
    {
      name: skill.name,
      description: skill.description,
      instructions: "Changed setup guidance",
    },
    "a",
  );
  const response = await s.send(
    "POST",
    `/api/agents/a/skill-automations/${skill.id}/templates`,
    {
      templateId: "daily",
      fingerprint: info.fingerprint,
      overrides: {
        when: {
          kind: "cron",
          expression: "0 9 * * *",
          timezone: "Europe/London",
        },
      },
    },
  );
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(s.service.list(s.workspaceId).total, 0);
});

test("trigger causation survives user follow-ups and delegated agent tasks", async (t) => {
  const s = await setup(t);
  const trigger = await s.create({
    kind: "event",
    eventType: "ufai.task.completed",
  });
  const root = s.service.execution.submit(
    "a",
    "new",
    "Root work",
    randomUUID(),
  );
  s.db
    .prepare("UPDATE agent_tasks SET status='completed' WHERE id=?")
    .run(root.taskId);
  await s.service.tick();
  const occurrence = s.service.occurrences(s.workspaceId, trigger.id).items[0];
  const followup = s.service.execution.submit(
    "a",
    occurrence.taskId!,
    "Answer to the user question",
    randomUUID(),
  );
  const envelope = JSON.parse(
    (
      s.db
        .prepare("SELECT envelope FROM agent_turns WHERE id=?")
        .get(followup.turnId) as any
    ).envelope,
  );
  assert.deepEqual(envelope.trigger.lineage, [trigger.id]);
  const link = await s.send(
    "POST",
    `/api/workspaces/${s.workspaceId}/communication-links`,
    { sourceAgentId: "a", targetAgentId: "b" },
  );
  assert.equal(link.statusCode, 201, link.body);
  const owner = {
    workspaceId: s.workspaceId,
    agentId: "a",
    taskId: occurrence.taskId!,
    turnId: followup.turnId,
  };
  const tools = (s.service.execution as any).tools as AgentTools;
  const delegated = await tools.dispatch(
    owner,
    {
      id: "delegate-with-lineage",
      name: "agent_send",
      arguments: { agentId: "b", content: "Help with this work" },
    },
    new AbortController().signal,
    async () => ({}),
  );
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  const helper = s.db
    .prepare(
      "SELECT envelope FROM agent_turns WHERE agentId='b' ORDER BY rowid DESC LIMIT 1",
    )
    .get() as any;
  assert.deepEqual(JSON.parse(helper.envelope).trigger.lineage, [trigger.id]);
  s.db
    .prepare("UPDATE agent_tasks SET status='completed' WHERE id=?")
    .run(occurrence.taskId);
  await s.service.tick();
  assert.ok(
    s.service
      .occurrences(s.workspaceId, trigger.id)
      .items.some((o) => o.state === "suppressed"),
  );
});

test("retry and follow-up cannot reopen an old occurrence while a newer occurrence is unfinished", async (t) => {
  const s = await setup(t);
  const trigger = await s.create({ kind: "every", everyMs: 1000 });
  s.advance(2000);
  await s.service.tick();
  const old = s.service
    .occurrences(s.workspaceId, trigger.id)
    .items.find((o) => o.taskId)!;
  s.db
    .prepare("UPDATE agent_turns SET status='failed' WHERE id=?")
    .run(old.turnId);
  s.db
    .prepare("UPDATE agent_tasks SET status='failed' WHERE id=?")
    .run(old.taskId);
  await s.service.tick();
  assert.throws(
    () => s.service.execution.retry(old.taskId!),
    /Another occurrence/,
  );
  s.db
    .prepare("UPDATE agent_tasks SET status='completed' WHERE id=?")
    .run(old.taskId);
  assert.throws(
    () =>
      s.service.execution.submit(
        "a",
        old.taskId!,
        "Continue earlier work",
        randomUUID(),
      ),
    /Another occurrence/,
  );
  const active = s.service
    .occurrences(s.workspaceId, trigger.id)
    .items.find((o) => o.state === "submitted")!;
  await s.service.execution.cancelTask(active.taskId!);
  const accepted = s.service.execution.submit(
    "a",
    old.taskId!,
    "Continue earlier work",
    randomUUID(),
  );
  assert.ok(accepted.turnId);
});

test("state-filtered lists ignore historical skill requirements once their work is complete", async (t) => {
  const s = await setup(t);
  const skill = await s.service.skills.create("a", {
    name: "released-dependency",
    description: "Released fixture",
    instructions: "Original guidance",
  });
  const trigger = await s.create(
    { kind: "every", everyMs: 1000 },
    { requiredSkillIds: [skill.id] },
  );
  s.advance(1000);
  await s.service.tick();
  const old = s.service.occurrences(s.workspaceId, trigger.id).items[0];
  await s.service.save(
    "a",
    { ...trigger, requiredSkillIds: [] },
    trigger.id,
    trigger.revision,
  );
  s.db
    .prepare("UPDATE agent_tasks SET status='completed' WHERE id=?")
    .run(old.taskId);
  await s.service.skills.update(
    skill.id,
    skill.revision,
    {
      name: skill.name,
      description: skill.description,
      instructions: "New unrelated guidance",
    },
    "a",
  );
  const active = s.service.list(s.workspaceId, "a", 50, 0, { state: "active" });
  assert.equal(active.total, 1);
  assert.equal(active.items[0].state, "active");
  assert.equal(
    s.service.list(s.workspaceId, "a", 50, 0, { state: "review_required" })
      .total,
    0,
  );
});

for (const early of [false, true])
  test(`version 30 ${early ? "early development" : "final"} upgrades preserve collected occurrences and installation reviews`, async (t) => {
    const s = await setup(t);
    const skill = await s.service.skills.create("a", {
      name: "upgrade-review",
      description: "Upgrade fixture",
      instructions: "Original reviewed guidance",
    });
    const trigger = await s.create(
      { kind: "every", everyMs: 1000 },
      { paused: true, requiredSkillIds: [skill.id] },
    );
    s.advance(3000);
    await s.service.tick();
    const reviewId = s.service.automation!.list("a", skill.id).items[0].id;
    const tables = [
      "trigger_clock",
      "agent_triggers",
      "trigger_revisions",
      "trigger_occurrences",
      "trigger_dependencies",
      "skill_automation_setups",
    ];
    const rows = tables.map(
      (table) =>
        s.db.prepare(`SELECT * FROM ${table}`).all() as Record<
          string,
          unknown
        >[],
    );
    await s.app.close();
    const legacy = openDatabase(s.databasePath);
    removeTriggers(legacy);
    migrateTriggers(legacy);
    legacy.exec("DELETE FROM trigger_clock");
    tables.forEach((table, index) => {
      const columns = (
        legacy.pragma(`table_info(${table})`) as { name: string }[]
      ).map((c) => c.name);
      const insert = legacy.prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      );
      for (const row of rows[index]) insert.run(...columns.map((c) => row[c]));
    });
    if (early)
      legacy.exec(`
    DROP INDEX trigger_turn_start;
    DROP TABLE trigger_cancellations;
    ALTER TABLE agent_triggers DROP COLUMN dispatchFailures;
    ALTER TABLE trigger_events DROP COLUMN uploadFingerprint;
    ALTER TABLE skill_automation_setups DROP COLUMN consentAfterRow;
  `);
    legacy.pragma("user_version=30");
    legacy.close();
    await s.reopen();
    assert.equal(s.db.pragma("user_version", { simple: true }), 38);
    assert.ok(
      (s.db.pragma("table_info(agent_triggers)") as { name: string }[]).some(
        (c) => c.name === "dispatchFailures",
      ),
    );
    assert.ok(
      (s.db.pragma("table_info(trigger_events)") as { name: string }[]).some(
        (c) => c.name === "uploadFingerprint",
      ),
    );
    assert.ok(
      s.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='trigger_cancellations'",
        )
        .get(),
    );

    assert.equal(s.service.automation!.get(reviewId).skillId, skill.id);
    assert.equal(
      s.service.occurrences(s.workspaceId, trigger.id).items.length,
      3,
    );
    assert.equal(
      (
        s.db
          .prepare(
            "SELECT collectedThrough FROM trigger_revisions WHERE triggerId=?",
          )
          .get(trigger.id) as any
      ).collectedThrough,
      s.now(),
    );
    s.advance(-2000);
    await s.service.save(
      "a",
      { ...trigger, name: "Edited after rollback" },
      trigger.id,
      trigger.revision,
    );
    s.advance(3000);
    await s.service.tick();
    assert.equal(
      s.service.occurrences(s.workspaceId, trigger.id).items.length,
      4,
    );
  });

test("deleting a trigger during asynchronous dispatch validation does not submit or report a false failure", async (t) => {
  const s = await setup(t);
  const skill = await s.service.skills.create("a", {
    name: "delete-fence",
    description: "Deletion fixture",
    instructions: "Use this guidance",
  });
  const trigger = await s.create(
    { kind: "every", everyMs: 1000 },
    { requiredSkillIds: [skill.id] },
  );
  const original = s.service.skills.refresh.bind(s.service.skills);
  t.mock.method(
    s.service.skills,
    "refresh",
    async (...args: Parameters<typeof original>) => {
      s.service.remove(trigger.id, trigger.revision, true);
      return original(...args);
    },
  );
  s.advance(1000);
  await s.service.tick();
  const occurrence = s.service.occurrences(s.workspaceId, trigger.id).items[0];
  assert.equal(occurrence.state, "cancelled");
  assert.equal(occurrence.taskId, null);
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM workspace_inbox").get() as any).n,
    0,
  );
});

test("disk edits after submission are refreshed before a trigger's first execution claim", async (t) => {
  const s = await setup(t);
  const skill = await s.service.skills.create("a", {
    name: "disk-start-fence",
    description: "Disk fixture",
    instructions: "Approved guidance",
  });
  const trigger = await s.create(
    { kind: "every", everyMs: 1000 },
    { requiredSkillIds: [skill.id] },
  );
  s.advance(1000);
  await s.service.tick();
  const occurrence = s.service.occurrences(s.workspaceId, trigger.id).items[0];
  const setupTask = s.service
    .automation!.list("a", skill.id)
    .items.find((x) => x.kind === "setup")?.taskId;
  if (setupTask) await s.service.execution.cancelTask(setupTask);
  await writeFile(
    join(skill.path, "SKILL.md"),
    skillDocument({
      name: skill.name,
      description: skill.description,
      instructions: "Unreviewed disk guidance",
    }),
  );
  const started: string[] = [];
  t.mock.method(
    s.service.execution as any,
    "run",
    async (turn: any, active: any) => {
      started.push(turn.taskId);
      await new Promise<void>((resolve) =>
        active.controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
    },
  );
  s.service.execution.pump();
  await Promise.all((s.service.execution as any).triggerValidations.values());
  assert.deepEqual(started, []);
  assert.equal(s.service.execution.task(occurrence.taskId!).status, "queued");
  assert.equal(
    (
      s.db
        .prepare("SELECT snapshot FROM agent_turns WHERE id=?")
        .get(occurrence.turnId) as any
    ).snapshot,
    null,
  );
  assert.equal(s.service.get(trigger.id).state, "review_required");
  await s.service.tick();
  const review = s.service
    .automation!.list("a", skill.id)
    .items.find((x) => x.kind === "review")!;
  assert.ok(review);
  if (review.taskId) await s.service.execution.cancelTask(review.taskId);
  s.service.automation!.review(review.id, review.fingerprint, "approved");
  s.service.execution.pump();
  await Promise.all((s.service.execution as any).triggerValidations.values());
  assert.deepEqual(started, [occurrence.taskId]);
});

test("a setup decision made during package inspection cannot be overwritten by a background review task", async (t) => {
  const s = await setup(t);
  const skill = await s.service.skills.create("a", {
    name: "setup-decision-fence",
    description: "Setup decision fixture",
    instructions: "Review possible setup",
  });
  const proposal = s.service.automation!.list("a", skill.id).items[0];
  let entered!: () => void, release!: () => void;
  const inspecting = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const capture = s.service.automation!.capture.bind(s.service.automation);
  t.mock.method(s.service.automation!, "capture", async (id: string) => {
    const snapshot = await capture(id);
    entered();
    await gate;
    return snapshot;
  });
  const ticking = s.service.tick();
  await inspecting;
  s.service.automation!.review(proposal.id, proposal.fingerprint, "declined");
  release();
  await ticking;
  const saved = s.service.automation!.get(proposal.id);
  assert.equal(saved.state, "declined");
  assert.equal(saved.taskId, null);
});
