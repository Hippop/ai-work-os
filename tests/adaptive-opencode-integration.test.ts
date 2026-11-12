import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveRuntime } from "../packages/adaptive/runtime.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";

test("OpenCode mock CLI spans real adaptive planner, worktree write, tests, checkpoint and delivery",async()=>{
  const root=mkdtempSync(join(tmpdir(),"aiwork-opencode-integration-"));
  const repo=join(root,"repo"),data=join(root,"data");
  mkdirSync(repo);mkdirSync(data);
  const fake=join(root,"fake-opencode.cjs");
  writeFileSync(fake,[
    "#!/usr/bin/env node",
    'const fs=require("fs"),path=require("path");',
    'const a=process.argv.slice(2);',
    'if(a[0]!=="run" || !a.includes("--standalone") || a[a.indexOf("--format")+1]!=="json" || a.includes("--dir"))process.exit(17);',
    'const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);',
    'if(!config.default_agent?.startsWith("aiwork_"))process.exit(18);',
    'const cwd=process.cwd();',
    'const prompt=a.at(-1);',
    'let answer;',
    'if(prompt.includes("workflow composition capability")){',
    '  const ops=["analyze","implement","test","review","deliver"];',
    '  answer={nodes:ops.map((op,i)=>({id:op,capabilityRef:"core."+op+"@1.0.0",',
    '    profileRef: op==="implement"?"core.opencode.write@1.0.0":',
    '      ["analyze","review"].includes(op)?"core.opencode.read@1.0.0":undefined,',
    '    dependsOn:i?[ops[i-1]]:[],inputs:{objective:"Do "+op},bindings:{}})),',
    '    observations:[{id:"checkpoint",afterNode:"test",on:["succeeded","failed"],',
    '      barrier:true,question:"Is the test evidence sufficient?",maxInvocations:1}],',
    '    rationale:"Mock OpenCode planner returns valid DAG"};',
    '}else if(prompt.includes("READ-ONLY progress evaluation capability")){',
    '  answer={decision:"CONTINUE",reason:"Verified test success",affectedNodeIds:[],evidenceRefs:[]};',
    '}else{',
    '  if(prompt.includes("Capability: core.implement@")){',
    '    if(config.default_agent!=="aiwork_write")process.exit(19);',
    '    fs.mkdirSync(path.join(cwd,"docs"),{recursive:true});',
    '    fs.writeFileSync(path.join(cwd,"docs","smoke.md"),"OpenCode adapter integration passed\\n");',
    '  }',
    '  answer={summary:"OpenCode mock successful",evidence:["checked"],risks:[]};',
    '}',
    'console.log(JSON.stringify({type:"text",part:{text:JSON.stringify(answer)}}));',
    'console.log(JSON.stringify({type:"step_finish",part:{tokens:{input:15,output:8}}}));',
  ].join("\n"),{mode:0o700});
  chmodSync(fake,0o700);
  const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{
    encoding:"utf8",stdio:"pipe",
  });
  const old=process.env.AI_WORK_OS_OPENCODE;
  process.env.AI_WORK_OS_OPENCODE=fake;
  let store:Store|undefined,runtime:AdaptiveRuntime|undefined;
  try {
    git("init","-q");git("config","user.email","ci@example.invalid");
    git("config","user.name","CI");
    writeFileSync(join(repo,"README.md"),"# Temporary repository\n");
    git("add",".");git("commit","-qm","init");
    store=new Store(":memory:");
    bootstrapAdaptiveAssets(store);
    const work=new WorkService(store);
    const project=work.createProject({
      name:"Temporary OpenCode integration",repositoryPath:repo,allowAgent:true,
      testCommand:{executable:process.execPath,args:[
        "-e",'if(!require("fs").existsSync("docs/smoke.md"))process.exit(1);console.log("PASS")',
      ]},
    });
    const task=work.createTask({
      type:"development",projectId:project.id,title:"OpenCode mock end-to-end",
      objective:"Write docs/smoke.md",acceptanceCriteria:["File is created","Tests pass"],
    });
    runtime=new AdaptiveRuntime(store,data,"codex",undefined,"opencode");
    const engine=new AdaptiveEngine(store,new AssetService(store),runtime.executor(),runtime.planner());
    const plan=await engine.compose(task.id,"opencode");
    assert.equal(plan.nodes.length,5);
    assert.equal(plan.nodes.find((x)=>x.id==="implement")?.profileRef,"core.opencode.write@1.0.0");
    const run=engine.createRun(task.id,plan);
    for(let i=0;i<20;i++){
      await engine.tick();
      if(["failed","waiting","reconciling","awaiting_acceptance"].includes(engine.get(run.id).status))
        break;
    }
    const result=engine.get(run.id);
    assert.equal(result.status,"awaiting_acceptance",JSON.stringify(result.failures));
    assert.equal(result.observationStates.checkpoint,"completed");
    assert.equal(result.nodeStates.implement,"succeeded");
    assert.equal(result.nodeStates.test,"succeeded");
    assert.equal(result.nodeStates.review,"succeeded");
    assert.deepEqual(store.list<{runId:string;status:string}>("adaptive_invocation")
      .filter((i)=>i.runId===run.id).map((i)=>i.status),["succeeded","succeeded","succeeded","succeeded","succeeded"]);
    const artifact=result.results.deliver.artifactRefs.find((x)=>x.endsWith("untracked.json"));
    assert.ok(artifact);
    const entries=JSON.parse(readFileSync(artifact,"utf8")) as {path:string;contentBase64:string}[];
    assert.match(Buffer.from(entries.find((f)=>f.path==="docs/smoke.md")!.contentBase64,"base64")
      .toString(),/OpenCode adapter integration passed/);
  }finally{
    if(runtime)await runtime.close();
    store?.close();
    if(old===undefined)delete process.env.AI_WORK_OS_OPENCODE;
    else process.env.AI_WORK_OS_OPENCODE=old;
    rmSync(root,{recursive:true,force:true});
  }
});
