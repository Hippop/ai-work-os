import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { BudgetService, estimatedCostMicro } from "../packages/adaptive/budget.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { WorkService } from "../packages/workflow/service.js";

const billing={
  inputUsdPerMillion:2,
  outputUsdPerMillion:8,
  reservedInputTokens:100_000,
  reservedOutputTokens:10_000,
};
function setup(){
  const store=new Store(":memory:");
  const assets=new AssetService(store);
  const profile=assets.publishProfile(assets.createProfile({
    name:"priced.agent",version:"1.0.0",executor:"agent",agent:"codex",
    workspaceMode:"read-only",maxCostUsd:1,billing,
  }).id);
  return {store,assets,profile,budget:new BudgetService(store)};
}
test("prices use micro USD accounting and reject parallel reservations above run budget",()=>{
 const {store,profile,budget}=setup();
 try {
  assert.equal(estimatedCostMicro(billing),280_000);
  const first=budget.reserve("run-1","first",profile,0.5)!;
  assert.equal(first.reservedMicroUsd,280_000);
  assert.throws(()=>budget.reserve("run-1","second",profile,0.5),/总预算/);
  const actual=budget.settle("first",{inputTokens:20_000,outputTokens:2_000},profile,0.5)!;
  assert.equal(actual.state,"settled");
  assert.equal(actual.actualMicroUsd,56_000);
  const second=budget.reserve("run-1","second",profile,0.5)!;
  assert.equal(second.state,"reserved");
  assert.equal(budget.list("run-1").length,2);
 }finally{store.close();}
});
test("unverified or overrunning usage blocks new model invocations without inventing a zero charge",()=>{
 const {store,profile,budget}=setup();
 try{
  budget.reserve("run-2","uncertain",profile,1.5);
  budget.unverified("uncertain","provider_log_missing");
  assert.throws(()=>budget.reserve("run-2","next",profile,1.5),/未确认费用/);
  const settled=budget.reconcile("uncertain",10_000,1_000,profile,1.5,"Confirmed from provider billing statement on 2026-11-11")!;
  assert.equal(settled.state,"settled");
  budget.reserve("run-2","over",profile,1.5);
  const over=budget.settle("over",{inputTokens:250_000,outputTokens:40_000},profile,1.5)!;
  assert.equal(over.state,"overrun");
  assert.throws(()=>budget.reserve("run-2","blocked",profile,1.5),/未确认费用/);
  assert.ok(store.events("run-2").some((e)=>e.type==="adaptive.cost.overrun"));
 }finally{store.close();}
});
test("priced run refuses Agent Profiles with unknown rates at admission",()=>{
 const {store,assets,profile}=setup();
 try{
  const unpriced=assets.publishProfile(assets.createProfile({
    name:"unpriced.agent",version:"1.0.0",executor:"agent",
    agent:"codex",workspaceMode:"read-only",
  }).id);
  const input={type:"object",properties:{objective:{type:"string"}},required:["objective"],additionalProperties:false};
  const output={type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false};
  const cap=assets.createCapability({
    name:"priced.analyze",version:"1.0.0",title:"Analyze",description:"Analyze",
    profileRef:unpriced.id,inputSchema:input,outputSchema:output,
  });
  assets.validateCapability(cap.id,"Verified input/output");assets.publishCapability(cap.id);
  const deliverProfile=assets.publishProfile(assets.createProfile({
    name:"priced.deliver",version:"1.0.0",executor:"builtin",
  }).id);
  const deliver=assets.createCapability({
    name:"priced.delivery",version:"1.0.0",title:"Deliver",description:"Deliver",
    profileRef:deliverProfile.id,inputSchema:input,outputSchema:output,tags:["deliver"],
  });
  assets.validateCapability(deliver.id,"Verified output");assets.publishCapability(deliver.id);
  const task=new WorkService(store).createTask({
    type:"manual",title:"Budget test",objective:"Examine safe data",
    acceptanceCriteria:["Evidence checked"],
  });
  const plan={nodes:[
    {id:"analyze",capabilityRef:cap.id,dependsOn:[],inputs:{objective:"Analyze"},bindings:{}},
    {id:"deliver",capabilityRef:deliver.id,dependsOn:["analyze"],inputs:{objective:"Finish"},bindings:{}},
  ],observations:[],rationale:"Budget admission"};
  const engine=new AdaptiveEngine(store,assets);
  assert.throws(()=>engine.createRun(task.id,plan,0.5),/费用预算模式要求/);
  const run=engine.createRun(task.id,plan);
  assert.equal(run.budgetUsd,null);
  assert.equal(profile.billing?.reservedInputTokens,100_000);
 }finally{store.close();}
});
