import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";

function fixture() {
  const store = new Store(":memory:");
  bootstrapAdaptiveAssets(store);
  const task = new WorkService(store).createTask({
    type:"manual",title:"Lifecycle test",objective:"Analyze a task",
    maxMinutes:1,acceptanceCriteria:["Output reviewed"],
  });
  const plan = {
    nodes:[
      {id:"analyze",capabilityRef:"core.analyze@1.0.0",
        dependsOn:[],inputs:{objective:"Analyze a task"},bindings:{}},
      {id:"deliver",capabilityRef:"core.deliver@1.0.0",
        dependsOn:["analyze"],inputs:{objective:"Deliver results"},bindings:{}},
    ],observations:[],rationale:"Lifecycle state consistency",
  };
  return {store,task,plan};
}
test("task-wide duration expires before new dispatch and returns task to planned state", async () => {
  const {store,task,plan}=fixture();
  try {
    let called=0;
    const engine = new AdaptiveEngine(store,new AssetService(store),
      async()=>{called++;return {output:{summary:"done",evidence:[],risks:[]}}});
    const run=engine.createRun(task.id,plan);
    assert.equal(store.get<{status:string}>("task",task.id)?.status,"in_progress");
    store.put("adaptive_run",{...run,createdAt:"2020-01-01T00:00:00.000Z"});
    await engine.tick();
    assert.equal(called,0);
    assert.equal(engine.get(run.id).status,"failed");
    assert.equal(store.get<{status:string}>("task",task.id)?.status,"planned");
    assert.equal(store.events(run.id).filter((e)=>e.type==="adaptive.budget.time_exceeded").length,1);
  }finally{store.close();}
});
test("successful adaptive delivery marks task awaiting acceptance; human acceptance finishes it",async()=>{
  const {store,task,plan}=fixture();
  try{
    const engine=new AdaptiveEngine(store,new AssetService(store),
      async()=>({output:{summary:"done",evidence:[],risks:[]}}));
    const run=engine.createRun(task.id,plan);
    await engine.tick();await engine.tick();await engine.tick();
    assert.equal(engine.get(run.id).status,"awaiting_acceptance");
    assert.equal(store.get<{status:string}>("task",task.id)?.status,"awaiting_acceptance");
    engine.accept(run.id,true,"Reviewed delivery evidence");
    assert.equal(engine.get(run.id).status,"done");
    assert.equal(store.get<{status:string}>("task",task.id)?.status,"done");
  }finally{store.close();}
});
