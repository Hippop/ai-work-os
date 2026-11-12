import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { DiagnosisService } from "../packages/diagnosis/index.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import {
  bootstrapAdaptiveAssets,
  standardAdaptivePlan,
} from "../packages/adaptive/bootstrap.js";
import { createApp } from "../apps/server/app.js";
function fixture() {
  const store = new Store(":memory:");
  bootstrapAdaptiveAssets(store);
  const work = new WorkService(store);
  const task = work.createTask({
    title: "GC incident",
    type: "diagnosis",
    objective: "Inspect GC evidence",
    acceptanceCriteria: ["Causal evidence checked"],
  });
  const diagnosis = new DiagnosisService(store);
  return { store, work, task, diagnosis };
}
const ok = { summary: "checked", evidence: [], risks: [] };
const evidence = {
  title: "GC observation",
  source: "user log",
  observedAt: "2026-11-12T01:00:00Z",
  kind: "observation",
  content: "GC occurred repeatedly",
  verified: true,
};
async function runAll(e: AdaptiveEngine, id: string) {
  for (let i = 0; i < 20; i++) {
    await e.tick();
    if (
      ["failed", "reconciling", "waiting", "awaiting_acceptance"].includes(
        e.get(id).status,
      )
    )
      break;
  }
}
function report(id: string, status = "likely") {
  return {
    summary: "GC pressure observed",
    hypotheses: [
      {
        claim: "Allocation pressure",
        supportingEvidence: [id],
        contradictingEvidence: [],
        nextExperiment: "Compare controlled allocations",
        status: "supported",
      },
    ],
    conclusion: {
      status,
      hypothesisIndex: 0,
      reason: "Evidence supports a hypothesis",
      unknowns: ["Causal experiment not performed"],
    },
  };
}
test("V2 diagnosis freezes evidence, shares its report with diagnosis UI, and creates one explicit repair task", async () => {
  const { store, work, task, diagnosis } = fixture();
  try {
    const ev = diagnosis.addEvidence(task.id, evidence);
    const expected = diagnosis.snapshot(task.id);
    let calls = 0;
    const engine = new AdaptiveEngine(store, undefined, async (call) => {
      calls++;
      assert.equal(call.run.diagnosisSnapshot?.digest, expected.digest);
      return {
        output: call.capability.tags.includes("diagnosis-report")
          ? { ...ok, diagnosisReportJson: JSON.stringify(report(ev.id)) }
          : ok,
      };
    });
    const plan = standardAdaptivePlan(task, "opencode");
    plan.observations = [];
    assert.equal(
      plan.nodes.find((n) => n.id === "conclude")?.profileRef,
      "core.opencode.read@1.0.0",
    );
    const run = engine.createRun(task.id, plan);
    diagnosis.addEvidence(task.id, { ...evidence, title: "Late evidence" });
    await runAll(engine, run.id);
    assert.equal(engine.get(run.id).status, "awaiting_acceptance");
    assert.equal(calls, 5);
    const reports = store.list<any>("diagnosis_report");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].evidenceSnapshot.length, 1);
    assert.equal(reports[0].inputDigest, expected.digest);
    const app = createApp(store, "token", work, undefined, engine);
    const api = await request(app)
      .get(`/api/v1/tasks/${task.id}/diagnosis`)
      .set("Authorization", "Bearer token")
      .expect(200);
    assert.equal(api.body.reports[0].runId, run.id);
    const payload = {
      title: "Repair allocation pressure",
      objective: "Validate and implement a bounded fix",
      acceptanceCriteria: ["Regression test passes"],
    };
    const url = `/api/v1/tasks/${task.id}/diagnosis/reports/${reports[0].id}/repair-task`;
    await request(app).post(url).send(payload).expect(401);
    await request(app)
      .post(url)
      .set("Authorization", "Bearer token")
      .send(payload)
      .expect(409);
    engine.accept(run.id, true, "Reviewed actual evidence");
    const one = await request(app)
      .post(url)
      .set("Authorization", "Bearer token")
      .send(payload)
      .expect(201);
    const two = await request(app)
      .post(url)
      .set("Authorization", "Bearer token")
      .send(payload)
      .expect(201);
    assert.equal(one.body.id, two.body.id);
    assert.equal(one.body.type, "development");
    assert.deepEqual(one.body.dependsOn, [task.id]);
    assert.match(one.body.objective, /likely/);
    await request(app)
      .post(url)
      .set("Authorization", "Bearer token")
      .send({ ...payload, title: "Different request" })
      .expect(409);
    assert.equal(store.list("diagnosis_repair").length, 1);
  } finally {
    store.close();
  }
});
test("confirmed root cause cannot use observations or evidence added after run creation", async () => {
  for (const late of [false, true]) {
    const { store, task, diagnosis } = fixture();
    try {
      const ev = diagnosis.addEvidence(task.id, evidence);
      let source = ev.id;
      const engine = new AdaptiveEngine(
        store,
        undefined,
        async ({ capability }) => ({
          output: capability.tags.includes("diagnosis-report")
            ? {
                ...ok,
                diagnosisReportJson: JSON.stringify(
                  report(source, "confirmed"),
                ),
              }
            : ok,
        }),
      );
      const plan = standardAdaptivePlan(task);
      plan.observations = [];
      const run = engine.createRun(task.id, plan);
      if (late)
        source = diagnosis.addEvidence(task.id, {
          ...evidence,
          kind: "experiment",
          causal: true,
        }).id;
      await runAll(engine, run.id);
      assert.equal(engine.get(run.id).status, "failed");
      assert.equal(store.list("diagnosis_report").length, 0);
      assert.match(
        engine.get(run.id).failures.conclude,
        late ? /未知或其他任务/ : /因果实验/,
      );
    } finally {
      store.close();
    }
  }
});
test("verified causal evidence permits a confirmed report, diagnostic writes are forbidden", async () => {
  const { store, task, diagnosis } = fixture();
  try {
    const ev = diagnosis.addEvidence(task.id, {
      ...evidence,
      kind: "experiment",
      causal: true,
    });
    const e = new AdaptiveEngine(store, undefined, async ({ capability }) => ({
      output: capability.tags.includes("diagnosis-report")
        ? {
            ...ok,
            diagnosisReportJson: JSON.stringify(report(ev.id, "confirmed")),
          }
        : ok,
    }));
    const plan = standardAdaptivePlan(task);
    plan.observations = [];
    const r = e.createRun(task.id, plan);
    await runAll(e, r.id);
    assert.equal(e.get(r.id).status, "awaiting_acceptance");
    const writes = standardAdaptivePlan({ ...task, type: "development" });
    assert.throws(() => e.createRun(task.id, writes), /不允许代码或外部写入/);
  } finally {
    store.close();
  }
});
test("event pages validate cursors and return events beyond the first 500", async () => {
  const { store, work, task } = fixture();
  try {
    const e = new AdaptiveEngine(store);
    const r = e.createRun(task.id, standardAdaptivePlan(task));
    for (let i = 0; i < 620; i++) store.event(r.id, "log", { i });
    const app = createApp(store, "token", work, undefined, e);
    const url = `/api/v2/adaptive-runs/${r.id}/events`;
    const first = await request(app)
      .get(url)
      .set("Authorization", "Bearer token")
      .expect(200);
    assert.equal(first.body.length, 500);
    const second = await request(app)
      .get(url + "?after=500")
      .set("Authorization", "Bearer token")
      .expect(200);
    assert.equal(second.body[0].seq, 501);
    assert.ok(second.body.length > 100);
    await request(app)
      .get(url + "?after=-1")
      .set("Authorization", "Bearer token")
      .expect(422);
    await request(app)
      .get(url + "?after=abc")
      .set("Authorization", "Bearer token")
      .expect(422);
  } finally {
    store.close();
  }
});
test("real subprocess protocol receives frozen evidence and exports a validated report artifact", async () => {
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    chmodSync,
    readFileSync,
    rmSync,
  } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { AdaptiveRuntime } = await import("../packages/adaptive/runtime.js");
  const root = mkdtempSync(join(tmpdir(), "aiwork-diagnosis-cli-"));
  const { store, work, diagnosis } = fixture();
  let runtime: InstanceType<typeof AdaptiveRuntime> | undefined;
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "fixture");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "init",
    );
    const project = work.createProject({
      name: "Diagnosis fixture",
      repositoryPath: repo,
      allowAgent: true,
    });
    const t = work.createTask({
      title: "Read incident",
      type: "diagnosis",
      projectId: project.id,
      objective: "Read evidence only",
      acceptanceCriteria: ["Report verified"],
    });
    const ev = diagnosis.addEvidence(t.id, {
      ...evidence,
      content: "FROZEN_INPUT_739",
    });
    const output = {
      ...ok,
      diagnosisReportJson: JSON.stringify(report(ev.id)),
    };
    const fake = join(root, "codex.cjs");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
 const fs=require('fs'),a=process.argv.slice(2),p=a.at(-1);
 if(!p.includes('FROZEN_INPUT_739')||p.includes('LATE_INPUT_739'))process.exit(9);
 fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify(${JSON.stringify(output)}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
 `,
    );
    chmodSync(fake, 0o700);
    runtime = new AdaptiveRuntime(store, join(root, "data"), fake);
    const engine = new AdaptiveEngine(store, undefined, runtime.executor());
    const standard = standardAdaptivePlan(t);
    const conclude = standard.nodes.find((n) => n.id === "conclude")!;
    const deliver = standard.nodes.find((n) => n.id === "deliver")!;
    const r = engine.createRun(t.id, {
      nodes: [
        { ...conclude, dependsOn: [] },
        { ...deliver, dependsOn: ["conclude"] },
      ],
      observations: [],
    });
    diagnosis.addEvidence(t.id, { ...evidence, content: "LATE_INPUT_739" });
    await runAll(engine, r.id);
    assert.equal(
      engine.get(r.id).status,
      "awaiting_acceptance",
      JSON.stringify(engine.get(r.id).failures),
    );
    const artifact = engine
      .get(r.id)
      .results.conclude.artifactRefs.find((p) =>
        p.endsWith("diagnosis-report.json"),
      );
    assert.ok(artifact);
    assert.equal(
      JSON.parse(readFileSync(artifact, "utf8")).conclusion.status,
      "likely",
    );
    engine.accept(r.id, true, "Checked real fixture output");
  } finally {
    await runtime?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
