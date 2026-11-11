import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { McpRegistry } from "../packages/adaptive/mcp.js";
import { McpWriteService } from "../packages/adaptive/mcp-write.js";
import request from "supertest";
import { createApp } from "../apps/server/app.js";

function fixture(fn?: ConstructorParameters<typeof McpWriteService>[1]) {
  const store = new Store(":memory:");
  const registry = new McpRegistry(store);
  const server = registry.register({
    name:"write-docs", description:"External write API (explicit user approval required)",
    transport:{type:"http",url:"https://example.org/mcp"},
    exposedTools:["read","update"],readOnlyTools:["read"],
  });
  registry.publish(server.id);
  const service = new McpWriteService(store,fn ?? (async()=>({content:[{text:"ok"}]})));
  const payload = {
    server:server.id, tool:"update",projectId:null,runId:null,
    arguments:{key:"item-1",value:"changed"},purpose:"User requested an explicit remote change",
  };
  return {store,registry,service,payload};
}
test("exact parameters and server snapshot require human approval; execution is at-most-once",async()=>{
  const calls:string[]=[];
  const {store,service,payload}=fixture(async(server,tool,args,id)=>{
    calls.push(id);
    assert.equal(server.id,"write-docs");
    assert.equal(tool,"update");
    assert.deepEqual(args,{key:"item-1",value:"changed"});
    return {content:[{type:"text",text:"updated"}]};
  });
  try {
    const intent=service.request(payload);
    assert.equal(intent.status,"requested");
    assert.throws(()=>service.decide(intent.id,true,"Approved exact requested operation","wrong"),/摘要/);
    assert.throws(()=>service.request({...payload,tool:"read"}),/只能申请已登记的写入工具/);
    assert.equal(service.decide(intent.id,true,"Operator checked the item and arguments",intent.argsDigest).status,"approved");
    assert.throws(()=>service.decide(intent.id,true,"Try approve twice",intent.argsDigest),/不再等待审批/);
    const result=await service.execute(intent.id);
    assert.equal(result.status,"succeeded");
    assert.ok(result.resultDigest);
    assert.deepEqual(calls,[intent.id]);
    await assert.rejects(()=>service.execute(intent.id),/未获得有效一次性授权/);
    assert.equal(store.list<{state:string}>("adaptive_side_effect")[0].state,"confirmed");
    assert.ok(store.events("mcp-write:"+intent.id).some((e)=>e.type==="mcp.write.confirmed"));
  }finally{store.close();}
});
test("external timeout becomes uncertain; a restart never retries the write",async()=>{
  let calls=0;
  const {store,service,payload}=fixture(async()=>{calls++;throw Error("connection lost after send");});
  try{
    const intent=service.request(payload);
    service.decide(intent.id,true,"Checked exact destination and input",intent.argsDigest);
    await assert.rejects(()=>service.execute(intent.id),/connection lost/);
    assert.equal(service.get(intent.id).status,"uncertain");
    assert.equal(calls,1);
    await assert.rejects(()=>service.execute(intent.id),/未获得有效一次性授权/);
    assert.throws(()=>service.reconcile(intent.id,"short"),/必须提供外部状态核验依据/);
    assert.equal(service.reconcile(intent.id,"Remote administrator verified the final state").status,"reconciled");
    assert.equal(store.list<{state:string}>("adaptive_side_effect")[0].state,"reconciled");
    assert.equal(calls,1);
  }finally{store.close();}
});
test("controller recovery marks interrupted dispatch uncertain",()=>{
  const {store,service,payload}=fixture();
  try{
    const intent=service.request(payload);
    service.decide(intent.id,true,"Approved exact user-provided operation",intent.argsDigest);
    store.put("adaptive_mcp_write",{...service.get(intent.id),status:"executing"});
    store.put("adaptive_side_effect",{id:intent.id,runId:null,state:"started"});
    service.recover();
    assert.equal(service.get(intent.id).status,"uncertain");
    assert.equal(store.get<{state:string}>("adaptive_side_effect",intent.id)?.state,"uncertain");
    service.recover();
    assert.equal(store.events("mcp-write:"+intent.id).filter((e)=>e.type==="mcp.write.uncertain").length,1);
  }finally{store.close();}
});
test("MCP writes API requires bearer token and echoes immutable argument digest for approval",async()=>{
  const {store,payload}=fixture();
  try{
    const app=createApp(store,"token");
    await request(app).get("/api/v2/mcp-write-intents").expect(401);
    const created=(await request(app).post("/api/v2/mcp-write-intents")
      .set("Authorization","Bearer token").send(payload).expect(201)).body;
    assert.equal(created.status,"requested");
    await request(app).post("/api/v2/mcp-write-intents/"+created.id+"/decision")
      .set("Authorization","Bearer token").send({
        approve:true,reason:"User inspected exact target and arguments",
        expectedArgsDigest:created.argsDigest,
      }).expect(200);
    const events=(await request(app).get("/api/v2/mcp-write-intents/"+created.id+"/events")
      .set("Authorization","Bearer token").expect(200)).body;
    assert.equal(events[0].type,"mcp.write.requested");
    assert.equal(events[1].type,"mcp.write.approved");
    assert.ok(!JSON.stringify(events).includes('"value":"changed"'));
  }finally{store.close();}
});
