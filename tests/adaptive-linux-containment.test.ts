import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createLinuxCgroup, cgroupShellArgs } from "../packages/runtime/linux-cgroup.js";
import { execute } from "../packages/runtime/adapter.js";

test("cgroup pre-exec wrapper preserves arbitrary user args without shell interpolation", {
  skip: process.platform !== "linux",
}, () => {
  const dir=mkdtempSync(join(tmpdir(),"aiwork-cgroup-args-"));
  try {
    const inside=join(dir,"cgroup.procs"),unexpected=join(dir,"unexpected");
    writeFileSync(inside,"");
    const literal="literal; touch " + unexpected;
    const r=spawnSync("/bin/sh",cgroupShellArgs("/usr/bin/printf",["%s",literal]),{
      encoding:"utf8",env:{...process.env,AIWORK_CGROUP_PATH:dir},
    });
    assert.equal(r.status,0);
    assert.equal(r.stdout,literal);
    assert.equal(existsSync(unexpected),false);
    assert.match(readFileSync(inside,"utf8"),/^\d+$/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("cgroup opt-in rejects a fake or undelegated subtree rather than silently executing",{
  skip: process.platform !== "linux",
},async()=>{
 const dir=mkdtempSync(join(tmpdir(),"aiwork-undel-"));
 try {
  assert.throws(()=>createLinuxCgroup({parent:dir}),/not delegated/);
  await assert.rejects(execute("/usr/bin/printf",["hello"],dir,Date.now()+5000,()=>{},
    {cgroup:{parent:dir,memoryMaxBytes:256*1024*1024,pidsMax:20}}),/not delegated/);
  assert.throws(()=>createLinuxCgroup({parent:dir,memoryMaxBytes:0}),/not delegated|Invalid/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
