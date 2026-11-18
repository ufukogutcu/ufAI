import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import type { WorkspaceExecutionControl } from "../../server/src/contracts";
import { AgentContext, createAgentStore } from "../src/agent-store";
import { mountComponent } from "./component-helpers";
const {useWorkspacePause}=await import("../src/components/WorkspaceControls");
const control:WorkspaceExecutionControl={state:"frozen",revision:3,requestedAt:"now",frozenAt:"now",queuedTriggerCount:8,backlogPending:true,agentCount:3,resumeAgentCount:2,frozenAgentCount:3};

function probe(store:ReturnType<typeof createAgentStore>,id="w") {
  function Probe(){const pause=useWorkspacePause(id);return h("div",null,h("button",{ref:pause.triggerRef,onClick:pause.activate,disabled:pause.pending},pause.label),pause.dialog);}
  return h(AgentContext.Provider,{value:store},h(Probe));
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

test("empty queues still ask; Cancel leaves the workspace paused; pause submits directly",async t=>{
  const store=createAgentStore(),actions:unknown[]=[];
  store.setState({workspaceControls:{w:{...control,queuedTriggerCount:0,backlogPending:false}},loadWorkspaceControl:async()=>{},controlWorkspace:async(...args)=>{actions.push(args);}});
  const p=await mountComponent(t,probe(store));await p.click(p.document.querySelector("button")!);
  assert.ok(p.document.querySelector("dialog"));assert.match(p.document.querySelector("dialog")!.textContent!,/0 queued/);
  await p.click([...p.document.querySelectorAll("button")].find(b=>b.textContent==="Cancel")!);assert.deepEqual(actions,[]);
  await act(async()=>store.setState({workspaceControls:{w:{...control,state:"active"}}}));
  await p.click(p.document.querySelector("button")!);assert.deepEqual(actions,[["w","pause",undefined]]);
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
