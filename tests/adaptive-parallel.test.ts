import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";

const input = {type:"object",properties:{objective:{type:"string"}},required:["objective"],additionalProperties:false};
const output = {type:"object",properties:{summary:{type:"string"},allowed:{type:"boolean"}},required:["summary","allowed"],additionalProperties:false};
function setup() {
  const store = new Store(":memory:"), assets = new AssetService(store);
  const p = assets.createProfile({name:"parallel.builtin",version:"1.0.0",executor:"builtin"});
  assets.publishProfile(p.id);
  for (const name of ["branch", "final"]) {
    const cap = assets.createCapability({name:"parallel."+name,version:"1.0.0",title:name,description:name,
      inputSchema:input,outputSchema:output,profileRef:p.id,tags:name==="final"?["deliver"]:[]});
    assets.validateCapability(cap.id,"Contract checked with deterministic values");assets.publishCapability(cap.id);
  }
  const task=new WorkService(store).createTask({type:"manual",title:"Parallel DAG",objective:"Test event scheduler",
    acceptanceCriteria:["Join all branches"]});
  const node=(id:string,from:string[],condition?:{fromNode:string;field:string;equals:boolean})=>({
    id,capabilityRef:id==="deliver"?"parallel.final@1.0.0":"parallel.branch@1.0.0",
    dependsOn:from,inputs:{objective:id},bindings:{},...(condition?{condition}:{})
  });
  return {store,assets,task,node};
}
test("independent DAG branches execute concurrently, join starts only after both complete",async()=>{
  const {store,assets,task,node}=setup();
  let release!:()=>void;
  const blocker=new Promise<void>(resolve=>{release=resolve});
  const started:string[]=[];
  try {
    const engine=new AdaptiveEngine(store,assets,async({node:n})=>{
      started.push(n.id);
      if(n.id==="left"||n.id==="right")await blocker;
      return {output:{summary:n.id,allowed:true}};
    });
    const run=engine.createRun(task.id,{nodes:[node("left",[]),node("right",[]),node("deliver",["left","right"])],
      observations:[],rationale:"Parallel branches, deterministic join"});
    const ticking=engine.tick();
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(started.sort(),["left","right"]);
    assert.equal(engine.get(run.id).nodeStates.deliver,"pending");
    release(); await ticking;
    await engine.tick();await engine.tick();
    assert.equal(engine.get(run.id).status,"awaiting_acceptance");
    assert.deepEqual(started.sort(),["deliver","left","right"]);
  }finally {store.close();}
});
test("typed boolean condition skips one branch, propagates skipped bindings and joins",async()=>{
  const {store,assets,task,node}=setup();
  try {
    const engine=new AdaptiveEngine(store,assets,async({node:n})=>({output:{summary:n.id,allowed:false}}));
    const plan={nodes:[
      node("source",[]),
      node("truebranch",["source"],{fromNode:"source",field:"allowed",equals:true}),
      node("falsebranch",["source"],{fromNode:"source",field:"allowed",equals:false}),
      node("deliver",["truebranch","falsebranch"]),
    ],observations:[],rationale:"Test conditional branch"};
    const run=engine.createRun(task.id,plan);
    await engine.tick();await engine.tick();await engine.tick();await engine.tick();
    const state=engine.get(run.id);
    assert.equal(state.nodeStates.truebranch,"skipped");
    assert.equal(state.nodeStates.falsebranch,"succeeded");
    assert.equal(state.nodeStates.deliver,"succeeded");
    assert.equal(state.status,"awaiting_acceptance");
    assert.ok(store.events(run.id).some((event)=>event.type==="adaptive.node.skipped"));
  }finally {store.close();}
});
test("condition must read a typed field from direct predecessor",()=>{
 const {store,assets,task,node}=setup();
 try {
  const engine=new AdaptiveEngine(store,assets);
  const plan={nodes:[
    node("source",[]),
    node("branch",["source"],{fromNode:"wrong",field:"allowed",equals:true}),
    node("deliver",["branch"]),
  ],observations:[],rationale:"Invalid condition"};
  assert.throws(()=>engine.validate(plan,null,task.id),/条件必须引用直接前驱|条件字段/);
 }finally{store.close();}
});
