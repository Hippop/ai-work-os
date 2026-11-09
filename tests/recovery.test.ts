import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { Supervisor } from "../packages/runtime/supervisor.js";
import {
  loadReceipt,
  pidExists,
  saveReceipt,
  type Lease,
} from "../packages/runtime/receipt.js";
import {
  acquireController,
  inspectRecovery,
} from "../packages/runtime/recovery.js";
import { execute, stopTree } from "../packages/runtime/adapter.js";
import type { Run } from "../packages/domain/index.js";
import { createApp } from "../apps/server/app.js";

const windows = process.platform === "win32";
async function until(check: () => boolean, tick = () => {}, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Recovery fixture timed out");
    tick();
    await new Promise((r) => setTimeout(r, 50));
  }
}
function root() {
  const dir = mkdtempSync(join(tmpdir(), "aiwork-recovery-")),
    repo = join(dir, "repo");
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "answer.txt"), "0");
  execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
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
  return dir;
}
async function controller(root: string, mode: string) {
  const child = fork(resolve("tests/fixtures/controller.ts"), [root, mode], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let errors = "";
  child.stderr?.on("data", (data) => (errors += data.toString()));
  const ready = await new Promise<{
    runId: string;
    taskId: string;
    lease: Lease;
  }>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`Controller did not become ready: ${errors}`)),
      30000,
    );
    child.once("message", (message) => {
      clearTimeout(timer);
      done(message as any);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`Controller exited ${code}: ${errors}`));
    });
  });
  return { child, ...ready };
}
async function killOnly(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, fail) => {
    child.once("exit", () => done());
    child.once("error", fail);
    child.kill("SIGKILL");
  });
}

test(
  "Windows Job contains and stops a detached descendant on normal command exit",
  { skip: !windows },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiwork-job-"));
    let descendant: number | undefined;
    try {
      const pidPath = join(dir, "child.pid");
      const result = await execute(
        process.execPath,
        [
          "-e",
          `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidPath)},String(c.pid));c.unref();`,
        ],
        dir,
        Date.now() + 15000,
        () => {},
      );
      descendant = Number(readFileSync(pidPath, "utf8"));
      assert.equal(result.code, 0, result.stderr);
      assert.equal(pidExists(descendant), false);
    } finally {
      if (descendant && pidExists(descendant))
        process.kill(descendant, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "Windows executor lookup does not use a same-name executable in the task directory",
  { skip: !windows },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiwork-command-"));
    try {
      writeFileSync(join(dir, "node.exe"), "not a valid executable");
      writeFileSync(join(dir, "powershell.exe"), "not a valid executable");
      const result = await execute(
        "node",
        ["-e", 'console.log("trusted-path-executable")'],
        dir,
        Date.now() + 15000,
        () => {},
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), "trusted-path-executable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "Windows managed cancellation waits for the job and detached descendant to stop",
  { skip: !windows },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiwork-job-"));
    let current: ChildProcess | null = null,
      descendant: number | undefined;
    try {
      const pidPath = join(dir, "child.pid");
      const execution = execute(
        process.execPath,
        [
          "-e",
          `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidPath)},String(c.pid));setInterval(()=>{},1000);`,
        ],
        dir,
        Date.now() + 20000,
        (c) => {
          current = c;
        },
      );
      await until(() => existsSync(pidPath));
      descendant = Number(readFileSync(pidPath, "utf8"));
      assert.equal(pidExists(descendant), true);
      await stopTree(current!);
      await execution;
      assert.equal(pidExists(descendant), false);
      assert.equal(current, null);
    } finally {
      if (current) await stopTree(current);
      if (descendant && pidExists(descendant))
        process.kill(descendant, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "hard controller crash preserves worktree and resumes from a verified stopped worker receipt",
  { skip: !windows },
  async () => {
    const dir = root();
    let child: ChildProcess | undefined,
      store: Store | undefined,
      supervisor: Supervisor | undefined;
    try {
      const f = await controller(dir, "hang");
      child = f.child;
      await killOnly(child);
      await until(
        () =>
          !pidExists(f.lease.workerPid) &&
          loadReceipt(f.lease)?.stopped === true,
      ).catch((error) => {
        throw new Error(
          `${error.message}; receipt=${existsSync(f.lease.receiptPath) ? readFileSync(f.lease.receiptPath, "utf8") : "missing"}; workerAlive=${pidExists(f.lease.workerPid)}`,
        );
      });
      store = new Store(join(dir, "state.db"));
      const service = new WorkService(store, {
        available: true,
        version: "fixture",
      });
      supervisor = new Supervisor(store, service, dir, process.execPath, [
        resolve("tests/fixtures/agent.mjs"),
      ]);
      supervisor.start();
      await until(
        () => service.required<Run>("run", f.runId).status === "paused",
        () => supervisor!.tick(),
      );
      const binding = store.get<any>("workspace", f.runId);
      assert.equal(binding.locked, false);
      assert.ok(binding.checkpointDigest);
      assert.equal(store.list("delivery").length, 0);
      service.control(f.runId, "resume");
      await until(
        () =>
          ["succeeded", "failed", "reconciling"].includes(
            service.required<Run>("run", f.runId).status,
          ),
        () => supervisor!.tick(),
      );
      assert.equal(
        service.required<Run>("run", f.runId).status,
        "succeeded",
        JSON.stringify(store.events(f.runId)),
      );
      assert.equal(
        store.get<any>("workspace", f.runId).workspace,
        binding.workspace,
      );
      assert.equal(
        store.list<any>("attempt").filter((a) => a.stepKey === "analyze")
          .length,
        1,
      );
      assert.equal(store.list("delivery").length, 1);
    } finally {
      if (child) await killOnly(child);
      await supervisor?.close();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "lost result recovery rejects mismatched receipts and replays valid steps exactly once",
  { skip: !windows },
  async () => {
    const dir = root();
    let child: ChildProcess | undefined,
      store: Store | undefined,
      supervisor: Supervisor | undefined;
    try {
      const f = await controller(dir, "lost-result");
      child = f.child;
      await until(
        () =>
          !pidExists(f.lease.workerPid) &&
          loadReceipt(f.lease)?.stopped === true,
      );
      await killOnly(child);
      const receipt = loadReceipt(f.lease)!;
      assert.ok(receipt.messages.some((m) => m.type === "result"));
      saveReceipt(f.lease.receiptPath, {
        ...receipt,
        inputDigest: "0".repeat(64),
      });
      store = new Store(join(dir, "state.db"));
      const service = new WorkService(store, {
        available: true,
        version: "fixture",
      });
      supervisor = new Supervisor(store, service, dir, process.execPath, [
        resolve("tests/fixtures/agent.mjs"),
      ]);
      supervisor.start();
      supervisor.tick();
      assert.equal(service.required<Run>("run", f.runId).status, "reconciling");
      assert.equal(store.get<any>("workspace", f.runId).locked, true);
      assert.equal(store.list("delivery").length, 0);
      saveReceipt(f.lease.receiptPath, receipt);
      supervisor.tick();
      supervisor.tick();
      assert.equal(service.required<Run>("run", f.runId).status, "succeeded");
      assert.equal(store.list("delivery").length, 1);
      assert.equal(store.list("attempt").length, 6);
      assert.ok(
        service
          .required<Run>("run", f.runId)
          .steps.every((s) => s.attempts === 1),
      );
      assert.equal(
        store.events(f.runId).filter((e) => e.type === "recovery.verified")
          .length,
        1,
      );
    } finally {
      if (child) await killOnly(child);
      await supervisor?.close();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test("manual reconciliation requires stopped known PIDs, matching code and explicit side effect review", async () => {
  const dir = root(),
    store = new Store(join(dir, "state.db")),
    service = new WorkService(store, { available: true, version: "fixture" });
  try {
    const project = service.createProject({
        name: "Manual recovery",
        repositoryPath: join(dir, "repo"),
        allowAgent: true,
        testCommand: { executable: process.execPath, args: [] },
      }),
      task = service.createTask({
        title: "Uncertain run",
        objective: "Review then resume",
        projectId: project.id,
        acceptanceCriteria: ["Reviewed"],
      });
    const run = service.start(
      task.id,
      service.prepare(task.id).preparationDigest,
      "manual-reconcile",
    );
    service.transition(run.id, "preparing");
    service.transition(run.id, "running");
    service.transition(run.id, "reconciling");
    const epoch = "a0000000-0000-4000-8000-000000000001";
    store.put("workspace", {
      id: run.id,
      epoch,
      workspace: join(dir, "repo"),
      locked: true,
    });
    const lease: Lease = {
      id: run.id,
      epoch,
      workerPid: process.pid,
      inputDigest: "a".repeat(64),
      receiptPath: join(dir, "missing.json"),
      outputDir: dir,
      state: "dispatched",
      createdAt: new Date().toISOString(),
    };
    store.put("execution_lease", lease);
    const app = createApp(store, "recovery-token", service, dir),
      post = (body: object) =>
        request(app)
          .post(`/api/v1/runs/${run.id}/recovery`)
          .set("Authorization", "Bearer recovery-token")
          .send(body);
    const input = {
      expectedEpoch: epoch,
      subjectDigest: inspectRecovery(store, service, run.id).subjectDigest,
      workerStopped: true,
      externalActionsReconciled: true,
      reason: "Checked known processes, repository state and external actions",
    };
    await post(input).expect(409);
    store.put("execution_lease", { ...lease, workerPid: 2147483647 });
    await post({ ...input, externalActionsReconciled: false }).expect(422);
    await post({ ...input, subjectDigest: "0".repeat(64) }).expect(409);
    await post(input).expect(200);
    assert.equal(service.required<Run>("run", run.id).status, "paused");
    assert.equal(store.get<any>("workspace", run.id).locked, false);
    assert.equal(store.list("reconciliation").length, 1);
    assert.ok(
      service
        .required<Run>("run", run.id)
        .steps.every((s) => s.status === "pending"),
    );
    await post(input).expect(409);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("data directory admits only one live controller and supports explicit release", () => {
  const store = new Store(":memory:");
  try {
    const release = acquireController(store);
    assert.throws(() => acquireController(store), /已有控制服务/);
    release();
    const next = acquireController(store);
    release();
    assert.throws(() => acquireController(store), /已有控制服务/);
    next();
    acquireController(store)();
  } finally {
    store.close();
  }
});
test("an absent optional executor does not prevent manual work", async () => {
  const store = new Store(":memory:"),
    service = new WorkService(store, { available: false, version: null }),
    supervisor = new Supervisor(
      store,
      service,
      tmpdir(),
      "aiwork-missing-executor-7ed754a1",
    );
  try {
    const task = service.createTask({
      title: "Manual fallback",
      objective: "Handle a manual task without a CLI",
      type: "manual",
      acceptanceCriteria: ["Recorded"],
    });
    const ready = service.prepare(task.id);
    assert.equal(ready.ready, true);
    assert.equal(
      service.start(task.id, ready.preparationDigest, "manual-fallback").status,
      "running",
    );
    supervisor.tick();
  } finally {
    await supervisor.close();
    store.close();
  }
});
test(
  "recovery refuses altered delivery artifacts even when worker completion was persisted",
  { skip: !windows },
  async () => {
    const dir = root();
    let child: ChildProcess | undefined,
      store: Store | undefined,
      supervisor: Supervisor | undefined;
    try {
      const f = await controller(dir, "lost-result");
      child = f.child;
      await until(
        () =>
          !pidExists(f.lease.workerPid) &&
          loadReceipt(f.lease)?.stopped === true,
      );
      await killOnly(child);
      writeFileSync(
        join(f.lease.outputDir, "changes.patch"),
        "tampered after worker completion",
      );
      store = new Store(join(dir, "state.db"));
      const service = new WorkService(store, {
        available: true,
        version: "fixture",
      });
      supervisor = new Supervisor(store, service, dir, process.execPath, [
        resolve("tests/fixtures/agent.mjs"),
      ]);
      supervisor.start();
      supervisor.tick();
      assert.equal(service.required<Run>("run", f.runId).status, "failed");
      assert.equal(store.list("delivery").length, 0);
      assert.equal(store.get<any>("workspace", f.runId).locked, false);
    } finally {
      if (child) await killOnly(child);
      await supervisor?.close();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "worker hard death retains its lock until explicit owner reconciliation",
  { skip: !windows },
  async () => {
    const dir = root();
    let child: ChildProcess | undefined,
      store: Store | undefined,
      supervisor: Supervisor | undefined;
    try {
      const f = await controller(dir, "hang");
      child = f.child;
      await until(() => !!loadReceipt(f.lease)?.childPid);
      process.kill(f.lease.workerPid, "SIGKILL");
      await until(
        () =>
          !pidExists(f.lease.workerPid) &&
          !pidExists(loadReceipt(f.lease)!.lastChildPid!),
      );
      await killOnly(child);
      store = new Store(join(dir, "state.db"));
      const service = new WorkService(store, {
        available: true,
        version: "fixture",
      });
      supervisor = new Supervisor(store, service, dir, process.execPath, [
        resolve("tests/fixtures/agent.mjs"),
      ]);
      supervisor.start();
      supervisor.tick();
      assert.equal(service.required<Run>("run", f.runId).status, "reconciling");
      assert.equal(store.get<any>("workspace", f.runId).locked, true);
      assert.notEqual(loadReceipt(f.lease)?.stopped, true);
      const view = inspectRecovery(store, service, f.runId);
      await request(createApp(store, "recovery-token", service, dir))
        .post(`/api/v1/runs/${f.runId}/recovery`)
        .set("Authorization", "Bearer recovery-token")
        .send({
          expectedEpoch: view.epoch,
          subjectDigest: view.subjectDigest,
          workerStopped: true,
          externalActionsReconciled: true,
          reason:
            "Fixture process tree is gone; no external actions; reset validation",
        })
        .expect(200);
      assert.equal(service.required<Run>("run", f.runId).status, "paused");
      assert.ok(
        service
          .required<Run>("run", f.runId)
          .steps.every((s) => s.status === "pending"),
      );
    } finally {
      if (child) await killOnly(child);
      await supervisor?.close();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test("crash before dispatch is resolved without claiming any agent execution", async () => {
  const dir = root();
  let child: ChildProcess | undefined,
    store: Store | undefined,
    supervisor: Supervisor | undefined;
  try {
    child = fork(
      resolve("tests/fixtures/controller.ts"),
      [dir, "before-dispatch"],
      { execArgv: ["--import", "tsx"], stdio: "ignore", windowsHide: true },
    );
    const code = await new Promise<number | null>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error("Pre-dispatch controller did not exit")),
        30000,
      );
      child!.once("exit", (code) => {
        clearTimeout(timer);
        done(code);
      });
      child!.once("error", fail);
    });
    assert.equal(code, 137);
    store = new Store(join(dir, "state.db"));
    const service = new WorkService(store, {
        available: true,
        version: "fixture",
      }),
      run = store.list<Run>("run")[0];
    assert.equal(run.status, "preparing");
    assert.equal(store.list("execution_lease").length, 0);
    supervisor = new Supervisor(store, service, dir, process.execPath, [
      resolve("tests/fixtures/agent.mjs"),
    ]);
    supervisor.start();
    supervisor.tick();
    assert.equal(service.required<Run>("run", run.id).status, "failed");
    assert.equal(store.list("attempt").length, 0);
    assert.equal(
      store.events(run.id).filter((e) => e.type === "recovery.not_dispatched")
        .length,
      1,
    );
  } finally {
    if (child) await killOnly(child);
    await supervisor?.close();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
