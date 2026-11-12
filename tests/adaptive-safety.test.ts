import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { bootstrapAdaptiveAssets, standardAdaptivePlan } from "../packages/adaptive/bootstrap.js";
import { ExternalSkillService } from "../packages/external-skills/index.js";

test("shipped standard plan includes two observation barriers and mandatory code gates", () => {
  const store = new Store(":memory:");
  try {
    bootstrapAdaptiveAssets(store);
    bootstrapAdaptiveAssets(store); // idempotent, no duplicate versions
    const assets = new AssetService(store);
    assert.equal(assets.listCapabilities().filter((c)=>!c.tags.includes("platform-builder")).length, 11);
    assert.equal(assets.getCapability("core.capability.builder@1.0.0").status, "published");
    const task = new WorkService(store).createTask({
      title: "Add retry handling", objective: "Implement request retry handling",
      type: "development", acceptanceCriteria: ["All tests pass"],
    });
    const engine = new AdaptiveEngine(store, assets);
    const plan = engine.validate(standardAdaptivePlan(task), task.projectId, task.id);
    assert.equal(plan.nodes.length, 6);
    assert.equal(plan.observations.length, 2);
    assert.ok(plan.observations.every((o) => o.barrier));
  } finally { store.close(); }
});

test("advisory checkpoint does not prevent a ready downstream capability from executing", async () => {
  const store = new Store(":memory:");
  try {
    const assets = new AssetService(store);
    const p = assets.publishProfile(assets.createProfile({ name: "test.builtin", version: "1.0.0", executor: "builtin" }).id);
    const schema = { type: "object", additionalProperties: false, properties: { objective: { type: "string" } }, required: ["objective"] };
    const output = { type: "object", additionalProperties: false, properties: { summary: { type: "string" } }, required: ["summary"] };
    for (const name of ["test.analyze", "test.deliver"]) {
      const c = assets.createCapability({
        name, version: "1.0.0", title: name, description: name,
        inputSchema: schema, outputSchema: output, profileRef: p.id,
        tags: name.endsWith("deliver") ? ["deliver"] : [],
      });
      assets.validateCapability(c.id, "Known deterministic output"); assets.publishCapability(c.id);
    }
    const task = new WorkService(store).createTask({
      title: "Advisory test", objective: "Check order", type: "manual", acceptanceCriteria: ["Done"],
    });
    const plan = {
      nodes: [
        { id: "first", capabilityRef: "test.analyze@1.0.0", dependsOn: [], inputs: { objective: "Read" }, bindings: {} },
        { id: "last", capabilityRef: "test.deliver@1.0.0", dependsOn: ["first"], inputs: { objective: "Deliver" }, bindings: {} },
      ],
      observations: [{ id: "advice", afterNode: "first", on: ["succeeded" as const], barrier: false,
        question: "What can be learned?", maxInvocations: 1 }],
      rationale: "Advisory checkpoint should not block downstream",
    };
    const order: string[] = [];
    const engine = new AdaptiveEngine(store, assets, async ({ node }) => { order.push(node.id); return { output: { summary: "ok" } }; }, {
      compose: async () => plan,
      evaluate: async () => ({ decision: "CONTINUE", reason: "No blocker", affectedNodeIds: [], evidenceRefs: [] }),
    });
    const run = engine.createRun(task.id, plan);
    await engine.tick(); await engine.tick();
    assert.deepEqual(order, ["first", "last"]);
    assert.equal(engine.get(run.id).observationStates.advice, "pending");
    await engine.tick(); await engine.tick();
    assert.equal(engine.get(run.id).status, "awaiting_acceptance");
  } finally { store.close(); }
});

test("write failure becomes uncertain with ledger, never gets automatically retried", async () => {
  const store = new Store(":memory:");
  try {
    bootstrapAdaptiveAssets(store);
    const task = new WorkService(store).createTask({
      title: "Code modification", objective: "Change code", type: "development",
      acceptanceCriteria: ["Tests pass"],
    });
    const plan = standardAdaptivePlan(task);
    // Start with the code-writing stage while preserving test-review-deliver ancestry.
    const caps = ["core.implement", "core.test", "core.review", "core.deliver"];
    plan.nodes = plan.nodes.filter((n) => caps.some((name) => n.capabilityRef === name + "@1.0.0"))
      .map((n,i,list) => ({ ...n, dependsOn: i ? [list[i-1].id] : [] }));
    plan.observations = [];
    const engine = new AdaptiveEngine(store, new AssetService(store),
      async () => { throw Error("Code execution aborted after a possible write"); });
    const run = engine.createRun(task.id, plan);
    await engine.tick();
    const updated = engine.get(run.id);
    assert.equal(updated.status, "reconciling");
    assert.equal(updated.nodeStates.implement, "uncertain");
    const ledger = store.list<any>("adaptive_side_effect");
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].state, "uncertain");
    assert.throws(() => engine.retry(run.id, "implement"), /当前无法重试|未核对/);
    assert.throws(() => engine.cancel(run.id), /未确认停止/);
    assert.equal(engine.reconcileUncertain(run.id, "implement", true,
      "Inspected worktree and child process; no pending external actions").status, "failed");
    assert.equal(store.list<any>("adaptive_side_effect")[0].state, "reconciled");
  } finally { store.close(); }
});

test("Skill instructions stay frozen in the adaptive plan when source file changes", () => {
  const root = mkdtempSync(join(tmpdir(), "adaptive-skill-snapshot-"));
  const store = new Store(":memory:");
  try {
    const dir = join(root, "review");
    mkdirSync(dir);
    const file = join(dir, "SKILL.md");
    const skill = (content: string) => "---\nname: review\ndescription: Review changes\n---\n" + content;
    writeFileSync(file, skill("Original instructions"));
    const scanner = new ExternalSkillService(store);
    scanner.register({ path: root });
    const sourceId = scanner.skills()[0].id;
    const assets = new AssetService(store);
    const profile = assets.publishProfile(assets.createProfile({
      name: "skill.read", version: "1.0.0", executor: "agent", agent: "codex",
      workspaceMode: "read-only", skillIds: [sourceId],
    }).id);
    const outputSchema = { type: "object", properties: { summary: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } } }, required: ["summary", "evidence", "risks"], additionalProperties: false };
    const draft = assets.draftFromSkill(sourceId);
    assets.updateCandidate(draft.id, { profileRef: profile.id });
    assets.validateCapability(draft.id, "Input-output contract manually verified", {
      input: { objective: "Review code" }, output: { summary: "Reviewed", evidence: [], risks: [] },
    });
    assets.publishCapability(draft.id);
    const builtin = assets.publishProfile(assets.createProfile({
      name: "builtin.deliver", version: "1.0.0", executor: "builtin",
    }).id);
    const c = assets.createCapability({
      name: "skill.deliver", version: "1.0.0", title: "Deliver", description: "Delivery",
      inputSchema: { type:"object", properties:{ objective: { type:"string" } }, required:["objective"], additionalProperties:false },
      outputSchema, profileRef:builtin.id, tags:["deliver"],
    });
    assets.validateCapability(c.id, "Builtin output contract known"); assets.publishCapability(c.id);
    const task = new WorkService(store).createTask({
      title: "Review", objective: "Review code", acceptanceCriteria: ["Review completed"], type: "manual",
    });
    const engine = new AdaptiveEngine(store, assets);
    const plan = { nodes: [
      { id:"review", capabilityRef:draft.id, dependsOn:[], inputs:{ objective:"Review code" }, bindings:{} },
      { id:"deliver", capabilityRef:c.id, dependsOn:["review"], inputs:{ objective:"Deliver" }, bindings:{} },
    ], observations:[] };
    const run = engine.createRun(task.id, plan);
    assert.match(engine.get(run.id).snapshots.review.skillInstructions[0].content, /Original instructions/);
    writeFileSync(file, skill("Changed instructions"));
    assert.match(engine.get(run.id).snapshots.review.skillInstructions[0].content, /Original instructions/);
    assert.throws(() => engine.createRun(
      new WorkService(store).createTask({ title:"Another", objective:"Review", type:"manual", acceptanceCriteria:["Done"] }).id,
      plan,
    ), /已变化/);
  } finally { store.close(); rmSync(root, { recursive:true, force:true }); }
});

test("review with blocking risks cannot pass delivery gate", async () => {
  const store = new Store(":memory:");
  try {
    bootstrapAdaptiveAssets(store);
    const task = new WorkService(store).createTask({
      title: "Review blocked", objective: "Patch service", type: "development",
      acceptanceCriteria: ["Review clear"],
    });
    const plan = standardAdaptivePlan(task);
    plan.observations = [];
    const engine = new AdaptiveEngine(store, new AssetService(store),
      async ({ node }) => ({
        output: node.id === "review"
          ? { summary: "Blocking issue found", evidence: ["artifact://finding"], risks: ["Dangerous race condition"] }
          : { summary: "Step completed", evidence: [], risks: [] },
      }));
    const run = engine.createRun(task.id, plan);
    for (let i=0; i<7; i++) await engine.tick();
    const state = engine.get(run.id);
    assert.equal(state.nodeStates.review, "failed");
    assert.equal(state.nodeStates.deliver, "pending");
    assert.equal(state.status, "failed");
    assert.match(state.failures.review, /未解决的风险/);
  } finally { store.close(); }
});
