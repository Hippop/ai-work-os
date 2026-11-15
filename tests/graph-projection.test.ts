import { apiPath } from "../apps/web/src/api-path.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";
import { createApp } from "../apps/server/app.js";
import { projectRun, getRunGraph } from "../packages/graph/projection.js";
import { defaultPositions } from "../packages/graph/layout.js";
import { readLayout, saveLayout } from "../packages/graph/layout-service.js";

function fixture() {
  const store = new Store(":memory:"); bootstrapAdaptiveAssets(store);
  const task = new WorkService(store).createTask({title:"Canvas inspection",type:"manual",objective:"Inspect evidence on a graph",acceptanceCriteria:["Preserve execution facts"]});
  const engine = new AdaptiveEngine(store);
  const run = engine.createRun(task.id,{nodes:[
    {id:"inspect",capabilityRef:"core.analyze@1.0.0",inputs:{objective:"Inspect"}},
    {id:"deliver",capabilityRef:"core.deliver@1.0.0",dependsOn:["inspect"],bindings:{objective:{fromNode:"inspect",field:"summary"}}},
  ],observations:[{id:"inspect",afterNode:"inspect",question:"Is the evidence sufficient?"}]});
  return {store,run,engine};
}
test("projection separates observation identity, uses frozen profiles and only recorded invocation knowledge", () => {
  const {store,run} = fixture();
  try {
    run.snapshots.inspect.profile.workspaceSubdir = "src";
    run.snapshots.inspect.capability.title = "Frozen title";
    run.results.inspect = {output:{summary:"done"},artifactRefs:["report"],invocationId:"old-result",digest:"digest"};
    const graph = projectRun(run,[
      {id:"old-result",runId:run.id,nodeId:"inspect",planRevision:0,startedAt:"2026-01-01",knowledgeRefs:[{id:"facts@1.0.0",digest:"frozen"}]},
      {id:"unrelated",runId:"another-run",nodeId:"inspect",planRevision:1,startedAt:"2027-01-01",knowledgeRefs:[{id:"secret",digest:"no"}]},
    ]);
    assert.equal(new Set(graph.nodes.map(n=>n.id)).size,3);
    assert.equal(graph.nodes[0].title,"Frozen title");
    assert.deepEqual(graph.nodes[0].knowledge,[{id:"facts@1.0.0",digest:"frozen"}]);
    assert.equal(graph.nodes[0].artifactCount,1);
    assert.equal(graph.nodes[1].knowledgeRecorded,false);
    assert.deepEqual(graph.edges[0].kinds,["dependency","data"]);
    assert.deepEqual(graph.edges[0].mappings,[{input:"objective",output:"summary"}]);
    assert.equal(graph.edges[1].target,"obs:inspect");
    assert.equal(JSON.stringify(graph).includes("secret"),false);
  } finally {store.close();}
});
test("layout persistence is CAS protected, bounded, and does not change plan or events", () => {
  const {store,run,engine} = fixture();
  try {
    const beforeEvents=store.events(run.id);
    const positions=defaultPositions(getRunGraph(store,run.id).nodes,getRunGraph(store,run.id).edges);
    assert.ok(positions["cap:deliver"].x > positions["cap:inspect"].x);
    const saved=saveLayout(store,run.id,{expectedRevision:0,positions});
    assert.equal(saved.revision,1);assert.deepEqual(readLayout(store,run.id),saved);
    assert.throws(()=>saveLayout(store,run.id,{expectedRevision:0,positions}),/布局已在其他页面/);
    assert.throws(()=>saveLayout(store,run.id,{expectedRevision:1,positions:{"cap:missing":{x:1,y:1}}}),/不存在/);
    assert.throws(()=>saveLayout(store,run.id,{expectedRevision:1,positions:{"cap:inspect":{x:-1,y:1}}}));
    assert.deepEqual(engine.get(run.id),run);assert.deepEqual(store.events(run.id),beforeEvents);
  } finally {store.close();}
});
test("V3 graph and layout routes enforce authentication, origin, missing runs and layout conflicts", async () => {
  const {store,run,engine} = fixture();
  try {
    const app=createApp(store,"test-token",undefined,undefined,engine);
    const path=`/api/v3/runs/${run.id}`;
    await request(app).get(path+"/graph").expect(401);
    await request(app).get(path+"/graph").set("Authorization","Bearer test-token").set("Origin","https://evil.example").expect(403);
    const result=await request(app).get(path+"/graph").set("Authorization","Bearer test-token").expect(200);
    assert.equal(result.body.runId,run.id);assert.equal(result.body.nodes.length,3);
    await request(app).get("/api/v3/runs/missing/graph").set("Authorization","Bearer test-token").expect(404);
    await request(app).post(path+"/layout").set("Authorization","Bearer test-token").send({expectedRevision:0,positions:{}}).expect(200);
    await request(app).post(path+"/layout").set("Authorization","Bearer test-token").send({expectedRevision:0,positions:{}}).expect(409);
  } finally {store.close();}
});

test("frontend routes V3 graph requests without adding a legacy V1 prefix", () => {
  assert.equal(apiPath("/v3/runs/example/graph"), "/api/v3/runs/example/graph");
  assert.equal(apiPath("/v2/adaptive-runs"), "/api/v2/adaptive-runs");
  assert.equal(apiPath("/tasks"), "/api/v1/tasks");
});
