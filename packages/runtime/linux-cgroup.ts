import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Requires a cgroup v2 subtree delegated to the service account. This module
 * does NOT create/delegate privileges. The executable is moved into the cgroup
 * by a wrapper BEFORE exec() to prevent the parent-spawn race.
 */
export type CgroupLimits = {
  parent: string;
  memoryMaxBytes?: number;
  pidsMax?: number;
};
export type ManagedCgroup = {
  path: string;
  populated: () => boolean;
  kill: () => void;
  cleanup: () => void;
};
export function createLinuxCgroup(limits: CgroupLimits): ManagedCgroup {
  if (process.platform !== "linux")
    throw new Error("Cgroup v2 containment requires Linux");
  const parent = realpathSync(limits.parent);
  if (!existsSync(join(parent, "cgroup.controllers")))
    throw new Error("cgroup v2 subtree is not delegated or accessible");
  if (limits.memoryMaxBytes !== undefined &&
      (!Number.isSafeInteger(limits.memoryMaxBytes) || limits.memoryMaxBytes < 64 * 1024 * 1024))
    throw new Error("Invalid cgroup memory limit");
  if (limits.pidsMax !== undefined &&
      (!Number.isSafeInteger(limits.pidsMax) || limits.pidsMax < 2))
    throw new Error("Invalid cgroup process limit");
  const folder = join(parent, "aiwork-" + randomUUID());
  mkdirSync(folder,{mode:0o700});
  try {
    if (limits.memoryMaxBytes !== undefined)
      writeFileSync(join(folder,"memory.max"),String(limits.memoryMaxBytes));
    if (limits.pidsMax !== undefined)
      writeFileSync(join(folder,"pids.max"),String(limits.pidsMax));
    // Test existence of the atomic kill interface before accepting a job.
    if (!existsSync(join(folder,"cgroup.kill")) || !existsSync(join(folder,"cgroup.procs")))
      throw new Error("Delegated cgroup lacks kill and process attachment support");
  } catch(error) {
    try { rmdirSync(folder); } catch {}
    throw error;
  }
  const populated=()=>{
    if (!existsSync(folder)) return false;
    const match=readFileSync(join(folder,"cgroup.events"),"utf8").match(/^populated\s+([01])$/m);
    if (!match) throw new Error("cgroup.events does not expose a populated state");
    return match[1]==="1";
  };
  return {
    path:folder,populated,
    kill() { if (existsSync(folder)) writeFileSync(join(folder,"cgroup.kill"),"1"); },
    cleanup() {
      if (!existsSync(folder)) return;
      if (populated()) throw new Error("Cgroup still contains live processes");
      rmdirSync(folder);
    },
  };
}
export function cgroupShellArgs(command:string,args:string[]) {
  // No shell interpolation of any untrusted command/arguments.
  return ["-c",
    'printf "%s" "$$" > "$AIWORK_CGROUP_PATH/cgroup.procs" || exit 97; exec "$@"',
    "aiwork-cgroup", command, ...args];
}
