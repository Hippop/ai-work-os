import type { Plan } from "./engine.js";
export type AgentBackend = "codex" | "opencode";
/** Explicit user-selected backend for platform core Agent nodes only.
 * Project-specific capabilities retain their individually published profiles. */
export function selectCoreAgent(plan:Plan,agent:AgentBackend):Plan {
  const read=new Set(["analyze","design","review","collect","hypothesize","verify","conclude"]);
  return {
    ...plan,
    nodes:plan.nodes.map((node)=>{
      const match=/^core\.([a-z]+)@1\.0\.0$/.exec(node.capabilityRef);
      if(!match)return node;
      const operation=match[1];
      const profile=operation==="implement" ? "core."+agent+".write@1.0.0" :
        read.has(operation) ? "core."+agent+".read@1.0.0" : null;
      return profile ? {...node,profileRef:profile}:node;
    }),
  };
}
