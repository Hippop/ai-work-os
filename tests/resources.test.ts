import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import {
  ResourceService,
  defaultPlan,
  validatePlan,
} from "../packages/resources/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { digest } from "../packages/domain/index.js";
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
test("follow-published bindings resolve for future runs while existing input snapshots stay pinned", () => {
  const store = new Store(":memory:");
  try {
    const resources = new ResourceService(store),
      service = new WorkService(store),
      first = resources.create({
        kind: "skill",
        name: "Follow release",
        version: "1.0.0",
        content: "First policy",
      });
    resources.publish(first.id);
    const family = digest([first.kind, first.name, first.projectId]);
    const input = {
      title: "Bound task",
      type: "manual",
      objective: "Follow published skill at start",
      acceptanceCriteria: ["Result verified"],
      resourceFamilyIds: [family],
    };
    const task = service.createTask(input),
      run = service.start(
        task.id,
        service.prepare(task.id).preparationDigest,
        "binding",
      );
    const second = resources.create({
      ...first,
      version: "2.0.0",
      content: "Second policy",
    });
    resources.publish(second.id);
    const next = service.createTask(input);
    assert.equal(
      service.prepare(next.id).manifest.context.skills[0].id,
      second.id,
    );
    assert.equal((run.manifest.context as any).skills[0].id, first.id);
    resources.publish(first.id);
    const afterRollback = service.createTask(input);
    assert.equal(
      service.prepare(afterRollback.id).manifest.context.skills[0].id,
      first.id,
    );
    assert.throws(
      () => resources.context([first.id, second.id], [], null, null),
      /版本冲突/,
    );
  } finally {
    store.close();
  }
});
