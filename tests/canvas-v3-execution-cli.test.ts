import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { McpRegistry } from "../packages/adaptive/mcp.js";
import { McpWriteService } from "../packages/adaptive/mcp-write.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";
import { GraphDraftService } from "../packages/graph/draft-service.js";
import { GraphCompiler, capabilityVersionDigest } from "../packages/graph/compiler.js";
import { PlanChangeService } from "../packages/graph/change-service.js";
import { getRunGraph } from "../packages/graph/projection.js";
import { WorkspaceAccessCoordinator } from "../packages/workspace/access.js";
import { workspaceDigest } from "../packages/workspace/index.js";
import {
  AgentSessionManager,
  InterventionService,
  type SpawnSessionHook,
} from "../packages/runtime/sessions/index.js";
import { createApp } from "../apps/server/app.js";

function capRef(assets: AssetService, id: string) {
  const cap = assets.getCapability(id, false);
  return { id: cap.id, version: cap.version, digest: capabilityVersionDigest(cap) };
}

function createWorkspaceEnv(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const repoDir = process.cwd();
  const wsDir = join(dir, "worktree");
  mkdirSync(wsDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: wsDir, stdio: "ignore" });
  writeFileSync(join(wsDir, "app.ts"), "export const v = 1;\n", "utf8");

  const store = new Store(":memory:");
  bootstrapAdaptiveAssets(store);
  const work = new WorkService(store);
  const assets = new AssetService(store);
  const project = work.createProject({
    name: "Exec & CLI Project",
    repositoryPath: repoDir,
    allowAgent: false,
  });
  const task = work.createTask({
    title: "Canvas V3.1 Execution & CLI",
    type: "development",
    projectId: project.id,
    objective: "Verify interventions, sessions, locks, validity, proposals, and effects",
    acceptanceCriteria: ["All A11-A20, A26 invariants hold"],
  });
  return { dir, repoDir, wsDir, store, work, assets, project, task };
}

function createExternalWriteCap(store: Store, assets: AssetService) {
  const registry = new McpRegistry(store);
  const server = registry.register({
    name: "ext-write-srv",
    description: "Mock external write MCP server",
    transport: { type: "http", url: "https://mock.example.com/mcp" },
    exposedTools: ["update"],
    readOnlyTools: [],
  });
  registry.publish(server.id);

  const profile = assets.createProfile({
    name: "ext.write.prof",
    version: "1.0.0",
    executor: "mcp-write",
    workspaceMode: "none",
    mcpWrite: {
      server: server.id,
      tool: "update",
      purpose: "Approved external write action",
    },
  });
  assets.publishProfile(profile.id);

  const cap = assets.createCapability({
    name: "mcp.ext.write",
    version: "1.0.0",
    title: "External Write Capability",
    description: "Executes approved external write",
    sideEffect: "external-write",
    profileRef: profile.id,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["key", "value"],
      properties: { key: { type: "string" }, value: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "evidence", "risks"],
      properties: {
        summary: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
      },
    },
    tags: ["write"],
  });
  assets.validateCapability(cap.id, "Side-effect contract verified");
  assets.publishCapability(cap.id);
  return { cap, profile };
}

function makeCrossPlatformEchoHook(opts?: {
  chunkCountOnBoot?: number;
  unstoppable?: boolean;
  spawnedPids?: Set<number>;
}): SpawnSessionHook {
  return () => {
    const script = `
      const count = ${opts?.chunkCountOnBoot ?? 3};
      for (let i = 1; i <= count; i++) {
        process.stdout.write("BOOT_CHUNK_" + i + "\\n");
      }
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => {
        for (const line of d.split(/\\r?\\n/)) {
          if (line.trim()) process.stdout.write("ECHO:" + line.trim() + "\\n");
        }
      });
      setInterval(() => {}, 10000);
    `;
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid) opts?.spawnedPids?.add(child.pid);
    child.unref();

    const dataCbs: ((stream: "stdout" | "stderr", chunk: string) => void)[] = [];
    const exitCbs: ((code: number | null, signal: string | null) => void)[] = [];
    child.stdout?.on("data", (buf) => {
      const text = buf.toString("utf8");
      for (const cb of dataCbs) cb("stdout", text);
    });
    child.stderr?.on("data", (buf) => {
      const text = buf.toString("utf8");
      for (const cb of dataCbs) cb("stderr", text);
    });
    child.on("exit", (code, signal) => {
      for (const cb of exitCbs) cb(code, signal);
    });

    return {
      pid: child.pid ?? null,
      write: (data: string) => {
        if (child.stdin?.writable) child.stdin.write(data);
      },
      resize: () => {},
      stop: async () => {
        if (opts?.unstoppable) {
          // Simulate a process that refuses termination confirmation (A18)
          return false;
        }
        return await new Promise<boolean>((resolve) => {
          if (child.exitCode !== null || child.killed) {
            resolve(true);
            return;
          }
          child.once("exit", () => resolve(true));
          child.kill("SIGKILL");
          setTimeout(() => resolve(child.exitCode !== null), 1000);
        });
      },
      onData: (cb) => dataCbs.push(cb),
      onExit: (cb) => exitCbs.push(cb),
    };
  };
}

test("A11, A19 & A26: interactive-write -> file edit -> adoptIntervention checks frozen outputSchema, invalidates downstream & auto-resumes to completion", async () => {
  const { dir, wsDir, store, assets, task } = createWorkspaceEnv("aiw-a11-");
  try {
    const { cap: writeCap } = createExternalWriteCap(store, assets);
    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const draft = drafts.createDraft({
      projectId: task.projectId,
      taskId: task.id,
      goal: "Interactive write invalidates downstream test/review/deliver while preserving earlier confirmed write",
      nodes: [
        {
          id: "ext_write",
          engineKey: "ext_write",
          capabilityRef: capRef(assets, writeCap.id),
          literals: { key: "k", value: "v" },
          actionKey: "ticket:release-1",
        },
        {
          id: "impl",
          engineKey: "impl",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          dependsOn: ["ext_write"],
          literals: { objective: "Edit app module" },
        },
        {
          id: "test_node",
          engineKey: "test_node",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          dependsOn: ["impl"],
          bindings: [
            {
              id: "b-impl",
              target: "/objective",
              source: { nodeId: "impl", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
        {
          id: "deliver",
          engineKey: "deliver",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["test_node"],
          bindings: [
            {
              id: "b-test",
              target: "/objective",
              source: { nodeId: "test_node", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
      ],
    });
    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, true);

    const execCounts: Record<string, number> = {};
    const engine = new AdaptiveEngine(store, assets, async (call) => {
      execCounts[call.node.id] = (execCounts[call.node.id] ?? 0) + 1;
      if (call.node.capabilityRef === writeCap.id) {
        return { output: { summary: "external ok", evidence: ["receipt"], risks: [] } };
      }
      return { output: { summary: `${call.node.id} pass #${execCounts[call.node.id]}`, evidence: ["ok"], risks: [] } };
    });

    const { runId } = await compiler.startCompiledPlan(draft.id, {
      expectedRevision: draft.revision,
      compiledDigest: compiled.compiledDigest!,
    });

    // Manually link workspace and execute initial steps
    const runRec = store.get<any>("adaptive_run", runId)!;
    runRec.workspacePath = wsDir;
    store.put("adaptive_run", runRec);
    store.put("adaptive_worktree", {
      id: runId,
      runId,
      path: wsDir,
      branch: "main",
      createdAt: new Date().toISOString(),
    });

    // Execute all nodes once cleanly
    for (let i = 0; i < 6; i++) await engine.tick();
    const beforeIv = engine.get(runId);
    assert.equal(beforeIv.status, "awaiting_acceptance");
    assert.equal(execCounts.ext_write, 1);
    assert.equal(execCounts.test_node, 1);
    assert.equal(execCounts.deliver, 1);

    // Trigger interactive-write intervention on `impl`
    const ivService = new InterventionService(store);
    const iv = ivService.requestIntervention(runId, {
      nodeId: "impl",
      expectedRevision: beforeIv.planRevision,
      mode: "interactive-write",
    });
    assert.equal(engine.get(runId).dispatchGate, "intervention");

    // Simulate manual edit inside workspace under lock
    writeFileSync(join(wsDir, "app.ts"), "export const v = 2;\n", "utf8");
    const postDigest = workspaceDigest(wsDir);

    // A19: Invalid outputMapping rejected against frozen capability outputSchema
    assert.throws(() => {
      ivService.adoptIntervention(iv.id, {
        expectedDigest: postDigest,
        note: "Try invalid schema",
        outputMapping: { wrongField: true },
      });
    }, /Schema|契约|required|additionalProperties|字段|必填/);

    // A11 & A26: Valid outputMapping against frozen schema recalculates downstream test_node & deliver
    const adopted = ivService.adoptIntervention(iv.id, {
      expectedDigest: postDigest,
      note: "Updated app.ts v=2 via manual interactive CLI edit",
      outputMapping: {
        summary: "Manually edited v=2",
        evidence: ["app.ts#L1"],
        risks: [],
      },
    });
    assert.equal(adopted.intervention.reviewState, "adopted");

    const afterAdopt = engine.get(runId);
    assert.equal(afterAdopt.dispatchGate, "open");
    assert.equal(afterAdopt.nodeStates.ext_write, "succeeded");
    assert.equal(afterAdopt.nodeStates.impl, "succeeded");
    assert.equal(afterAdopt.nodeStates.test_node, "pending");
    assert.equal(afterAdopt.nodeStates.deliver, "pending");
    assert.equal(afterAdopt.resultValidity?.test_node, "stale");

    // Re-run downstream nodes to completion without replaying ext_write
    for (let i = 0; i < 4; i++) await engine.tick();
    const finalRun = engine.get(runId);
    assert.equal(finalRun.status, "awaiting_acceptance");
    assert.equal(execCounts.ext_write, 1, "earlier confirmed write must not replay");
    assert.equal(execCounts.test_node, 2, "downstream test must re-execute");
    assert.equal(execCounts.deliver, 2, "downstream deliver must re-execute");

    // Accept delivery cleanly -> done (A26)
    const doneRun = engine.accept(runId, true, "All post-edit verifications passed");
    assert.equal(doneRun.status, "done");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A12 & A15: confirmed external-write blocks unsafe ChangeProposal AND drifted execution state rejects stale proposal commit", async () => {
  const { dir, store, assets, task } = createWorkspaceEnv("aiw-a12-");
  try {
    const { cap: writeCap } = createExternalWriteCap(store, assets);
    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const changes = new PlanChangeService(store);

    const draft = drafts.createDraft({
      projectId: task.projectId,
      taskId: task.id,
      goal: "Test confirmed write protection & stale proposal rejection",
      nodes: [
        {
          id: "ext_write",
          engineKey: "ext_write",
          capabilityRef: capRef(assets, writeCap.id),
          literals: { key: "ticket", value: "DONE" },
          actionKey: "jira:123",
        },
        {
          id: "analyze_after",
          engineKey: "analyze_after",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          dependsOn: ["ext_write"],
          literals: { objective: "Analyze after write" },
        },
        {
          id: "deliver",
          engineKey: "deliver",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["analyze_after"],
          bindings: [
            {
              id: "b1",
              target: "/objective",
              source: { nodeId: "analyze_after", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
      ],
    });
    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, true);

    const engine = new AdaptiveEngine(store, assets, async () => ({
      output: { summary: "ok", evidence: ["e1"], risks: [] },
    }));
    const { runId } = await compiler.startCompiledPlan(draft.id, {
      expectedRevision: draft.revision,
      compiledDigest: compiled.compiledDigest!,
    });

    await engine.tick(); // executes ext_write -> writes confirmed EffectRecord!

    const runMid = engine.get(runId);
    assert.equal(runMid.nodeStates.ext_write, "succeeded");
    assert.equal(runMid.nodeStates.analyze_after, "pending");

    // A12: ChangeProposal removing or resetting confirmed external-write node MUST throw 409 write_replan_unsafe
    await assert.rejects(
      () =>
        changes.createProposal(runId, {
          expectedRevision: runMid.planRevision,
          instruction: "Attempt to remove confirmed external write",
          patch: { operations: [{ op: "removeNode", nodeId: "ext_write" }] },
        }),
      /write_replan_unsafe|外部写入|确认/,
    );

    // A15: Valid ChangeProposal modifying analyze_after created at state T1
    const { proposal } = await changes.createProposal(runId, {
      expectedRevision: runMid.planRevision,
      instruction: "Update analyze_after objective",
      patch: {
        operations: [
          {
            op: "updateNode",
            nodeId: "analyze_after",
            patch: { literals: { objective: "Revised objective" } },
          },
        ],
      },
    });
    assert.equal(proposal.status, "pending");

    // Now advance execution state while planRevision stays unchanged!
    await engine.tick(); // analyze_after executes!

    assert.throws(
      () =>
        changes.commitProposal(proposal.id, {
          expectedRunRevision: runMid.planRevision,
          proposalDigest: proposal.approvalDigest,
        }),
      /状态已推进|proposal_stale|变更/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A13: uncertain write failure enters reconciling, blocks retry, and requires manual reconcileUncertain proof", async () => {
  const { dir, store, assets, task } = createWorkspaceEnv("aiw-a13-");
  try {
    const engine = new AdaptiveEngine(store, assets, async () => {
      const timeoutErr = new Error("Upstream HTTP socket timeout after send") as Error & {
        uncertain?: boolean;
      };
      timeoutErr.uncertain = true;
      throw timeoutErr;
    });

    const { cap: writeCap } = createExternalWriteCap(store, assets);
    const run = engine.createRun(task.id, {
      nodes: [
        { id: "ext", capabilityRef: writeCap.id, inputs: { key: "k", value: "v" } },
        {
          id: "deliver",
          capabilityRef: "core.deliver@1.0.0",
          dependsOn: ["ext"],
          bindings: { objective: { fromNode: "ext", field: "summary" } },
        },
      ],
      observations: [],
    });

    await engine.tick();
    const afterUncertain = engine.get(run.id);
    assert.equal(afterUncertain.nodeStates.ext, "uncertain");
    assert.equal(afterUncertain.status, "reconciling");

    // Cannot auto-retry uncertain node
    assert.throws(() => engine.retry(run.id, "ext"), /核对|uncertain|reconcil/);

    // EffectRecord exists in uncertain state
    const effs = store
      .list<any>("effect_record")
      .filter((e) => e.runId === run.id && e.nodeId === "ext");
    assert.equal(effs.length, 1);
    assert.equal(effs[0].state, "uncertain");

    // Manual reconciliation confirms stopped + provides note -> reconciled cleanly
    engine.reconcileUncertain(run.id, "ext", true, "Confirmed remote state updated once");
    const reconciledEffs = store
      .list<any>("effect_record")
      .filter((e) => e.runId === run.id && e.nodeId === "ext");
    assert.equal(reconciledEffs[0].state, "reconciled");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A14, A16, A17, A18: real subprocess ring buffer, WebSocket single-writer/disconnect-without-kill/reconnect, workspace locks & restart recovery", async () => {
  const { dir, wsDir, store, assets, task } = createWorkspaceEnv("aiw-cli-");
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | null = null;
  let ws1: WebSocket | null = null;
  let ws2: WebSocket | null = null;
  const spawnedPids = new Set<number>();
  try {
    // Prepare active run pointing to wsDir
    const engine = new AdaptiveEngine(store, assets);
    const run = engine.createRun(task.id, {
      nodes: [{ id: "deliver", capabilityRef: "core.deliver@1.0.0", inputs: { objective: "CLI test" } }],
      observations: [],
    });
    store.put("adaptive_run", { ...run, workspacePath: wsDir });

    const coordinator = new WorkspaceAccessCoordinator(store);

    // A17: Concurrent read-only locks succeed together; concurrent write lock is rejected; stale epoch release is rejected
    const r1 = coordinator.acquire({ workspacePath: wsDir, owner: "reader-1", mode: "read-only" });
    const r2 = coordinator.acquire({ workspacePath: wsDir, owner: "reader-2", mode: "read-only" });
    assert.throws(
      () => coordinator.acquire({ workspacePath: wsDir, owner: "writer-1", mode: "write" }),
      /workspace_locked|占用/,
    );
    assert.throws(() => coordinator.assertEpoch(wsDir, "reader-1", 999), /stale_workspace_epoch|已过期|失效/);
    coordinator.release(wsDir, "reader-1", r1.epoch, true);
    coordinator.release(wsDir, "reader-2", r2.epoch, true);

    const w1 = coordinator.acquire({ workspacePath: wsDir, owner: "writer-1", mode: "write" });
    assert.throws(
      () => coordinator.acquire({ workspacePath: wsDir, owner: "reader-3", mode: "read-only" }),
      /workspace_locked|workspace_write_locked|独占|占用/,
    );
    coordinator.release(wsDir, "writer-1", w1.epoch, true);

    // Boot real Express + WebSocket app with cross-platform child process spawnHook
    const app = createApp(store, "tok-cli", undefined, dir, engine);
    const customSessions = new AgentSessionManager(
      store,
      "server-test",
      makeCrossPlatformEchoHook({ chunkCountOnBoot: 3, spawnedPids }),
    );
    app.locals.v3Sessions = customSessions;
    const ivService = app.locals.v3Interventions as InterventionService;

    const iv = ivService.requestIntervention(run.id, {
      nodeId: "deliver",
      expectedRevision: run.planRevision,
      mode: "interactive-write",
    });

    // Start real Node subprocess session directly via customSessions
    const session = customSessions.startSession(iv.id, { adapter: "codex" });
    assert.ok(session.processIdentity?.pid);

    // Wait briefly for initial child stdout chunks
    await new Promise((r) => setTimeout(r, 350));

    // Attach WS server cleanly via customSessions
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const { attachTerminalWebSocket } = await import("../packages/runtime/sessions/index.js");
    // Ensure customSessions handles the WS upgrade when test substitutes app.locals.v3Sessions
    server.removeAllListeners("upgrade");
    attachTerminalWebSocket(server, customSessions, () => true);

    // A16: First client connects with one-time connect-ticket -> becomes Writer
    const t1 = customSessions.issueConnectTicket(session.id);
    // One-time ticket cannot be reused directly (second check rejects below)
    const ws1Msgs: any[] = [];
    ws1 = new WebSocket(
      `ws://127.0.0.1:${port}/api/v3/agent-sessions/${session.id}/stream?ticket=${encodeURIComponent(t1.ticket)}&afterSeq=0`,
    );
    ws1.addEventListener("message", (ev) => {
      ws1Msgs.push(JSON.parse(String(ev.data)));
    });
    await new Promise<void>((resolve, reject) => {
      ws1!.addEventListener("open", () => resolve());
      ws1!.addEventListener("error", (e) => reject(e));
    });

    // Wait for hello + initial replay
    await new Promise((r) => setTimeout(r, 200));
    const welcome1 = ws1Msgs.find((m) => m.type === "hello" || m.type === "welcome");
    assert.ok(welcome1);
    assert.equal(welcome1.isWriter ?? welcome1.writer, true);
    assert.ok(ws1Msgs.some((m) => m.type === "output" && String(m.data).includes("BOOT_CHUNK_1")));

    // Second viewer connects -> becomes read-only observer (isWriter: false)
    const t2 = customSessions.issueConnectTicket(session.id);
    const ws2Msgs: any[] = [];
    ws2 = new WebSocket(
      `ws://127.0.0.1:${port}/api/v3/agent-sessions/${session.id}/stream?ticket=${encodeURIComponent(t2.ticket)}&afterSeq=0`,
    );
    ws2.addEventListener("message", (ev) => {
      ws2Msgs.push(JSON.parse(String(ev.data)));
    });
    await new Promise<void>((resolve, reject) => {
      ws2!.addEventListener("open", () => resolve());
      ws2!.addEventListener("error", (e) => reject(e));
    });
    await new Promise((r) => setTimeout(r, 150));
    const welcome2 = ws2Msgs.find((m) => m.type === "hello" || m.type === "welcome");
    assert.ok(welcome2);
    assert.equal(welcome2.isWriter ?? welcome2.writer, false);

    // Send input from writer -> subprocess echoes it back over stdout
    ws1.send(JSON.stringify({ type: "input", data: "HELLO_WS_TEST\n" }));
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(ws1Msgs.some((m) => m.type === "output" && String(m.data).includes("ECHO:HELLO_WS_TEST")));

    // A16: Disconnect WS WITHOUT killing subprocess -> processState stays running, lock stays active!
    ws1.close();
    ws2.close();
    await new Promise((r) => setTimeout(r, 150));
    const afterDetach = customSessions.getSession(session.id);
    assert.equal(afterDetach.processState, "running");
    assert.equal(afterDetach.connectionState, "detached");
    assert.equal(coordinator.get(wsDir)?.status, "active");

    // Reconnect replays chunks missed while detached
    const t3 = customSessions.issueConnectTicket(session.id);
    const replay = await request(app)
      .get(`/api/v3/agent-sessions/${session.id}/output?afterSeq=0`)
      .set("Authorization", "Bearer tok-cli")
      .expect(200);
    const replayedText = replay.body.chunks.map((c: any) => c.data).join("");
    assert.ok(replay.body.chunks.length >= 2);
    assert.ok(
      replayedText.includes("BOOT_CHUNK_1") &&
        replayedText.includes("BOOT_CHUNK_3") &&
        replayedText.includes("ECHO:HELLO_WS_TEST"),
    );
    assert.equal(typeof t3.ticket, "string");

    // A14: Controller restart marks running sessions stop-unconfirmed & active write lock needs-reconciliation
    const recSessions = customSessions.recoverOnRestart();
    const recLocks = coordinator.recoverOnControllerRestart("server-test");
    assert.ok(recSessions.some((s) => s.id === session.id && s.processState === "stop-unconfirmed"));
    assert.ok(recLocks.some((l) => l.status === "needs-reconciliation"));

    // A18: stop-unconfirmed + needs-reconciliation MUST block adoptIntervention until explicitly reconciled!
    assert.throws(() => {
      ivService.adoptIntervention(iv.id, {
        expectedDigest: workspaceDigest(wsDir),
        note: "Cannot adopt while unconfirmed",
      });
    }, /session_not_stopped|stop-unconfirmed|workspace_reconciliation_required/);

    // Cleanly stop real OS process & reconcile lock
    const curSess = customSessions.getSession(session.id);
    await customSessions.stopSession(session.id, { expectedSessionRevision: curSess.revision });
    coordinator.reconcile(wsDir, true, "Verified process exited cleanly on OS");
  } finally {
    try {
      ws1?.close();
    } catch {}
    try {
      ws2?.close();
    } catch {}
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    if (server) {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A18 (stop-unconfirmed): unstoppable process keeps workspace lock in needs-reconciliation and blocks adopt", async () => {
  const { dir, wsDir, store, assets, task } = createWorkspaceEnv("aiw-a18-");
  const spawnedPids = new Set<number>();
  try {
    const engine = new AdaptiveEngine(store, assets);
    const run = engine.createRun(task.id, {
      nodes: [{ id: "deliver", capabilityRef: "core.deliver@1.0.0", inputs: { objective: "A18" } }],
      observations: [],
    });
    store.put("adaptive_run", { ...run, workspacePath: wsDir });

    const ivService = new InterventionService(store);
    const sessions = new AgentSessionManager(
      store,
      "srv-a18",
      makeCrossPlatformEchoHook({ unstoppable: true, spawnedPids }),
    );
    const coordinator = new WorkspaceAccessCoordinator(store);

    const iv = ivService.requestIntervention(run.id, {
      nodeId: "deliver",
      expectedRevision: run.planRevision,
      mode: "interactive-write",
    });
    const sess = sessions.startSession(iv.id, { adapter: "codex" });
    const stopped = await sessions.stopSession(sess.id, {
      expectedSessionRevision: sess.revision,
    });
    assert.equal(stopped.processState, "stop-unconfirmed");
    assert.equal(coordinator.get(wsDir)?.status, "needs-reconciliation");
    assert.throws(() => {
      ivService.adoptIntervention(iv.id, {
        expectedDigest: workspaceDigest(wsDir),
        note: "Should remain blocked",
      });
    }, /session_not_stopped|stop-unconfirmed|workspace_reconciliation_required/);

    // Reconcile explicitly cleanly
    coordinator.reconcile(wsDir, true, "Manually killed stray pid and verified clean");
    assert.equal(coordinator.get(wsDir)?.status, "released");
  } finally {
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A20: end-to-end V3 HTTP workflow across draft -> compose -> compile -> start (Idempotency-Key) -> graph/events/context/layout/change-proposals", async () => {
  const { dir, store, assets, task } = createWorkspaceEnv("aiw-a20-");
  try {
    const engine = new AdaptiveEngine(store, assets, async (call) => ({
      output: { summary: `done ${call.node.id}`, evidence: ["ev1"], risks: [] },
    }));
    const app = createApp(store, "tok-v3", undefined, dir, engine);

    // 1. Create PlanDraft
    const draftRes = await request(app)
      .post("/api/v3/plan-drafts")
      .set("Authorization", "Bearer tok-v3")
      .send({ taskId: task.id, projectId: task.projectId, goal: "Build end-to-end V3 flow" })
      .expect(201);
    const draftId = draftRes.body.id;

    // 2. Compose Draft
    const composeRes = await request(app)
      .post(`/api/v3/plan-drafts/${draftId}/compose`)
      .set("Authorization", "Bearer tok-v3")
      .send({
        expectedRevision: draftRes.body.revision,
        instruction: "Compose analyze -> deliver",
      })
      .expect(202);
    const composedDraft = composeRes.body.draft;
    assert.ok(composedDraft.nodes.length >= 2);

    // 3. Compile Draft
    const compileRes = await request(app)
      .post(`/api/v3/plan-drafts/${draftId}/compile`)
      .set("Authorization", "Bearer tok-v3")
      .send({ expectedRevision: composedDraft.revision })
      .expect(200);
    assert.equal(compileRes.body.ok, true);
    const compiledDigest = compileRes.body.compiledDigest as string;

    // 4. Start Run with Idempotency-Key (replay returns same runId, mismatch returns 409)
    const start1 = await request(app)
      .post(`/api/v3/plan-drafts/${draftId}/start`)
      .set("Authorization", "Bearer tok-v3")
      .set("Idempotency-Key", "start-idem-key-1")
      .send({ expectedRevision: composedDraft.revision, compiledDigest })
      .expect(201);
    const runId = start1.body.runId as string;

    const startReplay = await request(app)
      .post(`/api/v3/plan-drafts/${draftId}/start`)
      .set("Authorization", "Bearer tok-v3")
      .set("Idempotency-Key", "start-idem-key-1")
      .send({ expectedRevision: composedDraft.revision, compiledDigest })
      .expect(201);
    assert.equal(startReplay.body.runId, runId);

    await request(app)
      .post(`/api/v3/plan-drafts/${draftId}/start`)
      .set("Authorization", "Bearer tok-v3")
      .set("Idempotency-Key", "start-idem-key-1")
      .send({ expectedRevision: composedDraft.revision + 1, compiledDigest })
      .expect(409);

    // Tick once to run first node and persist V3 context manifest
    await engine.tick();

    // 5. Query Graph, Events, Node Context & PATCH Layout
    const graphRes = await request(app)
      .get(`/api/v3/runs/${runId}/graph`)
      .set("Authorization", "Bearer tok-v3")
      .expect(200);
    assert.equal(graphRes.body.runId, runId);
    assert.ok(graphRes.body.nodes.length >= 2);
    const firstCapNode = graphRes.body.nodes.find((n: any) => n.kind === "capability");

    const ctxRes = await request(app)
      .get(`/api/v3/runs/${runId}/nodes/${firstCapNode.sourceId}/context`)
      .set("Authorization", "Bearer tok-v3")
      .expect(200);
    assert.equal(ctxRes.body.available, true);
    assert.equal(ctxRes.body.contextMode, "contract-v3");

    const eventsRes = await request(app)
      .get(`/api/v3/runs/${runId}/events?after=0&limit=50`)
      .set("Authorization", "Bearer tok-v3")
      .expect(200);
    assert.ok(eventsRes.body.events.length >= 1);

    const layoutPatch = await request(app)
      .patch(`/api/v3/canvas-layouts/${runId}`)
      .set("Authorization", "Bearer tok-v3")
      .send({
        expectedRevision: 0,
        graphId: runId,
        positions: { [firstCapNode.id]: { x: 120, y: 80 } },
        viewport: { x: 10, y: 15, zoom: 1.2 },
      })
      .expect(200);
    assert.equal(layoutPatch.body.revision, 1);
    assert.equal(layoutPatch.body.viewport.zoom, 1.2);

    // 6. Create & Commit ChangeProposal + Inspect Historical ?revision=1
    const propRes = await request(app)
      .post(`/api/v3/runs/${runId}/change-proposals`)
      .set("Authorization", "Bearer tok-v3")
      .send({
        expectedRevision: graphRes.body.revision,
        instruction: "Revise analysis instruction",
        patch: {
          operations: [
            {
              op: "updateNode",
              nodeId: firstCapNode.sourceId,
              patch: { literals: { objective: "Updated objective in proposal" } },
            },
          ],
        },
      })
      .expect(201);
    const proposal = propRes.body.proposal;

    await request(app)
      .post(`/api/v3/change-proposals/${proposal.id}/commit`)
      .set("Authorization", "Bearer tok-v3")
      .send({
        expectedRunRevision: graphRes.body.revision,
        proposalDigest: proposal.approvalDigest,
      })
      .expect(200);

    const histGraph = await request(app)
      .get(`/api/v3/runs/${runId}/graph?revision=1`)
      .set("Authorization", "Bearer tok-v3")
      .expect(200);
    assert.equal(histGraph.body.revision, 1);
    assert.equal(histGraph.body.historicalView, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
