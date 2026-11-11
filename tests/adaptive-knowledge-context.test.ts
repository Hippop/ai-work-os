import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { AssetService } from "../packages/adaptive/assets.js";

test("required knowledge larger than model context budget never silently truncates",()=>{
  const store=new Store(":memory:");
  try{
    const assets=new AssetService(store);
    const large=assets.createKnowledge({
      name:"context.required",version:"1.0.0",title:"Required policy",
      content:"Policy detail: "+"A".repeat(12000),scope:"global",source:"User",
    });
    assets.publishKnowledge(large.id);
    assets.bindKnowledge({capabilityName:"code.review",knowledgeRef:large.id,mode:"required"});
    assert.throws(()=>assets.retrieveKnowledge("policy",null,null,"code.review"),
      /必需知识超出 Agent 上下文预算/);
    assert.equal(store.events("knowledge:search").length,0);
  }finally{store.close();}
});
test("oversized optional knowledge is omitted; compact required knowledge stays exact and audited",()=>{
  const store=new Store(":memory:");
  try{
    const assets=new AssetService(store);
    const needed=assets.createKnowledge({
      name:"context.acceptance",version:"1.0.0",title:"Review policy",
      content:"Always review permission boundaries",scope:"global",source:"Owner",
    });
    const large=assets.createKnowledge({
      name:"context.long",version:"1.0.0",title:"Review policy deep-dive",
      content:"review "+"X".repeat(12000),scope:"global",source:"User",
    });
    assets.publishKnowledge(needed.id);assets.publishKnowledge(large.id);
    assets.bindKnowledge({capabilityName:"code.review",knowledgeRef:needed.id,mode:"required"});
    const retrieved=assets.retrieveKnowledge("review",null,null,"code.review");
    assert.equal(retrieved.length,1);
    assert.equal(retrieved[0].id,needed.id);
    assert.equal(retrieved[0].content,"Always review permission boundaries");
    assert.ok(JSON.stringify(retrieved).length <= 9000);
    const last=store.events("knowledge:search").at(-1)!;
    assert.equal((last.payload as {omittedByBudget:number}).omittedByBudget,1);
  }finally{store.close();}
});
test("on-demand knowledge requires query relevance and does not inject automatically",()=>{
  const store=new Store(":memory:");
  try{
    const assets=new AssetService(store);
    const entry=assets.createKnowledge({
      name:"context.database",version:"1.0.0",title:"Database migrations",
      content:"sqlite lock timeout planning",scope:"global",source:"User",
    });
    assets.publishKnowledge(entry.id);
    assets.bindKnowledge({capabilityName:"code.review",knowledgeRef:entry.id,mode:"on-demand"});
    assert.equal(assets.retrieveKnowledge("frontend layout",null,null,"code.review").length,0);
    assert.equal(assets.retrieveKnowledge("sqlite",null,null,"code.review").length,1);
  }finally{store.close();}
});
