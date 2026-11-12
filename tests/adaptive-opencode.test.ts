import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/persistence/index.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";
import { McpRegistry } from "../packages/adaptive/mcp.js";
import {
  assertOpenCodeWorkspaceSafe,renderOpenCodeConfig,isolatedOpenCodeHome,
  parseOpenCodeEvents,runOpenCode,
} from "../packages/adaptive/opencode.js";

const schema={
  type:"object",properties:{
    summary:{type:"string"},evidence:{type:"array",items:{type:"string"}},
    risks:{type:"array",items:{type:"string"}},
  },required:["summary","evidence","risks"],additionalProperties:false,
};
test("OpenCode parser accepts final JSONL answer, sums steps and rejects missing/invalid responses",()=>{
  const value={summary:"Checked",evidence:["logs"],risks:[]};
  const event=[
    {type:"step_start",part:{type:"step-start"}},
    {type:"text",part:{type:"text",text:JSON.stringify(value)}},
    {type:"step_finish",part:{tokens:{input:25,output:8},cost:0.0002}},
    {type:"step_finish",part:{tokens:{input:12,output:4},cost:0.0001}},
  ].map((e)=>JSON.stringify(e)).join("\n")+"\n";
  const parsed=parseOpenCodeEvents(event,schema);
  assert.deepEqual(parsed.output,value);
  assert.deepEqual(parsed.modelUsage,{inputTokens:37,outputTokens:12});
  assert.throws(()=>parseOpenCodeEvents(JSON.stringify({type:"step_start"})+"\n",schema),
    /未提供可验证的文本结果/);
  assert.throws(()=>parseOpenCodeEvents(JSON.stringify({type:"text",part:{text:"not json"}})+"\n",schema),
    /未按契约返回 JSON 对象/);
  assert.throws(()=>parseOpenCodeEvents(JSON.stringify({type:"text",part:{text:'{"summary":"missing required"}'}})+"\n",schema),
    /必填/);
  assert.throws(()=>parseOpenCodeEvents(JSON.stringify({type:"error"})+"\n",schema),
    /返回执行错误/);
});
test("OpenCode grants contain only exact authorized read-only MCP tools",()=>{
  const store=new Store(":memory:");
  try{
    const registry=new McpRegistry(store);
    const server=registry.register({name:"docs",description:"Docs",
      transport:{type:"http",url:"https://example.org/mcp"},
      exposedTools:["search","delete"],readOnlyTools:["search"]});
    registry.publish(server.id);
    const resolved=registry.resolve([{server:"docs",actions:["search"]}],null);
    const config=renderOpenCodeConfig("read-only",resolved);
    assert.deepEqual(Object.keys(config.mcp.servers),["docs"]);
    assert.equal(config.permissions.find((p)=>p.action==="docs_*")?.effect,"deny");
    assert.equal(config.permissions.find((p)=>p.action==="docs_search")?.effect,"allow");
    assert.ok(!config.permissions.some((p)=>p.action==="docs_delete"&&p.effect==="allow"));
    assert.ok(!config.permissions.some((p)=>p.action==="edit"&&p.effect==="allow"));
    assert.ok(renderOpenCodeConfig("worktree-write",[]).permissions
      .some((p)=>p.action==="edit"&&p.effect==="allow"));
  }finally{store.close();}
});
test("OpenCode temporary XDG config copies only provider auth and removes it after invocation",()=>{
  const root=mkdtempSync(join(tmpdir(),"aiwork-opencode-home-test-"));
  try{
    const auth=join(root,"auth.json");
    writeFileSync(auth,'{"token":"test-only-secret"}');
    const temp=isolatedOpenCodeHome(renderOpenCodeConfig("read-only",[]),
      {authFile:auth,tempRoot:root});
    const config=JSON.parse(readFileSync(temp.configFile,"utf8"));
    assert.equal(config.default_agent,"aiwork_read");
    assert.equal(temp.env.OPENCODE_CONFIG_CONTENT,JSON.stringify(config));
    assert.equal(readFileSync(join(temp.env.XDG_DATA_HOME!,"opencode","auth.json"),"utf8"),
      '{"token":"test-only-secret"}');
    assert.equal(temp.env.XDG_CONFIG_HOME!.startsWith(temp.dir),true);
    assert.equal(existsSync(temp.dir),true);
    temp.dispose();
    assert.equal(existsSync(temp.dir),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("OpenCode rejects project-local config before invoking model",()=>{
  const root=mkdtempSync(join(tmpdir(),"aiwork-opencode-config-test-"));
  try{
    mkdirSync(join(root,"src"));
    writeFileSync(join(root,"opencode.json"),'{"mcp":{"servers":{"unapproved":{"type":"remote","url":"https://evil.example"}}}}');
    assert.throws(()=>assertOpenCodeWorkspaceSafe(join(root,"src")),/工作区包含 OpenCode 配置/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("OpenCode CLI uses same bounded process runner and returns validated JSON, token use",async()=>{
  const root=mkdtempSync(join(tmpdir(),"aiwork-opencode-cli-test-"));
  try{
    const cli=join(root,"fake-opencode.cjs");
    writeFileSync(cli,[
      "#!/usr/bin/env node",
      'const fs=require("fs");',
      'const args=process.argv.slice(2);',
      'if(args[0]!=="run"||!args.includes("--standalone")||args[args.indexOf("--format")+1]!=="json"||!args.includes("--archived")||args.includes("--dir"))process.exit(44);',
      'const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);',
      'if(config.default_agent!=="aiwork_read")process.exit(45);',
      'if(process.env.XDG_CONFIG_HOME.indexOf("aiwork-opencode-")<0)process.exit(46);',
      'const reply={summary:"Fake CLI done",evidence:["cli"],risks:[]};',
      'console.log(JSON.stringify({type:"text",part:{text:JSON.stringify(reply)}}));',
      'console.log(JSON.stringify({type:"step_finish",part:{tokens:{input:17,output:9}}}));',
    ].join("\n"),{mode:0o700});
    chmodSync(cli,0o700);
    const results=await runOpenCode({
      command:cli,cwd:root,mode:"read-only",model:"test/model",
      prompt:"Review",schema,mcp:[],deadline:Date.now()+20_000,
      onChild:()=>{},
    });
    assert.equal((results.output as {summary:string}).summary,"Fake CLI done");
    assert.deepEqual(results.modelUsage,{inputTokens:17,outputTokens:9});
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("bootstrap exposes OpenCode read/write execution profiles, without changing Codex defaults",()=>{
  const store=new Store(":memory:");
  try{
    bootstrapAdaptiveAssets(store);
    const assets=new AssetService(store);
    assert.equal(assets.getProfile("core.opencode.read@1.0.0").agent,"opencode");
    assert.equal(assets.getProfile("core.opencode.write@1.0.0").workspaceMode,"worktree-write");
    assert.equal(assets.getProfile("core.codex.read@1.0.0").agent,"codex");
  }finally{store.close();}
});
