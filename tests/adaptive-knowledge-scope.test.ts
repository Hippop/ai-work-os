import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";

test("task Knowledge can only be created and retrieved within its actual project", () => {
  const store=new Store(":memory:");
  try{
    const work=new WorkService(store),assets=new AssetService(store);
    const projectA=work.createProject({
      name:"Knowledge scope project A",repositoryPath:process.cwd(),allowAgent:false,
    });
    const projectB=work.createProject({
      name:"Knowledge scope project B",repositoryPath:process.cwd(),allowAgent:false,
    });
    const task=work.createTask({
      title:"Scoped task",type:"manual",objective:"Review knowledge scope",
      projectId:projectA.id,acceptanceCriteria:["No cross-project leakage"],
    });
    const entry={
      name:"scope.private",version:"1.0.0",title:"Task project knowledge",
      content:"Project A confidential architectural detail",source:"User authored",
      scope:"task" as const,taskId:task.id,
    };
    assert.throws(()=>assets.createKnowledge({...entry,projectId:projectB.id}),
      /任务知识项目范围必须与任务所属项目一致/);
    assert.throws(()=>assets.createKnowledge({...entry,projectId:null}),
      /任务知识项目范围必须与任务所属项目一致/);
    const added=assets.createKnowledge({...entry,projectId:projectA.id});
    assets.publishKnowledge(added.id);
    assert.throws(()=>assets.retrieveKnowledge("confidential",projectB.id,task.id,"core.analyze"),
      /任务与查询项目范围不一致/);
    assert.throws(()=>assets.retrieveKnowledge("confidential",null,task.id,"core.analyze"),
      /任务与查询项目范围不一致/);
    assert.equal(assets.retrieveKnowledge("confidential",projectB.id,null,"core.analyze").length,0);
    assert.equal(assets.retrieveKnowledge("confidential",projectA.id,task.id,"core.analyze").length,1);
  }finally{store.close();}
});
test("Knowledge retrieval refuses truncating more than twenty mandatory knowledge bindings", () => {
  const store=new Store(":memory:");
  try{
    const assets=new AssetService(store);
    for(let i=0;i<21;i++){
      const entry=assets.createKnowledge({
        name:"required.knowledge"+i,version:"1.0.0",title:"Required knowledge "+i,
        content:"For task acceptance criteria "+i,scope:"global",source:"User",
      });
      assets.publishKnowledge(entry.id);
      assets.bindKnowledge({knowledgeRef:entry.id,capabilityName:"core.analyze",mode:"required"});
    }
    assert.throws(()=>assets.retrieveKnowledge("acceptance",null,null,"core.analyze"),
      /必需知识超过运行上下文上限/);
    assert.ok(store.events("knowledge:search").every((e)=>e.type!=="knowledge.retrieved"));
  }finally{store.close();}
});
test("knowledge with task id outside task scope is rejected",()=>{
  const store=new Store(":memory:");
  try{
    const task=new WorkService(store).createTask({
      title:"Task",type:"manual",objective:"Limit scope",acceptanceCriteria:["No leak"],
    });
    const assets=new AssetService(store);
    assert.throws(()=>assets.createKnowledge({
      name:"scope.invalid",version:"1.0.0",title:"Invalid global task knowledge",
      scope:"global",taskId:task.id,source:"User",content:"Invalid",
    }),/只有任务作用域知识可以指定任务 ID/);
  }finally{store.close();}
});
