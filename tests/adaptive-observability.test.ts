import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { AdaptiveObservability } from "../packages/adaptive/observability.js";

test("observability derives run, checkpoint and capability metrics from persisted state without altering it", async () => {
  const store=new Store(":memory:");
  try {
    const assets=new AssetService(store);
    const profile=assets.publishProfile(assets.createProfile({
      name:"metrics.builtin",version:"1.0.0",executor:"builtin",
    }).id);
    const schemaIn={type:"object",properties:{objective:{type:"string"}},required:["objective"],additionalProperties:false};
    const schemaOut={type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false};
    for(const name of ["metrics.analyze","metrics.deliver"]){
      const cap=assets.createCapability({name,version:"1.0.0",title:name,description:name,
        inputSchema:schemaIn,outputSchema:schemaOut,profileRef:profile.id,
        tags:name==="metrics.deliver"?["deliver"]:[]});
      assets.validateCapability(cap.id,"Validated in test");assets.publishCapability(cap.id);
    }
    const task=new WorkService(store).createTask({
      type:"manual",title:"Metric check",objective:"Analyze traces",acceptanceCriteria:["Verified"],
    });
    const engine=new AdaptiveEngine(store,assets,async({node})=>({
      output:{summary:node.id},modelUsage:{inputTokens:25,outputTokens:10},
    }),{
      compose:async()=>{throw Error("not needed");},
      evaluate:async()=>({decision:"CONTINUE",reason:"Evidence sufficient",affectedNodeIds:[],evidenceRefs:[]}),
    });
    const run=engine.createRun(task.id,{nodes:[
      {id:"analyze",capabilityRef:"metrics.analyze@1.0.0",dependsOn:[],inputs:{objective:"Analyze"},bindings:{}},
      {id:"deliver",capabilityRef:"metrics.deliver@1.0.0",dependsOn:["analyze"],inputs:{objective:"Deliver"},bindings:{}},
    ],observations:[{id:"check",afterNode:"analyze",on:["succeeded"],barrier:true,
      question:"Is the outcome valid?",maxInvocations:1}],rationale:"observe"});
    await engine.tick(); await engine.tick(); await engine.tick(); await engine.tick();
    const report=new AdaptiveObservability(store).report({days:30});
    assert.equal(report.range.runCount,1);
    assert.equal(report.completed,1);
    assert.equal(report.checkpoints.decided,1);
    assert.equal(report.invocations.length,2);
    assert.equal(report.invocations.reduce((sum,c)=>sum+c.inputTokens,0),50);
    assert.equal(report.invocations.reduce((sum,c)=>sum+c.outputTokens,0),20);
    assert.ok(report.invocations.every((v)=>v.averageDurationMs!==null));
    assert.equal(engine.get(run.id).status,"awaiting_acceptance");
    assert.throws(()=>new AdaptiveObservability(store).report({days:900}),/Too big|less than or equal/);
  }finally{store.close();}
});
