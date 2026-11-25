import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/database.js";
import { createApp } from "../src/app.js";

for (const version of [36, 37]) {
  for (const missing of ["both", "table", "column", "neither"]) {
    test(`version ${version} with ${missing} execution additions missing upgrades without losing state`, async t => {
      const root = await mkdtemp(join(tmpdir(), "ufai-execution-migration-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const path = join(root, "app.sqlite");
      let db = openDatabase(path);
      const workspace = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
      db.prepare("INSERT INTO agents(id,workspaceId,name,instructions,createdAt,updatedAt) VALUES('agent',?,'Fixture','Keep instructions','seed','seed')").run(workspace);
      db.exec(`
        INSERT INTO conversations(id,agentId,kind,createdAt) VALUES('conversation','agent','task','seed');
        INSERT INTO agent_tasks(id,agentId,conversationId,title,status,createdAt,updatedAt)
          VALUES('task','agent','conversation','Synthetic task','failed','seed','seed');
        INSERT INTO agent_messages(id,conversationId,role,content,state,createdAt)
          VALUES('input','conversation','user','Synthetic input','complete','seed');
        INSERT INTO agent_turns(id,taskId,conversationId,agentId,inputMessageId,attempt,status,createdAt,updatedAt)
          VALUES('turn','task','conversation','agent','input',1,'failed','seed','seed');
        INSERT INTO execution_checkpoints(turnId,context,answer,maintenanceBaseline)
          VALUES('turn','saved context','saved answer','[{"key":"topic","revision":3}]');
        INSERT INTO execution_results(turnId,callId,call,result)
          VALUES('turn','saved-call','{"name":"files_write"}','{"ok":true}');
        INSERT INTO execution_deliveries VALUES('turn',0,0,'saved-call','{"ok":true}');
        INSERT INTO execution_generations VALUES('turn','saved-generation','{"text":"saved"}');
      `);
      const tableMissing = missing === "both" || missing === "table";
      const columnMissing = missing === "both" || missing === "column";
      if (tableMissing) db.exec("DROP TABLE execution_deliveries");
      if (columnMissing) db.exec("ALTER TABLE execution_checkpoints DROP COLUMN maintenanceBaseline");
      db.pragma(`user_version = ${version}`);
      db.close();

      db = openDatabase(path);
      assert.equal(db.pragma("user_version", { simple: true }), 47);
      const checkpoint = db.prepare("SELECT context,answer,maintenanceBaseline FROM execution_checkpoints WHERE turnId='turn'").get();
      assert.deepEqual(checkpoint, {
        context: "saved context", answer: "saved answer",
        maintenanceBaseline: columnMissing ? null : '[{"key":"topic","revision":3}]',
      });
      assert.equal((db.prepare("SELECT count(*) n FROM execution_deliveries").get() as { n: number }).n, tableMissing ? 0 : 1);
      assert.equal((db.prepare("SELECT result FROM execution_results WHERE turnId='turn'").get() as { result: string }).result, '{"ok":true}');
      assert.equal((db.prepare("SELECT result FROM execution_generations WHERE turnId='turn'").get() as { result: string }).result, '{"text":"saved"}');
      assert.equal((db.prepare("SELECT instructions FROM agents WHERE id='agent'").get() as { instructions: string }).instructions, "Keep instructions");
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      db.close();

      // Exercise real cancellation cleanup after upgrading, without any provider work.
      const app = createApp({ databasePath: path, filesRoot: join(root, "files"), serveStatic: false,
        execution: { autoStart: false }, triggers: { autoStart: false } });
      try {
        const cancelled = await app.inject({ method: "POST", url: "/api/tasks/task/cancel" });
        assert.equal(cancelled.statusCode, 204, cancelled.body);
        assert.equal((await app.inject("/api/tasks/task")).json().task.status, "cancelled");
      } finally { await app.close(); }

      db = openDatabase(path);
      assert.equal(db.pragma("user_version", { simple: true }), 47);
      for (const table of ["execution_checkpoints", "execution_results", "execution_deliveries", "execution_generations"])
        assert.equal((db.prepare(`SELECT count(*) n FROM ${table} WHERE turnId='turn'`).get() as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT content FROM agent_messages WHERE id='input'").get() as { content: string }).content, "Synthetic input");
      db.close();
    });
  }
}
