import { assertCharacterUpgrade } from "./legacy-schema.js";
import { removeMessagingTables } from "./legacy-schema.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { ProviderModels } from "../src/provider-models.js";
import { normalizeModel } from "../src/model-providers.js";
import {
  effectiveMedia,
  imageMetadata,
  MediaService,
} from "../src/media-service.js";
import { ToolProvider } from "../src/tool-provider.js";
import { ManagedFiles } from "../src/managed-files.js";
import { ArtifactService } from "../src/artifact-service.js";
import { AgentTools } from "../src/agent-tools.js";
import { ProcessService } from "../src/process-service.js";
import { AgentExecution } from "../src/agent-execution.js";
import { ConnectionService } from "../src/connection-service.js";
import type { TaskRequest } from "../src/execution-types.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL9sAAAAASUVORK5CYII=",
  "base64",
);
function seed(db: ReturnType<typeof openDatabase>) {
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as any).id,
    stamp = new Date().toISOString();
  db.prepare(
    "INSERT INTO connections(id,provider,name,endpoint,createdAt,updatedAt,draft) VALUES ('c','openai-compatible','Test','http://127.0.0.1:9999/v1',?,?,0)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO provider_models(connectionId,id,name,contextWindowOverride,enabled) VALUES ('c','m','Model',200000,1)",
  ).run();
  db.prepare(
    "INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES ('p','Preset','c','m',?,?)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO agents(id,workspaceId,name,instructions,presetId,createdAt,updatedAt) VALUES ('a',?,'Agent','','p',?,?)",
  ).run(workspaceId, stamp, stamp);
  return workspaceId;
}
function multipart(
  files: { name: string; bytes: Buffer; mode?: string; size?: number }[],
  content = "Use these files",
  requestId = randomUUID(),
) {
  const boundary = "ufai-test-boundary";
  const chunks = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${JSON.stringify({ content, requestId, attachments: files.map((f) => ({ name: f.name, size: f.size ?? f.bytes.length, mode: f.mode ?? "file" })) })}\r\n`,
    ),
  ];
  files.forEach((f, i) =>
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file${i}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      f.bytes,
      Buffer.from("\r\n"),
    ),
  );
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}
async function setup(t: any, extra: any = {}) {
  const root = await mkdtemp(join(tmpdir(), "ufai-media-")),
    databasePath = join(root, "app.sqlite");
  const db = openDatabase(databasePath);
  const workspaceId = seed(db);
  db.close();
  const app = createApp({
    databasePath,
    filesRoot: join(root, "files"),
    serveStatic: false,
    execution: { autoStart: false },
    ...extra,
  });
  await app.ready();
  const inspect = openDatabase(databasePath);
  t.after(async () => {
    await app.close();
    inspect.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, app, db: inspect, workspaceId };
}
test("one multipart Send stores ordered immutable inputs atomically; retry does not duplicate", async (t) => {
  const s = await setup(t),
    rid = randomUUID(),
    files = [
      { name: "source.png", bytes: png },
      { name: "notes.txt", bytes: Buffer.from("Notes") },
    ];
  const send = () =>
    s.app.inject({
      method: "POST",
      url: "/api/agents/a/tasks",
      ...multipart(files, "", rid),
    });
  const first = await send();
  assert.equal(first.statusCode, 202, first.body);
  const task = first.json().taskId,
    messages = await s.app.inject(`/api/tasks/${task}/messages`),
    parts = messages.json().items[0].parts;
  assert.deepEqual(
    parts.filter((p: any) => p.type === "artifact").map((p: any) => p.name),
    ["source.png", "notes.txt"],
  );
  const second = await send();
  assert.deepEqual(second.json(), first.json());
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM artifact_versions").get() as any).n,
    2,
  );
  const changed = await s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart(
      [
        { name: "source.png", bytes: Buffer.from("different") },
        { name: "notes.txt", bytes: Buffer.from("Notes") },
      ],
      "",
      rid,
    ),
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM artifact_versions").get() as any).n,
    2,
  );
  const version = parts[1].versionId;
  const bytes = await s.app.inject(`/api/artifact-versions/${version}/content`);
  assert.deepEqual(bytes.rawPayload, png);
  assert.equal(bytes.headers["x-content-type-options"], "nosniff");
  const preview = await s.app.inject(
    `/api/artifact-versions/${version}/preview`,
  );
  assert.equal(preview.headers["content-type"], "image/png");
  const published = await s.app.inject(
    `/api/workspaces/${s.workspaceId}/artifacts`,
  );
  assert.equal(published.json().total, 0);
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM agent_turns").get() as any).n,
    1,
  );
});
test("failed attachment or unsupported inspection never submits text alone, File only succeeds", async (t) => {
  const s = await setup(t);
  const broken = await s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart([
      { name: "okay.txt", bytes: Buffer.from("okay") },
      { name: "short.bin", bytes: Buffer.from("short"), size: 100 },
    ]),
  });
  assert.equal(broken.statusCode, 409, broken.body);
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM agent_tasks").get() as any).n,
    0,
  );
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM artifact_versions").get() as any).n,
    0,
  );
  const denied = await s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart([{ name: "source.png", bytes: png, mode: "inspect" }]),
  });
  assert.equal(denied.statusCode, 409, denied.body);
  const saved = await s.app.inject({
    method: "PATCH",
    url: "/api/connections/c/models/m",
    payload: { mediaOverrides: { image: true, pdf: true } },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const good = await s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart([{ name: "source.png", bytes: png, mode: "inspect" }]),
  });
  assert.equal(good.statusCode, 202, good.body);
  const text = await s.app.inject({
    method: "POST",
    url: `/api/tasks/${good.json().taskId}/messages`,
    payload: { content: "Next", requestId: randomUUID() },
  });
  assert.equal(text.statusCode, 202);
  const active = await s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart([
      { name: "page.html", bytes: Buffer.from("<script>alert(1)</script>") },
    ]),
  });
  assert.equal(active.statusCode, 202);
  const id = (
    s.db
      .prepare("SELECT id FROM artifact_versions WHERE name='page.html'")
      .get() as any
  ).id;
  assert.equal(
    (await s.app.inject(`/api/artifact-versions/${id}/preview`)).statusCode,
    409,
  );
});
test("upload limits and cross-origin guard reject without accepted turns", async (t) => {
  const s = await setup(t, { uploads: { maxFiles: 1, maxBytes: 10 } });
  const large = await s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart([{ name: "large", bytes: Buffer.alloc(11) }]),
  });
  assert.equal(large.statusCode, 413);
  const many = await s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart([
      { name: "1", bytes: Buffer.from("a") },
      { name: "2", bytes: Buffer.from("b") },
    ]),
  });
  assert.equal(many.statusCode, 400);
  const cross = await s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart([{ name: "1", bytes: Buffer.from("a") }]),
    headers: { ...multipart([]).headers, origin: "https://untrusted.example" },
  });
  assert.equal(cross.statusCode, 403);
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM agent_tasks").get() as any).n,
    0,
  );
});
test("capability discovery preserves overrides and protocol limits cannot be overridden", () => {
  const db = openDatabase(":memory:");
  try {
    seed(db);
    const models = new ProviderModels(db);
    models.save("c", { mediaOverrides: { image: true, pdf: true } }, "m");
    models.merge("c", [
      {
        id: "m",
        name: "Renamed",
        contextWindow: 200000,
        media: { image: "unsupported", pdf: "unknown" },
      },
    ]);
    const m = models.get("c", "m")!;
    assert.equal(m.mediaSettings?.discovered.image, "unsupported");
    assert.equal(m.mediaSettings?.effective.image, "supported");
    assert.equal(effectiveMedia("codex", m).pdf, "unsupported");
    assert.equal(effectiveMedia("ollama", m).pdf, "unsupported");
    assert.equal(
      normalizeModel(
        { id: "vision", architecture: { input_modalities: ["text", "image"] } },
        "openrouter",
      )?.media?.image,
      "supported",
    );
    models.save("c", { mediaOverrides: { image: null } }, "m");
    assert.equal(
      models.get("c", "m")?.mediaSettings?.effective.image,
      "unsupported",
    );
  } finally {
    db.close();
  }
});
test("v12 upgrade retains existing messages, references and paths; interrupted incoming files are reclaimed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ufai-media-upgrade-")),
    path = join(root, "app.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  let db = openDatabase(path);
  const workspaceId = seed(db);
  const oldFiles = new ManagedFiles(db, join(root, "files")),
    oldConnections = new ConnectionService(db),
    oldEngine = new AgentExecution(
      db,
      oldConnections,
      { autoStart: false },
      oldFiles,
    );
  oldFiles.bind(oldEngine);
  await oldFiles.start();
  const priorTask = oldEngine.submit(
    "a",
    "new",
    "Keep original history",
    randomUUID(),
  );
  await oldFiles.repair("task", priorTask.taskId!);
  db.prepare(
    "INSERT INTO clusters(id,workspaceId,name,colorSlot,createdAt,updatedAt) VALUES ('department',?,'Design',3,'now','now')",
  ).run(workspaceId);
  db.prepare("UPDATE agents SET clusterId='department' WHERE id='a'").run();
  db.prepare(
    "INSERT INTO agent_memories(id,agentId,key,content,kind,sources,createdAt,updatedAt) VALUES ('memory','a','preference','Keep the original','fact','[]','now','now')",
  ).run();
  db.prepare(
    "UPDATE app_settings SET activeThemeId='dark-mode' WHERE id=1",
  ).run();
  const oldArtifacts = new ArtifactService(db, oldFiles, () => {}),
    { Readable: Source } = await import("node:stream");
  const legacyVersion = await oldArtifacts.publish(
    { workspaceId, agentId: "a", taskId: priorTask.taskId! },
    { stream: Source.from([png]), size: png.length, name: "legacy.png" },
    new AbortController().signal,
  );
  db.prepare(
    "INSERT INTO artifact_references(versionId,messageId,ordinal) SELECT ?,inputMessageId,0 FROM agent_turns WHERE id=?",
  ).run(legacyVersion.id, priorTask.turnId);
  await oldEngine.close();
  await oldArtifacts.close();
  await oldConnections.close();
  await oldFiles.close();
  removeMessagingTables(db);
  db.exec(
    "DROP TABLE provider_media_files;DROP TABLE model_media_capabilities;DROP TABLE media_open_references;DROP TABLE submission_ingests;ALTER TABLE artifact_versions DROP COLUMN origin;DROP INDEX artifact_versions_ingest;ALTER TABLE artifact_versions DROP COLUMN ingestId;ALTER TABLE artifact_references DROP COLUMN mode;ALTER TABLE agent_submissions DROP COLUMN attachmentFingerprint;PRAGMA user_version=12",
  );
  const preserved = [
    "agents",
    "agent_tasks",
    "agent_messages",
    "agent_memories",
    "clusters",
    "managed_locations",
    "model_presets",
    "provider_models",
    "app_settings",
  ];
  const before = Object.fromEntries(
    preserved.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
  db.close();
  db = openDatabase(path);
  for (const table of preserved) {
    const rows = db.prepare(`SELECT ${Object.keys((before[table] as any[])[0] ?? {}).join(",") || "*"} FROM ${table} ORDER BY rowid`).all();
    if (table === "agents") rows.forEach((row, index) => assertCharacterUpgrade(row, before[table]![index]));
    else assert.deepEqual(rows, before[table], table);
  }
  assert.equal(
    (db.prepare("SELECT mode FROM artifact_references").get() as any).mode,
    "file",
  );
  assert.equal(db.pragma("user_version", { simple: true }), 23);
  const files = new ManagedFiles(db, join(root, "files"));
  await files.start();
  const artifacts = new ArtifactService(db, files, () => {});
  db.prepare(
    "INSERT INTO submission_ingests VALUES ('abandoned',?,'a','request-123','receiving','now')",
  ).run(workspaceId);
  const { Readable } = await import("node:stream");
  await artifacts.publish(
    { workspaceId, agentId: "a" },
    {
      stream: Readable.from([png]),
      size: png.length,
      name: "orphan.png",
      origin: "user_upload",
      ingestId: "abandoned",
    },
    new AbortController().signal,
  );
  await artifacts.start();
  assert.equal(
    (db.prepare("SELECT count(*) n FROM artifact_versions").get() as any).n,
    1,
  );
  assert.deepEqual(
    (await artifacts.bytes(legacyVersion.id, workspaceId)).bytes,
    png,
  );
  await artifacts.close();
  await files.close();
  db.close();
});
test("media_open snapshots host bytes, deduplicates calls, and leaves published outputs separate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ufai-media-open-")),
    db = openDatabase(join(root, "app.sqlite")),
    workspaceId = seed(db),
    files = new ManagedFiles(db, join(root, "files")),
    connections = new ConnectionService(db),
    artifacts = new ArtifactService(db, files, () => {}),
    processes = new ProcessService(db, files, () => {}),
    tools = new AgentTools(db, files, processes, artifacts, () => {}),
    engine = new AgentExecution(
      db,
      connections,
      { autoStart: false },
      files,
      tools,
    );
  files.bind(engine);
  await files.start();
  tools.ready = true;
  tools.media = new MediaService(artifacts);
  tools.mediaCapabilities = () => ({ image: "supported", pdf: "unsupported" });
  t.after(async () => {
    await engine.close();
    await processes.close();
    await artifacts.close();
    await connections.close();
    await files.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const turn = engine.submit("a", "new", "Inspect", randomUUID()),
    owner = {
      workspaceId,
      agentId: "a",
      taskId: turn.taskId!,
      turnId: turn.turnId,
    };
  await tools.locations(owner);
  const path = join(files.location("task", owner.taskId).path, "image.png");
  await writeFile(path, png);
  const call = { id: "open-1", name: "media_open", arguments: { path } };
  const first = await tools.dispatch(
    owner,
    call,
    new AbortController().signal,
    async () => {},
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.media?.[0]);
  await writeFile(path, "changed");
  assert.deepEqual(
    await tools.dispatch(
      owner,
      call,
      new AbortController().signal,
      async () => {},
    ),
    first,
  );
  assert.deepEqual(
    (await artifacts.bytes(first.media![0]!.versionId, workspaceId)).bytes,
    png,
  );
  assert.equal(
    (db.prepare("SELECT origin FROM artifact_versions").get() as any).origin,
    "inspection",
  );
  assert.equal(
    (db.prepare("SELECT count(*) n FROM media_open_references").get() as any).n,
    1,
  );
  assert.throws(() => imageMetadata(Buffer.from("bad image")), /dimensions/);
});
test("native PDF bytes use each supported wire format and OpenRouter never enables OCR fallback", async () => {
  const ref = {
    versionId: "pdf",
    name: "report.pdf",
    mediaType: "application/pdf",
    size: 5,
  };
  const request: TaskRequest = {
    modelId: "m",
    instructions: "",
    messages: [{ role: "user", content: "Open", media: [ref] }],
    tools: [],

    contextWindow: 100000,
    signal: new AbortController().signal,
    onTool: async () => ({ ok: true }),
    resolveMedia: async (refs) => refs.map((r) => ({ ...r, data: "JVBERi0=" })),
  };
  for (const provider of [
    "openai",
    "xai",
    "anthropic",
    "google",
    "openrouter",
    "openai-compatible",
  ] as const) {
    let body: any,
      uploads = 0;
    const adapter = new ToolProvider(
      provider,
      "http://127.0.0.1",
      null,
      async (_url, init) => {
        if (String(_url).endsWith("/models/m") || String(_url).endsWith("/models/model")) return Response.json({max_tokens:16000});
        if (String(_url).endsWith("/count_tokens")) return Response.json({input_tokens:100});
        body = JSON.parse(String(init?.body));
        return new Response("", { status: 400 });
      },
      async () => {
        uploads++;
        return "remote-file";
      },
    );
    await assert.rejects(() => adapter.round(request), /rejected tool/);
    const wire = JSON.stringify(body);
    if (provider === "xai") {
      assert.equal(uploads, 1);
      assert.match(wire, /"file_id":"remote-file"/);
      assert.ok(!wire.includes("JVBERi0="));
    } else assert.match(wire, /JVBERi0=/);
    if (provider === "anthropic") assert.match(wire, /"type":"document"/);
    if (provider === "google")
      assert.match(wire, /"mimeType":"application\/pdf"/);
    if (provider === "openrouter")
      assert.equal(body.plugins[0].pdf.engine, "native");
  }
});
test("a tool-enabled task receives image content and publishes a document containing its bytes", async (t) => {
  let round = 0,
    sawImage = false;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.tools)
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ status: "completed", summary: "Created embedded document", memories: [] }) }, finish_reason: "stop" }] })}\n\n`,
      );
    const image = body.messages
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .find((p: any) => p.type === "image_url");
    sawImage ||=
      image?.image_url.url ===
      `data:image/png;base64,${png.toString("base64")}`;
    const calls =
      round++ === 0
        ? [
            {
              index: 0,
              id: "write",
              type: "function",
              function: {
                name: "files_write",
                arguments: JSON.stringify({
                  path: "result.html",
                  text: `<!doctype html><title>Result</title><img alt="Reference" src="${image.image_url.url}">`,
                  expectedSha256: null,
                }),
              },
            },
            {
              index: 1,
              id: "publish",
              type: "function",
              function: {
                name: "artifact_publish",
                arguments: JSON.stringify({ path: "result.html" }),
              },
            },
          ]
        : undefined;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: calls ? { tool_calls: calls } : { content: "Document ready." }, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\n`,
    );
  };
  const s = await setup(t, {
    execution: { autoStart: true },
    connections: { fetcher },
  });
  new ProviderModels(s.db).save("c", { mediaOverrides: { image: true } }, "m");
  const sent = await s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart(
      [{ name: "reference.png", bytes: png, mode: "inspect" }],
      "Make a self-contained document",
    ),
  });
  assert.equal(sent.statusCode, 202, sent.body);
  for (let i = 0; i < 300; i++) {
    const task = (await s.app.inject(`/api/tasks/${sent.json().taskId}`)).json()
      .task;
    if (["completed", "failed", "blocked"].includes(task.status)) {
      assert.equal(task.status, "completed", task.error);
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(sawImage, true);
  const outputs = await s.app.inject(
    `/api/tasks/${sent.json().taskId}/artifacts`,
  );
  assert.equal(outputs.json().total, 1);
  const document = await s.app.inject(
    `/api/artifact-versions/${outputs.json().items[0].id}/content`,
  );
  assert.ok(
    document.body.includes(`data:image/png;base64,${png.toString("base64")}`),
  );
  const source = (
    s.db
      .prepare("SELECT id FROM artifact_versions WHERE origin='user_upload'")
      .get() as any
  ).id;
  const deletion = await s.app.inject({
    method: "DELETE",
    url: "/api/agents/a",
    payload: { confirmFilesDeletion: true },
  });
  assert.equal(deletion.statusCode, 202);
  for (let i = 0; i < 300; i++) {
    if (!s.db.prepare("SELECT id FROM agents WHERE id='a'").get()) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(
    (await s.app.inject(`/api/artifact-versions/${source}/content`)).statusCode,
    200,
  );
  assert.equal(
    (
      await s.app.inject(
        `/api/artifact-versions/${outputs.json().items[0].id}/content`,
      )
    ).statusCode,
    200,
  );
});
test("shutdown aborts stalled uploads, waits for cleanup, and never leaves an executable task", async (t) => {
  const s = await setup(t);
  await s.app.listen({ host: "127.0.0.1", port: 0 });
  const { request } = await import("node:http"),
    url = new URL(s.app.listeningOrigin);
  const boundary = "stalled-upload",
    manifest = {
      content: "Do not submit a partial file",
      requestId: randomUUID(),
      attachments: [{ name: "large.bin", size: 1000000, mode: "file" }],
    };
  const req = request({
    hostname: url.hostname,
    port: url.port,
    path: "/api/agents/a/tasks",
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  });
  req.on("error", () => {});
  req.write(
    `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${JSON.stringify(manifest)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file0"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\npartial`,
  );
  for (let i = 0; i < 100; i++) {
    if (
      (
        s.db
          .prepare(
            "SELECT count(*) n FROM artifact_versions WHERE state='staging'",
          )
          .get() as any
      ).n
    )
      break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await s.app.close();
  req.destroy();
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM agent_tasks").get() as any).n,
    0,
  );
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM artifact_versions").get() as any).n,
    0,
  );
});
test("xAI PDF file IDs are connection/version cached, expire and invalidate on credential changes", async () => {
  const db = openDatabase(":memory:");
  seed(db);
  let uploads = 0,
    generations = 0,
    fail = false;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/files")) {
      uploads++;
      return Response.json({ id: `file-${uploads}` });
    }
    generations++;
    if (fail) return new Response("", { status: 400 });
    return new Response(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Done" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`,
    );
  };
  const connections = new ConnectionService(db, fetcher);
  db.prepare(
    "UPDATE connections SET provider='xai',endpoint=NULL,credential=? WHERE id='c'",
  ).run(connections.secrets.encrypt("fixture-key", "c"));
  const ref = {
    versionId: "pdf",
    name: "a.pdf",
    mediaType: "application/pdf",
    size: 5,
  };
  // The cache references durable artifact identities even though this fixture supplies bytes directly.
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as any).id;
  db.prepare("INSERT INTO artifacts VALUES ('artifact',?,'a.pdf','now')").run(
    workspaceId,
  );
  db.prepare(
    "INSERT INTO artifact_versions(id,artifactId,workspaceId,provenance,name,mediaType,size,state,createdAt) VALUES ('pdf','artifact',?,'{}','a.pdf','application/pdf',5,'ready','now')",
  ).run(workspaceId);
  const snapshot = connections.snapshot({
    presetId: "p",
    instructions: "",
    revision: 1,
  });
  const request: TaskRequest = {
    modelId: "m",
    instructions: "",
    messages: [{ role: "user", content: "Open", media: [ref] }],
    tools: [],

    contextWindow: 200000,
    signal: new AbortController().signal,
    onTool: async () => ({ ok: true }),
    resolveMedia: async (refs) => refs.map((r) => ({ ...r, data: "JVBERi0=" })),
  };
  try {
    await connections.toolRound(snapshot, request);
    await connections.toolRound(snapshot, request);
    assert.equal(uploads, 1);
    assert.equal(generations, 2);
    db.prepare("UPDATE provider_media_files SET expiresAt=0").run();
    await connections.toolRound(snapshot, request);
    assert.equal(uploads, 2);
    db.prepare("UPDATE connections SET credential=? WHERE id='c'").run(
      connections.secrets.encrypt("rotated-fixture", "c"),
    );
    await connections.toolRound(snapshot, request);
    assert.equal(uploads, 3);
    fail = true;
    await assert.rejects(() => connections.toolRound(snapshot, request));
    assert.equal(generations, 5);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM provider_media_files").get() as any)
        .n,
      0,
    );
  } finally {
    await connections.close();
    db.close();
  }
});
test("native token counting sends media rather than reference text, and safely falls back when unavailable", async () => {
  const ref = {
    versionId: "image",
    name: "a.png",
    mediaType: "image/png",
    size: 3,
  };
  let wire = "";
  const request: TaskRequest = {
    modelId: "m",
    instructions: "",
    messages: [{ role: "user", content: "See", media: [ref] }],
    tools: [],

    contextWindow: 100000,
    signal: new AbortController().signal,
    onTool: async () => ({ ok: true }),
    resolveMedia: async (refs) => refs.map((r) => ({ ...r, data: "AQID" })),
  };
  for (const provider of ["openai", "anthropic", "google"] as const) {
    const adapter = new ToolProvider(
      provider,
      "http://127.0.0.1",
      null,
      async (_url, init) => {
        wire = String(init?.body);
        return Response.json({ input_tokens: 123, totalTokens: 123 });
      },
    );
    assert.equal(await adapter.countTokens(request), 123);
    assert.match(wire, /AQID/);
  }
  const rejected = new ToolProvider(
    "openai",
    "http://127.0.0.1",
    null,
    async () => new Response("", { status: 404 }),
  );
  assert.equal(await rejected.countTokens(request), null);
});
test("oversized image metadata is rejected without enabling another format or changing bytes", () => {
  const large = Buffer.from(png);
  large.writeUInt32BE(50000, 16);
  assert.throws(() => imageMetadata(large), /dimensions/);
  assert.deepEqual(imageMetadata(png), { width: 1, height: 1 });
});
test("concurrent duplicate image sends bind one version and reclaim the losing transfer", async (t) => {
  const s = await setup(t);
  new ProviderModels(s.db).save("c", { mediaOverrides: { image: true } }, "m");
  const original = MediaService.prototype.prepare;
  let count = 0,
    release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  MediaService.prototype.prepare = async function (...args) {
    if (++count === 2) release();
    await barrier;
    return original.apply(this, args);
  };
  t.after(() => {
    MediaService.prototype.prepare = original;
  });
  const rid = randomUUID(),
    send = () =>
      s.app.inject({
        method: "POST",
        url: "/api/agents/a/tasks",
        ...multipart(
          [{ name: "image.png", bytes: png, mode: "inspect" }],
          "Inspect",
          rid,
        ),
      });
  const [one, two] = await Promise.all([send(), send()]);
  assert.equal(one.statusCode, 202, one.body);
  assert.equal(two.statusCode, 202, two.body);
  assert.deepEqual(one.json(), two.json());
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM artifact_versions").get() as any).n,
    1,
  );
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM agent_tasks").get() as any).n,
    1,
  );
});
test("an accepted attachment retry succeeds even when the artifact quota is full", async (t) => {
  const s = await setup(t, { artifacts: { maxStorageBytes: png.length } }),
    rid = randomUUID();
  const send = (id: string) =>
    s.app.inject({
      method: "POST",
      url: "/api/agents/a/tasks",
      ...multipart([{ name: "image.png", bytes: png }], "File only", id),
    });
  const first = await send(rid);
  assert.equal(first.statusCode, 202, first.body);
  assert.equal((await send(randomUUID())).statusCode, 413);
  const repeated = await send(rid);
  assert.equal(repeated.statusCode, 202, repeated.body);
  assert.deepEqual(repeated.json(), first.json());
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM artifact_versions").get() as any).n,
    1,
  );
});
test("ready bytes from an uncommitted Send are unavailable to other consumers", async (t) => {
  const s = await setup(t);
  new ProviderModels(s.db).save("c", { mediaOverrides: { image: true } }, "m");
  const original = MediaService.prototype.prepare;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => {
      entered = r;
    }),
    barrier = new Promise<void>((r) => {
      release = r;
    });
  MediaService.prototype.prepare = async function (...args) {
    entered();
    await barrier;
    return original.apply(this, args);
  };
  const pending = s.app.inject({
    method: "POST",
    url: "/api/agents/a/tasks",
    ...multipart([{ name: "image.png", bytes: png, mode: "inspect" }]),
  });
  let id = "";
  try {
    await reached;
    id = (s.db.prepare("SELECT id FROM artifact_versions").get() as any).id;
    for (const suffix of ["", "/content", "/preview"])
      assert.equal(
        (await s.app.inject(`/api/artifact-versions/${id}${suffix}`))
          .statusCode,
        409,
      );
  } finally {
    release();
    MediaService.prototype.prepare = original;
  }
  const accepted = await pending;
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(
    (await s.app.inject(`/api/artifact-versions/${id}/content`)).statusCode,
    200,
  );
});
test("native adapter restrictions reject unsupported formats and oversized media before loading bytes", async () => {
  let reads = 0;
  const media = new MediaService({
    bytes: async () => {
      reads++;
      throw new Error("Unexpected byte read");
    },
  } as any);
  const model = {
    mediaSettings: { effective: { image: "supported", pdf: "supported" } },
  } as any;
  await assert.rejects(
    () =>
      media.resolve(
        { versionId: "gif", name: "a.gif", mediaType: "image/gif", size: 10 },
        "workspace",
        effectiveMedia("google", model),
      ),
    /format is unsupported/,
  );
  await assert.rejects(
    () =>
      media.prepare(
        [
          {
            versionId: "pdf",
            name: "a.pdf",
            mediaType: "application/pdf",
            size: 13_000_001,
          },
        ],
        "workspace",
        effectiveMedia("google", model),
      ),
    /Provider byte limit/,
  );
  await assert.rejects(
    () =>
      media.resolve(
        {
          versionId: "image",
          name: "a.png",
          mediaType: "image/png",
          size: 7_500_001,
        },
        "workspace",
        effectiveMedia("anthropic", model),
      ),
    /native input limit/,
  );
  assert.equal(reads, 0);
});

test("Chat accepts file-only messages atomically and retries preserve one Chat and its uploads", async t => {
  const s = await setup(t);
  const requestId = randomUUID();
  const send = () => s.app.inject({ method: "POST", url: "/api/agents/a/chat/messages", ...multipart([{ name: "notes.txt", bytes: Buffer.from("Chat input") }], "", requestId) });
  const first = await send();
  assert.equal(first.statusCode, 202, first.body);
  assert.deepEqual((await send()).json(), first.json());
  const detail = (await s.app.inject("/api/agents/a/chat")).json();
  assert.equal(detail.task.kind, "chat");
  const messages = (await s.app.inject("/api/agents/a/chat/messages")).json();
  const attachment = messages.items[0].parts.find((p: any) => p.type === "artifact");
  assert.equal(attachment.name, "notes.txt");
  assert.equal((await s.app.inject(`/api/artifact-versions/${attachment.versionId}/content`)).body, "Chat input");
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM artifact_versions").get() as any).n, 1);
  assert.equal((await s.app.inject("/api/agents/a/tasks")).json().total, 0);
});
