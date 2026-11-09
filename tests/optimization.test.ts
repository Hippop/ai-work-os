import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { ResourceService } from "../packages/resources/index.js";
import { OptimizationService } from "../packages/optimization/index.js";
import { Supervisor } from "../packages/runtime/supervisor.js";
import { RolloutService } from "../packages/optimization/rollout.js";
import request from "supertest";
import { createApp } from "../apps/server/app.js";
import { type Run, digest } from "../packages/domain/index.js";
async function until(check: () => boolean, tick: () => void) {
  const deadline = Date.now() + 60000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Evaluation workers timed out");
    tick();
    await new Promise((r) => setTimeout(r, 50));
  }
}
test("real paired workers produce evaluation evidence, enforce publication gates and preserve rollback history", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-eval-")),
    repo = join(root, "repo");
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "answer.txt"), "0");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    ],
    { stdio: "ignore" },
  );
  const store = new Store(join(root, "state.db")),
    runtime = { available: true, version: "fixture" },
    service = new WorkService(store, runtime),
    resources = new ResourceService(store),
    optimization = new OptimizationService(store, root, runtime),
    supervisor = new Supervisor(store, service, root, process.execPath, [
      resolve("tests/fixtures/agent.mjs"),
    ]);
  try {
    const project = service.createProject({
      name: "Evaluation fixture",
      repositoryPath: repo,
      allowAgent: true,
      testCommand: {
        executable: process.execPath,
        args: [
          "-e",
          "if(require('fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)",
        ],
      },
    });
    const baseline = resources.create({
      kind: "skill",
      name: "Fixture improvement",
      version: "1.0.0",
      content: "FAIL_BASELINE",
    });
    resources.publish(baseline.id);
    const sources = [] as string[];
    for (let i = 0; i < 4; i++) {
      const task = service.createTask({
        title: `Case ${i}`,
        objective: `Produce verified answer 42 for scenario ${i}`,
        projectId: project.id,
        acceptanceCriteria: ["answer.txt is 42"],
        skillVersionIds: [baseline.id],
      });
      sources.push(
        service.start(
          task.id,
          service.prepare(task.id).preparationDigest,
          `source-${i}`,
        ).id,
      );
    }
    await until(
      () =>
        sources.every(
          (id) => service.required<Run>("run", id).status === "failed",
        ),
      () => supervisor.tick(),
    );
    const analysis = optimization.analyze(
      "2000-01-01T00:00:00.000Z",
      "2100-01-01T00:00:00.000Z",
    );
    assert.equal(analysis.groups[0].runIds.length, 4);
    assert.equal(
      optimization.analyze(analysis.from, analysis.to).id,
      analysis.id,
    );
    const proposal = optimization.generateCandidate(baseline.id, [sources[0]]);
    assert.equal(proposal.risk, "review_required");
    assert.throws(() => resources.publish(proposal.candidateId), /评估/);
    const dataset = optimization.dataset({
      name: "Fixed regression cases",
      version: "1.0.0",
      baselineId: baseline.id,
      cases: sources.slice(1).map((sourceRunId, i) => ({
        sourceRunId,
        label: `Case ${i}`,
        split: "holdout",
      })),
    });
    assert.throws(
      () =>
        optimization.dataset({
          name: "Duplicates",
          version: "1.0.0",
          baselineId: baseline.id,
          cases: [
            { sourceRunId: sources[0], label: "A", split: "holdout" },
            { sourceRunId: sources[0], label: "B", split: "holdout" },
          ],
        }),
      /重复输入/,
    );
    const trial = optimization.trials(proposal.id, {
      datasetId: dataset.id,
      consentToLocalExecution: true,
    });
    await until(
      () =>
        trial.pairs.every(
          (p) =>
            ["failed", "succeeded"].includes(
              service.required<Run>("run", p.baselineRunId).status,
            ) &&
            ["failed", "succeeded"].includes(
              service.required<Run>("run", p.candidateRunId).status,
            ),
        ),
      () => supervisor.tick(),
    );
    const insufficient = optimization.evaluate(proposal.id, {
      datasetId: dataset.id,
      pairs: trial.pairs,
    });
    assert.equal(insufficient.result.gate, "insufficient_samples");
    assert.throws(
      () =>
        optimization.release(proposal.id, {
          evaluationId: insufficient.id,
          approvalReason: "reviewed",
        }),
      /门槛/,
    );
    const evaluation = optimization.evaluate(proposal.id, {
      datasetId: dataset.id,
      pairs: trial.pairs,
      minHoldoutCases: 3,
    });
    assert.equal(evaluation.result.baselinePass, 0);
    assert.equal(evaluation.result.candidatePass, 3);
    assert.equal(evaluation.result.gate, "passed");
    assert.equal(evaluation.result.cost, "unknown");
    const leakedCandidate = resources.create({
      ...store.get<any>("resource", proposal.candidateId),
      version: "3.0.0",
    });
    const leaked = optimization.propose({
      title: "Leaked holdout",
      reason: "Intentional negative case",
      baselineId: baseline.id,
      candidateId: leakedCandidate.id,
      evidenceRunIds: [sources[1]],
    });
    assert.throws(
      () =>
        optimization.evaluate(leaked.id, {
          datasetId: dataset.id,
          pairs: trial.pairs,
          minHoldoutCases: 3,
        }),
      /留出/,
    );
    const countBeforeLeak = store.list("run").length;
    assert.throws(
      () =>
        optimization.trials(leaked.id, {
          datasetId: dataset.id,
          consentToLocalExecution: true,
        }),
      /留出/,
    );
    assert.equal(store.list("run").length, countBeforeLeak);
    assert.throws(
      () =>
        optimization.release(proposal.id, {
          evaluationId: evaluation.id,
          mode: "automatic",
        }),
      /自动发布/,
    );
    assert.throws(
      () => optimization.release(proposal.id, { evaluationId: evaluation.id }),
      /审核理由/,
    );
    const rollouts = new RolloutService(optimization),
      canary = rollouts.start(proposal.id, {
        evaluationId: evaluation.id,
        approvalReason: "Three fixture cases pass; limited manual test policy",
        projectIds: [project.id],
        maxTasks: 1,
      });
    assert.throws(
      () => rollouts.promote(canary.id, { rolloutId: canary.rolloutId }),
      /灰度需要/,
    );
    const dynamic = service.createTask({
      title: "Canary real work",
      objective: "Produce 42 under canary",
      projectId: project.id,
      acceptanceCriteria: ["42 verified"],
      resourceFamilyIds: [canary.id],
    });
    assert.equal(
      service.prepare(dynamic.id).manifest.context.skills[0].id,
      proposal.candidateId,
    );
    const canaryRun = service.start(
      dynamic.id,
      service.prepare(dynamic.id).preparationDigest,
      "canary",
    );
    const overflow = service.createTask({
      title: "Outside quota",
      objective: "Verify no extra canary adoption",
      projectId: project.id,
      acceptanceCriteria: ["Limited scope"],
      resourceFamilyIds: [canary.id],
    });
    assert.equal(
      service.prepare(overflow.id).manifest.context.skills[0].id,
      baseline.id,
    );
    await until(
      () =>
        ["succeeded", "failed"].includes(
          service.required<Run>("run", canaryRun.id).status,
        ),
      () => supervisor.tick(),
    );
    const canaryDelivery = store
      .list<any>("delivery")
      .find((d) => d.runId === canaryRun.id);
    assert.ok(canaryDelivery);
    service.accept(
      dynamic.id,
      canaryDelivery.id,
      true,
      "Verified canary result",
    );
    const release = rollouts.promote(canary.id, {
      rolloutId: canary.rolloutId,
      approvalReason: "Canary accepted; promote after manual review",
    });
    assert.equal(
      store.get<any>("resource_release", release.pointerId).resourceId,
      proposal.candidateId,
    );
    assert.equal(
      optimization.release(proposal.id, {
        evaluationId: evaluation.id,
        approvalReason: "same",
      }).id,
      release.id,
    );
    const rollback = optimization.rollback(
      release.id,
      "Restore baseline for verification",
    );
    assert.equal(rollback.to, baseline.id);
    assert.equal(
      store.get<any>("resource_release", release.pointerId).resourceId,
      baseline.id,
    );
    const candidateRun = service.required<Run>(
      "run",
      trial.pairs[0].candidateRunId,
    );
    assert.equal(
      (candidateRun.manifest.context as any).skills[0].id,
      proposal.candidateId,
    );
    assert.throws(
      () => optimization.rollback(release.id, "stale rollback"),
      /已变化/,
    );
    assert.throws(
      () =>
        optimization.evaluate(proposal.id, {
          datasetId: dataset.id,
          pairs: trial.pairs.map((p, i) =>
            i ? p : { ...p, candidateRunId: trial.pairs[1].candidateRunId },
          ),
        }),
      /重复使用/,
    );
    const higherTargetCandidate = resources.create({
      ...store.get<any>("resource", proposal.candidateId),
      version: "4.0.0",
    });
    const higherTarget = optimization.propose({
      title: "Insufficient measured gain",
      reason: "Require four extra holdout passes with three cases",
      baselineId: baseline.id,
      candidateId: higherTargetCandidate.id,
      evidenceRunIds: [sources[0]],
      minVerifiedDeliveryGain: 4,
    });
    const higherTrial = optimization.trials(higherTarget.id, {
      datasetId: dataset.id,
      consentToLocalExecution: true,
    });
    await until(
      () =>
        higherTrial.pairs.every(
          (pair) =>
            ["failed", "succeeded"].includes(
              service.required<Run>("run", pair.baselineRunId).status,
            ) &&
            ["failed", "succeeded"].includes(
              service.required<Run>("run", pair.candidateRunId).status,
            ),
        ),
      () => supervisor.tick(),
    );
    const noGain = optimization.evaluate(higherTarget.id, {
      datasetId: dataset.id,
      pairs: higherTrial.pairs,
      minHoldoutCases: 3,
    });
    assert.equal(noGain.result.gain, 3);
    assert.equal(noGain.result.gate, "no_measured_gain");
    assert.throws(
      () =>
        optimization.release(higherTarget.id, {
          evaluationId: noGain.id,
          approvalReason: "Cannot bypass the declared goal",
        }),
      /门槛/,
    );
    const delivery = store
      .list<any>("delivery")
      .find((d) => d.runId === trial.pairs[0].candidateRunId);
    writeFileSync(
      join(
        root,
        "artifacts",
        delivery.runId,
        ...(delivery.artifactSubdir ? [delivery.artifactSubdir] : []),
        "changes.patch",
      ),
      "tamper",
    );
    assert.throws(
      () =>
        optimization.release(proposal.id, {
          evaluationId: evaluation.id,
          approvalReason: "Invalidated evidence",
        }),
      /失效/,
    );
  } finally {
    await supervisor.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("periodic analysis starts disabled, coalesces missed windows and nested transactions remain atomic", () => {
  const store = new Store(":memory:"),
    optimization = new OptimizationService(store);
  try {
    optimization.tick(new Date("2026-11-08T00:00:00Z"));
    assert.equal(store.list("analysis_batch").length, 0);
    const schedule = optimization.configureSchedule({
      enabled: true,
      intervalDays: 7,
    });
    const now = new Date(Date.parse(schedule.nextAt) + 30 * 86400000);
    optimization.tick(now);
    optimization.tick(now);
    assert.equal(store.list("analysis_batch").length, 1);
    assert.throws(() =>
      store.transaction(() => {
        store.put("test", { id: "outer" });
        store.transaction(() => store.put("test", { id: "inner" }));
        throw new Error("rollback");
      }),
    );
    assert.equal(store.list("test").length, 0);
  } finally {
    store.close();
  }
});
test("optimization HTTP endpoints authenticate and require explicit scoped automation configuration", async () => {
  const store = new Store(":memory:"),
    app = createApp(store, "optimization-api"),
    auth = { Authorization: "Bearer optimization-api" };
  try {
    await request(app).get("/api/v1/optimization").expect(401);
    const initial = (
      await request(app).get("/api/v1/optimization").set(auth).expect(200)
    ).body;
    assert.deepEqual(initial.proposals, []);
    assert.deepEqual(initial.canaries, []);
    await request(app)
      .post("/api/v1/optimization/policy")
      .set(auth)
      .send({ enabled: true, approvalReason: "No project selected" })
      .expect(422);
    await request(app)
      .post("/api/v1/optimization/policy")
      .set(auth)
      .send({ enabled: false, approvalReason: "Keep automation disabled" })
      .expect(200);
    const body = {
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-08T00:00:00.000Z",
    };
    const first = (
      await request(app)
        .post("/api/v1/optimization/analyze")
        .set(auth)
        .send(body)
        .expect(200)
    ).body;
    const second = (
      await request(app)
        .post("/api/v1/optimization/analyze")
        .set(auth)
        .send(body)
        .expect(200)
    ).body;
    assert.equal(first.id, second.id);
    assert.equal(store.list("analysis_batch").length, 1);
  } finally {
    store.close();
  }
});
