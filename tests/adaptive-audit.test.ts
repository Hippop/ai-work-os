import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";
import { AdaptiveAuditService } from "../packages/adaptive/audit.js";
import { createApp } from "../apps/server/app.js";

function fixture() {
  const store=new Store(":memory:");
  bootstrapAdaptiveAssets(store);
  const task=new WorkService(store).createTask({
    title:"Audit task",type:"manual",objective:"Review audit events",
    acceptanceCriteria:["Verified event history"],
  });
  const engine=new AdaptiveEngine(store,new AssetService(store),async({node})=>({
    output:{summary:node.id,evidence:[],risks:[]},
  }));
  const run=engine.createRun(task.id,{
    nodes:[
      {id:"analyze",capabilityRef:"core.analyze@1.0.0",dependsOn:[],
        inputs:{objective:"Review audit events"},bindings:{}},
      {id:"deliver",capabilityRef:"core.deliver@1.0.0",dependsOn:["analyze"],
        inputs:{objective:"Deliver audit"},bindings:{}},
    ],observations:[],rationale:"Trace records",
  });
  return {store,engine,run};
}
test("audit exports stable event chain with private payloads omitted and run artifacts hashed",async()=>{
  const {store,engine,run}=fixture();
  try {
    await engine.tick();await engine.tick();await engine.tick();
    store.event(run.id,"private.audit.test",{apiToken:"SUPER_PRIVATE_SECRET",action:"inspect"});
    store.put("adaptive_cost",{
      id:"cost-one",runId:run.id,profileRef:"read.profile@1.0.0",model:"test-model",
      state:"settled",reservedMicroUsd:100,actualMicroUsd:20,
      inputTokens:8,outputTokens:2,createdAt:new Date().toISOString(),
    });
    const audit=new AdaptiveAuditService(store).exportRun(run.id);
    assert.equal(audit.runId,run.id);
    assert.equal(audit.format,"ai-work-os.adaptive-audit.v1");
    assert.equal(audit.invocations.length,2);
    assert.equal(audit.costs[0].actualMicroUsd,20);
    assert.ok(audit.events.some((e)=>e.type==="private.audit.test"));
    assert.equal(audit.events.at(-1)?.chainHash,audit.finalChainHash);
    assert.equal(audit.events.at(0)?.seq,1);
    assert.doesNotMatch(JSON.stringify(audit),/SUPER_PRIVATE_SECRET/);
    assert.equal(new AdaptiveAuditService(store).exportRun(run.id).snapshotDigest,
      audit.snapshotDigest);
  }finally{store.close();}
});
test("audit export includes more than 500 events without losing chain continuity",()=>{
  const {store,run}=fixture();
  try{
    for(let i=0;i<1100;i++)store.event(run.id,"test.trace",{offset:i});
    const exported=new AdaptiveAuditService(store).exportRun(run.id);
    assert.equal(exported.events.length,1101);
    assert.equal(exported.events.at(-1)?.seq,1101);
    assert.equal(exported.events.at(-1)?.chainHash,exported.finalChainHash);
    store.db.prepare("DELETE FROM events WHERE run_id=? AND seq=?").run(run.id,15);
    assert.throws(()=>new AdaptiveAuditService(store).exportRun(run.id),/事件序号缺失/);
  }finally{store.close();}
});
test("audit endpoint is authenticated and does not echo raw run event payloads",async()=>{
  const {store,run}=fixture();
  try{
    store.event(run.id,"test.secret",{privateValue:"NOT_FOR_EXPORT"});
    const app=createApp(store,"securetoken");
    await request(app).get("/api/v2/adaptive-runs/"+run.id+"/audit").expect(401);
    const result=(await request(app).get("/api/v2/adaptive-runs/"+run.id+"/audit")
      .set("Authorization","Bearer securetoken").expect(200)).body;
    assert.equal(result.runId,run.id);
    assert.doesNotMatch(JSON.stringify(result),/NOT_FOR_EXPORT/);
    await request(app).get("/api/v2/adaptive-runs/00000000-0000-0000-0000-000000000000/audit")
      .set("Authorization","Bearer securetoken").expect(404);
  }finally{store.close();}
});
