import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { bootstrapAdaptiveAssets,standardAdaptivePlan } from "../packages/adaptive/bootstrap.js";
import { selectCoreAgent } from "../packages/adaptive/agent-selection.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { createApp } from "../apps/server/app.js";

test("standard plan uses OpenCode profiles for core Agent nodes and preserves tests/delivery",()=>{
  const store=new Store(":memory:");
  try{
    bootstrapAdaptiveAssets(store);
    const task=new WorkService(store).createTask({
      type:"development",title:"Run with OpenCode",
      objective:"Implement a service",acceptanceCriteria:["Tests pass"],
    });
    const plan=standardAdaptivePlan(task,"opencode");
    const byId=new Map(plan.nodes.map((node)=>[node.id,node]));
    assert.equal(byId.get("analyze")?.profileRef,"core.opencode.read@1.0.0");
    assert.equal(byId.get("design")?.profileRef,"core.opencode.read@1.0.0");
    assert.equal(byId.get("implement")?.profileRef,"core.opencode.write@1.0.0");
    assert.equal(byId.get("review")?.profileRef,"core.opencode.read@1.0.0");
    assert.equal(byId.get("test")?.profileRef,undefined);
    assert.equal(byId.get("deliver")?.profileRef,undefined);
    assert.doesNotThrow(()=>new AdaptiveEngine(store,new AssetService(store))
      .validate(plan,null,task.id));
    assert.equal(standardAdaptivePlan(task,"codex").nodes[0].profileRef,
      "core.codex.read@1.0.0");
  }finally{store.close();}
});
test("core Agent backend selection does not override user-defined custom capability profiles",()=>{
  const plan={nodes:[
    {id:"custom",capabilityRef:"company.review@1.0.0",
      profileRef:"company.special@1.0.0",dependsOn:[],inputs:{},bindings:{}},
    {id:"deliver",capabilityRef:"core.deliver@1.0.0",
      dependsOn:["custom"],inputs:{},bindings:{}},
  ],observations:[],rationale:"Preserve custom execution profiles"};
  assert.equal(selectCoreAgent(plan,"opencode").nodes[0].profileRef,"company.special@1.0.0");
});
test("API generates OpenCode-specific standard DAG without starting any model",async()=>{
  const store=new Store(":memory:");
  try{
    bootstrapAdaptiveAssets(store);
    const task=new WorkService(store).createTask({
      type:"diagnosis",title:"OpenCode diagnosis",objective:"Inspect memory",
      acceptanceCriteria:["Evidence verified"],
    });
    const app=createApp(store,"localtoken");
    const result=(await request(app).post("/api/v2/tasks/"+task.id+"/standard-plan")
      .set("Authorization","Bearer localtoken")
      .send({executionAgent:"opencode"}).expect(200)).body;
    assert.equal(result.executionAgent,"opencode");
    assert.equal(result.plan.nodes[0].profileRef,"core.opencode.read@1.0.0");
  }finally{store.close();}
});
