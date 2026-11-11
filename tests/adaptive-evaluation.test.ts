import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { AdaptiveEvaluationService } from "../packages/adaptive/evaluation.js";
import { createApp } from "../apps/server/app.js";

async function fixture() {
  const store=new Store(":memory:");
  const assets=new AssetService(store),work=new WorkService(store);
  const profile=assets.publishProfile(assets.createProfile({
    name:"eval.builtin",version:"1.0.0",executor:"builtin",
  }).id);
  const inputSchema={type:"object",required:["objective"],
    properties:{objective:{type:"string"}},additionalProperties:false};
  const outputSchema={type:"object",required:["summary"],
    properties:{summary:{type:"string"}},additionalProperties:false};
  for(const [name,version] of [
    ["eval.analyze","1.0.0"],["eval.analyze","2.0.0"],["eval.deliver","1.0.0"],
  ]){
    const cap=assets.createCapability({
      name,version,title:name+" "+version,description:name,
      profileRef:profile.id,inputSchema,outputSchema,
      tags:name==="eval.deliver"?["deliver"]:[],
    });
    assets.validateCapability(cap.id,"Verified deterministic contract");
    assets.publishCapability(cap.id);
  }
  const engine=new AdaptiveEngine(store,assets,async ({node,capability})=>({
    output:{summary:node.id==="deliver"?"complete":
      capability.version==="2.0.0"?"fixed":"broken"},
  }));
  async function run(capabilityRef:string,objective:string) {
    const task=work.createTask({
      type:"manual",title:"Evaluation "+capabilityRef,
      objective,acceptanceCriteria:["Output matches criteria"],
    });
    const result=engine.createRun(task.id,{
      nodes:[
        {id:"analyze",capabilityRef,dependsOn:[],inputs:{objective},bindings:{}},
        {id:"deliver",capabilityRef:"eval.deliver@1.0.0",dependsOn:["analyze"],
          inputs:{objective},bindings:{}},
      ],observations:[],rationale:"Recorded run for evaluation",
    });
    await engine.tick();await engine.tick();await engine.tick();
    assert.equal(engine.get(result.id).status,"awaiting_acceptance");
    return result.id;
  }
  return {store,assets,run,evalService:new AdaptiveEvaluationService(store,assets)};
}

test("paired evidence evaluation reports improvements using exact recorded inputs and immutable output digests",async()=>{
  const {store,run,evalService}=await fixture();
  try {
    const oldId=await run("eval.analyze@1.0.0","inspect");
    const newId=await run("eval.analyze@2.0.0","inspect");
    const dataset=evalService.createDataset({
      title:"Replay acceptance dataset",capabilityName:"eval.analyze",
      cases:[{id:"case1",input:{objective:"inspect"},
        assertions:[{field:"summary",equals:"fixed"}]}],
    });
    const input={datasetId:dataset.id,baselineRef:"eval.analyze@1.0.0",
      candidateRef:"eval.analyze@2.0.0",
      pairs:[{caseId:"case1",baselineRunId:oldId,baselineNodeId:"analyze",
        candidateRunId:newId,candidateNodeId:"analyze"}]};
    const report=evalService.evaluate(input);
    assert.equal(report.verdict,"passed");
    assert.deepEqual(report.improvements,["case1"]);
    assert.deepEqual(report.regressions,[]);
    assert.equal(report.cases[0].baselinePass,false);
    assert.equal(report.cases[0].candidatePass,true);
    assert.equal(evalService.listEvaluations().length,1);
    assert.ok(store.events("evaluation:"+report.id).some((event)=>
      event.type==="evaluation.completed"));
    assert.equal(evalService.listDatasets()[0].digest,dataset.digest);
  }finally{store.close();}
});
test("evaluation rejects mismatched evidence and incomplete cases without inventing success",async()=>{
  const {store,run,evalService}=await fixture();
  try{
    const oldId=await run("eval.analyze@1.0.0","inspect");
    const newId=await run("eval.analyze@2.0.0","inspect");
    const dataset=evalService.createDataset({
      title:"Frozen acceptance dataset",capabilityName:"eval.analyze",
      cases:[{id:"case1",input:{objective:"different"},
        assertions:[{field:"summary",equals:"fixed"}]}],
    });
    const input={datasetId:dataset.id,baselineRef:"eval.analyze@1.0.0",
      candidateRef:"eval.analyze@2.0.0",
      pairs:[{caseId:"case1",baselineRunId:oldId,baselineNodeId:"analyze",
        candidateRunId:newId,candidateNodeId:"analyze"}]};
    assert.throws(()=>evalService.evaluate(input),/运行输入与冻结样例不一致/);
    assert.throws(()=>evalService.evaluate({...input,pairs:[]}),/Too small|at least one|>=1/);
    assert.equal(evalService.listEvaluations().length,0);
  }finally{store.close();}
});
test("evaluation dataset and evaluation routes are bearer-authenticated",async()=>{
 const {store,evalService}=await fixture();
 try{
  const app=createApp(store,"secret");
  await request(app).get("/api/v2/evaluations/datasets").expect(401);
  await request(app).get("/api/v2/evaluations").expect(401);
  const r=await request(app).post("/api/v2/evaluations/datasets")
    .set("Authorization","Bearer secret").send({
      title:"API test dataset",capabilityName:"eval.analyze",
      cases:[{id:"case1",input:{objective:"inspect"},
        assertions:[{field:"summary",equals:"fixed"}]}],
    }).expect(201);
  assert.equal(r.body.cases.length,1);
  assert.equal(evalService.listDatasets().length,1);
 }finally{store.close();}
});
