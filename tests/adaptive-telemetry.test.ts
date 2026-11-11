import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCodexEvents } from "../packages/adaptive/telemetry.js";

test("Codex telemetry tracks token counts and hashes tool details without exposing secrets",()=>{
 const raw=[
  {type:"item.completed",item:{type:"mcp_tool_call",name:"search",arguments:{secret:"DO_NOT_LOG"},output:"Private matching documents"}},
  {type:"item.completed",item:{type:"command_execution",command:"cat /private/secrets",output:"SECRET_VALUE"}},
  {type:"turn.completed",usage:{input_tokens:120,output_tokens:45}},
 ].map((x)=>JSON.stringify(x)).join("\n");
 const result=summarizeCodexEvents(raw);
 assert.deepEqual(result.usage,{inputTokens:120,outputTokens:45});
 assert.equal(result.tools.length,2);
 assert.equal(result.tools[0].name,"search");
 assert.match(result.tools[0].inputDigest!,/^[a-f0-9]{64}$/);
 assert.match(result.tools[1].outputDigest!,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(result),/DO_NOT_LOG|SECRET_VALUE|Private matching documents|cat \/private/);
});
test("invalid events and invalid token fields are safely ignored",()=>{
 const result=summarizeCodexEvents("not json\n"+JSON.stringify({
  type:"turn.completed",usage:{input_tokens:"infinite",output_tokens:-1},
 }));
 assert.equal(result.usage,undefined);
 assert.deepEqual(result.tools,[]);
});
