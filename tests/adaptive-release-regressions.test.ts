import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AdaptiveEngine, type Plan } from "../packages/adaptive/engine.js";
import { AdaptiveRuntime } from "../packages/adaptive/runtime.js";
import { AssetService } from "../packages/adaptive/assets.js";
import {
  bootstrapAdaptiveAssets,
  standardAdaptivePlan,
} from "../packages/adaptive/bootstrap.js";
import { createApp } from "../apps/server/app.js";
import { workspaceDigest } from "../packages/workspace/index.js";
import { taskRunLink } from "../apps/web/src/run-navigation.js";
const result = { summary: "Evidence checked", evidence: [], risks: [] };
const delivery: Plan = {
  nodes: [
    {
      id: "deliver",
      capabilityRef: "core.deliver@1.0.0",
      dependsOn: [],
      inputs: { objective: "Deliver" },
      bindings: {},
    },
  ],
  observations: [],
  rationale: "Release regression",
};
const analysis: Plan = {
  ...delivery,
  nodes: [
    {
      id: "analyze",
      capabilityRef: "core.analyze@1.0.0",
      dependsOn: [],
      inputs: { objective: "Inspect" },
      bindings: {},
    },
    { ...delivery.nodes[0], dependsOn: ["analyze"] },
  ],
};
function fixture() {
  const store = new Store(":memory:");
  bootstrapAdaptiveAssets(store);
  const work = new WorkService(store);
  const task = (title: string, extra: object = {}) =>
    work.createTask({
      title,
      type: "manual",
      objective: "Verify release contract",
      acceptanceCriteria: ["Checked"],
      ...extra,
    });
  return { store, work, task };
}
async function drain(engine: AdaptiveEngine, id: string) {
  for (let i = 0; i < 30; i++) {
    await engine.tick();
    if (
      ["failed", "waiting", "reconciling", "awaiting_acceptance"].includes(
        engine.get(id).status,
      )
    )
      return;
  }
}
test("V2 gates upstream dependencies, child acceptance, completed tasks and stale task versions", async () => {
  const { store, work, task } = fixture();
  try {
    const e = new AdaptiveEngine(store, undefined, async () => ({
      output: result,
    }));
    const upstream = task("Unfinished upstream");
    const dependent = task("Dependent", { dependsOn: [upstream.id] });
    assert.throws(() => e.createRun(dependent.id, delivery), /前置任务/);
    const parent = task("Parent");
    const child = task("Child", { parentId: parent.id });
    const run = e.createRun(parent.id, delivery);
    await drain(e, run.id);
    assert.throws(() => e.accept(run.id, true, "Reviewed"), /子任务/);
    const c = e.createRun(child.id, delivery);
    await drain(e, c.id);
    e.accept(c.id, true, "Reviewed");
    e.accept(run.id, true, "Reviewed");
    assert.throws(() => e.cancel(run.id), /已结束/);
    assert.throws(() => e.createRun(parent.id, delivery), /新的任务版本/);
    const r = e.createRun(upstream.id, analysis);
    e.cancel(r.id);
    work.updateTask(upstream.id, upstream.revision, { title: "New revision" });
    assert.throws(
      () =>
        e.adoptWorkspace(
          r.id,
          "0".repeat(64),
          "Explicitly inspected workspace and all processes",
        ),
      /先停止/,
    );
    assert.equal(store.get<any>("task", parent.id).status, "done");
  } finally {
    store.close();
  }
});
test("cancelled and superseded failed runs cannot retry or mutate a newer active task", async () => {
  const { store, task } = fixture();
  try {
    const t = task("Retry interlock");
    const e = new AdaptiveEngine(store, undefined, async () => {
      throw Error("failed read");
    });
    const first = e.createRun(t.id, analysis);
    await drain(e, first.id);
    assert.equal(e.get(first.id).status, "failed");
    const second = e.createRun(t.id, analysis);
    assert.throws(() => e.retry(first.id, "analyze"), /其他活跃/);
    assert.throws(() => e.cancel(first.id), /其他活跃/);
    e.cancel(second.id);
    e.cancel(first.id);
    const third = e.createRun(t.id, analysis);
    assert.throws(() => e.retry(first.id, "analyze"), /不允许重试/);
    e.cancel(first.id);
    assert.equal(store.get<any>("task", t.id).status, "in_progress");
    assert.equal(e.get(third.id).status, "queued");
  } finally {
    store.close();
  }
});
test("artifact tampering blocks authenticated downloads and acceptance; old unverified artifacts fail closed", async () => {
  const { store, work, task } = fixture();
  const root = mkdtempSync(join(tmpdir(), "aiwork-artifact-regression-"));
  const folder = join(root, "adaptive");
  mkdirSync(folder);
  const file = join(folder, "report.txt");
  writeFileSync(file, "original");
  try {
    const e = new AdaptiveEngine(store, undefined, async () => ({
      output: result,
      artifacts: [file],
    }));
    const t = task("Delivery integrity");
    const r = e.createRun(t.id, delivery);
    await drain(e, r.id);
    const app = createApp(store, "secret", work, root, e);
    const url = `/api/v2/adaptive-runs/${r.id}/artifacts/deliver/report.txt`;
    await request(app).get(url).expect(401);
    await request(app)
      .get(url)
      .set("Authorization", "Bearer secret")
      .expect(200);
    writeFileSync(file, "changed");
    await request(app)
      .get(url)
      .set("Authorization", "Bearer secret")
      .expect(409);
    assert.throws(() => e.accept(r.id, true, "Checked"), /摘要已改变/);
    assert.equal(store.get<any>("task", t.id).status, "awaiting_acceptance");
    writeFileSync(file, "original");
    const old = e.get(r.id);
    delete old.results.deliver.artifactDigests;
    store.put("adaptive_run", old);
    await request(app)
      .get(url)
      .set("Authorization", "Bearer secret")
      .expect(409);
    assert.throws(() => e.accept(r.id, true, "Checked"), /缺少原始摘要/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("late evaluator cannot revive a stopped run; paused run resumes explicitly", async () => {
  const { store, task } = fixture();
  try {
    const t = task("Stop evaluator");
    let enter!: () => void, finish!: (v: any) => void;
    const entered = new Promise<void>((r) => (enter = r));
    const e = new AdaptiveEngine(
      store,
      undefined,
      async () => ({ output: result }),
      {
        compose: async () => analysis,
        evaluate: async () => {
          enter();
          return new Promise((r) => (finish = r));
        },
      },
      {
        stop: async () => {
          finish({
            decision: "CONTINUE",
            reason: "Late result",
            affectedNodeIds: [],
            evidenceRefs: [],
          });
        },
        resume: () => {},
      },
    );
    const p = {
      ...analysis,
      observations: [
        {
          id: "check",
          afterNode: "analyze",
          on: ["succeeded" as const],
          barrier: true,
          question: "Check",
          maxInvocations: 1,
        },
      ],
    };
    const r = e.createRun(t.id, p);
    await e.tick();
    const tick = e.tick();
    await entered;
    const stopped = await e.stop(r.id, "pause");
    await tick;
    assert.equal(stopped.status, "paused");
    assert.equal(e.get(r.id).observationStates.check, "waiting");
    e.resume(r.id);
    assert.equal(e.get(r.id).status, "waiting");
    e.resolveWaiting(r.id, "check", {
      decision: "CONTINUE",
      reason: "Human reviewed",
    });
    await drain(e, r.id);
    assert.equal(e.get(r.id).status, "awaiting_acceptance");
  } finally {
    store.close();
  }
});
test("run navigation selects the active backend and latest finished run", () => {
  const legacy = [
    {
      id: "old",
      taskId: "task",
      status: "succeeded",
      createdAt: "2026-11-12T01:00:00Z",
    },
  ];
  const adaptive = [
    {
      id: "new",
      taskId: "task",
      status: "waiting",
      createdAt: "2026-11-12T02:00:00Z",
    },
  ];
  assert.equal(taskRunLink("task", legacy, adaptive)?.engine, "adaptive");
  assert.equal(taskRunLink("missing", legacy, adaptive), undefined);
  assert.equal(
    taskRunLink("task", legacy, [{ ...adaptive[0], status: "done" }])?.id,
    "new",
  );
});
function repository(root: string) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repo, ...a], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Regression");
  git("config", "user.email", "regression@example.invalid");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "README.md"), "# Fixture\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  return repo;
}
test("standard flow passes design and real test evidence to agents and initializes fresh worktree once", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-flow-regression-"));
  const { store, work, task } = fixture();
  let runtime: AdaptiveRuntime | undefined;
  try {
    const repo = repository(root),
      fake = join(root, "fake-codex.cjs");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
 const fs=require('fs'),path=require('path'),a=process.argv.slice(2),p=a.at(-1),cwd=a[a.indexOf('-C')+1];
 let output={summary:'Checked',evidence:[],risks:[]};
 if(p.includes('READ-ONLY progress evaluation'))output={decision:'CONTINUE',reason:'Checked evidence',affectedNodeIds:[],evidenceRefs:[]};
 else if(p.includes('Capability: core.design@'))output.summary='DESIGN_DECISION_739';
 else if(p.includes('Capability: core.implement@')){
   if(!p.includes('DESIGN_DECISION_739'))process.exit(31);
   if(!fs.existsSync(path.join(cwd,'node_modules','fixture','index.js')))process.exit(32);
   fs.writeFileSync(path.join(cwd,'feature.txt'),'implemented');
 }else if(p.includes('Capability: core.review@')){if(!p.includes('REAL_TEST_EVIDENCE_739'))process.exit(33);}
 fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify(output));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}));
 `,
      { mode: 0o700 },
    );
    chmodSync(fake, 0o700);
    const project = work.createProject({
      name: "Initialized fixture",
      repositoryPath: repo,
      allowAgent: true,
      setupCommand: {
        executable: process.execPath,
        args: [
          "-e",
          "const fs=require('fs');fs.mkdirSync('node_modules/fixture',{recursive:true});fs.writeFileSync('node_modules/fixture/index.js','module.exports=true');",
        ],
      },
      testCommand: {
        executable: process.execPath,
        args: [
          "-e",
          "require('fixture');if(!require('fs').existsSync('feature.txt'))process.exit(1);console.log('REAL_TEST_EVIDENCE_739')",
        ],
      },
    });
    const t = task("Full default flow", {
      type: "development",
      projectId: project.id,
    });
    runtime = new AdaptiveRuntime(store, join(root, "data"), fake);
    const e = new AdaptiveEngine(
      store,
      undefined,
      runtime.executor(),
      runtime.planner(),
      runtime.control(),
    );
    const r = e.createRun(t.id, standardAdaptivePlan(t));
    await drain(e, r.id);
    assert.equal(
      e.get(r.id).status,
      "awaiting_acceptance",
      JSON.stringify(e.get(r.id).failures),
    );
    assert.equal(
      store
        .events(r.id)
        .filter((x) => x.type === "adaptive.workspace.setup_completed").length,
      1,
    );
    e.accept(r.id, true, "Reviewed actual evidence");
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# Fixture\n");
  } finally {
    await runtime?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("workspace recovery checks digest, preserves interrupted write and reruns tests without replaying write", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-adopt-regression-"));
  const { store, task } = fixture();
  try {
    const repo = repository(root);
    const t = task("Recovery", { type: "development" });
    let writes = 0,
      tests = 0;
    const e = new AdaptiveEngine(
      store,
      new AssetService(store),
      async ({ node }) => {
        if (node.id === "implement") {
          writes++;
          writeFileSync(join(repo, "feature.txt"), "partial work");
          throw Error("interrupted");
        }
        if (node.id === "test") tests++;
        return { output: result };
      },
    );
    const p = standardAdaptivePlan(t);
    p.observations = [];
    const r = e.createRun(t.id, p);
    store.put("adaptive_workspace", {
      id: r.id,
      path: repo,
      setupState: "complete",
    });
    await drain(e, r.id);
    assert.equal(e.get(r.id).status, "reconciling");
    assert.throws(
      () =>
        e.adoptWorkspace(
          r.id,
          workspaceDigest(repo),
          "Confirmed all processes and inspected changes",
        ),
      /先停止/,
    );
    e.reconcileUncertain(
      r.id,
      "implement",
      true,
      "Inspected processes and all workspace changes",
    );
    const digest = workspaceDigest(repo);
    writeFileSync(join(repo, "feature.txt"), "manually repaired");
    assert.throws(
      () =>
        e.adoptWorkspace(
          r.id,
          digest,
          "Confirmed all processes and inspected changes",
        ),
      /已改变/,
    );
    e.adoptWorkspace(
      r.id,
      workspaceDigest(repo),
      "Confirmed all processes, repaired implementation, reviewed local dependencies",
    );
    await drain(e, r.id);
    assert.equal(e.get(r.id).status, "awaiting_acceptance");
    assert.equal(writes, 1);
    assert.equal(tests, 1);
    assert.ok(
      store
        .list<any>("adaptive_invocation")
        .some((i) => i.kind === "workspace-adoption" && i.actor === "user"),
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("stopping a real program affects only its own run and leaves another run running", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-stop-regression-"));
  const { store, work, task } = fixture();
  let runtime: AdaptiveRuntime | undefined;
  try {
    const repo = repository(root);
    const command = {
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
    };
    const project = work.createProject({
      name: "Real stop",
      repositoryPath: repo,
      allowAgent: true,
      authorizedCommands: [{ name: "wait", ...command }],
    });
    const assets = new AssetService(store);
    const profile = assets.publishProfile(
      assets.createProfile({
        name: "wait",
        version: "1.0.0",
        executor: "program",
        workspaceMode: "read-only",
        program: command,
      }).id,
    );
    const p = {
      ...analysis,
      nodes: analysis.nodes.map((n) =>
        n.id === "analyze" ? { ...n, profileRef: profile.id } : n,
      ),
    };
    runtime = new AdaptiveRuntime(store, join(root, "data"));
    const e = new AdaptiveEngine(
      store,
      assets,
      runtime.executor(),
      undefined,
      runtime.control(),
    );
    const one = e.createRun(task("Stop one", { projectId: project.id }).id, p),
      two = e.createRun(task("Keep two", { projectId: project.id }).id, p);
    const running = e.tick();
    const deadline = Date.now() + 5000;
    while (
      store
        .events(one.id)
        .every((x) => x.type !== "adaptive.process.started") ||
      store.events(two.id).every((x) => x.type !== "adaptive.process.started")
    ) {
      assert.ok(Date.now() < deadline, "programs did not start");
      await new Promise((r) => setTimeout(r, 10));
    }
    // tick awaits all jobs; each per-run busy flag still settles independently.
    const first = await e.stop(one.id, "pause");
    assert.equal(first.status, "paused");
    assert.equal(e.get(two.id).nodeStates.analyze, "running");
    await e.stop(two.id, "cancel");
    await running;
    assert.equal(e.get(two.id).status, "cancelled");
    assert.equal(e.get(one.id).status, "paused");
    e.cancel(one.id);
  } finally {
    await runtime?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("existing project configuration can be cleared but is locked during active runs; preflight is read only", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-config-regression-"));
  const { store, work, task } = fixture();
  try {
    const repo = repository(root);
    const project = work.createProject({
      name: "Config",
      repositoryPath: repo,
      allowAgent: true,
    });
    work.configureProject(project.id, {
      setupCommand: {
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    });
    const t = task("Preflight", { projectId: project.id });
    const runtime = new AdaptiveRuntime(
      store,
      join(root, "data"),
      join(root, "missing-codex"),
    );
    const report = runtime.preflight(t, analysis);
    assert.equal(report.ready, false);
    assert.ok(report.checks.some((c) => c.label === "codex CLI" && !c.passed));
    assert.equal(store.list("adaptive_run").length, 0);
    const e = new AdaptiveEngine(store, undefined, async () => ({
      output: result,
    }));
    const r = e.createRun(t.id, delivery);
    assert.throws(
      () => work.configureProject(project.id, { allowAgent: false }),
      /活跃运行/,
    );
    e.cancel(r.id);
    const cleared = work.configureProject(project.id, { setupCommand: null });
    assert.equal(cleared.setupCommand, undefined);
    assert.equal(cleared.allowAgent, true);
    assert.throws(
      () => work.configureProject(project.id, { repositoryPath: "/tmp/other" }),
      /Unrecognized|unrecognized/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("retry rejects a failed run after task revision changes", async () => {
  const { store, work, task } = fixture();
  try {
    const t = task("Stale failure");
    const e = new AdaptiveEngine(store, undefined, async () => {
      throw Error("read failed");
    });
    const r = e.createRun(t.id, analysis);
    await drain(e, r.id);
    work.updateTask(t.id, t.revision, { title: "Revised task" });
    assert.throws(() => e.retry(r.id, "analyze"), /任务版本/);
    assert.equal(store.get<any>("task", t.id).revision, 2);
  } finally {
    store.close();
  }
});
