import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { createApp } from "../apps/server/app.js";
import { type Task } from "../packages/domain/index.js";

const input = {
  title: "验证任务",
  objective: "完成一项可验收工作",
  type: "manual",
  acceptanceCriteria: ["提交有验证依据的成果"],
};
function fixture() {
  const store = new Store(":memory:");
  return { store, service: new WorkService(store) };
}
test("manual delivery succeeds independently of business acceptance", () => {
  const { store, service } = fixture();
  try {
    const task = service.createTask(input),
      prepared = service.prepare(task.id);
    const run = service.start(task.id, prepared.preparationDigest, "request-1");
    assert.equal(run.status, "running");
    const delivery = service.submit(run.id, "成果说明");
    assert.equal(
      service.required<Task>("task", task.id).status,
      "awaiting_acceptance",
    );
    assert.equal(service.accept(task.id, delivery.id, true, "").status, "done");
    const events = store.events(run.id);
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i + 1),
    );
  } finally {
    store.close();
  }
});
test("duplicate start is idempotent; changed content conflicts and no duplicate outbox exists", () => {
  const { store, service } = fixture();
  try {
    const task = service.createTask(input),
      p = service.prepare(task.id);
    const a = service.start(task.id, p.preparationDigest, "same");
    assert.equal(service.start(task.id, p.preparationDigest, "same").id, a.id);
    assert.throws(
      () => service.start(task.id, "different", "same"),
      /同一请求键/,
    );
    assert.throws(
      () => service.start(task.id, p.preparationDigest, "another"),
      /准备已过期|已有活跃/,
    );
    assert.equal(store.list("run").length, 1);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM outbox").get()!.n,
      1,
    );
  } finally {
    store.close();
  }
});
test("pause, resume, cancel retain history and terminal run cannot resume", () => {
  const { store, service } = fixture();
  try {
    const t = service.createTask(input),
      run = service.start(t.id, service.prepare(t.id).preparationDigest, "one");
    assert.equal(service.control(run.id, "pause").status, "paused");
    assert.equal(service.control(run.id, "resume").status, "running");
    assert.equal(service.control(run.id, "cancel").status, "cancelled");
    const count = store.events(run.id).length;
    assert.throws(() => service.control(run.id, "resume"), /不能从/);
    assert.equal(store.events(run.id).length, count);
  } finally {
    store.close();
  }
});
test("rejected delivery increments task version and old delivery cannot be accepted", () => {
  const { store, service } = fixture();
  try {
    const t = service.createTask(input),
      r = service.start(t.id, service.prepare(t.id).preparationDigest, "first"),
      d = service.submit(r.id, "第一版");
    assert.throws(() => service.accept(t.id, d.id, false, ""), /原因/);
    const rejected = service.accept(t.id, d.id, false, "缺少验证");
    assert.equal(rejected.revision, 2);
    assert.throws(() => service.accept(t.id, d.id, true, ""), /当前待验收版本/);
    const second = service.start(
      t.id,
      service.prepare(t.id).preparationDigest,
      "second",
    );
    assert.notEqual(r.id, second.id);
    assert.equal(store.list("run").length, 2);
  } finally {
    store.close();
  }
});
test("task revisions invalidate preparation; Agent runs remain blocked until adapter exists", () => {
  const { store, service } = fixture();
  try {
    const t = service.createTask(input),
      p = service.prepare(t.id);
    service.updateTask(t.id, 1, { ...input, title: "新版本" });
    assert.throws(
      () => service.start(t.id, p.preparationDigest, "stale"),
      /准备已过期/,
    );
    const agent = service.createTask({ ...input, type: "development" });
    assert.equal(service.prepare(agent.id).ready, false);
    assert.throws(
      () =>
        service.start(
          agent.id,
          service.prepare(agent.id).preparationDigest,
          "agent",
        ),
      /未通过/,
    );
    assert.equal(store.list("run").length, 0);
  } finally {
    store.close();
  }
});
test("state persists across reopening and failed transaction leaves no partial state", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiwork-"));
  try {
    const file = join(dir, "state.db");
    let store = new Store(file);
    const service = new WorkService(store);
    const t = service.createTask(input);
    assert.throws(() =>
      store.transaction(() => {
        store.put("task", { ...t, title: "坏版本" });
        store.event("fake", "test", {});
        throw new Error("crash");
      }),
    );
    store.close();
    store = new Store(file);
    assert.equal(store.get<Task>("task", t.id)?.title, input.title);
    assert.equal(store.events("fake").length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("API rejects unauthenticated and cross-origin requests; validates inputs and completes workflow", async () => {
  const { store } = fixture();
  const app = createApp(store, "test-token"),
    auth = { Authorization: "Bearer test-token" };
  try {
    await request(app).get("/api/v1/tasks").expect(401);
    await request(app)
      .get("/api/v1/tasks")
      .set(auth)
      .set("Origin", "https://evil.example")
      .expect(403);
    await request(app)
      .post("/api/v1/tasks")
      .set(auth)
      .send({ title: "" })
      .expect(422);
    const t = (
      await request(app).post("/api/v1/tasks").set(auth).send(input).expect(201)
    ).body;
    const p = (
      await request(app)
        .post(`/api/v1/tasks/${t.id}/prepare`)
        .set(auth)
        .send({})
        .expect(200)
    ).body;
    const r = (
      await request(app)
        .post(`/api/v1/tasks/${t.id}/runs`)
        .set(auth)
        .set("Idempotency-Key", "api")
        .send({ preparationDigest: p.preparationDigest })
        .expect(202)
    ).body;
    const d = (
      await request(app)
        .post(`/api/v1/runs/${r.id}/deliveries`)
        .set(auth)
        .send({ summary: "已验证" })
        .expect(201)
    ).body;
    const accepted = await request(app)
      .post(`/api/v1/tasks/${t.id}/acceptances`)
      .set(auth)
      .send({ deliveryId: d.id, accepted: true })
      .expect(200);
    assert.equal(accepted.body.status, "done");
    await request(app).get("/api/v1/runs/absent").set(auth).expect(404);
  } finally {
    store.close();
  }
});
