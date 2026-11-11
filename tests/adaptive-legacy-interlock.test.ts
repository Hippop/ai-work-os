import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";

function fixture(){
 const store=new Store(":memory:");
 bootstrapAdaptiveAssets(store);
 const work=new WorkService(store);
 const task=work.createTask({
  title:"Interlock test",objective:"Do not run both execution engines",
  type:"manual",acceptanceCriteria:["Run only once"],
 });
 const plan={
  nodes:[
   {id:"analyze",capabilityRef:"core.collect@1.0.0",dependsOn:[],inputs:{objective:task.objective},bindings:{}},
   {id:"deliver",capabilityRef:"core.deliver@1.0.0",dependsOn:["analyze"],inputs:{objective:"Deliver"},bindings:{}},
  ],
  observations:[],rationale:"Ensure single task runtime",
 };
 return {store,work,task,plan};
}
test("active adaptive run blocks legacy task editing and duplicate legacy dispatch",()=>{
 const {store,work,task,plan}=fixture();
 try{
  const prepared=work.prepare(task.id);
  const engine=new AdaptiveEngine(store);
  engine.createRun(task.id,plan);
  assert.throws(()=>work.updateTask(task.id,task.revision,{title:"Edit during execution"}),/活跃的自适应运行/);
  assert.throws(()=>work.start(task.id,prepared.preparationDigest,"legacy-start"),/活跃的自适应运行|准备已过期/);
 }finally{store.close();}
});
test("active legacy run blocks starting adaptive execution with the same task",()=>{
 const {store,work,task,plan}=fixture();
 try{
  const prepared=work.prepare(task.id);
  assert.equal(prepared.ready,true);
  work.start(task.id,prepared.preparationDigest,"legacy-start");
  const engine=new AdaptiveEngine(store);
  assert.throws(()=>engine.createRun(task.id,plan),/活跃的旧版运行/);
 }finally{store.close();}
});
