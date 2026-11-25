import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { AgentContext, createAgentStore, useAgents } from "../src/agent-store";
import { SettingsContext, createSettingsStore } from "../src/settings-store";
import { initialSettings } from "./helpers";
import { mountComponent } from "./component-helpers";
import type { Agent, AgentExecutionControl } from "../../server/src/contracts";
const {useAgentFreeze,FrozenIndicator}=await import("../src/components/AgentFreeze");
const {LiveAgentCharacter}=await import("../src/components/LiveAgentCharacter");

const control:AgentExecutionControl={state:"frozen",revision:2,requestedAt:"now",frozenAt:"now",queuedTriggerCount:8,backlogPending:false,workspaceHeld:false};
const agent:Agent={id:"a",workspaceId:"w",name:"Ava",presetId:null,instructions:"",appearance:{kind:"pebble",color:"sage",accessories:[]},x:0,y:0,revision:1,createdAt:"now",updatedAt:"now",state:"queued",queuedCount:1,runningTaskCount:0,unfinishedTaskCount:1,chatWorking:false,pendingUserInputCount:0,issueCounts:{warning:0,error:0},executionControl:control};

for(const policy of ["all","skip","latest_per_trigger"] as const) test(`unfreeze offers an explicit ${policy} queue choice and restores focus`,async t=>{
  const store=createAgentStore();
  const actions:unknown[]=[];
  store.setState({agents:{a:agent},refreshAgent:async()=>{},freezeControl:async(...args)=>{actions.push(args);}});
  function Probe(){const value=useAgentFreeze(store.getState().agents.a);return h("div",null,h("button",{onClick:value.activate},value.label),value.dialog);}
  const p=await mountComponent(t,h(AgentContext.Provider,{value:store},h(Probe)));
  const trigger=p.document.querySelector("button")!;
  trigger.focus();await p.click(trigger);
  const dialog=p.document.querySelector("dialog")!;
  assert.ok(dialog);
  assert.equal(p.document.querySelectorAll('input[type="radio"]').length,3);
  assert.equal(p.document.querySelector<HTMLInputElement>('input[value="all"]')!.checked,true);
  await p.click(p.document.querySelector(`input[value="${policy}"]`)!);
  const confirm=[...dialog.querySelectorAll("button")].find(b=>b.textContent==="Unfreeze")!;
  await p.click(confirm);
  assert.deepEqual(actions,[["a","resume",policy]]);
  assert.equal(p.document.querySelector("dialog"),null);
  assert.equal(p.document.activeElement,trigger);
});

test("cancelling leaves the agent frozen; an empty queue resumes directly",async t=>{
  const store=createAgentStore();const actions:unknown[]=[];
  store.setState({agents:{a:agent},refreshAgent:async()=>{},freezeControl:async(...args)=>{actions.push(args);}});
  function Probe(){const value=useAgentFreeze(store.getState().agents.a);return h("div",null,h("button",{onClick:value.activate},value.label),value.dialog);}
  const p=await mountComponent(t,h(AgentContext.Provider,{value:store},h(Probe)));
  await p.click(p.document.querySelector("button")!);
  await p.click([...p.document.querySelectorAll("button")].find(b=>b.textContent==="Cancel")!);
  assert.deepEqual(actions,[]);
  store.setState({agents:{a:{...agent,executionControl:{...control,queuedTriggerCount:0}}}});
  await p.click(p.document.querySelector("button")!);
  assert.deepEqual(actions,[["a","resume","all"]]);
});

test("frozen characters expose a static recognizable state and snowflake independent of animation pause",async t=>{
  const store=createAgentStore();
  const p=await mountComponent(t,h(AgentContext.Provider,{value:store},h(SettingsContext.Provider,{value:createSettingsStore({...initialSettings(),settings:{...initialSettings().settings,characterAnimationsPaused:true}})},h("div",null,h(LiveAgentCharacter,{agent}),h(FrozenIndicator,{agent})))));
  assert.equal(p.document.querySelector('svg[data-frozen="true"]')?.getAttribute("data-paused"),"true");
  assert.ok(p.document.querySelector('[aria-label="Frozen"]'));
});

test("a workspace hold disables individual resume even when its dialog was already open",async t=>{
  const store=createAgentStore(),actions:unknown[]=[];
  store.setState({agents:{a:agent},refreshAgent:async()=>{},freezeControl:async(...args)=>{actions.push(args);}});
  function Probe(){const saved=useAgents(s=>s.agents.a);const freeze=useAgentFreeze(saved);return h("div",null,h("button",{onClick:freeze.activate,disabled:freeze.pending},freeze.label),freeze.dialog);}
  const p=await mountComponent(t,h(AgentContext.Provider,{value:store},h(Probe)));
  await p.click(p.document.querySelector("button")!);
  await act(async()=>store.setState({agents:{a:{...agent,executionControl:{...control,workspaceHeld:true}}}}));
  const confirm=[...p.document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="Unfreeze")!;
  assert.equal(confirm.disabled,true);
  assert.match(p.document.querySelector('[role="status"]')!.textContent!,/Resume the workspace/);
  await p.click(confirm);assert.deepEqual(actions,[]);
});
