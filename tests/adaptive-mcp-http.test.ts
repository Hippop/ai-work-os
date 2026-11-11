import { test } from "node:test";
import assert from "node:assert/strict";
import { callMcpWrite, type WriteTransport } from "../packages/adaptive/mcp-write.js";
import type { McpServer } from "../packages/adaptive/mcp.js";

const server: McpServer = {
  id:"remote",
  name:"remote",
  status:"published",
  description:"Test Streamable HTTP MCP",
  transport:{type:"http",url:"https://remote.example.org/mcp"},
  exposedTools:["update"],
  readOnlyTools:[],
  projectId:null,
  createdAt:new Date().toISOString(),
};
test("HTTP MCP write adapter follows initialize, initialized, tools/call with session pinning",async()=>{
  const saved=globalThis.fetch;
  const allowed=process.env.AI_WORK_OS_MCP_WRITE_ALLOW_HOSTS;
  const calls:{body:any;headers:Headers;url:string}[]=[];
  process.env.AI_WORK_OS_MCP_WRITE_ALLOW_HOSTS="remote.example.org";
  try {
    globalThis.fetch = (async(input:any,init:any)=>{
      const body=JSON.parse(init.body);
      calls.push({body,headers:new Headers(init.headers),url:String(input)});
      assert.equal(init.redirect,"manual");
      assert.equal(String(input),"https://remote.example.org/mcp");
      if (body.method==="initialize")return new Response(JSON.stringify({
        jsonrpc:"2.0",id:body.id,result:{protocolVersion:"2025-06-18",capabilities:{},serverInfo:{name:"test",version:"1"}},
      }),{status:200,headers:{"content-type":"application/json","mcp-session-id":"session-1"}});
      if (body.method==="notifications/initialized")
        return new Response(null,{status:202,headers:{"mcp-session-id":"session-1"}});
      assert.equal(body.method,"tools/call");
      return new Response(JSON.stringify({
        jsonrpc:"2.0",id:body.id,result:{content:[{type:"text",text:"updated"}]},
      }),{status:200,headers:{"content-type":"application/json"}});
    }) as typeof globalThis.fetch;
    const result=await callMcpWrite(server,"update",{name:"document",content:"changed"},"intent-1");
    assert.deepEqual(result,{content:[{type:"text",text:"updated"}]});
    assert.deepEqual(calls.map((c)=>c.body.method),["initialize","notifications/initialized","tools/call"]);
    assert.equal(calls[1].headers.get("mcp-session-id"),"session-1");
    assert.equal(calls[2].headers.get("mcp-session-id"),"session-1");
    assert.equal(calls[2].body.id,"intent-1");
    assert.deepEqual(calls[2].body.params.arguments,{name:"document",content:"changed"});
  } finally {
    globalThis.fetch=saved;
    if(allowed===undefined)delete process.env.AI_WORK_OS_MCP_WRITE_ALLOW_HOSTS;
    else process.env.AI_WORK_OS_MCP_WRITE_ALLOW_HOSTS=allowed;
  }
});
test("HTTP MCP write adapter fails closed if host is not explicitly allowlisted",async()=>{
  const saved=process.env.AI_WORK_OS_MCP_WRITE_ALLOW_HOSTS;
  try{
    delete process.env.AI_WORK_OS_MCP_WRITE_ALLOW_HOSTS;
    await assert.rejects(()=>callMcpWrite(server,"update",{},"intent"),/域名不在运维白名单/);
  }finally{
    if(saved!==undefined)process.env.AI_WORK_OS_MCP_WRITE_ALLOW_HOSTS=saved;
  }
});
