import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { AdaptiveRuntime } from "../packages/adaptive/runtime.js";

/**
 * End-to-end CLI protocol test without external credentials or paid models.
 * A mock executable uses the SAME spawn and --output-schema contract as Codex,
 * writes an isolated worktree, runs a real project test command, and exports artifacts.
 * This is NOT a real Codex/authentication/cgroup integration test.
 */
test("mock CLI runs planner, worktree-writing atomics, tests, evaluator, review and delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-cli-integration-"));
  const repo = join(root, "repo"), dataDir = join(root, "data");
  mkdirSync(repo); mkdirSync(dataDir);
  const mock = join(root, "mock-codex.cjs");
  writeFileSync(mock, [
    "#!/usr/bin/env node",
    'const fs = require("fs");',
    'const path = require("path");',
    'const args = process.argv.slice(2);',
    'if (args[0] !== "exec") process.exit(2);',
    'const cwd = args[args.indexOf("-C") + 1];',
    'const out = args[args.indexOf("-o") + 1];',
    'const prompt = args[args.length - 1];',
    'if (!fs.existsSync(args[args.indexOf("--output-schema") + 1])) process.exit(3);',
    'let answer;',
    'if (prompt.includes("workflow composition capability")) {',
    '  const ops = ["analyze","design","implement","test","review","deliver"];',
    '  answer = { nodes: ops.map((op,i) => ({',
    '    id:op, capabilityRef:"core."+op+"@1.0.0",',
    '    dependsOn:i?[ops[i-1]]:[], inputs:{objective:"Perform "+op}, bindings:{}',
    '  })), observations:[{id:"after-test",afterNode:"test",',
    '    on:["succeeded","failed"],barrier:true,question:"Verify results",maxInvocations:1}],',
    '    rationale:"Mock CLI planner provides valid constrained DAG" };',
    '} else if (prompt.includes("READ-ONLY progress evaluation capability")) {',
    '  answer = {decision:"CONTINUE",reason:"Project test succeeded",affectedNodeIds:[],evidenceRefs:[]};',
    '} else {',
    '  if (prompt.includes("Capability: core.implement@")) {',
    '    fs.mkdirSync(path.join(cwd,"docs"),{recursive:true});',
    '    fs.writeFileSync(path.join(cwd,"docs","smoke.md"),"Verified adaptive CLI integration\\n");',
    '  }',
    '  answer = {summary:"Mock agent completed a bounded node",evidence:["mocked-cli"],risks:[]};',
    '}',
    'fs.writeFileSync(out,JSON.stringify(answer));',
    'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:31,output_tokens:9}}));',
  ].join("\n"));
  chmodSync(mock, 0o755);
  const git = (...args:string[]) => execFileSync("git",["-C",repo,...args],{encoding:"utf8",stdio:"pipe"});
  let store:Store|undefined, runtime:AdaptiveRuntime|undefined;
  try {
    git("init","-q");
    git("config","user.name","AI Work OS Test");
    git("config","user.email","test@example.invalid");
    writeFileSync(join(repo,"README.md"),"Disposable test repository\n");
    git("add",".");git("commit","-qm","initial");
    store=new Store(":memory:");
    bootstrapAdaptiveAssets(store);
    const work = new WorkService(store);
    const project=work.createProject({
      name:"Mock Codex integration",repositoryPath:repo,allowAgent:true,
      testCommand:{executable:process.execPath,args:[
        "-e",'const fs=require("fs");if(!fs.existsSync("docs/smoke.md"))process.exit(1);console.log("PASS")',
      ]},
    });
    const task=work.createTask({
      type:"development", projectId:project.id,title:"Write a test file",
      objective:"Write docs/smoke.md",acceptanceCriteria:["File is written","Test passes"],
      maxMinutes:3,
    });
    runtime=new AdaptiveRuntime(store,dataDir,mock);
    const engine=new AdaptiveEngine(store,new AssetService(store),runtime.executor(),runtime.planner());
    const plan=await engine.compose(task.id);
    assert.equal(plan.nodes.length,6);
    assert.equal(plan.observations[0].afterNode,"test");
    const run=engine.createRun(task.id,plan);
    for (let i=0;i<20;i++) {
      await engine.tick();
      if (["awaiting_acceptance","failed","waiting","reconciling"].includes(engine.get(run.id).status)) break;
    }
    const result=engine.get(run.id);
    assert.equal(result.status,"awaiting_acceptance",JSON.stringify(result.failures));
    assert.ok(plan.nodes.every((node)=>result.nodeStates[node.id]==="succeeded"));
    assert.equal(result.observationStates["after-test"],"completed");
    assert.equal(store.list<{runId:string}>("adaptive_invocation").filter((i)=>i.runId===run.id).length,6);
    const patchFile=result.results.deliver.artifactRefs.find((f)=>f.endsWith("untracked.json"));
    assert.ok(patchFile);
    const untracked=JSON.parse(readFileSync(patchFile,"utf8")) as {path:string;contentBase64:string}[];
    const changed=untracked.find((f)=>f.path==="docs/smoke.md");
    assert.ok(changed);
    assert.match(Buffer.from(changed.contentBase64,"base64").toString(),/Verified adaptive CLI integration/);
    assert.ok(store.events(run.id).some((e)=>e.type==="adaptive.observation.decided"));
    engine.accept(run.id,true,"Mock executable output and artifacts verified");
    assert.equal(store.get<{status:string}>("task",task.id)?.status,"done");
  } finally {
    if (runtime) await runtime.close();
    store?.close();
    rmSync(root,{recursive:true,force:true});
  }
});
