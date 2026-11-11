import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { createApp } from "../apps/server/app.js";
import { ResourceService, assemblePlan, defaultPlan, validatePlan } from "../packages/resources/index.js";

const development = [
  "analyze", "design", "implement", "test", "review", "deliver",
] as const;
const stages = development.map((operation) => ({
  operation,
  title: operation.toUpperCase(),
}));
const taskInput = {
  type: "development",
  title: "Workflow composition",
  objective: "Verify task-level workflow requirements",
  acceptanceCriteria: ["All requirements checked"],
};

test("compose mode creates a validated sequential flow with repeated stages", () => {
  const custom = [
    stages[0], stages[1], stages[2],
    { operation: "analyze" as const, title: "Review implementation risks", instruction: "Check API compatibility" },
    stages[3], stages[4], stages[5],
  ];
  const plan = assemblePlan(defaultPlan, {
    mode: "compose",
    instructions: "Prioritize compatibility",
    stages: custom,
  });
  assert.equal(plan.length, 7);
  assert.deepEqual(plan.map((n) => n.key), [
    "analyze_1", "design_1", "implement_1", "analyze_2",
    "test_1", "review_1", "deliver_1",
  ]);
  assert.deepEqual(plan[4].dependsOn, ["analyze_2"]);
  assert.equal(plan[3].instruction, "Check API compatibility");
});

test("graph mode enforces real ancestry and mandatory validation gates", () => {
  const chain = stages.map((stage, i) => ({
    ...stage, key: stage.operation, dependsOn: i ? [development[i - 1]] : [],
  }));
  assert.deepEqual(assemblePlan(defaultPlan, {
    mode: "graph", instructions: "", nodes: chain,
  }).map((node) => node.key), [...development]);
  assert.throws(() => assemblePlan(defaultPlan, {
    mode: "graph", instructions: "", nodes: [
      ...chain.slice(0, 4),
      { ...chain[4], dependsOn: ["implement"] },
      { ...chain[5], dependsOn: ["review", "test"] },
    ],
  }), /依赖链/);
  assert.throws(() => validatePlan(chain.map((node) =>
    node.operation === "deliver" ? { ...node, dependsOn: ["analyze"] } : node,
  )), /所有步骤|交付|依赖链/);
  assert.throws(() => assemblePlan(defaultPlan, {
    mode: "compose", instructions: "", stages: stages.filter((s) => s.operation !== "test"),
  }), /不能省略必需操作|Too small/);
});

test("per-task flow overrides template without replacing published version, and task edits invalidate preparation", () => {
  const store = new Store(":memory:");
  try {
    const service = new WorkService(store), resources = new ResourceService(store);
    const template = resources.create({
      kind: "workflow", name: "Feature", version: "1.0.0", content: "Base",
      nodes: defaultPlan,
    });
    resources.publish(template.id);
    const custom = {
      mode: "compose" as const,
      instructions: "Maintain backwards compatibility",
      stages: [
        ...stages.slice(0, 3),
        { operation: "test" as const, title: "Unit tests" },
        { operation: "test" as const, title: "Integration tests" },
        ...stages.slice(4),
      ],
    };
    const task = service.createTask({
      ...taskInput, workflowVersionId: template.id, flowRequirements: custom,
    });
    const prepared = service.prepare(task.id);
    assert.equal(prepared.manifest.context.plan.length, 7);
    assert.equal(prepared.manifest.context.workflow?.id, template.id);
    assert.match(prepared.manifest.workflowVersion, /task-compose/);
    assert.equal(prepared.manifest.task.flowRequirements?.instructions,
      "Maintain backwards compatibility");
    assert.equal(resources.resolve([template.id], "workflow", null)[0].nodes?.length, 6);
    const edited = service.updateTask(task.id, task.revision, {
      flowRequirements: {
        ...custom, instructions: "Add integration evidence",
      },
    });
    const revised = service.prepare(edited.id);
    assert.notEqual(revised.preparationDigest, prepared.preparationDigest);
    assert.equal(revised.manifest.context.plan.length, 7);
  } finally {
    store.close();
  }
});

test("standard flow requirements preserve published template; manual tasks cannot dispatch agent flows", () => {
  const store = new Store(":memory:");
  try {
    const service = new WorkService(store);
    const task = service.createTask({ ...taskInput,
      flowRequirements: { mode: "standard", instructions: "Be careful with API contracts" },
    });
    assert.equal(service.prepare(task.id).manifest.context.plan.length, 6);
    assert.throws(() => service.createTask({
      ...taskInput, type: "manual",
      flowRequirements: { mode: "compose", stages },
    }), /人工任务不支持/);
  } finally {
    store.close();
  }
});

test("preview API validates request without creating a task", async () => {
  const store = new Store(":memory:");
  const app = createApp(store, "test-token");
  const auth = { Authorization: "Bearer test-token" };
  try {
    await request(app).post("/api/v1/flows/preview")
      .send({ type: "development" }).expect(401);
    const preview = (await request(app).post("/api/v1/flows/preview")
      .set(auth).send({
        type: "development",
        flowRequirements: { mode: "compose", instructions: "", stages },
      }).expect(200)).body;
    assert.equal(preview.plan.length, 6);
    assert.equal(store.list("task").length, 0);
    await request(app).post("/api/v1/flows/preview").set(auth).send({
      type: "diagnosis",
      flowRequirements: { mode: "compose", instructions: "", stages },
    }).expect(422);
    await request(app).post("/api/v1/flows/preview").set(auth).send({
      type: "development",
      flowRequirements: { mode: "graph", instructions: "", nodes: [] },
    }).expect(422);
  } finally { store.close(); }
});
