import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../packages/runtime/adapter.js";
import type { Job } from "../packages/runtime/protocol.js";

test("agent adapter accepts per-capability schema and maintains legacy output contract",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"adaptive-agent-contract-"));
 try {
  const file=join(folder,"mock-cli.cjs");
  writeFileSync(file,[
   "const fs=require('fs');",
   "const a=process.argv.slice(2);",
   "const schema=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8'));",
   "const out=a[a.indexOf('-o')+1];",
   "const obj=schema.properties?.custom ? {custom:'value'} : {summary:'legacy',evidence:[],risks:[]};",
   "fs.writeFileSync(out,JSON.stringify(obj));",
   "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}));",
  ].join("\n"));
  const job:Job={
    runId:"a",epoch:"a",workspace:folder,outputDir:folder,command:process.execPath,
    commandPrefix:[file],objective:"Test adapter",criteria:["Structured response"],
    testCommand:{executable:"true",args:[]},deadline:Date.now()+60000,
  };
  const custom=await runAgent(job,"custom","Output custom property",()=>{}, "analyze",{
    type:"object",additionalProperties:false,required:["custom"],
    properties:{custom:{type:"string"}},
  });
  assert.deepEqual(custom,{custom:"value"});
  const written=JSON.parse(readFileSync(join(folder,"result.schema.json"),"utf8"));
  assert.deepEqual(written.required,["custom"]);
  const legacy=await runAgent(job,"legacy","Output legacy",()=>{},"analyze");
  assert.equal(legacy.summary,"legacy");
  assert.deepEqual(legacy.risks,[]);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
