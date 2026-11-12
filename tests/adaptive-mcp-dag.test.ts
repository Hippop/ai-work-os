import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { McpRegistry } from "../packages/adaptive/mcp.js";
import { McpWriteService, type WriteIntent } from "../packages/adaptive/mcp-write.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { AdaptiveRuntime } from "../packages/adaptive/runtime.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";

function fixture() {
  const folder=mkdtempSync(join(tmpdir(),"aiwork-mcp-dag-"));
  const store=new Store(":memory:");
  bootstrapAdaptiveAssets(store);
  const assets=new AssetService(store),registry=new McpRegistry(store);
  const server=registry.register({
    name:"write-service",description:"Approved external write service",
    transport:{type:"http",url:"https://mock.example.com/mcp"},
    exposedTools:["update"],readOnlyTools:[],
  });
  registry.publish(server.id);
  const profile=assets.createProfile({
    name:"write.approved",version:"1.0.0",executor:"mcp-write",
    workspaceMode:"none",mcpWrite:{
      server:server.id,tool:"update",purpose:"Update one external resource after user approval",
    },
  });
  assets.publishProfile(profile.id);
  const inputSchema={type:"object",required:["key","value"],
    properties:{key:{type:"string"},value:{type:"string"}},additionalProperties:false};
  const outputSchema={type:"object",required:["summary","evidence","risks"],
    properties:{summary:{type:"string"},
      evidence:{type:"array",items:{type:"string"}},
      risks:{type:"array",items:{type:"string"}}},additionalProperties:false};
  const cap=assets.createCapability({
    name:"mcp.change",version:"1.0.0",title:"Remote approved change",
    description:"Modify external resource after user approval",
    sideEffect:"external-write",profileRef:profile.id,
    inputSchema,outputSchema,
  });
  assets.validateCapability(cap.id,"Exact side-effect contract reviewed");
  assets.publishCapability(cap.id);
  const task=new WorkService(store).createTask({
    title:"Approved external change",type:"manual",objective:"Update remote resource",
    acceptanceCriteria:["Human approved exact arguments"],
  });
  const runtime=new AdaptiveRuntime(store,folder);
  const engine=new AdaptiveEngine(store,assets,runtime.executor());
  const run=engine.createRun(task.id,{nodes:[
    {id:"remote",capabilityRef:cap.id,dependsOn:[],
      inputs:{key:"resource1",value:"approved"},bindings:{}},
    {id:"deliver",capabilityRef:"core.deliver@1.0.0",dependsOn:["remote"],
      inputs:{objective:"Report confirmed change"},bindings:{}},
  ],observations:[],rationale:"Wait for human approval"});
  const intent=()=>store.list<WriteIntent>("adaptive_mcp_write")[0];
  return {folder,store,assets,engine,runtime,run,intent};
}
test("DAG external-write node pauses for exact approval and resumes downstream only after confirmed MCP execution",async()=>{
  const ctx=fixture();let calls=0;
  const service=new McpWriteService(ctx.store,async()=>{calls++;return {content:[{text:"done"}]};});
  try{
    await ctx.engine.tick();
    const pending=ctx.engine.get(ctx.run.id);
    assert.equal(pending.status,"waiting");
    assert.equal(pending.nodeStates.remote,"waiting");
    assert.equal(pending.nodeStates.deliver,"pending");
    assert.equal(ctx.intent().status,"requested");
    assert.equal(calls,0);
    assert.equal(ctx.store.list<{state:string}>("adaptive_side_effect")[0].state,"awaiting_approval");
    assert.equal(ctx.store.list<any>("adaptive_invocation")[0].mcpIntentId,ctx.intent().id);
    service.decide(ctx.intent().id,true,"Reviewed exact resource and value",ctx.intent().argsDigest);
    assert.equal(ctx.engine.get(ctx.run.id).nodeStates.deliver,"pending");
    await service.execute(ctx.intent().id);
    ctx.engine.syncMcpWriteIntent(ctx.intent().id);
    assert.equal(ctx.engine.get(ctx.run.id).nodeStates.remote,"succeeded");
    assert.equal(ctx.engine.get(ctx.run.id).status,"running");
    ctx.engine.syncMcpWriteIntent(ctx.intent().id);
    assert.equal(ctx.store.events(ctx.run.id).filter((e)=>
      e.type==="adaptive.mcp.approval_completed").length,1);
    await ctx.engine.tick();await ctx.engine.tick();
    assert.equal(ctx.engine.get(ctx.run.id).status,"awaiting_acceptance");
    assert.equal(ctx.engine.get(ctx.run.id).nodeStates.deliver,"succeeded");
    assert.equal(calls,1);
    assert.ok((ctx.engine.get(ctx.run.id).results.remote.output as {evidence:string[]})
      .evidence.some((x)=>x.includes(ctx.intent().id)));
  }finally{await ctx.runtime.close();ctx.store.close();
    rmSync(ctx.folder,{recursive:true,force:true});}
});
test("rejecting MCP write makes the run fail without sending an external request",async()=>{
  const ctx=fixture();
  try{
    await ctx.engine.tick();
    const service=new McpWriteService(ctx.store,async()=>{
      throw Error("transport must not execute");
    });
    service.decide(ctx.intent().id,false,"Operator rejected this exact remote change",
      ctx.intent().argsDigest);
    ctx.engine.syncMcpWriteIntent(ctx.intent().id);
    assert.equal(ctx.engine.get(ctx.run.id).status,"failed");
    assert.equal(ctx.engine.get(ctx.run.id).nodeStates.deliver,"pending");
    assert.equal(ctx.engine.get(ctx.run.id).nodeStates.remote,"failed");
    assert.equal(ctx.store.list<{state:string}>("adaptive_side_effect")[0].state,"not_executed");
  }finally{await ctx.runtime.close();ctx.store.close();
    rmSync(ctx.folder,{recursive:true,force:true});}
});
test("uncertain MCP response stops the DAG and cannot be silently resumed",async()=>{
  const ctx=fixture();
  try{
    await ctx.engine.tick();
    const service=new McpWriteService(ctx.store,async()=>{throw Error("Lost acknowledgement");});
    service.decide(ctx.intent().id,true,"Operator approved exact write arguments",ctx.intent().argsDigest);
    await assert.rejects(()=>service.execute(ctx.intent().id),/Lost acknowledgement/);
    ctx.engine.syncMcpWriteIntent(ctx.intent().id);
    assert.equal(ctx.engine.get(ctx.run.id).status,"reconciling");
    assert.equal(ctx.engine.get(ctx.run.id).nodeStates.remote,"uncertain");
    assert.throws(()=>ctx.engine.retry(ctx.run.id,"remote"),/未核对/);
  }finally{await ctx.runtime.close();ctx.store.close();
    rmSync(ctx.folder,{recursive:true,force:true});}
});
test("cancelled DAG cannot approve or execute an old pending MCP write",async()=>{
  const ctx=fixture();
  try{
    await ctx.engine.tick();
    ctx.engine.cancel(ctx.run.id,"Stop external changes");
    const service=new McpWriteService(ctx.store);
    assert.throws(()=>service.decide(ctx.intent().id,true,
      "Operator approves after cancellation",ctx.intent().argsDigest),/关联工作流并非等待/);
    assert.equal(ctx.engine.get(ctx.run.id).status,"cancelled");
  }finally{await ctx.runtime.close();ctx.store.close();
    rmSync(ctx.folder,{recursive:true,force:true});}
});
