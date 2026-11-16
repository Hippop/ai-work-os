import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { migrateDatabase, LATEST_SCHEMA_VERSION } from "../packages/persistence/migrations.js";
import { WorkService } from "../packages/workflow/service.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { bootstrapAdaptiveAssets } from "../packages/adaptive/bootstrap.js";
import { GraphDraftService } from "../packages/graph/draft-service.js";
import { GraphCompiler, capabilityVersionDigest } from "../packages/graph/compiler.js";
import { mergeRunEvents } from "../packages/graph/projection.js";
import { semanticDigest } from "../packages/graph/types.js";
import { createApp } from "../apps/server/app.js";

function capRef(assets: AssetService, id: string) {
  const cap = assets.getCapability(id, false);
  return { id: cap.id, version: cap.version, digest: capabilityVersionDigest(cap) };
}

function createTestEnv() {
  const store = new Store(":memory:");
  bootstrapAdaptiveAssets(store);
  const assets = new AssetService(store);
  const work = new WorkService(store);
  const task = work.createTask({
    title: "Canvas V3.1 Compiler Suite",
    type: "manual",
    objective: "Verify compiler, gaps, bindings, pointers, conditional skip, cycles, and events",
    acceptanceCriteria: ["Deterministic DAG compilation"],
  });
  return { store, assets, work, task };
}

test("A23: SQLite v1 -> v2 migration is transactional, rolls back cleanly, and mirrors all 11 dedicated tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-work-os-mig-"));
  const dbPath = join(dir, "state.db");
  try {
    // Seed a genuine v1 database manually
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE entities(kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE events(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,seq));
      CREATE TABLE idempotency(scope TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,key));
      PRAGMA user_version = 1;
    `);
    raw.prepare("INSERT INTO entities VALUES(?,?,?)").run(
      "canvas_layout",
      "run-legacy-1",
      JSON.stringify({ id: "run-legacy-1", revision: 2, positions: { "cap:a": { x: 10, y: 20 } } }),
    );

    // 1. Trigger a simulated crash right before COMMIT -> must roll back cleanly to version 1
    assert.throws(() => {
      migrateDatabase(raw, LATEST_SCHEMA_VERSION, {
        beforeCommit: () => {
          throw new Error("simulated crash before commit");
        },
      });
    }, /simulated crash/);
    const afterAbort = Number(
      (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    assert.equal(afterAbort, 1);
    const tablesAfterAbort = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_drafts'")
      .all();
    assert.equal(tablesAfterAbort.length, 0);
    raw.close();

    // 2. Re-open with Store -> automatically migrates v1 -> v2, backfills canvas_layouts, and exposes all 11 tables
    const store = new Store(dbPath);
    try {
      assert.equal(store.schemaVersion, 2);
      const expectedTables = [
        "graph_drafts",
        "compiled_plans",
        "canvas_layouts",
        "plan_changes",
        "result_validity",
        "context_manifests",
        "workspace_access",
        "agent_sessions",
        "interventions",
        "effect_records",
        "knowledge_relations",
      ];
      for (const tbl of expectedTables) {
        const row = store.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(tbl);
        assert.ok(row, `expected dedicated table ${tbl}`);
      }
      const backfilled = store.db
        .prepare("SELECT id, revision FROM canvas_layouts WHERE id=?")
        .get("run-legacy-1") as { id: string; revision: number } | undefined;
      assert.ok(backfilled);
      assert.equal(backfilled.revision, 2);

      // Verify Store.put dual-writes to graph_drafts
      const drafts = new GraphDraftService(store);
      const created = drafts.createDraft({ goal: "Dual write verification" });
      const mirrored = store.db
        .prepare("SELECT id, revision FROM graph_drafts WHERE id=?")
        .get(created.id) as { id: string; revision: number } | undefined;
      assert.ok(mirrored);
      assert.equal(mirrored.revision, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A01: same capabilityRef reused across multiple nodes keeps independent node specs, engineKey, literals and bindings", () => {
  const { store, assets, task } = createTestEnv();
  try {
    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const ref = capRef(assets, "core.analyze@1.0.0");
    const deliverRef = capRef(assets, "core.deliver@1.0.0");

    const draft = drafts.createDraft({
      taskId: task.id,
      goal: "Reuse analyze capability twice with separate configurations",
      nodes: [
        {
          id: "analyze_frontend",
          engineKey: "analyze_fe",
          title: "Frontend Analysis",
          capabilityRef: ref,
          literals: { objective: "Inspect frontend state" },
        },
        {
          id: "analyze_backend",
          engineKey: "analyze_be",
          title: "Backend Analysis",
          capabilityRef: ref,
          dependsOn: ["analyze_frontend"],
          literals: {},
          bindings: [
            {
              id: "b-be",
              target: "/objective",
              source: { nodeId: "analyze_frontend", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
        {
          id: "final_deliver",
          engineKey: "deliver",
          capabilityRef: deliverRef,
          dependsOn: ["analyze_backend"],
          bindings: [
            {
              id: "b-deliv",
              target: "/objective",
              source: { nodeId: "analyze_backend", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
      ],
    });

    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, true);
    assert.ok(compiled.compiledPlan);
    const planNodes = (compiled.compiledPlan.executablePlan as { nodes: { id: string; capabilityRef: string; inputs: Record<string, unknown> }[] }).nodes;
    assert.equal(planNodes.filter((n) => n.capabilityRef === "core.analyze@1.0.0").length, 2);
    assert.equal(planNodes.find((n) => n.id === "analyze_fe")?.inputs.objective, "Inspect frontend state");
    assert.equal(planNodes.find((n) => n.id === "analyze_be")?.inputs.objective, undefined);
  } finally {
    store.close();
  }
});

test("A02: open PlanGap and unpublished capability block compile until resolved and published", () => {
  const { store, assets, task } = createTestEnv();
  try {
    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);

    const candCap = assets.createCapability({
      name: "custom.audit",
      version: "1.0.0",
      title: "Custom Audit",
      description: "Inspect repository security rules",
      profileRef: "core.codex.read@1.0.0",
      sideEffect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: { objective: { type: "string" } },
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
      operatingInstructions: "Audit only",
      tags: ["analyze"],
    });

    const draft = drafts.createDraft({
      taskId: task.id,
      goal: "Resolve gap before starting",
      nodes: [
        {
          id: "audit",
          engineKey: "audit",
          capabilityRef: capRef(assets, candCap.id),
          literals: { objective: "Audit security" },
        },
        {
          id: "deliver",
          engineKey: "deliver",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["audit"],
          bindings: [
            {
              id: "b-out",
              target: "/objective",
              source: { nodeId: "audit", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
      ],
      gaps: [
        {
          id: "gap-1",
          kind: "capability",
          reason: "custom.audit is still candidate",
          affectedNodeIds: ["audit"],
          status: "open",
        },
      ],
    });

    const blocked = compiler.compile(draft.id, draft.revision);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.diagnostics.some((d) => d.code === "open_plan_gap"));
    assert.ok(blocked.diagnostics.some((d) => d.code === "capability_not_published"));

    // Resolve gap & publish capability -> compile succeeds
    assets.validateCapability(candCap.id, "Contract reviewed");
    assets.publishCapability(candCap.id);
    const updated = drafts.patchDraft(draft.id, {
      expectedRevision: draft.revision,
      operations: [{ op: "resolveGap", gapId: "gap-1" }],
    });
    const ok = compiler.compile(updated.id, updated.revision);
    assert.equal(ok.ok, true);
    assert.ok(ok.compiledDigest);
  } finally {
    store.close();
  }
});

test("A03: removeBinding cleanly removes only the targeted binding without removing dependsOn or sibling bindings", () => {
  const { store, assets, task } = createTestEnv();
  try {
    const targetCap = assets.createCapability({
      name: "custom.multi",
      version: "1.0.0",
      title: "Multi Input Deliver",
      description: "Combine primary and secondary summaries",
      profileRef: "core.builtin.deliver@1.0.0",
      sideEffect: "none",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: {
          objective: { type: "string" },
          extraNote: { type: "string" },
        },
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
      operatingInstructions: "Deliver summary",
      tags: ["deliver"],
    });
    assets.validateCapability(targetCap.id, "Contract reviewed");
    assets.publishCapability(targetCap.id);

    const drafts = new GraphDraftService(store);
    const draft = drafts.createDraft({
      taskId: task.id,
      goal: "Unbind one field without disturbing dependsOn or sibling binding",
      nodes: [
        {
          id: "n1",
          engineKey: "n1",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          literals: { objective: "Analyze first" },
        },
        {
          id: "n2",
          engineKey: "n2",
          capabilityRef: capRef(assets, targetCap.id),
          dependsOn: ["n1"],
          bindings: [
            {
              id: "b-primary",
              target: "/objective",
              source: { nodeId: "n1", pointer: "/summary" },
              required: true,
              missing: "block",
            },
            {
              id: "b-secondary",
              target: "/extraNote",
              source: { nodeId: "n1", pointer: "/summary" },
              required: false,
              missing: "omit",
            },
          ],
        },
      ],
    });

    const patched = drafts.patchDraft(draft.id, {
      expectedRevision: draft.revision,
      operations: [{ op: "removeBinding", nodeId: "n2", bindingId: "b-secondary" }],
    });
    const n2 = patched.nodes.find((n) => n.id === "n2")!;
    assert.deepEqual(n2.dependsOn, ["n1"]);
    assert.deepEqual(
      n2.bindings.map((b) => b.id),
      ["b-primary"],
    );
  } finally {
    store.close();
  }
});

test("A04: nested JSON Pointer mismatch or missing property produces diagnostic naming nodeId, bindingId and fieldPointer", () => {
  const { store, assets, task } = createTestEnv();
  try {
    const producer = assets.createCapability({
      name: "custom.nested.out",
      version: "1.0.0",
      title: "Nested Producer",
      description: "Outputs nested structured fields",
      profileRef: "core.codex.read@1.0.0",
      sideEffect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: { objective: { type: "string" } },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["nested"],
        properties: {
          nested: {
            type: "object",
            additionalProperties: false,
            required: ["count"],
            properties: { count: { type: "integer" } },
          },
        },
      },
      tags: ["analyze"],
    });
    assets.validateCapability(producer.id, "Contract reviewed");
    assets.publishCapability(producer.id);

    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const draft = drafts.createDraft({
      taskId: task.id,
      goal: "Nested pointer mismatch check",
      nodes: [
        {
          id: "prod",
          engineKey: "prod",
          capabilityRef: capRef(assets, producer.id),
          literals: { objective: "Produce" },
        },
        {
          id: "deliver",
          engineKey: "deliver",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["prod"],
          bindings: [
            {
              id: "bad-nested-bind",
              target: "/objective",
              source: { nodeId: "prod", pointer: "/nested/count" }, // integer vs string
              required: true,
              missing: "block",
            },
            {
              id: "missing-nested-bind",
              target: "/objective",
              source: { nodeId: "prod", pointer: "/nested/nonexistent" },
              required: false,
              missing: "omit",
            },
          ],
        },
      ],
    });

    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, false);
    const typeDiag = compiled.diagnostics.find(
      (d) => d.bindingId === "bad-nested-bind" && d.code === "binding_type_mismatch",
    );
    assert.ok(typeDiag);
    assert.equal(typeDiag.nodeId, "deliver");
    assert.equal(typeDiag.fieldPointer, "/objective");

    const missingDiag = compiled.diagnostics.find(
      (d) => d.bindingId === "missing-nested-bind" && d.code === "binding_source_schema_missing",
    );
    assert.ok(missingDiag);
    assert.equal(missingDiag.nodeId, "deliver");
    assert.equal(missingDiag.fieldPointer, "/nested/nonexistent");
  } finally {
    store.close();
  }
});

test("A05: skipped conditional upstream honors missing=use-default, omit and block deterministically without implicit null", async () => {
  const { store, assets, task } = createTestEnv();
  try {
    const optionalDeliver = assets.createCapability({
      name: "custom.optional.deliver",
      version: "1.0.0",
      title: "Optional Deliver",
      description: "Receives optional fallback/omitted inputs",
      profileRef: "core.builtin.deliver@1.0.0",
      sideEffect: "none",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: {
          objective: { type: "string" },
          optNote: { type: "string" },
        },
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
      tags: ["deliver"],
    });
    assets.validateCapability(optionalDeliver.id, "Contract reviewed");
    assets.publishCapability(optionalDeliver.id);

    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const draft = drafts.createDraft({
      taskId: task.id,
      goal: "Conditional branch skipped test",
      nodes: [
        {
          id: "gate",
          engineKey: "gate",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          literals: { objective: "Decide branch" },
        },
        {
          id: "branch",
          engineKey: "branch",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          dependsOn: ["gate"],
          condition: { fromNode: "gate", pointer: "/summary", equals: "RUN_BRANCH" },
          literals: { objective: "Conditional branch" },
        },
        {
          id: "blocked_child",
          engineKey: "blocked_child",
          capabilityRef: capRef(assets, "core.analyze@1.0.0"),
          dependsOn: ["branch"],
          bindings: [
            {
              id: "b-block",
              target: "/objective",
              source: { nodeId: "branch", pointer: "/summary" },
              required: true,
              missing: "block",
            },
          ],
        },
        {
          id: "deliver",
          engineKey: "deliver",
          capabilityRef: capRef(assets, optionalDeliver.id),
          dependsOn: ["gate", "branch", "blocked_child"],
          bindings: [
            {
              id: "b-default",
              target: "/objective",
              source: { nodeId: "branch", pointer: "/summary" },
              required: true,
              missing: "use-default",
              defaultValue: "fallback-summary",
            },
            {
              id: "b-omit",
              target: "/optNote",
              source: { nodeId: "branch", pointer: "/summary" },
              required: false,
              missing: "omit",
            },
          ],
        },
      ],
    });

    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, true);

    const capturedInputs: Record<string, Record<string, unknown>> = {};
    const engine = new AdaptiveEngine(store, assets, async (call) => {
      capturedInputs[call.node.id] = call.input;
      return { output: { summary: "SKIP_BRANCH", evidence: ["e1"], risks: [] } };
    });

    const { runId } = await compiler.startCompiledPlan(draft.id, {
      expectedRevision: draft.revision,
      compiledDigest: compiled.compiledDigest!,
    });
    for (let i = 0; i < 6; i++) {
      await engine.tick();
    }

    const done = engine.get(runId);
    assert.equal(done.nodeStates.gate, "succeeded");
    assert.equal(done.nodeStates.branch, "skipped");
    assert.equal(done.nodeStates.blocked_child, "skipped");
    assert.equal(done.nodeStates.deliver, "succeeded");
    assert.equal(capturedInputs.deliver.objective, "fallback-summary");
    assert.equal(Object.hasOwn(capturedInputs.deliver, "optNote"), false);
  } finally {
    store.close();
  }
});

test("A06: cycle detection fails compile with cycle diagnostic containing participating node IDs", () => {
  const { store, assets, task } = createTestEnv();
  try {
    const drafts = new GraphDraftService(store);
    const compiler = new GraphCompiler(store);
    const ref = capRef(assets, "core.analyze@1.0.0");
    const draft = drafts.createDraft({
      taskId: task.id,
      goal: "Cycle check",
      nodes: [
        {
          id: "node_alpha",
          engineKey: "alpha",
          capabilityRef: ref,
          dependsOn: ["node_beta"],
          literals: { objective: "A" },
        },
        {
          id: "node_beta",
          engineKey: "beta",
          capabilityRef: ref,
          dependsOn: ["node_alpha"],
          literals: { objective: "B" },
        },
        {
          id: "deliver",
          engineKey: "deliver",
          capabilityRef: capRef(assets, "core.deliver@1.0.0"),
          dependsOn: ["node_beta"],
          literals: { objective: "Deliver" },
        },
      ],
    });
    const compiled = compiler.compile(draft.id, draft.revision);
    assert.equal(compiled.ok, false);
    const cyc = compiled.diagnostics.find((d) => d.code === "cycle_detected");
    assert.ok(cyc);
    assert.ok(cyc.message.includes("node_alpha") && cyc.message.includes("node_beta"));
  } finally {
    store.close();
  }
});

test("A25: mergeRunEvents deduplicates, orders monotonically, detects seq gaps, and /v3/runs/:id/events paginates cleanly", async () => {
  const mergedNoGap = mergeRunEvents(
    [{ seq: 1, id: "e1" }, { seq: 3, id: "e3" }],
    [{ seq: 3, id: "e3" }, { seq: 2, id: "e2" }, { seq: 4, id: "e4" }],
    0,
  );
  assert.equal(mergedNoGap.snapshotRequired, false);
  assert.deepEqual(
    mergedNoGap.events.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.equal(mergedNoGap.lastSeq, 4);

  const mergedWithGap = mergeRunEvents(
    [{ seq: 1, id: "e1" }, { seq: 2, id: "e2" }],
    [{ seq: 5, id: "e5" }],
    2,
  );
  assert.equal(mergedWithGap.snapshotRequired, true);
  assert.equal(mergedWithGap.gapFromSeq, 3);
  assert.equal(mergedWithGap.gapToSeq, 4);

  const { store, task } = createTestEnv();
  try {
    const engine = new AdaptiveEngine(store);
    const run = engine.createRun(task.id, {
      nodes: [{ id: "deliver", capabilityRef: "core.deliver@1.0.0", inputs: { objective: "Hi" } }],
      observations: [],
    });
    store.event(run.id, "custom.one", { step: 1 });
    store.event(run.id, "custom.two", { step: 2 });

    const app = createApp(store, "tok", undefined, undefined, engine);
    const page1 = await request(app)
      .get(`/api/v3/runs/${run.id}/events?after=0&limit=1`)
      .set("Authorization", "Bearer tok")
      .expect(200);
    assert.equal(page1.body.events.length, 1);
    assert.equal(page1.body.hasMore, true);
    assert.equal(page1.body.snapshotRequired, false);

    const pageGap = await request(app)
      .get(`/api/v3/runs/${run.id}/events?after=99&limit=10`)
      .set("Authorization", "Bearer tok")
      .expect(200);
    assert.equal(pageGap.body.snapshotRequired, true);

    await request(app)
      .get("/api/v3/runs/nonexistent/events")
      .set("Authorization", "Bearer tok")
      .expect(404);
  } finally {
    store.close();
  }
});
