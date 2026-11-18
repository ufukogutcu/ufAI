import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import type { WorkspaceExecutionControl } from "../../server/src/contracts";
import { AgentContext, createAgentStore } from "../src/agent-store";
import { mountComponent } from "./component-helpers";
const {useWorkspacePause}=await import("../src/components/WorkspaceControls");
const control:WorkspaceExecutionControl={state:"frozen",revision:3,requestedAt:"now",frozenAt:"now",queuedTriggerCount:8,backlogPending:true,agentCount:3,resumeAgentCount:2,frozenAgentCount:3};

function Probe({id}:{id:string}) {
  const pause=useWorkspacePause(id);
  return h("div",null,h("button",{ref:pause.triggerRef,onClick:pause.activate,disabled:pause.pending},pause.label),
    pause.dialog,pause.actionError && h("p",{role:"alert"},pause.actionError));
}
function probe(store:ReturnType<typeof createAgentStore>,id="w") {
  return h(AgentContext.Provider,{value:store},h(Probe,{id}));
}

for(const policy of ["all","skip","latest_per_trigger"] as const) test(`workspace resume confirms ${policy}, explains preserved freezes and restores focus`,async t=>{
  const store=createAgentStore(),actions:unknown[]=[];
  store.setState({workspaceControls:{w:control},loadWorkspaceControl:async()=>{},controlWorkspace:async(...args)=>{actions.push(args);}});
  const p=await mountComponent(t,probe(store));
  const trigger=p.document.querySelector("button")!;trigger.focus();await p.click(trigger);
  const dialog=p.document.querySelector("dialog")!;
  assert.match(dialog.textContent!,/8 queued trigger occurrences; additional/);
  assert.match(dialog.textContent!,/Individually frozen agents stay frozen/);
  assert.equal(p.document.querySelector<HTMLInputElement>('input[value="all"]')!.checked,true);
  await p.click(p.document.querySelector(`input[value="${policy}"]`)!);
  await p.click([...dialog.querySelectorAll("button")].find(b=>b.textContent==="Resume workspace")!);
  assert.deepEqual(actions,[["w","resume",policy]]);
  assert.equal(p.document.querySelector("dialog"),null);assert.equal(p.document.activeElement,trigger);
});

test("a refreshed empty queue resumes directly with Run all; pause submits directly",async t=>{
  const store=createAgentStore(),actions:unknown[]=[];
  let reads=0;
  store.setState({workspaceControls:{w:control},loadWorkspaceControl:async()=>{
    reads++; store.setState({workspaceControls:{w:{...control,queuedTriggerCount:0,backlogPending:false}}});
  },controlWorkspace:async(...args)=>{assert.equal(reads,1);actions.push(args);}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  assert.equal(p.document.querySelector("dialog"),null);
  assert.deepEqual(actions,[["w","resume","all"]]);
  await act(async()=>store.setState({workspaceControls:{w:{...control,state:"active"}}}));
  await p.click(p.document.querySelector("button")!);assert.deepEqual(actions,[["w","resume","all"],["w","pause",undefined]]);
});

test("refresh finds queued triggers before showing choices; Cancel leaves the workspace paused",async t=>{
  const store=createAgentStore(),actions:unknown[]=[];
  store.setState({workspaceControls:{w:{...control,queuedTriggerCount:0,backlogPending:false}},loadWorkspaceControl:async()=>{
    store.setState({workspaceControls:{w:{...control,queuedTriggerCount:2,backlogPending:false}}});
  },controlWorkspace:async(...args)=>{actions.push(args);}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  assert.match(p.document.querySelector("dialog")!.textContent!,/2 queued trigger occurrences/);
  await p.click([...p.document.querySelectorAll("button")].find(b=>b.textContent==="Cancel")!);
  assert.equal(p.document.querySelector("dialog"),null);assert.deepEqual(actions,[]);
});

for(const agentCount of [0,3]) test(`empty release queue resumes directly with ${agentCount} individually frozen agents`,async t=>{
  const store=createAgentStore(),actions:unknown[]=[];
  store.setState({workspaceControls:{w:{...control,agentCount,frozenAgentCount:agentCount,resumeAgentCount:0,queuedTriggerCount:0,backlogPending:false}},
    loadWorkspaceControl:async()=>{},controlWorkspace:async(...args)=>{actions.push(args);}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  assert.equal(p.document.querySelector("dialog"),null);assert.deepEqual(actions,[["w","resume","all"]]);
});

for(const queued of [0,2]) test(`incomplete zero count waits until collection resolves to ${queued} occurrences`,async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const store=createAgentStore(),actions:unknown[]=[];
  let reads=0;
  store.setState({workspaceControls:{w:{...control,queuedTriggerCount:0}},loadWorkspaceControl:async()=>{
    if(++reads===3) store.setState({workspaceControls:{w:{...control,queuedTriggerCount:queued,backlogPending:queued>0}}});
  },controlWorkspace:async(...args)=>{actions.push(args);}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  const button=p.document.querySelector("button")!;
  assert.equal(button.disabled,true);assert.equal(button.textContent,"Checking queued triggers…");
  assert.equal(p.document.querySelector("dialog"),null);assert.deepEqual(actions,[]);
  await act(async()=>t.mock.timers.tick(500));
  assert.equal(reads,2);assert.equal(button.disabled,true);assert.equal(p.document.querySelector("dialog"),null);
  await act(async()=>t.mock.timers.tick(500));
  assert.equal(reads,3);assert.equal(button.disabled,false);
  if(queued) {
    assert.match(p.document.querySelector("dialog")!.textContent!,/2 queued trigger occurrences; additional/);
    assert.deepEqual(actions,[]);
  } else {
    assert.equal(p.document.querySelector("dialog"),null);assert.deepEqual(actions,[["w","resume","all"]]);
  }
});

test("refresh failure keeps the workspace paused without showing trigger choices and permits retry",async t=>{
  const store=createAgentStore(),actions:unknown[]=[];
  store.setState({workspaceControls:{w:control},loadWorkspaceControl:async()=>{throw new Error("Read failed");},
    controlWorkspace:async(...args)=>{actions.push(args);}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  assert.equal(p.document.querySelector("dialog"),null);assert.deepEqual(actions,[]);
  assert.match(p.document.querySelector('[role="alert"]')!.textContent!,/Read failed/);
  await act(async()=>store.setState({loadWorkspaceControl:async()=>{}}));
  await p.click(p.document.querySelector("button")!);
  assert.ok(p.document.querySelector("dialog"));assert.equal(p.document.querySelector('[role="alert"]'),null);
});

test("failed immediate resume reports the failure without an empty choices dialog",async t=>{
  const store=createAgentStore();
  store.setState({workspaceControls:{w:{...control,queuedTriggerCount:0,backlogPending:false}},loadWorkspaceControl:async()=>{},
    controlWorkspace:async()=>{throw new Error("Resume failed");}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  assert.equal(p.document.querySelector("dialog"),null);
  assert.match(p.document.querySelector('[role="alert"]')!.textContent!,/Resume failed/);
  assert.equal(p.document.querySelector<HTMLButtonElement>("button")!.disabled,false);
});

test("a failed backlog recheck stops checking and leaves the workspace paused",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const store=createAgentStore(),actions:unknown[]=[];let reads=0;
  store.setState({workspaceControls:{w:{...control,queuedTriggerCount:0}},loadWorkspaceControl:async()=>{
    if(++reads>1) throw new Error("Collection check failed");
  },controlWorkspace:async(...args)=>{actions.push(args);}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  await act(async()=>t.mock.timers.tick(500));
  assert.equal(p.document.querySelector("dialog"),null);assert.deepEqual(actions,[]);
  assert.match(p.document.querySelector('[role="alert"]')!.textContent!,/Collection check failed/);
  assert.equal(p.document.querySelector<HTMLButtonElement>("button")!.disabled,false);
  await act(async()=>t.mock.timers.tick(500));assert.equal(reads,2);
});

test("a refresh that observes another session's resume does not open choices or submit again",async t=>{
  const store=createAgentStore(),actions:unknown[]=[];
  store.setState({workspaceControls:{w:control},loadWorkspaceControl:async()=>{
    store.setState({workspaceControls:{w:{...control,state:"resuming",revision:4}}});
  },controlWorkspace:async(...args)=>{actions.push(args);}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  assert.equal(p.document.querySelector("dialog"),null);assert.deepEqual(actions,[]);
  assert.equal(p.document.querySelector<HTMLButtonElement>("button")!.disabled,true);
});

test("switching workspaces ignores an old in-flight check and does not start a check for the new workspace",async t=>{
  const store=createAgentStore(),actions:unknown[]=[];
  let finish!:()=>void,reads=0;
  store.setState({workspaceControls:{w:control,other:control},loadWorkspaceControl:async()=>{
    reads++;await new Promise<void>(resolve=>finish=resolve);
  },controlWorkspace:async(...args)=>{actions.push(args);}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  await act(async()=>p.root.render(probe(store,"other")));
  await act(async()=>finish());
  assert.equal(reads,1);assert.deepEqual(actions,[]);assert.equal(p.document.querySelector("dialog"),null);
  assert.equal(p.document.querySelector<HTMLButtonElement>("button")!.disabled,false);
});

test("unmounting cancels scheduled backlog checks",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const store=createAgentStore();let reads=0;
  store.setState({workspaceControls:{w:{...control,queuedTriggerCount:0}},loadWorkspaceControl:async()=>{reads++;}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  await act(async()=>p.root.render(h("div")));
  await act(async()=>t.mock.timers.tick(500));assert.equal(reads,1);
});

test("pending and unavailable states disable controls; write conflicts retain the dialog and selected policy",async t=>{
  const store=createAgentStore();
  store.setState({workspaceControls:{w:control},loadWorkspaceControl:async()=>{},controlWorkspace:async()=>{throw new Error("Workspace pause state changed. Refresh and try again.");}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  await p.click(p.document.querySelector('input[value="skip"]')!);
  await p.click([...p.document.querySelectorAll("button")].find(b=>b.textContent==="Resume workspace")!);
  assert.match(p.document.querySelector('[role="alert"]')!.textContent!,/state changed/);
  assert.equal(p.document.querySelector<HTMLInputElement>('input[value="skip"]')!.checked,true);
  await p.click([...p.document.querySelectorAll("button")].find(b=>b.textContent==="Cancel")!);
  for(const state of ["freezing","resuming"] as const) {
    await act(async()=>store.setState({workspaceControls:{w:{...control,state}}}));
    assert.equal(p.document.querySelector<HTMLButtonElement>("button")!.disabled,true);
  }
  await act(async()=>store.setState({workspaceControls:{},workspaceControlErrors:{w:"Read failed"}}));
  assert.equal(p.document.querySelector<HTMLButtonElement>("button")!.disabled,true);
});

test("workspace controls fence stale reads separately from agent configuration and isolate workspaces",async t=>{
  const store=createAgentStore();
  let resolveOld!:(r:Response)=>void;
  let calls=0;
  t.mock.method(globalThis,"fetch",async(url:string,init?:RequestInit)=>{
    if(url.endsWith("/pause")) {
      assert.deepEqual({...JSON.parse(init!.body as string),requestId:"id"},{requestId:"id",expectedRevision:3});
      return Response.json({...control,state:"freezing",revision:4});
    }
    if(url.includes("/other/"))return Response.json({...control,state:"active",revision:1});
    if(++calls===1)return new Promise<Response>(resolve=>resolveOld=resolve);
    return Response.json(control);
  });
  store.setState({workspaceControls:{w:control},loadWorkspace:async()=>{}});
  const old=store.getState().loadWorkspaceControl("w");
  await store.getState().controlWorkspace("w","pause");
  resolveOld(Response.json({...control,state:"active",revision:3}));await old;
  assert.equal(store.getState().workspaceControls.w.state,"freezing");
  await store.getState().loadWorkspaceControl("other");
  assert.equal(store.getState().workspaceControls.w.revision,4);
  assert.equal(store.getState().workspaceControls.other.state,"active");
  // At equal revisions, request sequence also protects changing queue counts.
  let resolveFirst!:(r:Response)=>void;
  let sameCalls=0;
  t.mock.method(globalThis,"fetch",async()=>++sameCalls===1?new Promise<Response>(resolve=>resolveFirst=resolve):Response.json({...control,revision:4,queuedTriggerCount:9}));
  const first=store.getState().loadWorkspaceControl("w");await store.getState().loadWorkspaceControl("w");
  resolveFirst(Response.json({...control,revision:4,queuedTriggerCount:1}));await first;
  assert.equal(store.getState().workspaceControls.w.queuedTriggerCount,9);
});
