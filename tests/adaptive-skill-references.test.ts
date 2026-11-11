import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/persistence/index.js";
import { ExternalSkillService } from "../packages/external-skills/index.js";

function fixture() {
  const root=mkdtempSync(join(tmpdir(),"aiwork-skill-refs-"));
  const dir=join(root,"review");
  mkdirSync(dir);
  mkdirSync(join(dir,"references"));
  mkdirSync(join(dir,"scripts"));
  writeFileSync(join(dir,"SKILL.md"),
    "---\nname: review\ndescription: Code review instructions\n---\nRead reference files");
  const store=new Store(":memory:");
  const service=new ExternalSkillService(store);
  service.register({path:root});
  return {root,dir,store,service,id:service.skills()[0].id};
}
test("text reference files are captured with immutable content/digest and scripts are not loaded",()=>{
 const {root,dir,store,service,id}=fixture();
 try{
  writeFileSync(join(dir,"references","guide.md"),"# Test checklist\nNo credentials");
  writeFileSync(join(dir,"scripts","dangerous.sh"),"rm -rf /tmp/example");
  const original=service.snapshot([id])[0];
  assert.equal(original.referenceFiles.length,1);
  assert.equal(original.referenceFiles[0].relativePath,"references/guide.md");
  assert.match(original.referenceFiles[0].content,/Test checklist/);
  assert.doesNotMatch(JSON.stringify(original),/rm -rf/);
  writeFileSync(join(dir,"references","guide.md"),"# Changed checklist");
  const updated=service.snapshot([id])[0];
  assert.match(original.referenceFiles[0].content,/Test checklist/);
  assert.match(updated.referenceFiles[0].content,/Changed checklist/);
  assert.notEqual(original.referenceFiles[0].digest,updated.referenceFiles[0].digest);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test("symbolic reference file is ignored; overly large references fail closed",()=>{
 const {root,dir,store,service,id}=fixture();
 try{
  const outside=join(root,"private.txt");
  writeFileSync(outside,"do not read");
  symlinkSync(outside,join(dir,"references","private.txt"));
  assert.equal(service.snapshot([id])[0].referenceFiles.length,0);
  writeFileSync(join(dir,"references","large.md"),"x".repeat(20*1024));
  assert.throws(()=>service.snapshot([id]),/参考文件尺寸/);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
