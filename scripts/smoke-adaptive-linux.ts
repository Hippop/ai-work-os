/**
 * Explicitly opt-in REAL Codex / Linux smoke, never run by CI or npm test.
 * AI_WORK_OS_SMOKE_CONFIRM=1 npm run smoke:adaptive:linux
 * Requires installed/authenticated Codex; uses a disposable Git repository.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";
import { AdaptiveRuntime } from "../packages/adaptive/runtime.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";

async function main() {
  if (process.platform !== "linux") throw Error("Linux only");
  if (process.env.AI_WORK_OS_SMOKE_CONFIRM !== "1")
    throw Error("Explicit opt-in required: AI_WORK_OS_SMOKE_CONFIRM=1");
  const root=mkdtempSync(join(tmpdir(),"aiwork-adaptive-smoke-"));
  const repo=join(root,"repo"),dataDir=join(root,"data");
  mkdirSync(repo);mkdirSync(dataDir);
  const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8",stdio:"pipe"});
  let store:Store|undefined,runtime:AdaptiveRuntime|undefined;
  try {
    git("init","-q");
    git("config","user.email","smoke@example.invalid");
    git("config","user.name","AI Work OS Smoke");
    writeFileSync(join(repo,"README.md"),"# Disposable smoke test\n");
    git("add",".");git("commit","-qm","smoke initial");
    store=new Store(join(dataDir,"state.db"));
    bootstrapAdaptiveAssets(store);
    const work=new WorkService(store);
    const project=work.createProject({
      name:"Disposable Codex smoke",repositoryPath:repo,allowAgent:true,
      testCommand:{executable:process.execPath,args:[
        "-e",
        "if(!require('fs').existsSync('docs/SMOKE.md'))process.exit(1);console.log('smoke file exists')",
      ]},
    });
    const task=work.createTask({
      type:"development",projectId:project.id,title:"Build a smoke artifact",
      objective:"Create docs/SMOKE.md in the disposable repo with the exact line 'AI Work OS adaptive smoke verified'. Do not modify other files.",
      acceptanceCriteria:["docs/SMOKE.md exists","The file contains the expected line","Project tests succeed","Code review finds no blocking risks"],
    });
    runtime=new AdaptiveRuntime(store,dataDir);
    const engine=new AdaptiveEngine(store,new AssetService(store),runtime.executor(),runtime.planner());
    const operations=["implement","test","review","deliver"];
    const plan={
      nodes:operations.map((operation,i)=>({
        id:operation,capabilityRef:"core."+operation+"@1.0.0",
        dependsOn:i?[operations[i-1]]:[],inputs:{objective:task.objective},bindings:{},
      })),
      observations:[{
        id:"after-test",afterNode:"test",on:["succeeded" as const,"failed" as const],
        barrier:true,question:"Do the real tests support moving on to review?",maxInvocations:1,
      }],
      rationale:"Controlled, local, disposable end-to-end smoke",
    };
    const run=engine.createRun(task.id,plan);
    for(let i=0;i<20;i++){
      await engine.tick();
      const latest=engine.get(run.id);
      process.stdout.write("Tick "+i+": "+latest.status+" "+JSON.stringify(latest.nodeStates)+"\n");
      if(["failed","reconciling","waiting","awaiting_acceptance"].includes(latest.status))break;
    }
    const latest=engine.get(run.id);
    assert.equal(latest.status,"awaiting_acceptance",
      "The run did not reach successful delivery: "+JSON.stringify(latest.failures));
    assert.equal(latest.nodeStates.implement,"succeeded");
    assert.equal(latest.nodeStates.test,"succeeded");
    assert.equal(latest.nodeStates.review,"succeeded");
    const artifact=latest.results.deliver.artifactRefs.find((ref)=>ref.endsWith("untracked.json"));
    assert.ok(artifact,"untracked artifact missing");
    const untracked=JSON.parse(readFileSync(artifact,"utf8")) as {path:string;contentBase64:string}[];
    const entry=untracked.find((f)=>f.path==="docs/SMOKE.md");
    assert.ok(entry,"SMOKE.md not present in exported artifacts");
    assert.match(Buffer.from(entry.contentBase64,"base64").toString("utf8"),/AI Work OS adaptive smoke verified/);
    engine.accept(run.id,true,"Smoke output and evidence checked");
    process.stdout.write("PASS: real Codex, isolated worktree, testing, review, checkpoint and artifacts verified\n");
  } finally {
    if(runtime)await runtime.close();
    store?.close();
    rmSync(root,{recursive:true,force:true});
  }
}
main().catch((err)=>{console.error(err);process.exitCode=1;});
