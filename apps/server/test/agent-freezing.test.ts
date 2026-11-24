import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../src/database.js";
import { createApp } from "../src/app.js";
import type { Triggers } from "../src/triggers.js";
import type { TaskRequest, ToolRound } from "../src/execution-types.js";
import type { FreezePolicy, WorkspaceExecutionControl } from "../src/contracts.js";
import { ConnectionError } from "../src/model-providers.js";

const round = (calls: ToolRound["calls"] = [], text = "Done"): ToolRound => ({calls,text,continuation:{saved:"opaque-signature"},usage:{outputTokens:3}});
const write = (id:string,name:string) => ({id,name:"files_write",arguments:{path:name,text:id,expectedSha256:null}});
async function setup(t:TestContext) {
  const root = await mkdtemp(join(tmpdir(),"ufai-freeze-"));
  const databasePath = join(root,"db.sqlite");
  const seed = openDatabase(databasePath);
  const workspaceId = (seed.prepare("SELECT id FROM workspaces").get() as any).id;
  seed.exec(`INSERT INTO connections(id,provider,name,createdAt,updatedAt,draft) VALUES('c','openai-compatible','Fixture','seed','seed',0);
    INSERT INTO provider_models(connectionId,id,name,contextWindowOverride,enabled) VALUES('c','m','Fixture',200000,1);
    INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES('p','Fixture','c','m','seed','seed');`);
  for (const id of ["a","b"]) seed.prepare("INSERT INTO agents(id,workspaceId,name,presetId,createdAt,updatedAt) VALUES(?,?,?,'p','seed','seed')").run(id,workspaceId,id);
  seed.close();
  let clock = Date.now();
  const open = async () => {
    const app = createApp({databasePath,filesRoot:join(root,"files"),serveStatic:false,execution:{autoStart:false},triggers:{autoStart:false,now:()=>clock}});
    await app.ready();
    const service = (app as any).triggers as Triggers;
    service.connections.countTokens = async ()=>100;
    service.connections.countTaskTokens = async ()=>null;
    service.connections.generate = async()=>({text:JSON.stringify({status:"completed",summary:"Done",memories:[]}),usage:null,finishReason:"stop"});
    service.connections.toolRound = async()=>round();
    return app;
  };
  let app = await open();
  const service = () => (app as any).triggers as Triggers;
  const execution = () => service().execution;
  const control = () => execution().requiredAgent("a").executionControl;
  const action = async (name:"freeze"|"resume",policy?:FreezePolicy) => {
    const response = await app.inject({method:"POST",url:`/api/agents/a/${name}`,payload:{requestId:randomUUID(),expectedRevision:control().revision,...(policy ? {policy} : {})}});
    assert.equal(response.statusCode,202,response.body);
    return response.json();
  };
  const until = async (fn:()=>boolean) => {
    for (let n=0;n<1600;n++) { execution().pump(); if(fn()) return; await delay(5); }
    assert.fail("Execution did not reach the expected boundary.");
  };
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  return {root,workspaceId,get app(){return app;},get service(){return service();},get engine(){return execution();},get db(){return service().db;},control,action,until,
    advance(ms:number){clock+=ms;},
    async reopen(){await app.close();app=await open();},
    async resume(policy:FreezePolicy="all") { await action("resume",policy); for(let n=0;n<1000 && control().state==="resuming";n++) await service().tick(); assert.equal(control().state,"active"); },
    async trigger(agentId="a") { return service().save(agentId,{name:"Fixture",instructions:"Handle once",when:{kind:"every",everyMs:1000,anchor:new Date(clock).toISOString()},enabled:true,paused:false,requiredSkillIds:[]}); },
  };
}

async function workspaceAction(s: Awaited<ReturnType<typeof setup>>, action: "pause" | "resume", policy?: FreezePolicy) {
  const current = s.engine.workspaceFreezing.control(s.workspaceId);
  const response = await s.app.inject({method:"POST",url:`/api/workspaces/${s.workspaceId}/${action}`,
    payload:{requestId:randomUUID(),expectedRevision:current.revision,...(policy ? {policy} : {})}});
  assert.equal(response.statusCode,202,response.body);
  return response.json<WorkspaceExecutionControl>();
}

test("workspace pacing is validated, isolated, and retained across a restart while paused", async t => {
  const s = await setup(t);
  const url = `/api/workspaces/${s.workspaceId}/pacing`;
  const read = async () => (await s.app.inject(url)).json();
  const put = (extraDelayMs: unknown) => s.app.inject({ method: "PUT", url, payload: { extraDelayMs } });
  assert.deepEqual(await read(), { extraDelayMs: 0, revision: 0 });
  for (const value of [-500, 200, 3500, 500.5, "500", null])
    assert.equal((await put(value)).statusCode, 400);
  assert.equal((await s.app.inject({ method: "PUT", url, payload: { extraDelayMs: 500, unexpected: true } })).statusCode, 400);
  assert.equal((await s.app.inject("/api/workspaces/missing/pacing")).statusCode, 404);
  assert.equal((await s.app.inject({ url, headers: { "sec-fetch-site": "cross-site" } })).statusCode, 403);
  const other = await s.app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Other" } });
  assert.equal(other.statusCode, 201);
  await workspaceAction(s, "pause");
  const saved = { extraDelayMs: 2000, revision: 1 };
  assert.deepEqual((await put(2000)).json(), saved);
  assert.deepEqual((await put(2000)).json(), saved);
  const eventCount = s.db.prepare("SELECT count(*) AS count FROM execution_events WHERE workspaceId=? AND kind='workspace-pacing'").get(s.workspaceId);
  assert.deepEqual(eventCount, { count: 1 });
  assert.deepEqual((await s.app.inject(`/api/workspaces/${other.json().id}/pacing`)).json(), { extraDelayMs: 0, revision: 0 });
  await s.reopen();
  assert.deepEqual(await read(), saved);
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state, "frozen");
  assert.deepEqual((await put(0)).json(), { extraDelayMs: 0, revision: 2 });
});

test("pacing delays ordinary tool continuations while Chat continues at its usual speed", async t => {
  const s = await setup(t);
  await s.app.inject({ method: "PUT", url: `/api/workspaces/${s.workspaceId}/pacing`, payload: { extraDelayMs: 500 } });
  const taskRounds: number[] = [];
  let chatRounds = 0;
  let chatFinishedBeforeTaskRound = false;
  s.service.connections.toolRound = async (_snapshot, request) => {
    if (request.instructions.includes("Main agent Chat.")) {
      if (++chatRounds === 1) return round([write("chat", "chat.txt")], "");
      chatFinishedBeforeTaskRound = taskRounds.length === 1;
      return round();
    }
    taskRounds.push(performance.now());
    return taskRounds.length === 1 ? round([write("work", "task.txt")], "") : round();
  };
  const task = s.engine.submit("a", "new", "Task", randomUUID());
  await s.until(() => taskRounds.length === 1);
  s.engine.submit("a", "chat", "Chat", randomUUID());
  await s.until(() => s.engine.task(task.taskId!).status === "completed");
  assert.equal(chatRounds, 2);
  assert.equal(chatFinishedBeforeTaskRound, true);
  assert.equal(taskRounds.length, 2);
  assert.ok(taskRounds[1]! - taskRounds[0]! >= 480);
});

test("pausing during a paced continuation preserves the safe boundary and cancellation stops the turn", async t => {
  const s = await setup(t);
  await s.app.inject({ method: "PUT", url: `/api/workspaces/${s.workspaceId}/pacing`, payload: { extraDelayMs: 500 } });
  let rounds = 0;
  s.service.connections.toolRound = async () => ++rounds === 1 ? round([write("before-pause", "task.txt")], "") : round();
  const task = s.engine.submit("a", "new", "Task", randomUUID());
  await s.until(() => !!s.db.prepare("SELECT 1 FROM execution_deliveries WHERE turnId=?").get(task.turnId));
  await workspaceAction(s, "pause");
  await s.until(() => !!s.db.prepare("SELECT 1 FROM execution_checkpoints WHERE turnId=? AND safe=1").get(task.turnId));
  await s.service.tick();
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state, "frozen");
  assert.equal(rounds, 1);
  await s.engine.cancelTask(task.taskId!);
  await workspaceAction(s, "resume", "all");
  assert.equal(s.engine.task(task.taskId!).status, "cancelled");
  assert.equal(rounds, 1);
  await s.service.tick();

  const second = s.engine.submit("a", "new", "Cancel during delay", randomUUID());
  s.service.connections.toolRound = async () => ++rounds === 2 ? round([write("before-stop", "stop.txt")], "") : round();
  await s.until(() => !!s.db.prepare("SELECT 1 FROM execution_deliveries WHERE turnId=?").get(second.turnId));
  await s.engine.cancelTask(second.taskId!);
  assert.equal(s.engine.task(second.taskId!).status, "cancelled");
  assert.equal(rounds, 2);
});

test("workspace pause preserves individual freezes, rejects individual resumes and freezes new agents before admission",async t=>{
  const s=await setup(t);
  await s.action("freeze");
  const paused=await workspaceAction(s,"pause");
  assert.equal(paused.state,"frozen");
  assert.equal(paused.resumeAgentCount,1);
  assert.equal(paused.frozenAgentCount,2);
  assert.equal(s.control().workspaceHeld,true);
  const rejected=await s.app.inject({method:"POST",url:"/api/agents/a/resume",payload:{requestId:randomUUID(),expectedRevision:s.control().revision,policy:"all"}});
  assert.equal(rejected.statusCode,409);
  assert.match(rejected.body,/Resume the workspace/);
  const created=await s.app.inject({method:"POST",url:`/api/workspaces/${s.workspaceId}/agents`,payload:{name:"New agent",presetId:"p"}});
  assert.equal(created.statusCode,201,created.body);
  const agent=created.json();
  assert.equal(agent.executionControl.state,"frozen");
  assert.equal(agent.executionControl.workspaceHeld,true);
  const task=s.engine.submit(agent.id,"new","Wait for workspace",randomUUID());
  s.engine.pump();assert.equal(s.engine.task(task.taskId!).status,"queued");
  await s.reopen();
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state,"frozen");
  await workspaceAction(s,"resume","all");
  await s.service.tick();
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state,"active");
  assert.equal(s.control().state,"frozen");
  assert.equal(s.control().workspaceHeld,false);
  assert.equal(s.engine.requiredAgent("b").executionControl.state,"active");
  await s.until(()=>s.engine.task(task.taskId!).status==="completed");
});

test("an explicit freeze during workspace pause is retained on workspace resume",async t=>{
  const s=await setup(t);await workspaceAction(s,"pause");
  await s.action("freeze");
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).resumeAgentCount,1);
  await workspaceAction(s,"resume","skip");await s.service.tick();
  assert.equal(s.control().state,"frozen");
  assert.equal(s.engine.requiredAgent("b").executionControl.state,"active");
});

test("workspace controls validate inputs, fence revisions and origins, and replay canonical requests",async t=>{
  const s=await setup(t),url=`/api/workspaces/${s.workspaceId}/pause`;
  const payload={requestId:randomUUID(),expectedRevision:1};
  assert.equal((await s.app.inject({method:"POST",url,headers:{origin:"https://foreign.example"},payload})).statusCode,403);
  assert.equal((await s.app.inject({method:"POST",url,payload:{...payload,extra:true}})).statusCode,400);
  assert.equal((await s.app.inject({method:"POST",url,payload:{...payload,expectedRevision:0}})).statusCode,400);
  assert.equal((await s.app.inject({method:"POST",url,payload:{...payload,requestId:"short"}})).statusCode,400);
  const first=await s.app.inject({method:"POST",url,payload});assert.equal(first.statusCode,202,first.body);
  const replay=await s.app.inject({method:"POST",url,payload:{expectedRevision:1,requestId:payload.requestId}});
  assert.equal(replay.statusCode,202);assert.equal(replay.json().revision,first.json().revision);
  assert.equal((await s.app.inject({method:"POST",url,payload:{...payload,expectedRevision:2}})).statusCode,409);
  assert.equal((await s.app.inject({method:"POST",url,payload:{...payload,requestId:randomUUID()}})).statusCode,409);
  assert.equal((await s.app.inject({method:"GET",url:`/api/workspaces/missing/execution-control`})).statusCode,404);
  const resumeUrl=`/api/workspaces/${s.workspaceId}/resume`;
  assert.equal((await s.app.inject({method:"POST",url:resumeUrl,payload:{requestId:randomUUID(),expectedRevision:first.json().revision,policy:"bad"}})).statusCode,400);
  const read=await s.app.inject(`/api/workspaces/${s.workspaceId}/execution-control`);
  assert.equal(read.json().state,"frozen");
  const current=s.engine.requiredAgent("b").executionControl;
  const r=await s.app.inject({method:"POST",url:"/api/agents/b/resume",payload:{requestId:randomUUID(),expectedRevision:current.revision,policy:"all"}});
  assert.equal(r.statusCode,409);
});

test("empty workspace pause/resume emits workspace invalidations and deletion of the last preparing member releases the barrier",async t=>{
  const s=await setup(t);
  s.db.prepare("DELETE FROM agents").run();
  assert.equal((await workspaceAction(s,"pause")).state,"frozen");
  assert.equal((await workspaceAction(s,"resume","skip")).state,"active");
  assert.ok(s.db.prepare("SELECT 1 FROM execution_events WHERE workspaceId=? AND agentId IS NULL").get(s.workspaceId));
  const made=await s.app.inject({method:"POST",url:`/api/workspaces/${s.workspaceId}/agents`,payload:{name:"Only member"}});
  assert.equal(made.json().executionControl.state,"active");
  await workspaceAction(s,"pause");await workspaceAction(s,"resume","all");
  s.db.prepare("DELETE FROM agents").run();await s.service.tick();
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state,"active");
});

test("workspace pause waits for both execution lanes and leaves other workspaces running",async t=>{
  const s=await setup(t);
  const other=(await s.app.inject({method:"POST",url:"/api/workspaces",payload:{name:"Other"}})).json();
  const otherAgent=(await s.app.inject({method:"POST",url:`/api/workspaces/${other.id}/agents`,payload:{name:"Other agent",presetId:"p"}})).json();
  const pending = new Map<"task" | "chat", (value: ToolRound) => void>();
  s.service.connections.toolRound=async(_snapshot,request)=>{
    if (request.messages.some(message => message.content.includes("Hold lane"))) {
      const lane = request.instructions.includes("Main agent Chat.") ? "chat" : "task";
      return new Promise(resolve => pending.set(lane, resolve));
    }
    return round();
  };
  const task=s.engine.submit("a","new","Hold lane task",randomUUID());
  const chat=s.engine.submit("a","chat","Hold lane chat",randomUUID());
  await s.until(()=>pending.size===2);
  assert.equal((await workspaceAction(s,"pause")).state,"freezing");
  const outside=s.engine.submit(otherAgent.id,"new","Continue outside",randomUUID());
  await s.until(()=>s.engine.task(outside.taskId!).status==="completed");
  pending.get("task")!(round([write("task-write","task.txt")]));
  await s.until(()=>!!s.db.prepare("SELECT 1 FROM execution_checkpoints WHERE turnId=? AND safe=1").get(task.turnId));
  await s.service.tick();assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state,"freezing");
  pending.get("chat")!(round([write("chat-write","chat.txt")]));
  await s.until(()=>!!s.db.prepare("SELECT 1 FROM execution_checkpoints WHERE turnId=? AND safe=1").get(chat.turnId));
  await s.service.tick();assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state,"frozen");
  assert.equal((s.db.prepare("SELECT count(*) n FROM tool_invocations").get() as any).n,0);
  s.service.connections.toolRound=async()=>round();
  await workspaceAction(s,"resume","all");await s.service.tick();
  await s.until(()=>s.engine.task(task.taskId!).status==="completed" && s.engine.task(chat.taskId!).status==="completed");
  assert.equal((s.db.prepare("SELECT count(*) n FROM tool_invocations").get() as any).n,2);
});

for(const policy of ["all","skip","latest_per_trigger"] as const) test(`workspace ${policy}: shared cutoff, bounded preparation, restart, barrier and agents created during preparation`,async t=>{
  const s=await setup(t);
  await workspaceAction(s,"pause");
  const first=await s.trigger("a"),second=await s.trigger("b");
  for(let n=0;n<65;n++) s.service.run(second.id,randomUUID());
  s.service.run(first.id,randomUUID());
  await workspaceAction(s,"resume",policy);
  const cutoffs=s.db.prepare("SELECT cutoff,eventCutoff,occurrenceCutoff FROM agent_freezes ORDER BY agentId").all();
  assert.deepEqual(cutoffs[0],cutoffs[1]);
  s.service.run(first.id,randomUUID()); // After confirmation: excluded from the chosen policy.
  await s.service.tick();
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state,"resuming");
  assert.equal(s.engine.freezing.state("a"),"active","a finished its preparation, but must stay held");
  assert.equal(s.control().state,"resuming");
  assert.equal(s.engine.freezing.blocked("a"),true);
  assert.equal((s.db.prepare("SELECT count(*) n FROM agent_tasks").get() as any).n,0);
  const made=await s.app.inject({method:"POST",url:`/api/workspaces/${s.workspaceId}/agents`,payload:{name:"During preparation"}});
  const newId=made.json().id;
  assert.equal(made.json().executionControl.state,"resuming");
  assert.equal(s.engine.freezing.state(newId),"frozen");
  await s.reopen();
  for(let n=0;n<10 && s.engine.workspaceFreezing.control(s.workspaceId).state!=="active";n++) await s.service.tick();
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state,"active");
  assert.equal(s.engine.requiredAgent(newId).executionControl.state,"active");
  const skipped=(s.db.prepare("SELECT count(*) n FROM trigger_occurrences WHERE state='skipped'").get() as any).n;
  assert.equal(skipped,policy==="skip"?66:policy==="latest_per_trigger"?64:0);
  assert.ok(s.service.occurrences(s.workspaceId,first.id).items.some(o=>o.state!=="skipped"));
});

test("pausing during individual resume preparation is rejected without acquiring a workspace hold",async t=>{
  const s=await setup(t);await s.action("freeze");await s.action("resume","all");
  const r=await s.app.inject({method:"POST",url:`/api/workspaces/${s.workspaceId}/pause`,payload:{requestId:randomUUID(),expectedRevision:1}});
  assert.equal(r.statusCode,409);assert.match(r.body,/agent is preparing/);
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state,"active");
});

for(const policy of ["all","skip","latest_per_trigger"] as const) test(`workspace ${policy} covers uncollected cron and event backlog without changing individually frozen queues`,async t=>{
  const s=await setup(t);await s.action("freeze");
  const source=s.service.saveSource(s.workspaceId,{name:"Events"}).source;
  const cron=await s.service.save("b",{name:"Cron",instructions:"Handle cron",when:{kind:"cron",expression:"* * * * *",timezone:"UTC"},enabled:true,paused:false,requiredSkillIds:[]});
  const eventInput={name:"Events",instructions:"Handle event",when:{kind:"event" as const,eventType:"fixture.changed",sourceId:source.id},enabled:true,paused:false,requiredSkillIds:[]};
  const event=await s.service.save("b",eventInput),individual=await s.service.save("a",eventInput);
  await workspaceAction(s,"pause");
  const accept=(id:string)=>s.service.accept(s.workspaceId,source.id,source.id,s.service.eventInput({eventId:id,eventType:"fixture.changed",data:{id}}));
  const old=[accept("before-one"),accept("before-two")];
  s.advance(5*60000);
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).backlogPending,true);
  await workspaceAction(s,"resume",policy);
  // Exercise a shared future cutoff with the deterministic scheduler clock.
  s.db.prepare("UPDATE agent_freezes SET cutoff=? WHERE agentId='b'").run(s.service.now());
  s.db.prepare("UPDATE workspace_freezes SET cutoff=? WHERE workspaceId=?").run(s.service.now(),s.workspaceId);
  const newer=accept("after-cutoff");
  await s.reopen();
  for(let n=0;n<30 && s.engine.workspaceFreezing.control(s.workspaceId).state!=="active";n++) await s.service.tick();
  assert.equal(s.engine.workspaceFreezing.control(s.workspaceId).state,"active");
  const cronRows=s.service.occurrences(s.workspaceId,cron.id).items;
  assert.equal(cronRows.length,5);
  assert.equal(cronRows.filter(o=>o.state==="skipped").length,policy==="all"?0:policy==="skip"?5:4);
  const events=s.service.occurrences(s.workspaceId,event.id).items;
  assert.equal(events.filter(o=>old.some(r=>r.id===o.eventId) && o.state==="skipped").length,policy==="all"?0:policy==="skip"?2:1);
  assert.notEqual(events.find(o=>o.eventId===newer.id)?.state,"skipped");
  const untouched=s.service.occurrences(s.workspaceId,individual.id).items;
  assert.equal(untouched.length,3);assert.ok(untouched.every(o=>o.state==="queued"));
  assert.equal(s.control().state,"frozen");
});

test("freeze control is revisioned, idempotent, local-only and accepts queued Chat/task input",async t=>{
  const s=await setup(t);
  const payload={requestId:randomUUID(),expectedRevision:1};
  const send=()=>s.app.inject({method:"POST",url:"/api/agents/a/freeze",payload});
  assert.equal((await send()).statusCode,202);
  assert.equal(s.control().state,"frozen");
  const revision=s.control().revision;
  assert.equal((await send()).statusCode,202);
  assert.equal(s.control().revision,revision);
  assert.equal((await s.app.inject({method:"POST",url:"/api/agents/a/freeze",payload:{expectedRevision:payload.expectedRevision,requestId:payload.requestId}})).statusCode,202,"property order does not change request identity");
  assert.equal((await s.app.inject({method:"POST",url:"/api/agents/a/resume",payload:{...payload,requestId:randomUUID(),policy:"all"}})).statusCode,409);
  assert.equal((await s.app.inject({method:"POST",url:"/api/agents/a/freeze",headers:{origin:"https://foreign.example"},payload})).statusCode,403);
  assert.equal((await s.app.inject({method:"POST",url:"/api/agents/a/resume",payload:{requestId:randomUUID(),expectedRevision:revision,policy:"invalid"}})).statusCode,400);
  const task=s.engine.submit("a","new","Task",randomUUID());
  s.engine.submit("a","chat","Chat",randomUUID());
  s.engine.pump();
  assert.equal(s.engine.task(task.taskId!).status,"queued");
  await s.reopen();
  assert.equal(s.control().state,"frozen");
  await s.resume();
  await s.until(()=>s.engine.task(task.taskId!).status==="completed");
});

test("streaming completes but freezes before the first returned tool; other agents continue",async t=>{
  const s=await setup(t);
  let finish!:(r:ToolRound)=>void;
  let started=false;
  s.service.connections.toolRound=async(_snapshot,request)=>{
    if(request.continuation?.length) return round();
    started=true;request.onDelta?.("Working");
    return new Promise(resolve=>{finish=resolve;});
  };
  const task=s.engine.submit("a","new","Use tools",randomUUID());
  await s.until(()=>started);
  await s.action("freeze");assert.equal(s.control().state,"freezing");
  finish(round([write("first","first.txt"),write("second","second.txt")]));
  await s.until(()=>s.control().state==="frozen");
  assert.equal((s.db.prepare("SELECT count(*) n FROM tool_invocations").get() as any).n,0);
  s.service.connections.toolRound=async()=>round();
  const other=s.engine.submit("b","new","Independent",randomUUID());
  await s.until(()=>s.engine.task(other.taskId!).status==="completed");
  assert.notEqual(s.engine.task(task.taskId!).status,"completed");
  await s.resume();
  await s.until(()=>s.engine.task(task.taskId!).status==="completed");
  assert.equal((s.db.prepare("SELECT count(*) n FROM tool_invocations WHERE turnId=?").get(task.turnId) as any).n,2);
});

test("restart restores the remaining tools and exact provider continuation without replaying writes",async t=>{
  const s=await setup(t);
  s.service.connections.toolRound=async(_snapshot,request)=>request.continuation?.length ? round() : round([write("one","one.txt"),write("two","two.txt")]);
  const tools=(s.engine as any).tools;
  const dispatch=tools.dispatch.bind(tools);
  tools.dispatch=async(...args:any[])=>{
    const result=await dispatch(...args);
    if(args[1].id==="one") await s.action("freeze");
    return result;
  };
  const task=s.engine.submit("a","new","Write two files",randomUUID());
  await s.until(()=>s.control().state==="frozen");
  assert.equal((s.db.prepare("SELECT count(*) n FROM tool_invocations WHERE turnId=?").get(task.turnId) as any).n,1);
  await s.reopen();
  let restored:TaskRequest|undefined;
  s.service.connections.toolRound=async(_snapshot,request)=>{restored=request;return round();};
  await s.resume();
  await s.until(()=>s.engine.task(task.taskId!).status==="completed");
  assert.equal(restored?.continuation?.length,1);
  assert.deepEqual((restored!.continuation![0] as any).response,{saved:"opaque-signature"});
  assert.deepEqual((restored!.continuation![0] as any).results.map((r:any)=>r.call.id),["one","two"]);
  assert.equal((s.db.prepare("SELECT count(*) n FROM tool_invocations WHERE turnId=?").get(task.turnId) as any).n,2);
  const folder=s.service.files.location("task",task.taskId!).path;
  assert.equal(await readFile(join(folder,"one.txt"),"utf8"),"one");
  assert.equal(await readFile(join(folder,"two.txt"),"utf8"),"two");
  assert.deepEqual(JSON.parse((s.db.prepare("SELECT usage FROM agent_turns WHERE id=?").get(task.turnId) as any).usage),{outputTokens:6});
});

for (const provider of ["native", "codex"] as const) {
  for (const restart of [false, true]) {
    test(`${provider} receives the removed last connection after ${restart ? "restart and replay" : "in-process resume"}`, async t => {
      const s = await setup(t);
      if (provider === "codex") s.db.prepare("UPDATE connections SET provider='codex' WHERE id='c'").run();
      s.engine.messaging!.createLink(s.workspaceId, "a", "b");
      const call = write("one", "one.txt");
      const renamePeer = () => s.db.prepare("UPDATE agents SET name='Historical peer' WHERE id='b'").run();
      let latest: string | undefined;
      let replay: string | undefined;
      s.service.connections.toolRound = async (_snapshot, request) => {
        if (!request.continuation?.length) {
          renamePeer();
          return round([call]);
        }
        await s.action("freeze");
        await request.beforeModelRequest!();
        request.refreshConnectionContext!();
        const step = request.continuation[0] as any;
        latest = step.serverObservations?.at(-1);
        replay = JSON.stringify(step.results[0].result);
        return round();
      };
      s.service.connections.executeTask = async (_snapshot, request) => {
        renamePeer();
        const committed = await request.onTool(call);
        await s.action("freeze");
        await request.beforeToolReply!();
        replay = JSON.stringify(committed);
        latest = JSON.stringify(request.finalizeToolReply!(call,committed));
        return {text:"Done",usage:null,finishReason:"stop"};
      };
      const task = s.engine.submit("a", "new", "Write one file", randomUUID());
      await s.until(() => s.control().state === "frozen");
      if (restart) {
        await s.reopen();
        // Cover checkpoints created before the connectedAgents baseline existed.
        s.db.prepare("UPDATE execution_checkpoints SET taskContext=json_remove(taskContext,'$.connectedAgents') WHERE turnId=?").run(task.turnId);
        s.service.connections.toolRound = async (_snapshot, request) => {
          const step = request.continuation![0] as any;
          latest = step.serverObservations?.at(-1);
          replay = JSON.stringify(step.results[0].result);
          assert.deepEqual(step.response, {saved:"opaque-signature"});
          return round();
        };
        s.service.connections.executeTask = async (_snapshot, request) => {
          replay = request.messages.at(-2)?.content;
          latest = request.messages.at(-1)?.content;
          return {text:"Done",usage:null,finishReason:"stop"};
        };
      }
      s.db.prepare("DELETE FROM communication_links WHERE workspaceId=?").run(s.workspaceId);
      await s.resume();
      await s.until(() => s.engine.task(task.taskId!).status === "completed");
      assert.match(replay!, /Historical peer/);
      assert.match(latest!, /"connectedAgents":\{.*"items":\[\]/);
      assert.doesNotMatch(latest!, /Historical peer/);
      assert.equal((s.db.prepare("SELECT COUNT(*) n FROM tool_invocations WHERE turnId=?").get(task.turnId) as any).n, 1);
    });
  }
}

test("a later restart preserves native roster observations between the original tool exchanges", async t => {
  const s = await setup(t);
  s.engine.messaging!.createLink(s.workspaceId, "a", "b");
  s.service.connections.toolRound = async (_snapshot, request) => {
    const count = request.continuation!.length;
    if (!count) return round([write("one", "one.txt")]);
    await s.action("freeze");
    await request.beforeModelRequest!();
    request.refreshConnectionContext!();
    return count === 1 ? round([write("two", "two.txt")]) : round();
  };
  const task = s.engine.submit("a", "new", "Write two files", randomUUID());
  await s.until(() => s.control().state === "frozen");
  s.db.prepare("DELETE FROM communication_links WHERE workspaceId=?").run(s.workspaceId);
  await s.resume();
  await s.until(() => s.control().state === "frozen");
  await s.reopen();
  s.engine.messaging!.createLink(s.workspaceId, "a", "b");
  let replayed: {serverObservations?: string[]}[] = [];
  s.service.connections.toolRound = async (_snapshot, request) => {
    replayed = request.continuation as typeof replayed;
    return round();
  };
  await s.resume();
  await s.until(() => s.engine.task(task.taskId!).status === "completed");
  assert.equal(replayed.length, 2);
  assert.match(replayed[0]!.serverObservations!.at(-1)!, /"items":\[\]/);
  assert.match(replayed[1]!.serverObservations!.at(-1)!, /"id":"b"/);
  assert.deepEqual(s.db.prepare("SELECT callId FROM tool_invocations WHERE turnId=? ORDER BY callId").all(task.turnId), [
    {callId: "one"}, {callId: "two"},
  ]);
});

for (const provider of ["native", "codex"] as const) {
  test(`${provider} checks late roster growth against the prepared model request's remaining context`, async t => {
    const s = await setup(t);
    if (provider === "codex") s.db.prepare("UPDATE connections SET provider='codex' WHERE id='c'").run();
    const park = async (request: TaskRequest) => {
      await s.action("freeze");
      await request.beforeModelRequest!();
      request.refreshConnectionContext!();
    };
    s.service.connections.toolRound = async (_snapshot, request) => {
      await park(request);
      return round();
    };
    s.service.connections.executeTask = async (_snapshot, request) => {
      await park(request);
      return {text: "Done", usage: null, finishReason: "stop"};
    };
    const task = s.engine.submit("a", "new", "Work", randomUUID());
    await s.until(() => s.control().state === "frozen");
    s.db.transaction(() => {
      const addAgent = s.db.prepare("INSERT INTO agents(id,workspaceId,name,instructions,createdAt,updatedAt) VALUES(?,?,'Peer',?,'seed','seed')");
      const addLink = s.db.prepare("INSERT INTO communication_links(id,workspaceId,sourceAgentId,targetAgentId,createdAt) VALUES(?,?,'a',?,'seed')");
      for (let n = 0; n < 1000; n++) {
        const id = `peer-${n}`;
        addAgent.run(id, s.workspaceId, "x".repeat(160));
        addLink.run(id, s.workspaceId, id);
      }
    })();
    await s.resume();
    await s.until(() => s.engine.task(task.taskId!).status === "blocked");
    assert.match(s.engine.task(task.taskId!).error!, /connection context is too large for this model/);
  });
}

for(const policy of ["all","skip","latest_per_trigger"] as const) test(`${policy}: cutoff includes uncollected schedule backlog and serializes retained triggers`,async t=>{
  const s=await setup(t);
  await s.action("freeze");
  await s.trigger();await s.trigger();
  s.advance(100000);
  await s.action("resume",policy);
  // Use the scheduler's deterministic clock for the action cutoff in this fixture.
  s.db.prepare("UPDATE agent_freezes SET cutoff=? WHERE agentId='a'").run(s.service.now());
  await s.service.tick();
  assert.equal(s.control().state,"resuming");
  await s.reopen();
  // Reopening the fixture resets no saved cutoff or preparation progress.
  for(let n=0;n<1000 && s.control().state==="resuming";n++) await s.service.tick();
  assert.equal(s.control().state,"active");
  const skipped=(s.db.prepare("SELECT count(*) n FROM trigger_occurrences WHERE state='skipped'").get() as any).n;
  assert.equal(skipped,policy==="skip"?200:policy==="latest_per_trigger"?198:0);
  const tasks=(s.db.prepare("SELECT count(*) n FROM agent_tasks").get() as any).n;
  assert.equal(tasks,policy==="skip"?0:1,"only one retained trigger is admitted");
  if(tasks) {
    const first=(s.db.prepare("SELECT id FROM agent_tasks").get() as any).id;
    s.db.prepare("UPDATE agent_tasks SET status='awaiting_user' WHERE id=?").run(first);
    await s.service.tick();
    assert.equal((s.db.prepare("SELECT count(*) n FROM agent_tasks").get() as any).n,1);
  }
});

test("both execution lanes reach a safe boundary before the agent becomes frozen; cancellation releases a parked turn",async t=>{
  const s=await setup(t);
  const pending:((value:ToolRound)=>void)[]=[];
  s.service.connections.toolRound=async()=>new Promise(resolve=>pending.push(resolve));
  const task=s.engine.submit("a","new","Task",randomUUID());
  const chat=s.engine.submit("a","chat","Chat",randomUUID());
  await s.until(()=>pending.length===2);
  await s.action("freeze");
  pending[0]!(round());
  await delay(10);assert.equal(s.control().state,"freezing");
  pending[1]!(round());
  await s.until(()=>s.control().state==="frozen");
  await s.engine.cancelTask(task.taskId!);
  await s.engine.cancelTask(chat.taskId!);
  assert.equal(s.engine.task(task.taskId!).status,"cancelled");
  assert.equal((s.db.prepare("SELECT count(*) n FROM execution_checkpoints").get() as any).n,0);
  assert.equal(s.control().state,"frozen");
});

test("a process wait is a safe freeze boundary and process completion does not restart the model",async t=>{
  const s=await setup(t);
  let requests=0;
  s.service.connections.toolRound=async(_snapshot,request)=>{
    requests++;
    if (!request.continuation?.length) return round([{id:"command",name:"process_start",arguments:{command:`"${process.execPath}" -e "setTimeout(() => {}, 1000)"`,background:false,yieldMs:0}}]);
    if (request.continuation.length===1) return round([{id:"wait",name:"process_wait",arguments:{processId:(request.continuation[0] as any).results[0].result.process.id}}]);
    return round();
  };
  const task=s.engine.submit("a","new","Wait for process",randomUUID());
  await s.until(()=>s.engine.task(task.taskId!).status==="waiting");
  await s.action("freeze");
  assert.equal(s.control().state,"frozen");
  assert.equal((s.db.prepare("SELECT phase FROM execution_checkpoints WHERE turnId=?").get(task.turnId) as any).phase,"waiting");
  await s.until(()=>!!s.db.prepare("SELECT 1 FROM owned_processes WHERE state NOT IN ('starting','running')").get());
  const proc=s.db.prepare("SELECT * FROM owned_processes").get() as any;
  assert.equal(proc.state,"exited",JSON.stringify(proc));
  assert.equal(requests,2);
  await s.resume();
  await s.until(()=>s.engine.task(task.taskId!).status==="completed");
  assert.equal(requests,3);
});

test("maintenance resumes from its saved response after restart and preserves memory edits made while frozen",async t=>{
  const s=await setup(t);
  s.db.prepare("INSERT INTO agent_memories(id,agentId,key,content,kind,sources,createdAt,updatedAt) VALUES('memory','a','topic','Original','finding','[]','seed','seed')").run();
  let finish!:(value:any)=>void;
  let started=false;
  s.service.connections.generate=async()=>{started=true;return new Promise(resolve=>finish=resolve);};
  const task=s.engine.submit("a","new","Answer",randomUUID());
  await s.until(()=>started);
  await s.action("freeze");
  const input=(s.db.prepare("SELECT inputMessageId FROM agent_turns WHERE id=?").get(task.turnId) as any).inputMessageId;
  finish({text:JSON.stringify({status:"completed",summary:"Saved",memories:[{key:"topic",kind:"finding",content:"Model finding",sources:[input]}]}),usage:null,finishReason:"stop"});
  await s.until(()=>s.control().state==="frozen");
  s.db.prepare("UPDATE agent_memories SET content='User edit',revision=revision+1 WHERE id='memory'").run();
  await s.reopen();
  s.service.connections.generate=async()=>{throw Error("Saved maintenance must not be requested again");};
  await s.resume();
  await s.until(()=>s.engine.task(task.taskId!).status==="completed");
  assert.equal((s.db.prepare("SELECT content FROM agent_memories WHERE id='memory'").get() as any).content,"User edit");
});

test("Codex restart resolves saved pending callbacks before rebuilding the provider session",async t=>{
  const s=await setup(t);
  s.db.prepare("UPDATE connections SET provider='codex' WHERE id='c'").run();
  const tools=(s.engine as any).tools;
  const dispatch=tools.dispatch.bind(tools);
  tools.dispatch=async(...args:any[])=>{
    const outcome=await dispatch(...args);
    if(args[1].id==="one") await s.action("freeze");
    return outcome;
  };
  s.service.connections.executeTask=async(_snapshot,request)=>{
    const calls=[write("one","one.txt"),write("two","two.txt")];
    calls.forEach(call=>request.onToolQueued?.(call));
    request.onUsage?.({inputTokens:10,outputTokens:5});
    for(const call of calls){await request.onTool(call);await request.beforeToolReply?.();}
    return {text:"Done",usage:{inputTokens:10,outputTokens:5},finishReason:"stop"};
  };
  const task=s.engine.submit("a","new","Use Codex tools",randomUUID());
  await s.until(()=>s.control().state==="frozen");
  assert.equal((s.db.prepare("SELECT count(*) n FROM execution_results WHERE turnId=?").get(task.turnId) as any).n,2);
  await s.reopen();
  let rebuilt=false;
  s.service.connections.executeTask=async(_snapshot,request)=>{
    rebuilt=true;
    assert.match(request.messages.at(-1)!.content,/Server-restored execution progress/);
    assert.equal((s.db.prepare("SELECT count(*) n FROM tool_invocations WHERE turnId=?").get(task.turnId) as any).n,2);
    request.onUsage?.({inputTokens:2,outputTokens:3});
    return {text:"Done",usage:{inputTokens:2,outputTokens:3},finishReason:"stop"};
  };
  await s.resume();
  await s.until(()=>s.engine.task(task.taskId!).status==="completed");
  assert.equal(rebuilt,true);
  assert.deepEqual(JSON.parse((s.db.prepare("SELECT usage FROM agent_turns WHERE id=?").get(task.turnId) as any).usage),{inputTokens:12,outputTokens:8});
});

test("Skip applies to late event fan-out through its cutoff but retains events received afterwards",async t=>{
  const s=await setup(t);
  await s.action("freeze");
  const source=s.service.saveSource(s.workspaceId,{name:"Events"}).source;
  const trigger=await s.service.save("a",{name:"Events",instructions:"Handle event",when:{kind:"event",eventType:"fixture.changed",sourceId:source.id},enabled:true,paused:false,requiredSkillIds:[]});
  const accept=(id:string)=>s.service.accept(s.workspaceId,source.id,source.id,s.service.eventInput({eventId:id,eventType:"fixture.changed",data:{id}}));
  const old=[accept("before-one"),accept("before-two")];
  await s.action("resume","skip");
  const newer=accept("after-cutoff");
  for(let n=0;n<100 && s.control().state==="resuming";n++) await s.service.tick();
  const occurrences=s.service.occurrences(s.workspaceId,trigger.id).items;
  for(const receipt of old) assert.equal(occurrences.find(o=>o.eventId===receipt.id)?.state,"skipped");
  assert.equal(occurrences.find(o=>o.eventId===newer.id)?.state,"submitted");
});

test("Skip cancels submitted tasks that have never started and retains their skipped audit rows",async t=>{
  const s=await setup(t);
  const trigger=await s.trigger();
  s.service.run(trigger.id,randomUUID());
  await s.service.tick();
  const occurrence=s.service.occurrences(s.workspaceId,trigger.id).items[0]!;
  assert.equal(occurrence.state,"submitted");
  await s.action("freeze");
  await s.resume("skip");
  assert.equal(s.engine.task(occurrence.taskId!).status,"cancelled");
  assert.equal(s.service.occurrences(s.workspaceId,trigger.id).items[0]!.state,"skipped");
});

test("freezing during compaction resumes its saved model response after restart",async t=>{
  const s=await setup(t);
  const first=s.engine.submit("a","new","1",randomUUID());
  await s.until(()=>s.engine.task(first.taskId!).status==="completed");
  s.engine.submit("a",first.taskId!,"2",randomUUID());
  await s.until(()=>s.engine.task(first.taskId!).status==="completed");
  let finish!:(value:any)=>void;
  let compacting=false;
  s.service.connections.countTokens=async(_snapshot,request)=>request.instructions.startsWith("You are") && !request.instructions.includes("Earlier task context: compacted") ? 190000 : 100;
  s.service.connections.generate=async(_snapshot,request)=>{
    assert.match(request.instructions,/^Summarize earlier task context/);
    compacting=true;return new Promise(resolve=>finish=resolve);
  };
  s.engine.submit("a",first.taskId!,"3",randomUUID());
  await s.until(()=>compacting);
  await s.action("freeze");
  finish({text:"compacted",usage:{outputTokens:2},finishReason:"stop"});
  await s.until(()=>s.control().state==="frozen");
  await s.reopen();
  s.service.connections.countTokens=async(_snapshot,request)=>request.instructions.startsWith("You are") && !request.instructions.includes("Earlier task context: compacted") ? 190000 : 100;
  s.service.connections.generate=async(_snapshot,request)=>{
    assert.ok(!request.instructions.startsWith("Summarize earlier task context"),"compaction must use the saved response");
    return {text:JSON.stringify({status:"completed",summary:"Done",memories:[]}),usage:null,finishReason:"stop"};
  };
  await s.resume();
  await s.until(()=>s.engine.task(first.taskId!).status==="completed");
  assert.equal((s.db.prepare("SELECT content FROM agent_context_summaries WHERE taskId=?").get(first.taskId) as any).content,"compacted");
});

test("a held trigger cannot hide later user work when helper scheduling is preferred",async t=>{
  const s=await setup(t);
  const triggers=[await s.trigger(),await s.trigger()];
  for(const trigger of triggers) s.service.run(trigger.id,randomUUID());
  await s.service.tick();
  const tasks=s.db.prepare("SELECT id FROM agent_tasks ORDER BY rowid").all() as {id:string}[];
  assert.equal(tasks.length,2);
  await s.action("freeze");await s.resume();
  // The first trigger has started and is awaiting an answer. Two later user
  // admissions have used their preference; the next helper must remain held.
  s.db.prepare("UPDATE agent_turns SET status='completed',snapshot=? WHERE taskId=?").run(JSON.stringify(s.service.connections.snapshot(s.engine.requiredAgent("a"))),tasks[0]!.id);
  s.db.prepare("UPDATE agent_tasks SET status='awaiting_user' WHERE id=?").run(tasks[0]!.id);
  s.db.prepare("INSERT OR REPLACE INTO agent_schedule_state VALUES('a',2)").run();
  const user=s.engine.submit("a","new","User work can proceed",randomUUID());
  assert.equal(s.engine.freezing.canRunTask("a",tasks[1]!.id),false);
  await s.until(()=>s.engine.task(user.taskId!).status==="completed");
  assert.equal(s.engine.task(tasks[1]!.id).status,"queued");
});

test("a failed provider reservation settles the parked execution and releases its lifetime pin",async t=>{
  const s=await setup(t);
  let finish!:(value:ToolRound)=>void;
  let started=false;
  s.service.connections.toolRound=async()=>{started=true;return new Promise(resolve=>finish=resolve);};
  const task=s.engine.submit("a","new","Pause",randomUUID());
  await s.until(()=>started);await s.action("freeze");finish(round());
  await s.until(()=>s.control().state==="frozen");
  s.service.connections.claim=()=>{throw new ConnectionError("Provider unavailable",503);};
  await s.resume();s.engine.pump();await delay(20);
  assert.equal(s.engine.task(task.taskId!).status,"blocked");
  assert.equal((s.engine as any).active.has(task.turnId),false,"the blocked parked promise must be settled");
  assert.equal(s.service.connections.busy("c"),false,"the provider lifetime pin must be released");
});

test("a rebuilt Codex session can reuse a previous provider call ID for a new action",async t=>{
  const s=await setup(t);
  s.db.prepare("UPDATE connections SET provider='codex' WHERE id='c'").run();
  s.service.connections.executeTask=async(_snapshot,request)=>{
    await request.onTool(write("reused","before.txt"));
    await s.action("freeze");await request.beforeToolReply?.();
    return {text:"Done",usage:null,finishReason:"stop"};
  };
  const task=s.engine.submit("a","new","Write files",randomUUID());
  await s.until(()=>s.control().state==="frozen");await s.reopen();
  s.service.connections.executeTask=async(_snapshot,request)=>{
    const result=await request.onTool(write("reused","after.txt"));
    assert.equal(result.ok,true);
    return {text:"Done",usage:null,finishReason:"stop"};
  };
  await s.resume();await s.until(()=>s.engine.task(task.taskId!).status!=="running" && s.engine.task(task.taskId!).status!=="queued");
  assert.equal(s.engine.task(task.taskId!).status,"completed");
  const folder=s.service.files.location("task",task.taskId!).path;
  assert.equal(await readFile(join(folder,"before.txt"),"utf8"),"reused");
  assert.equal(await readFile(join(folder,"after.txt"),"utf8"),"reused");
});

test("Skip preserves a manual occurrence accepted after the cutoff in the same clock millisecond",async t=>{
  const s=await setup(t);await s.action("freeze");
  const trigger=await s.trigger();
  s.service.run(trigger.id,randomUUID());
  await s.action("resume","skip");
  s.service.run(trigger.id,randomUUID());
  const newest=(s.db.prepare("SELECT id FROM trigger_occurrences ORDER BY sequence DESC LIMIT 1").get() as any).id;
  s.db.prepare("UPDATE trigger_occurrences SET createdAt=(SELECT cutoff FROM agent_freezes WHERE agentId='a') WHERE id=?").run(newest);
  await s.service.tick();
  const rows=s.service.occurrences(s.workspaceId,trigger.id).items;
  assert.equal(rows.find(o=>o.id===newest)?.state,"submitted");
  assert.equal(rows.filter(o=>o.state==="skipped").length,1);
});

test("resume collection progresses through its persisted cutoff after the clock moves backwards",async t=>{
  const s=await setup(t);await s.action("freeze");await s.trigger();s.advance(100000);
  await s.action("resume","skip");
  s.db.prepare("UPDATE agent_freezes SET cutoff=? WHERE agentId='a'").run(s.service.now());
  s.advance(-100000);
  const newer=await s.trigger();
  await s.reopen();
  for(let n=0;n<20 && s.control().state==="resuming";n++) await s.service.tick();
  assert.equal(s.control().state,"active");
  assert.equal((s.db.prepare("SELECT count(*) n FROM trigger_occurrences WHERE state='skipped'").get() as any).n,100);
  assert.equal(s.service.occurrences(s.workspaceId,newer.id).total,0,"new definitions do not inherit an older resume cutoff");
});

test("a Codex yield racing with Freeze is not restored as an empty final answer",async t=>{
  const s=await setup(t);s.db.prepare("UPDATE connections SET provider='codex' WHERE id='c'").run();
  s.service.connections.executeTask=async(_snapshot,request)=>{
    await request.onTool({id:"yield",name:"task_yield",arguments:{summary:"Waiting for a follow-up"}});
    await s.action("freeze");
    return {text:"",usage:null,finishReason:"yield"};
  };
  const task=s.engine.submit("a","new","Yield safely",randomUUID());
  await s.until(()=>s.control().state==="frozen");await s.reopen();
  s.service.connections.executeTask=async()=>{throw Error("A yielded turn must not generate again");};
  await s.resume();
  await s.until(()=>!(s.engine as any).active.has(task.turnId));
  assert.equal((s.db.prepare("SELECT phase FROM agent_turns WHERE id=?").get(task.turnId) as any).phase,"yielded");
  assert.equal((s.db.prepare("SELECT count(*) n FROM execution_items WHERE turnId=? AND kind='final'").get(task.turnId) as any).n,0);
});

test("late streamed commentary can be recorded while a Codex tool reply is parked",async t=>{
  const s=await setup(t);s.db.prepare("UPDATE connections SET provider='codex' WHERE id='c'").run();
  let recorded=false;
  s.service.connections.executeTask=async(_snapshot,request)=>{
    await request.onTool(write("write","before.txt"));
    await s.action("freeze");
    const parked=request.beforeToolReply!();
    // Notifications already queued by the transport can arrive after handoff.
    request.onDelta?.("Late tail");
    request.onCommentary?.("Finished preparing the tool request.");
    recorded=true;
    await parked;
    return {text:"Done",usage:null,finishReason:"stop"};
  };
  const task=s.engine.submit("a","new","Record trailing output",randomUUID());
  await s.until(()=>s.control().state==="frozen");await delay(10);
  assert.equal(recorded,true);
  assert.notEqual(s.engine.task(task.taskId!).status,"failed");
  await s.resume();await s.until(()=>s.engine.task(task.taskId!).status==="completed");
  assert.equal((s.db.prepare("SELECT count(*) n FROM execution_items WHERE turnId=? AND kind='commentary'").get(task.turnId) as any).n,1);
});

test("upgrading an old resume with an ambiguous manual-run boundary keeps it frozen for a new choice",async t=>{
  const s=await setup(t);await s.action("freeze");
  const trigger=await s.trigger();s.service.run(trigger.id,randomUUID());
  await s.action("resume","skip");
  s.db.exec("ALTER TABLE agent_freezes DROP COLUMN occurrenceCutoff; PRAGMA user_version=36");
  await s.reopen();
  assert.equal(s.control().state,"frozen");
  assert.equal(s.service.occurrences(s.workspaceId,trigger.id).items[0]!.state,"queued");
  await s.resume("skip");
  assert.equal(s.service.occurrences(s.workspaceId,trigger.id).items[0]!.state,"skipped");
});

test("initial task-event delivery rolls back if saving its provider checkpoint fails",async t=>{
  const s=await setup(t);
  const checkin=randomUUID();
  const context=(s.engine as any).context.bind(s.engine);
  (s.engine as any).context=async(turn:any,active:any,input:any)=>{
    const value=await context(turn,active,input);
    s.db.prepare(`INSERT INTO task_checkins(id,taskId,reason,dueAt,state,createdAt,updatedAt,returnEnvelope)
      VALUES(?,?,'Keep this reminder','seed','fired','seed','seed',?)`).run(checkin,turn.taskId,(s.db.prepare("SELECT envelope FROM agent_turns WHERE id=?").get(turn.id) as any).envelope);
    return value;
  };
  let inject=true;
  const prepare=s.db.prepare.bind(s.db);
  t.mock.method(s.db,"prepare",(sql:string)=>{
    if(inject && sql.includes("UPDATE execution_checkpoints SET taskContext=")) {
      inject=false;
      throw new ConnectionError("Checkpoint write failed",503);
    }
    return prepare(sql);
  });
  const task=s.engine.submit("a","new","1",randomUUID());
  await s.until(()=>s.engine.task(task.taskId!).status==="blocked");
  assert.equal((s.db.prepare("SELECT deliveredTurnId FROM task_checkins WHERE id=?").get(checkin) as any).deliveredTurnId,null);
  await s.reopen();
  let sawReminder=false;
  s.service.connections.toolRound=async(_snapshot,request)=>{sawReminder=request.messages.some(message=>message.content.includes("Keep this reminder"));return round();};
  const retry=s.engine.retry(task.taskId!);
  await s.until(()=>s.engine.task(task.taskId!).status==="completed");
  assert.equal(sawReminder,true);
  assert.equal((s.db.prepare("SELECT deliveredTurnId FROM task_checkins WHERE id=?").get(checkin) as any).deliveredTurnId,retry.turnId);
});

for (const restarted of [false,true]) test(`trigger replay waits for the frozen Chat turn${restarted ? " after restart" : ""} but permits later Chat turns to run concurrently`,async t=>{
  const s=await setup(t);
  let initialStarted=false;
  let finishInitial!:(result:ToolRound)=>void;
  s.service.connections.toolRound=async()=>{initialStarted=true;return new Promise(resolve=>finishInitial=resolve);};
  const chat=s.engine.submit("a","chat","Resume this Chat first",randomUUID());
  await s.until(()=>initialStarted);await s.action("freeze");finishInitial(round());
  await s.until(()=>s.control().state==="frozen");
  if (restarted) {
    // Older checkpoints parked in process waits did not retain a freeze phase.
    s.db.prepare("UPDATE execution_checkpoints SET phase=NULL WHERE turnId=?").run(chat.turnId);
    await s.reopen();
    assert.ok((s.db.prepare("SELECT phase FROM execution_checkpoints WHERE turnId=?").get(chat.turnId) as any).phase);
  }
  const trigger=await s.trigger();s.service.run(trigger.id,randomUUID());s.service.run(trigger.id,randomUUID());
  await s.action("resume","all");await s.service.tick();
  assert.equal(s.control().state,"active");
  assert.equal((s.db.prepare("SELECT count(*) n FROM trigger_occurrences WHERE taskId IS NOT NULL").get() as any).n,0,"trigger dispatch must wait for the captured Chat turn");
  await s.until(()=>s.engine.task(chat.taskId!).status==="completed");
  await s.service.tick();
  assert.equal((s.db.prepare("SELECT count(*) n FROM trigger_occurrences WHERE taskId IS NOT NULL").get() as any).n,1);
  // Holding a subsequent Chat turn must not extend the earlier freeze fence.
  s.service.connections.toolRound=async(_snapshot,request)=>{
    if(request.messages.at(-1)?.content.includes("Later Chat"))return new Promise((_resolve,reject)=>request.signal.addEventListener("abort",()=>reject(request.signal.reason),{once:true}));
    return round();
  };
  s.engine.submit("a","chat","Later Chat",randomUUID());
  await s.until(()=>!!s.db.prepare("SELECT 1 FROM agent_turns WHERE taskId=? AND status='running'").get(chat.taskId));
  await s.until(()=>s.service.occurrences(s.workspaceId,trigger.id).items.some(o=>o.state==="completed"));
  await s.service.tick();
  assert.equal((s.db.prepare("SELECT count(*) n FROM trigger_occurrences WHERE taskId IS NOT NULL").get() as any).n,2,"later Chat work does not hold the trigger queue");
  await s.engine.cancelTask(chat.taskId!);
});
