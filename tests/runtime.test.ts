import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { Supervisor } from "../packages/runtime/supervisor.js";
import { type Run, type Task } from "../packages/domain/index.js";
import request from "supertest";
import { createApp } from "../apps/server/app.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aiwork-runtime-")),
    repo = join(root, "repo");
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "answer.txt"), "0");
  for (const args of [
    ["add", "."],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    ],
  ])
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const store = new Store(join(root, "state.db")),
    service = new WorkService(store, { available: true, version: "fixture" });
  const supervisor = new Supervisor(store, service, root, process.execPath, [
    resolve("tests/fixtures/agent.mjs"),
  ]);
  const project = service.createProject({
    name: "Fixture",
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
  const task = service.createTask({
    title: "Change answer",
    objective: "Write 42 into answer.txt",
    projectId: project.id,
    acceptanceCriteria: ["answer.txt is 42"],
  });
  return { root, repo, store, service, supervisor, task };
}
async function until(check: () => boolean, tick: () => void, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for worker");
    tick();
    await new Promise((r) => setTimeout(r, 50));
  }
}
test("independent worker executes all required stages in isolated worktree and validates exact delivery subject", async () => {
  const f = setup();
  try {
    const run = f.service.start(
      f.task.id,
      f.service.prepare(f.task.id).preparationDigest,
      "fixture",
    );
    await until(
      () =>
        ["succeeded", "failed", "reconciling"].includes(
          f.service.required<Run>("run", run.id).status,
        ),
      () => f.supervisor.tick(),
    );
    const completed = f.service.required<Run>("run", run.id);
    assert.equal(
      completed.status,
      "succeeded",
      JSON.stringify(f.store.events(run.id)),
    );
    assert.ok(completed.steps.every((s) => s.status === "succeeded"));
    assert.equal(readFileSync(join(f.repo, "answer.txt"), "utf8"), "0");
    assert.equal(
      f.service.required<Task>("task", f.task.id).status,
      "awaiting_acceptance",
    );
    const delivery = f.store.list<{ subjectDigest: string }>("delivery")[0];
    assert.match(delivery.subjectDigest, /^[a-f0-9]{64}$/);
    const testEvidence = JSON.parse(
      readFileSync(join(f.root, "artifacts", run.id, "test.json"), "utf8"),
    );
    assert.equal(delivery.subjectDigest, testEvidence.subjectDigest);
    assert.equal(f.store.list("attempt").length, 6);
    const app = createApp(f.store, "artifact-test", f.service, f.root);
    await request(app)
      .get(`/api/v1/runs/${run.id}/artifacts/changes.patch`)
      .set("Authorization", "Bearer artifact-test")
      .expect(200);
    await request(app)
      .get(`/api/v1/runs/${run.id}/artifacts/unknown.txt`)
      .set("Authorization", "Bearer artifact-test")
      .expect(404);
    writeFileSync(
      join(f.root, "artifacts", run.id, "changes.patch"),
      "tampered",
    );
    await request(app)
      .get(`/api/v1/runs/${run.id}/artifacts/changes.patch`)
      .set("Authorization", "Bearer artifact-test")
      .expect(409);
  } finally {
    await f.supervisor.close();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("failed deterministic validation does not create successful delivery", async () => {
  const f = setup();
  try {
    const project = f.store.list<any>("project")[0];
    f.store.put("project", {
      ...project,
      testCommand: {
        executable: process.execPath,
        args: ["-e", "process.exit(1)"],
      },
    });
    const run = f.service.start(
      f.task.id,
      f.service.prepare(f.task.id).preparationDigest,
      "fail",
    );
    await until(
      () => f.service.required<Run>("run", run.id).status === "failed",
      () => f.supervisor.tick(),
    );
    assert.equal(f.store.list("delivery").length, 0);
    assert.equal(readFileSync(join(f.repo, "answer.txt"), "utf8"), "0");
  } finally {
    await f.supervisor.close();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("project authorization and test command are necessary for agent dispatch", async () => {
  const f = setup();
  try {
    const project = f.store.list<any>("project")[0];
    f.store.put("project", { ...project, allowAgent: false });
    assert.equal(f.service.prepare(f.task.id).ready, false);
    f.store.put("project", { ...project, testCommand: undefined });
    assert.equal(f.service.prepare(f.task.id).ready, false);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("cancellation waits for process-tree stop before releasing worktree", async () => {
  const f = setup();
  const previous = process.env.AI_WORK_OS_FIXTURE_HANG;
  process.env.AI_WORK_OS_FIXTURE_HANG = "1";
  try {
    const run = f.service.start(
      f.task.id,
      f.service.prepare(f.task.id).preparationDigest,
      "cancel",
    );
    await until(
      () =>
        f.service
          .required<Run>("run", run.id)
          .steps.some((s) => s.status === "running"),
      () => f.supervisor.tick(),
    );
    f.service.control(run.id, "cancel");
    assert.equal(f.service.required<Run>("run", run.id).status, "cancelling");
    await until(
      () => f.service.required<Run>("run", run.id).status === "cancelled",
      () => f.supervisor.tick(),
    );
    assert.equal(
      f.store.get<{ locked: boolean }>("workspace", run.id)?.locked,
      false,
    );
    assert.equal(f.store.list("delivery").length, 0);
  } finally {
    previous === undefined
      ? delete process.env.AI_WORK_OS_FIXTURE_HANG
      : (process.env.AI_WORK_OS_FIXTURE_HANG = previous);
    await f.supervisor.close();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
