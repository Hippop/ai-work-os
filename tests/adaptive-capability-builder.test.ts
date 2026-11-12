import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";
import { CapabilityBuilder, type BuilderAgent, type BuilderProposal,
  BUILDER_SKILL_ID, builderSkillVersion } from "../packages/adaptive/builder.js";
import { ExternalSkillService } from "../packages/external-skills/index.js";
import { createApp } from "../apps/server/app.js";
import type { AdaptiveRuntime } from "../packages/adaptive/runtime.js";

const proposal:BuilderProposal={
  name:"diagnostic.gc",title:"GC log review",description:"Analyze Java GC evidence",
  operatingInstructions:"Read only the supplied log samples and report anomalies with concrete line evidence.",
  inputSchema:{type:"object",properties:{log:{type:"string"}},required:["log"],additionalProperties:false},
  outputSchema:{type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false},
  tags:["analysis","java"],
  suggestedSideEffect:"external-write",suggestedExecutor:"agent",
  sampleInput:{log:"pause 50ms"},sampleOutput:{summary:"One pause recorded"},
  questions:["What is the JVM version?"],rationale:"One observable diagnostic task without mutations.",
};
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"aiwork-builder-"));
  const repo=join(root,"repo");
  mkdirSync(repo);mkdirSync(join(repo,"docs"));
  const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8",stdio:"pipe"});
  git("init","-q");git("config","user.name","Builder test");
  git("config","user.email","builder@example.invalid");
  writeFileSync(join(repo,"README.md"),"Test project");
  writeFileSync(join(repo,"docs","guide.md"),"GC pause means a stop-the-world event");
  git("add",".");git("commit","-qm","initial");
  const store=new Store(":memory:");
  bootstrapAdaptiveAssets(store);
  const work=new WorkService(store);
  const project=work.createProject({
    name:"Capability Builder Test",repositoryPath:repo,allowAgent:true,
  });
  const skillsDir=join(root,"skills"),skillDir=join(skillsDir,"gc-review");
  mkdirSync(skillsDir);mkdirSync(skillDir);
  writeFileSync(join(skillDir,"SKILL.md"),
    "---\nname: gc-review\ndescription: Review GC event logs\n---\nRead logs but never modify them");
  const skillService=new ExternalSkillService(store);
  skillService.register({path:skillsDir});
  const skillId=skillService.skills()[0].id;
  const assets=new AssetService(store);
  const knowledge=assets.createKnowledge({
    name:"java.gc.guidance",version:"1.0.0",title:"GC diagnosis",
    content:"Capture timestamps and pauses",source:"internal memo",
    scope:"project",projectId:project.id,
  });
  assets.publishKnowledge(knowledge.id);
  const prompts:string[]=[];
  const agent:BuilderAgent=async(args)=>{
    prompts.push(args.prompt);
    assert.equal(args.backend,"opencode");
    assert.equal(args.profileRef,"core.builder.opencode@1.0.0");
    return prompts.length>1 ? {...proposal,description:"Refined log analysis after conversation"} : proposal;
  };
  const builder=new CapabilityBuilder(store,agent);
  return {root,repo,store,project,skillId,knowledge,assets,builder,prompts,agent};
}
test("platform bootstraps immutable Builder skill, catalog entry and separate Codex/OpenCode read-only profiles",()=>{
  const store=new Store(":memory:");
  try {
    bootstrapAdaptiveAssets(store);bootstrapAdaptiveAssets(store);
    const assets=new AssetService(store);
    assert.equal(assets.getCapability(BUILDER_SKILL_ID).status,"published");
    assert.equal(assets.getProfile("core.builder.codex@1.0.0").agent,"codex");
    assert.equal(assets.getProfile("core.builder.opencode@1.0.0").agent,"opencode");
    assert.equal(assets.getProfile("core.builder.codex@1.0.0").workspaceMode,"read-only");
    assert.equal(store.list("adaptive_builder_skill").length,1);
    assert.equal((store.get<{digest:string}>("adaptive_builder_skill",BUILDER_SKILL_ID))?.digest,
      builderSkillVersion().digest);
  }finally{store.close();}
});
test("Builder snapshots text, project source, Skill and knowledge; revisions never grant proposed write effects",async()=>{
  const ctx=fixture();
  try {
    const created=await ctx.builder.create({
      projectId:ctx.project.id,backend:"opencode",
      goal:"Build a read-only atomic operation to inspect Java GC pauses",
      materials:[
        {kind:"inline",name:"operator-notes",text:"We use Eclipse OpenJ9"},
        {kind:"project-file",path:"docs/guide.md"},
        {kind:"skill",id:ctx.skillId},
        {kind:"knowledge",id:ctx.knowledge.id},
      ],
    });
    assert.equal(created.capability.status,"candidate");
    assert.equal(created.capability.sideEffect,"read");
    assert.equal(created.capability.profileRef,null);
    assert.equal(created.proposal.suggestedSideEffect,"external-write");
    assert.equal(created.materials.length,4);
    assert.equal(ctx.prompts.length,1);
    assert.match(ctx.prompts[0],/Eclipse OpenJ9/);
    assert.match(ctx.prompts[0],/Capture timestamps and pauses/);
    assert.match(ctx.prompts[0],/Read logs but never modify them/);
    assert.match(created.capability.operatingInstructions??"",/Read only/);
    const original=ctx.builder.get(created.sessionId);
    const before=original.materialDigest;
    writeFileSync(join(ctx.repo,"docs","guide.md"),"Changed on disk after snapshot");
    const edited=await ctx.builder.revise(created.sessionId,{
      instruction:"Include pause timestamps and mention OpenJ9 memory settings",
    });
    assert.equal(edited.revision.number,2);
    assert.equal(edited.capability.description,"Refined log analysis after conversation");
    assert.equal(edited.capability.sideEffect,"read");
    assert.equal(ctx.builder.get(created.sessionId).materialDigest,before);
    assert.match(ctx.prompts[1],/GC pause means a stop-the-world event/);
    assert.doesNotMatch(ctx.prompts[1],/Changed on disk/);
    assert.ok(!Object.hasOwn(ctx.builder.sessions()[0].materials[0],"content"));
    assert.equal(ctx.store.events("builder:"+created.sessionId).length,2);
    ctx.assets.validateCapability(edited.capability.id,"Human inspected the generated sample");
    await assert.rejects(()=>ctx.builder.revise(created.sessionId,{instruction:"Change everything"}),
      /已验证或发布的能力不能由 Builder 覆写/);
  }finally{ctx.store.close();rmSync(ctx.root,{recursive:true,force:true});}
});
test("Builder refuses traversal, symlinks, secrets and unauthorized knowledge or projects",async()=>{
  const ctx=fixture();
  try{
    const base={projectId:ctx.project.id,backend:"opencode" as const,
      goal:"Analyze these Java memory diagnostics without modifying any files"};
    await assert.rejects(()=>ctx.builder.create({...base,materials:[
      {kind:"project-file",path:"../secret.txt"}]}),/路径不在可读取范围/);
    writeFileSync(join(ctx.repo,".env"),"PRIVATE_TOKEN=x");
    await assert.rejects(()=>ctx.builder.create({...base,materials:[
      {kind:"project-file",path:".env"}]}),/路径不在可读取范围/);
    symlinkSync(join(ctx.repo,"docs","guide.md"),join(ctx.repo,"docs","link.md"));
    await assert.rejects(()=>ctx.builder.create({...base,materials:[
      {kind:"project-file",path:"docs/link.md"}]}),/不能包含符号链接/);
    const other=new WorkService(ctx.store).createProject({
      name:"Other knowledge project",repositoryPath:ctx.repo,allowAgent:true,
    });
    await assert.rejects(()=>ctx.builder.create({
      ...base,projectId:other.id,materials:[{kind:"knowledge",id:ctx.knowledge.id}],
    }),/知识未发布或不可用于该项目/);
    const forbidden=new WorkService(ctx.store).createProject({
      name:"No Agent authorized",repositoryPath:ctx.repo,allowAgent:false,
    });
    await assert.rejects(()=>ctx.builder.create({...base,projectId:forbidden.id}),
      /项目不存在或未授权/);
    assert.equal(ctx.prompts.length,0);
  }finally{ctx.store.close();rmSync(ctx.root,{recursive:true,force:true});}
});
test("API Builder sessions require token, preserve draft status and check only schema, not real execution",async()=>{
  const ctx=fixture();
  try{
    const fakeRuntime={builderAgent:()=>ctx.agent} as unknown as AdaptiveRuntime;
    const app=createApp(ctx.store,"test-token",undefined,undefined,undefined,fakeRuntime);
    await request(app).get("/api/v2/capability-builder").expect(401);
    const init=(await request(app).get("/api/v2/capability-builder")
      .set("Authorization","Bearer test-token").expect(200)).body;
    assert.equal(init.skill.id,BUILDER_SKILL_ID);
    const response=(await request(app).post("/api/v2/capability-builder/sessions")
      .set("Authorization","Bearer test-token")
      .send({
        projectId:ctx.project.id,backend:"opencode",
        goal:"Build a GC analysis capability from a referenced design guide",
        materials:[{kind:"project-file",path:"docs/guide.md"}],
      }).expect(201)).body;
    assert.equal(response.capability.status,"candidate");
    assert.equal(response.capability.sideEffect,"read");
    const check=(await request(app).post("/api/v2/capability-builder/sessions/"+response.sessionId+"/check-sample")
      .set("Authorization","Bearer test-token").send({}).expect(200)).body;
    assert.equal(check.passed,true);
    assert.equal(check.actualExecution,false);
    const retrieved=(await request(app).get("/api/v2/capability-builder/sessions/"+response.sessionId)
      .set("Authorization","Bearer test-token").expect(200)).body;
    assert.equal(retrieved.materials[0].content,undefined);
    const updated=(await request(app).post("/api/v2/capability-builder/sessions/"+response.sessionId+"/revise")
      .set("Authorization","Bearer test-token")
      .send({instruction:"Include pause timestamps in the description"}).expect(200)).body;
    assert.equal(updated.revision.number,2);
    assert.equal(ctx.assets.getCapability(response.capability.id,false).status,"candidate");
  }finally{ctx.store.close();rmSync(ctx.root,{recursive:true,force:true});}
});
