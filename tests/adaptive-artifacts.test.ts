import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { createApp } from "../apps/server/app.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";

test("V2 artifacts require authorization, selected node membership and canonical containment",async()=>{
 const root=mkdtempSync(join(tmpdir(),"adaptive-artifacts-"));
 const store=new Store(":memory:");
 try{
  bootstrapAdaptiveAssets(store);
  const work=new WorkService(store);
  const task=work.createTask({type:"manual",title:"Artifact test",objective:"Archive evidence",acceptanceCriteria:["Audit artifacts"]});
  const folder=join(root,"adaptive","invocations");
  mkdirSync(folder,{recursive:true});
  const file=join(folder,"report.txt"),outside=join(root,"secret.txt"),linked=join(folder,"leak.txt");
  writeFileSync(file,"trusted report");writeFileSync(outside,"private!");
  symlinkSync(outside,linked);
  const engine=new AdaptiveEngine(store,new AssetService(store),async({node})=>({
   output:{summary:node.id,evidence:[],risks:[]},
   artifacts:node.id==="analyze"?[file,linked,outside]:[],
  }));
  const run=engine.createRun(task.id,{
   nodes:[
    {id:"analyze",capabilityRef:"core.analyze@1.0.0",dependsOn:[],inputs:{objective:"Read"},bindings:{}},
    {id:"deliver",capabilityRef:"core.deliver@1.0.0",dependsOn:["analyze"],inputs:{objective:"Finish"},bindings:{}},
   ],observations:[],rationale:"Artifact ownership",
  });
  await engine.tick();await engine.tick();
  const app=createApp(store,"secret",work,root,engine);
  const base="/api/v2/adaptive-runs/"+run.id+"/artifacts/analyze/";
  await request(app).get(base+"report.txt").expect(401);
  const good=await request(app).get(base+"report.txt").set("Authorization","Bearer secret").expect(200);
  assert.equal(good.text ?? good.body.toString(),"trusted report");
  await request(app).get(base+"leak.txt").set("Authorization","Bearer secret").expect(403);
  await request(app).get(base+"secret.txt").set("Authorization","Bearer secret").expect(403);
  await request(app).get("/api/v2/adaptive-runs/"+run.id+"/artifacts/deliver/report.txt")
    .set("Authorization","Bearer secret").expect(404);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
