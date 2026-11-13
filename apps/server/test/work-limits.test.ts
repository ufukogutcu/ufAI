import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { AgentExecution } from "../src/agent-execution.js";
import { ConnectionService } from "../src/connection-service.js";
import { restoreWorkDeadlines } from "./legacy-schema.js";
import type { TextRequest } from "../src/execution-types.js";

function seed(db: ReturnType<typeof openDatabase>) {
  const workspace = (db.prepare("SELECT id FROM workspaces").get() as any).id;
  db.prepare("INSERT INTO agents(id,workspaceId,name,createdAt,updatedAt) VALUES ('a',?,'Agent','now','now')").run(workspace);
  return workspace;
}

test("v18 migration removes work deadlines while preserving open work, wait checkpoints and historical outcomes", async t => {
  const dir = await mkdtemp(join(tmpdir(),"ufai-unbounded-migration-"));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const path = join(dir,"app.sqlite");
  let db = openDatabase(path);
  const workspace = seed(db);
  const connections = new ConnectionService(db);
  const engine = new AgentExecution(db,connections,{autoStart:false});
  const turn = engine.submit("a","new","Work","migration-work");
  await engine.close(); await connections.close();
  restoreWorkDeadlines(db);
  db.prepare("INSERT INTO agent_requests(id,workspaceId,linkId,sourceName,targetName,sourceTaskId,rootWorkflowId,depth,kind,state,deadline,createdAt,updatedAt) VALUES (?,?,'link','A','B',?,?,1,'request',?,'2000-01-01','now','now')")
    .run("open",workspace,turn.taskId,turn.taskId,"open");
  db.prepare("INSERT INTO agent_requests(id,workspaceId,linkId,sourceName,targetName,rootWorkflowId,depth,kind,state,deadline,createdAt,updatedAt) VALUES ('expired',?,'link','A','B','root',1,'request','expired','2000-01-01','now','now')").run(workspace);
  const checkpoint = JSON.stringify({callId:"wait",rounds:32,context:{instructions:"Preserved",messages:[]},timeoutMs:1});
  db.prepare("INSERT INTO messaging_waits(turnId,taskId,requestIds,mode,deadline,state,checkpoint,createdAt) VALUES (?,?,'[\"open\"]','all','2000-01-01','waiting',?,'now')").run(turn.turnId,turn.taskId,checkpoint);
  db.prepare("INSERT INTO owned_processes(id,workspaceId,agentId,taskId,turnId,command,cwd,pty,launchId,state,deadline,createdAt,updatedAt) VALUES ('process',?,'a',?,?,'old','/',0,'launch','timed_out','2000-01-01','now','now')").run(workspace,turn.taskId,turn.turnId);
  db.pragma("user_version=18"); db.close();
  db=openDatabase(path);
  try {
    for (const table of ["agent_requests","messaging_waits","owned_processes"])
      assert.ok(!(db.pragma(`table_info(${table})`) as any[]).some(c=>c.name==="deadline"));
    assert.equal((db.prepare("SELECT state FROM agent_requests WHERE id='open'").get() as any).state,"open");
    assert.equal((db.prepare("SELECT state FROM agent_requests WHERE id='expired'").get() as any).state,"expired");
    assert.equal((db.prepare("SELECT state FROM owned_processes WHERE id='process'").get() as any).state,"timed_out");
    assert.equal((db.prepare("SELECT checkpoint FROM messaging_waits").get() as any).checkpoint,checkpoint);
    assert.deepEqual(db.pragma("foreign_key_check"),[]);
  } finally { db.close(); }
});

test("wait restoration rotates past an unready first batch without producing timed-out results", async t => {
  const db=openDatabase(":memory:"); seed(db);
  const connections=new ConnectionService(db);
  const engine=new AgentExecution(db,connections,{autoStart:false});
  t.after(async()=>{await engine.close();await connections.close();db.close();});
  const turns=[];
  for(let i=0;i<20;i++) {
    const turn=engine.submit("a","new","Wait",`wait-batch-${i}`);turns.push(turn);
    db.prepare("UPDATE agent_turns SET status='waiting' WHERE id=?").run(turn.turnId);
    db.prepare("INSERT INTO messaging_waits VALUES (?,?,?,'all','waiting',?,'now')")
      .run(turn.turnId,turn.taskId,JSON.stringify([turn.turnId]),JSON.stringify({callId:"wait"}));
  }
  const sorted=turns.toSorted((a,b)=>a.turnId.localeCompare(b.turnId));
  const ready=sorted.at(-1)!.turnId;
  engine.messaging={waitState:(_owner:any,ids:string[])=>({ready:ids[0]===ready}),waitResult:()=>({ready:true})} as any;
  (engine as any).restoreMessagingWaits();
  assert.equal((db.prepare("SELECT state FROM messaging_waits WHERE turnId=?").get(ready) as any).state,"waiting");
  (engine as any).restoreMessagingWaits();
  assert.equal((db.prepare("SELECT state FROM messaging_waits WHERE turnId=?").get(ready) as any).state,"resuming");
  assert.equal((db.prepare("SELECT count(*) n FROM messaging_waits WHERE state='waiting'").get() as any).n,19);
});

test("Anthropic required capacity is cached as metadata and refreshed without a configurable output budget", async t => {
  const db=openDatabase(":memory:");
  let lookups=0;
  const bodies:any[]=[];
  const connections=new ConnectionService(db,async(url,init)=>{
    if(String(url).includes("/models/")) {lookups++;return Response.json({max_tokens:16000});}
    if(String(url).endsWith("/count_tokens")) return Response.json({input_tokens:500});
    bodies.push(JSON.parse(String(init!.body)));
    return new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Done"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',{headers:{"content-type":"text/event-stream"}});
  });
  t.after(async()=>{await connections.close();db.close();});
  db.prepare("INSERT INTO connections(id,provider,name,credential,draft,createdAt,updatedAt) VALUES ('c','anthropic','Claude',?,0,'now','now')").run(connections.secrets.encrypt("secret","c"));
  db.exec("INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES ('c','manual','Manual',1,32000)");
  const snapshot={connectionId:"c",provider:"anthropic",modelId:"manual",presetId:"p",contextWindow:32000,compaction:null,instructions:"",agentRevision:1} as const;
  const request:TextRequest={modelId:"manual",contextWindow:32000,instructions:"",messages:[{role:"user",content:"Hi"}],signal:new AbortController().signal};
  await connections.generate(snapshot,request);await connections.generate(snapshot,request);
  assert.equal(lookups,1); assert.equal(bodies[0].max_tokens,16000);
  connections.models.invalidate("c");
  await connections.generate(snapshot,request);
  assert.equal(lookups,2);
  assert.equal((db.prepare("SELECT count(*) n FROM provider_output_metadata").get() as any).n,1);
  db.exec("DELETE FROM provider_models WHERE connectionId='c'");
  assert.equal((db.prepare("SELECT count(*) n FROM provider_output_metadata").get() as any).n,0);
  await connections.generate(snapshot,request);
  assert.equal((db.prepare("SELECT count(*) n FROM provider_output_metadata").get() as any).n,0);
});
