import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { PlanningService } from "../packages/planning/index.js";
import {
  DiagnosisService,
  validateDiagnosis,
} from "../packages/diagnosis/index.js";
import { diagnosisPlan, validatePlan } from "../packages/resources/index.js";
import request from "supertest";
import { createApp } from "../apps/server/app.js";
const input = {
  title: "Work",
  objective: "Complete work",
  type: "manual",
  acceptanceCriteria: ["Verified result"],
};
test("dependencies gate execution and parent acceptance requires child acceptance", () => {
  const store = new Store(":memory:"),
    service = new WorkService(store);
  try {
    const parent = service.createTask(input),
      child = service.createTask({ ...input, parentId: parent.id });
    const dependent = service.createTask({ ...input, dependsOn: [child.id] });
    assert.equal(service.prepare(dependent.id).ready, false);
    assert.throws(
      () => service.updateTask(child.id, 1, { dependsOn: [parent.id] }),
      /循环/,
    );
    const parentRun = service.start(
        parent.id,
        service.prepare(parent.id).preparationDigest,
        "parent",
      ),
      parentDelivery = service.submit(parentRun.id, "Parent result");
    assert.throws(
      () => service.accept(parent.id, parentDelivery.id, true, ""),
      /子任务/,
    );
    const childRun = service.start(
        child.id,
        service.prepare(child.id).preparationDigest,
        "child",
      ),
      childDelivery = service.submit(childRun.id, "Child result");
    service.accept(child.id, childDelivery.id, true, "");
    assert.equal(service.prepare(dependent.id).ready, true);
    assert.equal(
      service.accept(parent.id, parentDelivery.id, true, "").status,
      "done",
    );
  } finally {
    store.close();
  }
});
test("planning preserves task revisions, detects cycles and summarizes actual acceptance dates", () => {
  const store = new Store(":memory:"),
    service = new WorkService(store),
    planning = new PlanningService(store);
  try {
    const goal = planning.createGoal({
      name: "Release",
      objective: "Ship release",
      successCriteria: ["Acceptance passed"],
    });
    const a = service.createTask({ ...input, goalId: goal.id }),
      b = service.createTask({ ...input, dependsOn: [a.id] });
    assert.throws(
      () => service.updateTask(a.id, 1, { dependsOn: [b.id] }),
      /循环/,
    );
    const updated = service.updateTask(a.id, 1, {
      plannedFor: "2026-11-08",
      dueAt: "2026-11-09",
    });
    assert.equal(updated.title, a.title);
    assert.ok(store.get("task_revision", `${a.id}:1`));
    assert.throws(
      () => service.updateTask(a.id, 1, { title: "Stale" }),
      /刷新/,
    );
    const summary = planning.summary("2026-11-08", "2026-11-08");
    assert.equal(summary.planned.length, 1);
    assert.equal(summary.accepted.length, 0);
    assert.equal(planning.goals()[0].taskCount, 1);
  } finally {
    store.close();
  }
});
test("diagnostic conclusions require task-scoped evidence and explicit causal verification", () => {
  const store = new Store(":memory:"),
    service = new WorkService(store),
    diagnosis = new DiagnosisService(store);
  try {
    const task = service.createTask({ ...input, type: "diagnosis" }),
      other = service.createTask({ ...input, type: "diagnosis" });
    const observation = diagnosis.addEvidence(task.id, {
      title: "Timeout",
      source: "logs/request-123",
      observedAt: "2026-11-08T10:00:00Z",
      kind: "observation",
      content: "Request timed out",
    });
    const report = {
      summary: "Cause may be connection timeout",
      hypotheses: [
        {
          claim: "Timeout",
          supportingEvidence: [observation.id],
          contradictingEvidence: [],
          nextExperiment: "Replay in isolated environment",
          status: "supported",
        },
      ],
      conclusion: {
        status: "likely",
        hypothesisIndex: 0,
        reason: "Observed timeout",
        unknowns: ["Need experiment"],
      },
    };
    assert.equal(diagnosis.report(task.id, report).conclusion.status, "likely");
    const hypothesis = diagnosis.addHypothesis(task.id, report.hypotheses[0]);
    assert.equal(
      diagnosis.updateHypothesis(task.id, hypothesis.id, 1, {
        status: "rejected",
      }).revision,
      2,
    );
    assert.ok(store.get("hypothesis_revision", `${hypothesis.id}:1`));
    assert.throws(
      () =>
        diagnosis.updateHypothesis(task.id, hypothesis.id, 1, {
          status: "open",
        }),
      /刷新/,
    );
    assert.throws(() => diagnosis.report(other.id, report), /证据/);
    assert.throws(
      () =>
        diagnosis.report(task.id, {
          ...report,
          conclusion: { ...report.conclusion, status: "confirmed" },
        }),
      /因果/,
    );
    const experiment = diagnosis.addEvidence(task.id, {
      title: "Controlled replay",
      source: "experiment/1",
      observedAt: "2026-11-08T10:05:00Z",
      kind: "experiment",
      content: "Controlled intervention changed outcome",
      verified: true,
      causal: true,
    });
    const confirmed = {
      ...report,
      hypotheses: [
        { ...report.hypotheses[0], supportingEvidence: [experiment.id] },
      ],
      conclusion: { ...report.conclusion, status: "confirmed" },
    };
    assert.equal(
      diagnosis.report(task.id, confirmed).conclusion.status,
      "confirmed",
    );
    assert.throws(
      () =>
        validateDiagnosis(
          {
            ...report,
            conclusion: {
              status: "unresolved",
              hypothesisIndex: null,
              reason: "No data",
              unknowns: [],
            },
          },
          [observation],
        ),
      /未知/,
    );
    assert.equal(validatePlan(diagnosisPlan, "diagnosis").length, 5);
    assert.throws(() => validatePlan(diagnosisPlan, "development"));
  } finally {
    store.close();
  }
});

test("planning and diagnosis HTTP commands enforce the same contracts", async () => {
  const store = new Store(":memory:"),
    app = createApp(store, "planning-test"),
    headers = { Authorization: "Bearer planning-test" };
  try {
    const goal = (
      await request(app)
        .post("/api/v1/goals")
        .set(headers)
        .send({
          name: "Milestone",
          objective: "Finish verified work",
          successCriteria: ["Accepted tasks"],
        })
        .expect(201)
    ).body;
    const task = (
      await request(app)
        .post("/api/v1/tasks")
        .set(headers)
        .send({ ...input, type: "diagnosis", goalId: goal.id })
        .expect(201)
    ).body;
    await request(app)
      .post(`/api/v1/tasks/${task.id}/plan`)
      .set(headers)
      .send({ revision: 1, changes: { plannedFor: "2026-11-08" } })
      .expect(200);
    await request(app)
      .get("/api/v1/planning/summary?from=2026-11-08&to=2026-11-08")
      .set(headers)
      .expect(200)
      .then((r) => assert.equal(r.body.planned.length, 1));
    await request(app)
      .post(`/api/v1/tasks/${task.id}/diagnosis/evidence`)
      .set(headers)
      .send({
        title: "Invalid causal claim",
        source: "log",
        observedAt: "2026-11-08T10:00:00Z",
        kind: "observation",
        content: "Log",
        causal: true,
      })
      .expect(422);
    await request(app)
      .post(`/api/v1/tasks/${task.id}/diagnosis/evidence`)
      .set(headers)
      .send({
        title: "Log",
        source: "log",
        observedAt: "2026-11-08T10:00:00Z",
        kind: "observation",
        content: "Log",
      })
      .expect(201);
    await request(app)
      .get(`/api/v1/tasks/${task.id}/diagnosis`)
      .set(headers)
      .expect(200)
      .then((r) => assert.equal(r.body.evidence.length, 1));
  } finally {
    store.close();
  }
});
