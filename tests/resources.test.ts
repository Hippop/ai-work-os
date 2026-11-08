import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import {
  ResourceService,
  defaultPlan,
  validatePlan,
} from "../packages/resources/index.js";
import { WorkService } from "../packages/workflow/service.js";
test("resource versions are immutable, require publication and remain frozen in run input", () => {
  const store = new Store(":memory:");
  try {
    const resources = new ResourceService(store),
      service = new WorkService(store);
    const first = resources.create({
      kind: "skill",
      name: "Testing",
      version: "1.0.0",
      content: "Verify evidence before delivery",
    });
    assert.throws(() => resources.resolve([first.id], "skill", null), /已发布/);
    resources.publish(first.id);
    const task = service.createTask({
      type: "manual",
      title: "Use skill",
      objective: "Test context",
      acceptanceCriteria: ["verified"],
      skillVersionIds: [first.id],
    });
    const prep = service.prepare(task.id),
      run = service.start(task.id, prep.preparationDigest, "frozen");
    assert.throws(
      () =>
        resources.create({
          kind: "skill",
          name: "Testing",
          version: "1.0.0",
          content: "Overwrite",
        }),
      /不可覆盖/,
    );
    const second = resources.create({
      kind: "skill",
      name: "Testing",
      version: "2.0.0",
      content: "New instruction",
    });
    resources.publish(second.id);
    assert.equal(
      (run.manifest.context as any).skills[0].content,
      first.content,
    );
    resources.revoke(first.id);
    assert.throws(() => resources.resolve([first.id], "skill", null), /已发布/);
    assert.equal(
      (run.manifest.context as any).skills[0].contentDigest,
      first.contentDigest,
    );
  } finally {
    store.close();
  }
});
test("knowledge requires provenance and workflow rejects cycles and missing validation", () => {
  const store = new Store(":memory:");
  try {
    const resources = new ResourceService(store);
    assert.throws(
      () =>
        resources.create({
          kind: "knowledge",
          name: "Fact",
          version: "1.0.0",
          content: "Fact",
        }),
      /来源/,
    );
    const knowledge = resources.create({
      kind: "knowledge",
      name: "Fact",
      version: "1.0.0",
      content: "Fact",
      sources: ["docs/architecture.md"],
    });
    resources.publish(knowledge.id);
    assert.equal(
      resources.resolve([knowledge.id], "knowledge", null)[0].sources.length,
      1,
    );
    assert.throws(
      () => resources.resolve([knowledge.id], "skill", null),
      /范围/,
    );
    assert.equal(validatePlan(defaultPlan).length, 6);
    assert.throws(
      () =>
        validatePlan(
          defaultPlan.map((n) =>
            n.key === "analyze" ? { ...n, dependsOn: ["deliver"] } : n,
          ),
        ),
      /循环/,
    );
    assert.throws(
      () =>
        validatePlan(
          defaultPlan.map((n) =>
            n.operation === "test" ? { ...n, operation: "analyze" } : n,
          ),
        ),
      /必需操作/,
    );
  } finally {
    store.close();
  }
});
