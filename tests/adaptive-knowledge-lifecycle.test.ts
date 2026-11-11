import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { WorkService } from "../packages/workflow/service.js";

test("published knowledge is immutable, revision becomes a draft and binding can be revoked",()=>{
  const store=new Store(":memory:");
  try{
    const assets=new AssetService(store);
    const initial=assets.createKnowledge({
      name:"java.memory",version:"1.0.0",title:"JVM memory",
      content:"Inspect GC logs first",scope:"global",source:"User-authored",
    });
    assets.updateKnowledgeDraft(initial.id,{content:"Inspect GC and native memory"});
    assets.publishKnowledge(initial.id);
    const binding=assets.bindKnowledge({capabilityName:"java.analyze",
      knowledgeRef:initial.id,mode:"required"});
    assert.equal(assets.bindings("java.analyze").length,1);
    assert.throws(()=>assets.updateKnowledgeDraft(initial.id,{content:"overwrite"}),/已发布知识/);
    const revision=assets.reviseKnowledge(initial.id,{
      version:"1.0.1",content:"Check GC logs and cgroup native memory",
    });
    assert.equal(revision.status,"draft");
    assert.equal(revision.version,"1.0.1");
    assert.match(assets.getKnowledge(initial.id).content,/Inspect GC and native memory/);
    assets.publishKnowledge(revision.id);
    assert.equal(assets.listKnowledge().length,2);
    assert.equal(assets.bindings("java.analyze").length,1);
    assets.revokeKnowledgeBinding(binding.id);
    assert.equal(assets.bindings("java.analyze").length,0);
    assert.ok(store.events("asset:knowledge:"+revision.id)
      .some((event)=>event.type==="knowledge.revised_from"));
  }finally{store.close();}
});

test("mandatory project and capability scopes cannot leak into unrelated request",()=>{
 const store=new Store(":memory:");
 try{
  const assets=new AssetService(store);
  const project=new WorkService(store).createProject({name:"Project A",repositoryPath:process.cwd(),
    allowAgent:false});
  const knowledge=assets.createKnowledge({
    name:"project.private",version:"1.0.0",title:"Project A architecture",
    content:"Private project domain rules",scope:"project",projectId:project.id,
    source:"Project document",capabilityNames:["domain.analyze"],
  });
  assets.publishKnowledge(knowledge.id);
  assert.equal(assets.retrieveKnowledge("domain",null,null,"domain.analyze").length,0);
  assert.equal(assets.retrieveKnowledge("domain",project.id,null,"unrelated.analyze").length,0);
  assert.equal(assets.retrieveKnowledge("domain",project.id,null,"domain.analyze").length,1);
 }finally{store.close();}
});
