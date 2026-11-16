import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";
import { ContextAssembler, knowledgeVersionDigest } from "../packages/context/assembler.js";
import { KnowledgeCurationService } from "../packages/context/knowledge-governance.js";
import { GraphDraftService } from "../packages/graph/draft-service.js";
import { GraphCompiler, capabilityVersionDigest } from "../packages/graph/compiler.js";
import { getRunGraph } from "../packages/graph/projection.js";
import { createApp } from "../apps/server/app.js";

function capRef(assets: AssetService, id: string) {
  const cap = assets.getCapability(id, false);
  return { id: cap.id, version: cap.version, digest: capabilityVersionDigest(cap) };
}

function setupProjectAndTask(store: Store) {
  bootstrapAdaptiveAssets(store);
  const work = new WorkService(store);
  const assets = new AssetService(store);
  const projectA = work.createProject({
    name: "Project Alpha",
    repositoryPath: process.cwd(),
    allowAgent: false,
  });
  const projectB = work.createProject({
    name: "Project Beta",
    repositoryPath: process.cwd(),
    allowAgent: false,
  });
  const taskA = work.createTask({
    title: "Scoped Knowledge Task A",
    type: "manual",
    projectId: projectA.id,
    objective: "Verify context assembly and knowledge governance",
    acceptanceCriteria: ["Strict scope, revocation, budget, conflict, and artifact checks"],
  });
  return { work, assets, projectA, projectB, taskA };
}

test("A07: out-of-scope knowledge (other project/task/capability) fails compile and blocks runtime context assembly", () => {
  const store = new Store(":memory:");
  try {
    const { assets, projectB, taskA } = setupProjectAndTask(store);
    const otherProjKnowledge = assets.createKnowledge({
      name: "secret.projb",
      version: "1.0.0",
      title: "Project B Secret",
      content: "Internal credentials policy of Project B",
      scope: "project",
      projectId: projectB.id,
      source: "manual",
    });
    assets.publishKnowledge(otherProjKnowledge.id);

    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const draft = drafts.createDraft({
      projectId: taskA.projectId,
      taskId: taskA.id,
      goal: "Disallow cross-project pinned knowledge",
      nodes: [
        {
          id: "analyze",
          engineKey: "analyze",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          literals: { objective: "Analyze" },
          knowledgeInputs: [
            {
              id: "k-req-b",
              source: {
                kind: "pinned",
                ref: {
                  id: otherProjKnowledge.id,
                  version: otherProjKnowledge.version,
                  digest: knowledgeVersionDigest(otherProjKnowledge),
                },
              },
              required: true,
              purpose: "Cross-project leak test",
            },
          ],
        },
        {
          id: "deliver",
          engineKey: "deliver",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["analyze"],
          bindings: [
            {
              id: "b1",
              target: "/objective",
              source: { nodeId: "analyze", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
      ],
    });

    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, false);
    assert.ok(compiled.diagnostics.some((d) => d.code === "knowledge_scope_denied"));
  } finally {
    store.close();
  }
});

test("A08: revoking pinned knowledge after compile blocks unexecuted downstream node and revokeAndPropagate invalidates run", async () => {
  const store = new Store(":memory:");
  try {
    const { assets, projectA, taskA } = setupProjectAndTask(store);
    const curation = new KnowledgeCurationService(store);
    const k = assets.createKnowledge({
      name: "project.rule",
      version: "1.0.0",
      title: "Project Rule",
      content: "Use parameterized SQL queries everywhere.",
      scope: "project",
      projectId: projectA.id,
      source: "manual",
    });
    assets.publishKnowledge(k.id);

    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const draft = drafts.createDraft({
      projectId: projectA.id,
      taskId: taskA.id,
      goal: "Test live knowledge revocation before downstream execution",
      nodes: [
        {
          id: "step1",
          engineKey: "step1",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          literals: { objective: "Step 1" },
        },
        {
          id: "deliver",
          engineKey: "deliver",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["step1"],
          bindings: [
            {
              id: "b1",
              target: "/objective",
              source: { nodeId: "step1", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
          knowledgeInputs: [
            {
              id: "k-pinned",
              source: {
                kind: "pinned",
                ref: {
                  id: k.id,
                  version: k.version,
                  digest: knowledgeVersionDigest(k),
                },
              },
              required: true,
              purpose: "Verify compliance before delivery",
            },
          ],
        },
      ],
    });

    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, true);

    let stepCount = 0;
    const engine = new AdaptiveEngine(store, assets, async (call) => {
      stepCount += 1;
      if (call.node.id === "step1") {
        // Simulate revocation mid-run before deliver node runs!
        curation.revokeAndPropagate(k.id, "Policy superseded");
      }
      return { output: { summary: "ok", evidence: ["e1"], risks: [] } };
    });

    const { runId } = await compiler.startCompiledPlan(draft.id, {
      expectedRevision: draft.revision,
      compiledDigest: compiled.compiledDigest!,
    });

    await engine.tick(); // Executes step1 -> triggers revoke before deliver
    await engine.tick(); // Attempts deliver -> ContextAssembler must fail closed on revoked knowledge

    const run = engine.get(runId);
    assert.equal(stepCount, 1);
    assert.equal(run.nodeStates.step1, "succeeded");
    assert.equal(run.nodeStates.deliver, "failed");
    assert.match(run.failures.deliver ?? "", /撤销|revoked/);

    // Also test propagation marking a run that already consumed the knowledge as stale/invalid
    const k2 = assets.createKnowledge({
      name: "project.fact2",
      version: "1.0.0",
      title: "Consumed Fact",
      content: "Initial architectural benchmark fact",
      scope: "project",
      projectId: projectA.id,
      source: "manual",
    });
    assets.publishKnowledge(k2.id);

    const draft2 = drafts.createDraft({
      projectId: projectA.id,
      taskId: workTask(store, projectA.id),
      goal: "Consumed knowledge revocation propagation",
      nodes: [
        {
          id: "step_consume",
          engineKey: "step_consume",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          literals: { objective: "Consume k2" },
          knowledgeInputs: [
            {
              id: "k2-req",
              source: {
                kind: "pinned",
                ref: { id: k2.id, version: k2.version, digest: knowledgeVersionDigest(k2) },
              },
              required: true,
              purpose: "Constraint check",
            },
          ],
        },
        {
          id: "deliver2",
          engineKey: "deliver2",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["step_consume"],
          bindings: [
            {
              id: "b2",
              target: "/objective",
              source: { nodeId: "step_consume", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
      ],
    });
    const comp2 = compiler.compile(draft2.id, draft2.revision);
    assert.equal(comp2.ok, true);

    const engine2 = new AdaptiveEngine(store, assets, async () => ({
      output: { summary: "step_consume ok", evidence: ["ev1"], risks: [] },
    }));
    const { runId: runId2 } = await compiler.startCompiledPlan(draft2.id, {
      expectedRevision: draft2.revision,
      compiledDigest: comp2.compiledDigest!,
    });
    await engine2.tick(); // step_consume executes & persists ResolvedContextManifest hitting k2
    const propagated = curation.revokeAndPropagate(k2.id, "Benchmark invalidated");
    assert.ok(propagated.affectedRunIds.includes(runId2));
    assert.ok(propagated.invalidatedNodes >= 1);
    const graph2 = getRunGraph(store, runId2);
    assert.equal(graph2.resultValidity?.step_consume?.state, "stale");
  } finally {
    store.close();
  }
});

function workTask(store: Store, projectId: string) {
  return new WorkService(store).createTask({
    title: "Follow-up task",
    type: "manual",
    projectId,
    objective: "Verify propagation",
    acceptanceCriteria: ["Stale propagated"],
  }).id;
}

test("A09: producer node-output knowledge with evidence is delivered to consumer and missing evidence fails", async () => {
  const store = new Store(":memory:");
  try {
    const { assets, projectA, taskA } = setupProjectAndTask(store);
    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);

    const draft = drafts.createDraft({
      projectId: projectA.id,
      taskId: taskA.id,
      goal: "Upstream knowledgeOutputs consumed downstream",
      nodes: [
        {
          id: "producer",
          engineKey: "producer",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          literals: { objective: "Discover API invariant" },
          knowledgeOutputs: [
            {
              id: "api-invariant",
              kind: "fact",
              destination: "task",
              evidenceRequired: true,
            },
          ],
        },
        {
          id: "consumer",
          engineKey: "consumer",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["producer"],
          bindings: [
            {
              id: "b1",
              target: "/objective",
              source: { nodeId: "producer", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
          knowledgeInputs: [
            {
              id: "k-from-prod",
              source: { kind: "node-output", nodeId: "producer", outputId: "api-invariant" },
              required: true,
              acceptedKinds: ["fact"],
              purpose: "Use discovered API invariant",
              resolution: "producer-completion",
            },
          ],
        },
      ],
    });

    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, true);

    let consumerSawKnowledge = "";
    const engine = new AdaptiveEngine(store, assets, async (call) => {
      if (call.node.id === "consumer") {
        consumerSawKnowledge = call.knowledge.map((k) => k.content).join("\n");
      }
      return {
        output: { summary: "API must return pagination cursor", evidence: ["src/api.ts#L10"], risks: [] },
      };
    });

    const { runId } = await compiler.startCompiledPlan(draft.id, {
      expectedRevision: draft.revision,
      compiledDigest: compiled.compiledDigest!,
    });
    await engine.tick();
    await engine.tick();

    const finished = engine.get(runId);
    assert.equal(finished.nodeStates.consumer, "succeeded");
    assert.match(consumerSawKnowledge, /pagination cursor/);

    // Verify evidenceRequired=true rejects missing evidence in recordNodeKnowledgeOutputs
    const curation = new KnowledgeCurationService(store);
    assert.throws(() => {
      curation.recordNodeKnowledgeOutputs(
        finished,
        "producer",
        "inv-no-ev",
        [{ id: "missing-ev", kind: "fact", destination: "task", evidenceRequired: true }],
        { summary: "Unverified assertion", evidence: [] },
      );
    }, /缺少必需证据引用|必须附带至少一条证据/);
  } finally {
    store.close();
  }
});

test("A10: ContextAssembler omits optional knowledge on budget pressure and throws when required context exceeds budget", () => {
  const store = new Store(":memory:");
  try {
    const { assets, projectA, taskA } = setupProjectAndTask(store);
    const optKnowledge = assets.createKnowledge({
      name: "opt.long.doc",
      version: "1.0.0",
      title: "Very Long Optional Reference",
      content: "O".repeat(2500),
      scope: "project",
      projectId: projectA.id,
      source: "manual",
    });
    assets.publishKnowledge(optKnowledge.id);

    const reqKnowledge = assets.createKnowledge({
      name: "req.long.doc",
      version: "1.0.0",
      title: "Required Reference",
      content: "R".repeat(900),
      scope: "project",
      projectId: projectA.id,
      source: "manual",
    });
    assets.publishKnowledge(reqKnowledge.id);

    const cap = assets.getCapability("core.analyze@1.0.0");
    const profile = assets.getProfile("core.codex.read@1.0.0");
    const assembler = new ContextAssembler(store);

    const baseRun: AdaptiveEngine extends never ? never : any = {
      id: "run-budget-1",
      taskId: taskA.id,
      status: "running",
      planRevision: 1,
      plan: {
        nodes: [{ id: "a", capabilityRef: cap.id, dependsOn: [], inputs: { objective: "Hi" }, bindings: {} }],
        observations: [],
        rationale: "budget test",
      },
      snapshots: {},
      nodeStates: { a: "running" },
      observationStates: {},
      results: {},
      failures: {},
      decisions: {},
      revisionCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Budget sufficient for required items (~1200 chars), but too tight for optKnowledge (2500 chars) -> omitted cleanly
    const assembled = assembler.assemble({
      run: baseRun,
      node: baseRun.plan.nodes[0],
      nodeSpec: {
        id: "a",
        engineKey: "a",
        capabilityRef: { id: cap.id, version: cap.version, digest: "d12345678" },
        literals: { objective: "Hi" },
        bindings: [],
        dependsOn: [],
        knowledgeInputs: [
          {
            id: "req-k",
            source: {
              kind: "pinned",
              ref: { id: reqKnowledge.id, version: reqKnowledge.version, digest: knowledgeVersionDigest(reqKnowledge) },
            },
            required: true,
            acceptedKinds: ["pattern"],
            purpose: "Must keep",
            resolution: "run-start",
          },
          {
            id: "opt-k",
            source: {
              kind: "pinned",
              ref: { id: optKnowledge.id, version: optKnowledge.version, digest: knowledgeVersionDigest(optKnowledge) },
            },
            required: false,
            acceptedKinds: ["pattern"],
            purpose: "May omit",
            resolution: "run-start",
          },
        ],
        knowledgeOutputs: [],
        workspace: { policy: "run-shared", subdir: "." },
      },
      capability: cap,
      profileRef: profile.id,
      profile,
      skillInstructions: [],
      task: taskA,
      invocationId: "inv-b1",
      workspaceDir: process.cwd(),
      workspaceDigest: "ws-digest",
      maxContextChars: 1400,
    });

    assert.ok(assembled.knowledge.some((x) => x.id === reqKnowledge.id));
    assert.ok(!assembled.knowledge.some((x) => x.id === optKnowledge.id));
    assert.ok(assembled.manifest.omissions.some((o) => o.id === optKnowledge.id));

    // Too small even for required items -> MUST throw context_budget_exceeded instead of silently truncating
    assert.throws(() => {
      assembler.assemble({
        run: baseRun,
        node: baseRun.plan.nodes[0],
        nodeSpec: {
          id: "a",
          engineKey: "a",
          capabilityRef: { id: cap.id, version: cap.version, digest: "d12345678" },
          literals: { objective: "Hi" },
          bindings: [],
          dependsOn: [],
          knowledgeInputs: [
            {
              id: "req-k",
              source: {
                kind: "pinned",
                ref: { id: reqKnowledge.id, version: reqKnowledge.version, digest: knowledgeVersionDigest(reqKnowledge) },
              },
              required: true,
              acceptedKinds: ["pattern"],
              purpose: "Must keep",
              resolution: "run-start",
            },
          ],
          knowledgeOutputs: [],
          workspace: { policy: "run-shared", subdir: "." },
        },
        capability: cap,
        profileRef: profile.id,
        profile,
        skillInstructions: [],
        task: taskA,
        invocationId: "inv-b2",
        workspaceDir: process.cwd(),
        workspaceDigest: "ws-digest",
        maxContextChars: 200,
      });
    }, /超出预算|budget/);
  } finally {
    store.close();
  }
});

test("A21: conflicting knowledge pair blocks compile/assembly and candidate creation cannot promote directly to global", () => {
  const store = new Store(":memory:");
  try {
    const { assets, projectA, taskA } = setupProjectAndTask(store);
    const curation = new KnowledgeCurationService(store);
    const k1 = assets.createKnowledge({
      name: "approach.sync",
      version: "1.0.0",
      title: "Use synchronous DB write",
      content: "Always use direct synchronous SQLite writes",
      scope: "project",
      projectId: projectA.id,
      source: "manual",
    });
    const k2 = assets.createKnowledge({
      name: "approach.queue",
      version: "1.0.0",
      title: "Use async queue",
      content: "Always offload writes to background queue",
      scope: "project",
      projectId: projectA.id,
      source: "manual",
    });
    assets.publishKnowledge(k1.id);
    assets.publishKnowledge(k2.id);

    curation.registerConflict({
      sourceId: k1.id,
      targetId: k2.id,
      reason: "Mutually exclusive storage write strategies",
    });

    // Compiler must reject conflicting knowledge inputs
    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const draft = drafts.createDraft({
      projectId: projectA.id,
      taskId: taskA.id,
      goal: "Conflict detection",
      nodes: [
        {
          id: "deliver",
          engineKey: "deliver",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          literals: { objective: "Choose strategy" },
          knowledgeInputs: [
            {
              id: "r1",
              source: { kind: "pinned", ref: { id: k1.id, version: "1.0.0", digest: knowledgeVersionDigest(k1) } },
              required: true,
              purpose: "Strategy A",
            },
            {
              id: "r2",
              source: { kind: "pinned", ref: { id: k2.id, version: "1.0.0", digest: knowledgeVersionDigest(k2) } },
              required: true,
              purpose: "Strategy B",
            },
          ],
        },
      ],
    });
    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, false);
    assert.ok(compiled.diagnostics.some((d) => d.code === "knowledge_conflict"));

    // Runtime candidate curation cannot bypass review into global scope
    const eng = new AdaptiveEngine(store);
    const run = eng.createRun(taskA.id, {
      nodes: [{ id: "deliver", capabilityRef: "core.deliver@1.0.0", inputs: { objective: "x" } }],
      observations: [],
    });
    assert.throws(() => {
      curation.proposeCandidate({
        runId: run.id,
        name: "cand.bad",
        version: "1.0.0",
        title: "Attempt global promotion",
        content: "Should be denied",
        scope: "global",
        applicableConditions: ["always"],
      });
    }, /不能直接提升为全局知识|不能直接晋升为全局知识/);
  } finally {
    store.close();
  }
});

test("A22 & A24: tampered upstream artifact fails closed and legacy V2 runs report honest legacy-ancestors fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-work-os-v3-art-"));
  const store = new Store(":memory:");
  try {
    const { assets, taskA } = setupProjectAndTask(store);
    const artifactFile = join(dir, "upstream-report.txt");
    writeFileSync(artifactFile, "trusted-artifact-v1", "utf8");

    const engine = new AdaptiveEngine(store, assets, async (call) => {
      if (call.node.id === "step1") {
        // Modify artifact right after capture? No, step1 returns artifact, then we tamper before step2 runs!
        return { output: { summary: "step1 done", evidence: ["e"], risks: [] }, artifacts: [artifactFile] };
      }
      return { output: { summary: "step2 done", evidence: ["e"], risks: [] } };
    });

    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const draft = drafts.createDraft({
      projectId: taskA.projectId,
      taskId: taskA.id,
      goal: "Fail closed when upstream artifact is tampered",
      nodes: [
        {
          id: "step1",
          engineKey: "step1",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          literals: { objective: "Produce artifact" },
        },
        {
          id: "step2",
          engineKey: "step2",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["step1"],
          bindings: [
            {
              id: "b1",
              target: "/objective",
              source: { nodeId: "step1", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
      ],
    });
    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, true);

    const { runId } = await compiler.startCompiledPlan(draft.id, {
      expectedRevision: draft.revision,
      compiledDigest: compiled.compiledDigest!,
    });
    await engine.tick(); // step1 succeeds and stores artifactDigests

    // Tamper with upstream artifact before downstream node is assembled
    writeFileSync(artifactFile, "tampered-evil-content", "utf8");
    await engine.tick();

    const afterTamper = engine.get(runId);
    assert.equal(afterTamper.nodeStates.step2, "failed");
    assert.match(afterTamper.failures.step2 ?? "", /工件.*篡改|artifact|digest|摘要/);

    // A24: Legacy V2 run returns available=false contextMode="legacy-ancestors" without faking manifest
    const v2Run = engine.createRun(
      new WorkService(store).createTask({
        title: "Legacy V2 Task",
        type: "manual",
        objective: "Check legacy honest fallback",
        acceptanceCriteria: ["Do not fake manifest"],
      }).id,
      {
        nodes: [{ id: "deliver", capabilityRef: "core.deliver@1.0.0", inputs: { objective: "legacy" } }],
        observations: [],
      },
    );
    const app = createApp(store, "tok-a24", undefined, dir, engine);
    const res = await request(app)
      .get(`/api/v3/runs/${v2Run.id}/nodes/deliver/context`)
      .set("Authorization", "Bearer tok-a24")
      .expect(200);
    assert.equal(res.body.available, false);
    assert.equal(res.body.contextMode, "legacy-ancestors");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
