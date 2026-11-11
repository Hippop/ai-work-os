import type { Task } from "../domain/index.js";
import { Store } from "../persistence/index.js";
import { AssetService, type Capability, type Profile } from "./assets.js";
import type { Plan } from "./engine.js";

const objectiveInput = {
  type: "object", additionalProperties: false, required: ["objective"],
  properties: { objective: { type: "string" } },
};
const resultOutput = {
  type: "object", additionalProperties: false, required: ["summary", "evidence", "risks"],
  properties: {
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
};
/**
 * Idempotently installs platform-owned, versioned atomic capability definitions.
 * Never changes previously published definitions. Operator-provided candidates
 * remain separate versioned resources.
 */
export function bootstrapAdaptiveAssets(store: Store) {
  const assets = new AssetService(store);
  const profiles: { name: string; executor: Profile["executor"]; workspaceMode: Profile["workspaceMode"]; agent?: string }[] = [
    { name: "core.codex.read", executor: "agent", agent: "codex", workspaceMode: "read-only" },
    { name: "core.codex.write", executor: "agent", agent: "codex", workspaceMode: "worktree-write" },
    { name: "core.project.test", executor: "project-test", workspaceMode: "read-only" },
    { name: "core.builtin.deliver", executor: "builtin", workspaceMode: "none" },
  ];
  for (const p of profiles) {
    const id = p.name + "@1.0.0";
    if (!store.get("adaptive_profile", id)) {
      const profile = assets.createProfile({ ...p, version: "1.0.0" });
      assets.publishProfile(profile.id);
    }
  }
  const caps: {
    name: string; description: string; tags: string[]; profile: string;
    sideEffect?: Capability["sideEffect"];
  }[] = [
    { name: "core.analyze", description: "Analyze user requirements and constraints with evidence", tags: ["analyze"], profile: "core.codex.read@1.0.0" },
    { name: "core.design", description: "Design a technically justified solution", tags: ["design"], profile: "core.codex.read@1.0.0" },
    { name: "core.implement", description: "Implement changes in an isolated project worktree", tags: ["implement"], profile: "core.codex.write@1.0.0", sideEffect: "workspace-write" },
    { name: "core.test", description: "Run project-approved tests and return reproducible evidence", tags: ["test"], profile: "core.project.test@1.0.0" },
    { name: "core.review", description: "Review code and verification evidence for blocking risks", tags: ["review"], profile: "core.codex.read@1.0.0" },
    { name: "core.collect", description: "Collect diagnostic evidence without modifying code", tags: ["diagnosis"], profile: "core.codex.read@1.0.0" },
    { name: "core.hypothesize", description: "Form diagnostic hypotheses supported by evidence", tags: ["diagnosis"], profile: "core.codex.read@1.0.0" },
    { name: "core.verify", description: "Reason about tests and counterevidence without inventing experiments", tags: ["diagnosis"], profile: "core.codex.read@1.0.0" },
    { name: "core.conclude", description: "Summarize verified versus unresolved causes", tags: ["diagnosis"], profile: "core.codex.read@1.0.0" },
    { name: "core.deliver", description: "Produce final delivery for human acceptance", tags: ["deliver"], profile: "core.builtin.deliver@1.0.0", sideEffect: "none" },
  ];
  for (const c of caps) {
    const id = c.name + "@1.0.0";
    if (!store.get("adaptive_capability", id)) {
      const cap = assets.createCapability({
        name: c.name, title: c.name, version: "1.0.0",
        description: c.description, tags: c.tags, sideEffect: c.sideEffect ?? "read",
        inputSchema: objectiveInput, outputSchema: resultOutput, profileRef: c.profile,
      });
      assets.validateCapability(cap.id, "Platform-maintained core capability contract; regression tested in CI");
      assets.publishCapability(cap.id);
    }
  }
}

/** Clearly labeled deterministic template, never misrepresented as AI composition. */
export function standardAdaptivePlan(task: Task): Plan {
  const diagnosis = task.type === "diagnosis";
  const operations = diagnosis
    ? ["collect", "hypothesize", "verify", "conclude", "deliver"]
    : ["analyze", "design", "implement", "test", "review", "deliver"];
  const nodes: Plan["nodes"] = operations.map((operation, i) => ({
    id: operation,
    capabilityRef: "core." + operation + "@1.0.0",
    dependsOn: i ? [operations[i-1]] : [],
    inputs: { objective: task.objective },
    bindings: {},
  }));
  const observations: Plan["observations"] = (diagnosis
    ? [{ id: "after-hypotheses", afterNode: "hypothesize", question: "Do the available observations support the proposed diagnostic direction?" },
       { id: "after-verification", afterNode: "verify", question: "Is the evidence sufficient to conclude the cause?" }]
    : [{ id: "after-design", afterNode: "design", question: "Is the solution feasible and aligned with acceptance criteria?" },
       { id: "after-test", afterNode: "test", question: "Do the test outcomes and new evidence justify changing the remaining plan?" }])
      .map((o) => ({ ...o, on: ["succeeded", "failed"] as ("succeeded" | "failed")[],
        barrier: true, maxInvocations: 1 }));
  return { nodes, observations, rationale: "Deterministic platform default; review and verify before execution" };
}
