import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AdaptiveRuntime } from "../packages/adaptive/runtime.js";
import { CapabilityBuilder } from "../packages/adaptive/builder.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";

test("mock OpenCode CLI builds and revises atomic candidates from imported materials with no writes",async()=>{
  const root=mkdtempSync(join(tmpdir(),"aiwork-builder-cli-"));
  const repo=join(root,"repo"),data=join(root,"data"),bin=join(root,"opencode-mock.cjs");
  mkdirSync(repo);mkdirSync(data);
  const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8",stdio:"pipe"});
  git("init","-q");git("config","user.name","Builder Agent");
  git("config","user.email","builder@example.invalid");
  writeFileSync(join(repo,"README.md"),"Disposable builder repo");
  git("add",".");git("commit","-qm","initial");
  const result={
    name:"example.snapshot",title:"Snapshot review",
    description:"Summarize a project specification without modification",
    operatingInstructions:"Read the supplied input description carefully and summarize only evidenced facts.",
    inputSchema:{type:"object",properties:{objective:{type:"string"}},
      required:["objective"],additionalProperties:false},
    outputSchema:{type:"object",properties:{summary:{type:"string"}},
      required:["summary"],additionalProperties:false},
    tags:["read-only"],suggestedSideEffect:"read",suggestedExecutor:"agent",
    sampleInput:{objective:"Inspect specification"},sampleOutput:{summary:"Specification inspected"},
    questions:[],rationale:"One bounded task can be modeled as a read-only atomic operation.",
  };
  writeFileSync(bin,[
    "#!/usr/bin/env node",
    'const a=process.argv.slice(2);',
    'if(a[0]!=="run"||!a.includes("--standalone")||a.includes("--dir"))process.exit(31);',
    'const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);',
    'if(config.default_agent!=="aiwork_read")process.exit(32);',
    'const request=a.at(-1);',
    'if(!request.includes("Project specification as reference material"))process.exit(33);',
    'const result='+JSON.stringify(result)+';',
    'console.log(JSON.stringify({type:"text",part:{text:JSON.stringify(result)}}));',
    'console.log(JSON.stringify({type:"step_finish",part:{tokens:{input:45,output:20}}}));',
  ].join("\n"),{mode:0o700});
  chmodSync(bin,0o700);
  const old=process.env.AI_WORK_OS_OPENCODE;
  process.env.AI_WORK_OS_OPENCODE=bin;
  const store=new Store(":memory:");
  let runtime:AdaptiveRuntime|undefined;
  try {
    bootstrapAdaptiveAssets(store);
    const project=new WorkService(store).createProject({
      name:"OpenCode Builder test",repositoryPath:repo,allowAgent:true,
    });
    runtime=new AdaptiveRuntime(store,data);
    const builder=new CapabilityBuilder(store,runtime.builderAgent());
    const created=await builder.create({
      projectId:project.id,backend:"opencode",
      goal:"Build a read-only project specification review capability",
      materials:[{kind:"inline",name:"spec",text:"Project specification as reference material"}],
    });
    assert.equal(created.capability.status,"candidate");
    assert.equal(created.capability.name,"example.snapshot");
    assert.equal(created.capability.profileRef,null);
    assert.equal(store.events("brain:"+store.list<any>("adaptive_builder_session")[0].id).length,0);
    assert.equal(store.list<any>("adaptive_builder_session").length,1);
    const revised=await builder.revise(created.sessionId,{
      instruction:"Keep the capability purely read-only and retain its source evidence",
    });
    assert.equal(revised.revision.number,2);
    assert.equal(revised.capability.sideEffect,"read");
  }finally{
    if(runtime)await runtime.close();
    store.close();
    if(old===undefined)delete process.env.AI_WORK_OS_OPENCODE;
    else process.env.AI_WORK_OS_OPENCODE=old;
    rmSync(root,{recursive:true,force:true});
  }
});
