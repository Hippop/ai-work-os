import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveRuntime } from "../packages/adaptive/runtime.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";

async function runProgram(authorized:boolean) {
  const root=mkdtempSync(join(tmpdir(),"aiwork-program-list-"));
  const repo=join(root,"repo"),dataDir=join(root,"data");
  mkdirSync(repo);mkdirSync(dataDir);
  const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"});
  git("init","-q");
  git("config","user.name","CI");
  git("config","user.email","ci@example.invalid");
  writeFileSync(join(repo,"README.md"),"CI test\n");
  git("add",".");git("commit","-qm","initial");
  const store=new Store(":memory:");
  const runtime=new AdaptiveRuntime(store,dataDir);
  try{
    bootstrapAdaptiveAssets(store);
    const command={executable:process.execPath,args:["-e","console.log('AUTHORIZED_OUTPUT')"]};
    const work=new WorkService(store);
    const project=work.createProject({
      name:"Approved tools",repositoryPath:repo,allowAgent:true,
      authorizedCommands: authorized ? [{name:"check",...command,allowWorkspaceWrite:false}]:[],
    });
    const assets=new AssetService(store);
    const profile=assets.publishProfile(assets.createProfile({
      name:"project.command",version:"1.0.0",projectId:project.id,
      executor:"program",program:command,workspaceMode:"read-only",
    }).id);
    const input={type:"object",properties:{objective:{type:"string"}},
      required:["objective"],additionalProperties:false};
    const output={type:"object",properties:{
      summary:{type:"string"},evidence:{type:"array",items:{type:"string"}},
      risks:{type:"array",items:{type:"string"}},
    },required:["summary","evidence","risks"],additionalProperties:false};
    const cap=assets.createCapability({
      name:"project.custom",version:"1.0.0",title:"Project command",
      description:"Run a project-authorized command",
      profileRef:profile.id,inputSchema:input,outputSchema:output,
    });
    assets.validateCapability(cap.id,"Command contract verified");
    assets.publishCapability(cap.id);
    const task=work.createTask({
      type:"manual",projectId:project.id,title:"Run approved program",
      objective:"Check static output",acceptanceCriteria:["Only authorized programs run"],
    });
    const engine=new AdaptiveEngine(store,assets,runtime.executor());
    const run=engine.createRun(task.id,{
      nodes:[
        {id:"check",capabilityRef:cap.id,dependsOn:[],inputs:{objective:"Check"},bindings:{}},
        {id:"deliver",capabilityRef:"core.deliver@1.0.0",dependsOn:["check"],
          inputs:{objective:"Deliver"},bindings:{}},
      ],observations:[],rationale:"Authorized custom program",
    });
    await engine.tick();
    const after=engine.get(run.id);
    if(authorized){
      assert.equal(after.nodeStates.check,"succeeded");
      assert.match((after.results.check.output as {summary:string}).summary,/AUTHORIZED_OUTPUT/);
      await engine.tick();await engine.tick();
      assert.equal(engine.get(run.id).status,"awaiting_acceptance");
    }else{
      assert.equal(after.nodeStates.check,"failed");
      assert.match(after.failures.check,/命令未包含在项目显式授权列表/);
      assert.equal(after.nodeStates.deliver,"pending");
    }
  }finally{await runtime.close();store.close();rmSync(root,{recursive:true,force:true});}
}
test("authorized project program atom executes without being limited to testCommand",async()=>{
  await runProgram(true);
});
test("unlisted program atom fails closed before starting a process",async()=>{
  await runProgram(false);
});
