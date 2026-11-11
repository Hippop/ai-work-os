import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { createApp } from "../apps/server/app.js";
import { ExternalSkillService } from "../packages/external-skills/index.js";
import { AssetService, checkSchema } from "../packages/adaptive/assets.js";
import { AdaptiveEngine, type Plan } from "../packages/adaptive/engine.js";

const inputSchema = {
  type: "object", additionalProperties: false,
  properties: { objective: { type: "string" } }, required: ["objective"],
};
const outputSchema = {
  type: "object", additionalProperties: false,
  properties: { summary: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } } },
  required: ["summary", "evidence", "risks"],
};
function fixture() {
  const store = new Store(":memory:");
  const assets = new AssetService(store);
  const profile = assets.publishProfile(assets.createProfile({
    name: "builtin.review", version: "1.0.0", executor: "builtin", workspaceMode: "none",
  }).id);
  function cap(name: string, tags: string[], profileRef = profile.id, sideEffect = "none" as "none" | "read" | "workspace-write") {
    const c = assets.createCapability({
      name, version: "1.0.0", title: name, description: "Executable " + name,
      inputSchema, outputSchema, tags, sideEffect, profileRef,
    });
    assets.validateCapability(c.id, "Contract manually checked against sample output and inputs");
    return assets.publishCapability(c.id);
  }
  cap("core.analyze", []); cap("core.deliver", ["deliver"]);
  const work = new WorkService(store);
  const task = work.createTask({
    title: "Adaptive job", objective: "Analyze Java memory and deliver an evidence-backed result",
    type: "manual", acceptanceCriteria: ["Output validated"],
  });
  const plan: Plan = {
    nodes: [
      { id: "analyze", capabilityRef: "core.analyze@1.0.0", dependsOn: [], inputs: { objective: "Check memory" }, bindings: {} },
      { id: "deliver", capabilityRef: "core.deliver@1.0.0", dependsOn: ["analyze"], inputs: { objective: "Deliver evidence" }, bindings: {} },
    ],
    observations: [{ id: "check", afterNode: "analyze", on: ["succeeded"], question: "Is further analysis needed?", barrier: true, maxInvocations: 1 }],
    rationale: "Observe after first evidence",
  };
  return { store, assets, profile, cap, task, plan };
}
const ok = { summary: "Evidence sufficient", evidence: ["artifact://log"], risks: [] };

test("strict supported JSON Schema validates nested values and refuses unsupported keywords", () => {
  checkSchema(outputSchema, ok);
  assert.throws(() => checkSchema(outputSchema, { summary: "x", evidence: ["yes"], risks: [], extra: true }), /未声明字段/);
  assert.throws(() => checkSchema(outputSchema, { summary: "x", evidence: "not an array", risks: [] }), /类型不匹配/);
  assert.throws(() => checkSchema({ type: "object", $ref: "https://evil" }), /不支持/);
});

test("Capability versions immutable; Profile and evidence validation gates protect publication", () => {
  const { store, assets, profile } = fixture();
  try {
    assert.throws(() => assets.createProfile({ name: "builtin.review", version: "1.0.0", executor: "builtin" }), /版本已存在/);
    const candidate = assets.createCapability({
      name: "cap.new", version: "1.0.0", title: "New", description: "Test",
      inputSchema, outputSchema, profileRef: profile.id,
    });
    assert.throws(() => assets.publishCapability(candidate.id), /必须先验证/);
    assets.validateCapability(candidate.id, "Human verified input-output contract");
    assert.equal(assets.publishCapability(candidate.id).status, "published");
    assert.ok(store.events("asset:capability:" + candidate.id).some((e) => e.type === "capability.published"));
  } finally { store.close(); }
});

test("Knowledge Hub user creation, scope isolation, required bindings and revocation", () => {
  const { store, assets } = fixture();
  try {
    const projectId = WorkService.prototype.createProject; // project lookup checked by Knowledge Hub
    void projectId;
    const k = assets.createKnowledge({
      name: "jvm.oom", version: "1.0.0", title: "JVM memory policy",
      content: "For JVM OOM, check cgroup, native memory and GC logs.",
      scope: "global", source: "User-authored troubleshooting manual",
      capabilityNames: ["core.analyze"],
    });
    assert.equal(assets.retrieveKnowledge("jvm", null, null, "core.analyze").length, 0);
    assets.publishKnowledge(k.id);
    const b = assets.bindKnowledge({ capabilityName: "core.analyze", knowledgeRef: k.id, mode: "required" });
    assert.equal(b.mode, "required");
    assert.equal(assets.retrieveKnowledge("gc", null, null, "core.analyze").length, 1);
    assert.equal(assets.retrieveKnowledge("gc", null, null, "core.deliver").length, 0);
    assets.revokeKnowledge(k.id);
    assert.throws(() => assets.retrieveKnowledge("gc", null, null, "core.analyze"), /必需知识不可访问/);
  } finally { store.close(); }
});

test("DAG validates terminal delivery and dependencies, checkpoint fired and barriers respected", async () => {
  const { store, assets, task, plan } = fixture();
  try {
    let observations = 0, executed: string[] = [];
    const engine = new AdaptiveEngine(store, assets,
      async ({ node }) => { executed.push(node.id); return { output: ok }; },
      {
        compose: async () => plan,
        evaluate: async () => { observations++; return { decision: "CONTINUE", reason: "Verified required evidence", affectedNodeIds: [], evidenceRefs: [] }; },
      });
    const run = engine.createRun(task.id, plan);
    await engine.tick(); // analyze
    assert.equal(engine.get(run.id).nodeStates.analyze, "succeeded");
    assert.equal(engine.get(run.id).observationStates.check, "pending");
    assert.deepEqual(executed, ["analyze"]);
    await engine.tick(); // observe barrier
    assert.equal(observations, 1);
    assert.deepEqual(executed, ["analyze"]);
    await engine.tick(); // deliver
    await engine.tick(); // delivery accepted boundary
    assert.deepEqual(executed, ["analyze", "deliver"]);
    assert.equal(engine.get(run.id).status, "awaiting_acceptance");
    engine.accept(run.id, true, "Evidence checked");
    assert.equal(engine.get(run.id).status, "done");
    assert.ok(store.events(run.id).some((ev) => ev.type === "adaptive.observation.decided"));
    const invalid = structuredClone(plan);
    invalid.nodes[1].dependsOn = [];
    assert.throws(() => engine.validate(invalid, null, task.id), /交付/);
  } finally { store.close(); }
});

test("successful checkpoint can trigger controlled replanning while retaining immutable completed result", async () => {
  const { store, assets, task, plan } = fixture();
  try {
    let changed = false;
    const engine = new AdaptiveEngine(store, assets, async () => ({ output: ok }), {
      compose: async (_task, _catalog, _knowledge, previous) => {
        if (previous) {
          changed = true;
          return { ...plan, nodes: [
            plan.nodes[0],
            { id: "extra", capabilityRef: "core.analyze@1.0.0", dependsOn: ["analyze"],
              inputs: { objective: "More verification" }, bindings: {} },
            { ...plan.nodes[1], dependsOn: ["extra"] },
          ], observations: [] };
        }
        return plan;
      },
      evaluate: async () => ({ decision: "REPLAN", reason: "Need extra evidence", affectedNodeIds: ["deliver"], evidenceRefs: ["artifact://log"] }),
    });
    const run = engine.createRun(task.id, plan);
    await engine.tick();
    const first = engine.get(run.id).results.analyze;
    await engine.tick();
    assert.equal(changed, true);
    assert.equal(engine.get(run.id).planRevision, 2);
    assert.equal(engine.get(run.id).nodeStates.analyze, "succeeded");
    assert.equal(engine.get(run.id).results.analyze.digest, first.digest);
    assert.ok(store.events(run.id).some((ev) => ev.type === "adaptive.plan.revised"));
    await engine.tick();
    await engine.tick();
    await engine.tick();
    assert.equal(engine.get(run.id).status, "awaiting_acceptance");
  } finally { store.close(); }
});

test("checkpoint failures trigger evaluation; without a planner the run blocks rather than continuing", async () => {
  const { store, assets, task, plan } = fixture();
  try {
    const bad = structuredClone(plan);
    bad.observations[0].on = ["failed"];
    const engine = new AdaptiveEngine(store, assets, async () => { throw Error("test failed"); });
    const run = engine.createRun(task.id, bad);
    await engine.tick(); await engine.tick();
    assert.equal(engine.get(run.id).nodeStates.analyze, "failed");
    assert.equal(engine.get(run.id).observationStates.check, "waiting");
    assert.equal(engine.get(run.id).status, "waiting");
    assert.ok(store.events(run.id).some((e) => e.type === "adaptive.observation.blocked"));
  } finally { store.close(); }
});

test("manual executor waits for user input, validates result then resumes", async () => {
  const { store, assets, task, plan } = fixture();
  try {
    const profile = assets.publishProfile(assets.createProfile({
      name: "human.approval", version: "1.0.0", executor: "manual", workspaceMode: "none",
    }).id);
    const cap = assets.createCapability({
      name: "human.review", version: "1.0.0", title: "Human review", description: "Human evidence",
      inputSchema, outputSchema, profileRef: profile.id,
    });
    assets.validateCapability(cap.id, "User will provide schema-conformant output");
    assets.publishCapability(cap.id);
    plan.nodes[0].capabilityRef = cap.id;
    plan.observations = [];
    const engine = new AdaptiveEngine(store, assets);
    const run = engine.createRun(task.id, plan);
    await engine.tick();
    assert.equal(engine.get(run.id).status, "waiting");
    assert.throws(() => engine.completeManual(run.id, "analyze", {bad:true}), /必填|未声明/);
    engine.completeManual(run.id, "analyze", ok);
    assert.equal(engine.get(run.id).status, "running");
  } finally { store.close(); }
});

test("recovery never silently replays in-progress invocation; explicit reconciliation required", () => {
  const { store, assets, task, plan } = fixture();
  try {
    const engine = new AdaptiveEngine(store, assets);
    const run = engine.createRun(task.id, plan);
    const stale = engine.get(run.id);
    stale.nodeStates.analyze = "running";
    stale.status = "running";
    store.put("adaptive_run", stale);
    engine.recover();
    assert.equal(engine.get(run.id).status, "reconciling");
    assert.equal(engine.get(run.id).nodeStates.analyze, "uncertain");
    assert.throws(() => engine.reconcileUncertain(run.id, "analyze", false, ""), /人工确认/);
    assert.equal(engine.reconcileUncertain(run.id, "analyze", true, "Inspected child process and remote effects").status, "waiting");
  } finally { store.close(); }
});

test("skill references generate candidate abilities without claiming model verification", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiwork-v2-skills-"));
  const store = new Store(":memory:");
  try {
    const skillDir = join(dir, "java-oom-analysis");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"),
      "---\nname: java-oom-analysis\ndescription: JVM memory troubleshooting and analysis\n---\nInspect memory evidence");
    const links = new ExternalSkillService(store);
    links.register({ path: dir });
    const draft = new AssetService(store).draftFromSkill(links.skills()[0].id);
    assert.equal(draft.status, "candidate");
    assert.equal(draft.sourceSkillId, links.skills()[0].id);
    assert.match(draft.name, /skill.java.oom.analysis/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("V2 endpoints are authenticated, knowledge API creates and publishes, manual workflow validates", async () => {
  const { store, task, plan, assets } = fixture();
  try {
    const engine = new AdaptiveEngine(store, assets);
    const app = createApp(store, "local-token", undefined, undefined, engine);
    const auth = { Authorization: "Bearer local-token" };
    await request(app).get("/api/v2/capabilities").expect(401);
    const listing = await request(app).get("/api/v2/capabilities").set(auth).expect(200);
    assert.equal(listing.body.length, 2);
    const validated = await request(app).post("/api/v2/workflows/validate").set(auth)
      .send({ projectId: null, taskId: task.id, plan }).expect(200);
    assert.equal(validated.body.plan.nodes.length, 2);
    const k = (await request(app).post("/api/v2/knowledge").set(auth).send({
      name: "java.team", version: "1.0.0", title: "Java knowledge",
      content: "Check native memory", source: "User", scope: "global",
    }).expect(201)).body;
    await request(app).post("/api/v2/knowledge/" + k.id + "/publish").set(auth).send({}).expect(200);
    const run = (await request(app).post("/api/v2/adaptive-runs").set(auth).send({ taskId: task.id, plan }).expect(201)).body;
    assert.equal(run.planRevision, 1);
    await request(app).get("/api/v2/adaptive-runs/" + run.id + "/events").set(auth).expect(200);
  } finally { store.close(); }
});
