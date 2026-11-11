import { standardAdaptivePlan } from "../../packages/adaptive/bootstrap.js";
import { AssetService } from "../../packages/adaptive/assets.js";
import { AdaptiveEngine } from "../../packages/adaptive/engine.js";
import { AdaptiveRuntime } from "../../packages/adaptive/runtime.js";
import { ExternalSkillService } from "../../packages/external-skills/index.js";
import { McpRegistry } from "../../packages/adaptive/mcp.js";
import express from "express";
import { z, ZodError } from "zod";
import { resolve, join } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Store } from "../../packages/persistence/index.js";
import { WorkService } from "../../packages/workflow/service.js";
import { PlanningService } from "../../packages/planning/index.js";
import { DiagnosisService } from "../../packages/diagnosis/index.js";
import { OptimizationService } from "../../packages/optimization/index.js";
import { RolloutService } from "../../packages/optimization/rollout.js";
import { probeCodex } from "../../packages/runtime/adapter.js";
import {
  inspectRecovery,
  reconcileManually,
} from "../../packages/runtime/recovery.js";
import {
  ResourceService,
  defaultPlan,
} from "../../packages/resources/index.js";
import {
  DomainError,
  FlowRequirementsInput,
  type Run,
  type Task,
  digest,
} from "../../packages/domain/index.js";

export function createApp(
  store: Store,
  token: string,
  service = new WorkService(store),
  dataDir?: string,
  adaptive = new AdaptiveEngine(store),
  adaptiveRuntime?: AdaptiveRuntime,
) {
  const app = express();
  const resources = new ResourceService(store);
  const planning = new PlanningService(store),
    diagnosis = new DiagnosisService(store);
  const optimization = new OptimizationService(store, dataDir, service.runtime);
  const rollouts = new RolloutService(optimization);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (
      origin &&
      ![
        "http://127.0.0.1:4310",
        "http://localhost:4310",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        `http://127.0.0.1:${req.socket.localPort}`,
        `http://localhost:${req.socket.localPort}`,
      ].includes(origin)
    ) {
      res.status(403).json({ code: "origin_denied", message: "来源不允许" });
      return;
    }
    const provided = req.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const a = Buffer.from(provided),
      b = Buffer.from(token);
    if (!a.length || a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({
        code: "authentication_required",
        message: "请输入本机服务访问令牌",
      });
      return;
    }
    next();
  });
  app.get("/api/v1/health", (_req, res) =>
    res.json({ status: "ok", schemaVersion: 1 }),
  );
  app.get("/api/v1/runtimes", (_req, res) =>
    res.json([{ id: "codex", ...service.runtime }]),
  );
  app.post("/api/v1/runtimes/probe", (_req, res) => {
    Object.assign(service.runtime, probeCodex());
    res.json([{ id: "codex", ...service.runtime }]);
  });
  app.get("/api/v1/tasks", (_req, res) => res.json(store.list("task")));
  app.get("/api/v1/optimization", (_req, res) =>
    res.json({
      proposals: store.list("improvement"),
      datasets: store.list("evaluation_dataset"),
      trials: store.list("evaluation_trial"),
      evaluations: store.list("evaluation"),
      releases: store.list("improvement_release"),
      rollbacks: store.list("improvement_rollback"),
      analyses: store.list("analysis_batch"),
      schedule: store.get("optimization_schedule", "periodic_analysis"),
      policy: store.get("optimization_policy", "auto_low_risk"),
      notices: store.list("optimization_notice"),
      projects: store.list("project"),
      canaries: store
        .list<any>("resource_canary")
        .map((canary) => ({ ...canary, ...rollouts.inspect(canary) })),
      canaryHistory: store.list("canary_history"),
    }),
  );
  app.post("/api/v1/optimization/analyze", (req, res) => {
    const b = z
      .object({ from: z.iso.datetime(), to: z.iso.datetime() })
      .parse(req.body);
    res.json(optimization.analyze(b.from, b.to));
  });
  app.post("/api/v1/optimization/proposals", (req, res) =>
    res.status(201).json(optimization.propose(req.body)),
  );
  app.post("/api/v1/optimization/candidates", (req, res) => {
    const b = z
      .object({
        baselineId: z.string().uuid(),
        evidenceRunIds: z.array(z.string().uuid()).min(1),
      })
      .parse(req.body);
    res
      .status(201)
      .json(optimization.generateCandidate(b.baselineId, b.evidenceRunIds));
  });
  app.post("/api/v1/optimization/datasets", (req, res) =>
    res.status(201).json(optimization.dataset(req.body)),
  );
  app.post("/api/v1/optimization/proposals/:id/trials", (req, res) =>
    res.status(202).json(optimization.trials(req.params.id, req.body)),
  );
  app.post("/api/v1/optimization/proposals/:id/evaluations", (req, res) =>
    res.status(201).json(optimization.evaluate(req.params.id, req.body)),
  );
  app.post("/api/v1/optimization/proposals/:id/releases", (req, res) =>
    res.status(201).json(optimization.release(req.params.id, req.body)),
  );
  app.post("/api/v1/optimization/releases/:id/rollback", (req, res) =>
    res.json(
      optimization.rollback(
        req.params.id,
        z.object({ reason: z.string().min(1).max(10000) }).parse(req.body)
          .reason,
      ),
    ),
  );
  app.post("/api/v1/optimization/schedule", (req, res) =>
    res.json(optimization.configureSchedule(req.body)),
  );
  app.post("/api/v1/optimization/policy", (req, res) => {
    const data = z
      .object({
        enabled: z.boolean(),
        approvalReason: z.string().min(1).max(10000),
        projectIds: z.array(z.string().uuid()).max(20).default([]),
      })
      .parse(req.body);
    if (data.enabled && !data.projectIds.length)
      throw new DomainError(
        "project_scope_required",
        "启用自动灰度需要选定项目",
        422,
      );
    for (const id of data.projectIds) service.required("project", id);
    const policy = {
      id: "auto_low_risk",
      ...data,
      updatedAt: new Date().toISOString(),
    };
    store.put("optimization_policy", policy);
    rollouts.tick();
    res.json(policy);
  });
  app.post("/api/v1/optimization/proposals/:id/canaries", (req, res) =>
    res.status(201).json(rollouts.start(req.params.id, req.body)),
  );
  app.post("/api/v1/optimization/canaries/:id/promote", (req, res) =>
    res.json(rollouts.promote(req.params.id, req.body)),
  );
  app.post("/api/v1/optimization/canaries/:id/stop", (req, res) => {
    const data = z
      .object({
        rolloutId: z.string().uuid(),
        reason: z.string().min(1).max(10000),
      })
      .parse(req.body);
    res.json(rollouts.stop(req.params.id, data.rolloutId, data.reason));
  });
  app.get("/api/v1/goals", (_req, res) => res.json(planning.goals()));
  app.post("/api/v1/goals", (req, res) =>
    res.status(201).json(planning.createGoal(req.body)),
  );
  app.get("/api/v1/planning/summary", (req, res) =>
    res.json(
      planning.summary(
        z.string().parse(req.query.from),
        z.string().parse(req.query.to),
      ),
    ),
  );
  app.post("/api/v1/tasks/:id/plan", (req, res) => {
    const body = z
      .object({
        revision: z.number().int().positive(),
        changes: z.record(z.string(), z.unknown()),
      })
      .parse(req.body);
    res.json(service.updateTask(req.params.id, body.revision, body.changes));
  });
  app.get("/api/v1/tasks/:id/diagnosis", (req, res) =>
    res.json({
      ...diagnosis.snapshot(req.params.id),
      reports: store
        .list<{ taskId: string }>("diagnosis_report")
        .filter((r) => r.taskId === req.params.id),
    }),
  );
  app.post("/api/v1/tasks/:id/diagnosis/evidence", (req, res) =>
    res.status(201).json(diagnosis.addEvidence(req.params.id, req.body)),
  );
  app.post("/api/v1/tasks/:id/diagnosis/hypotheses", (req, res) =>
    res.status(201).json(diagnosis.addHypothesis(req.params.id, req.body)),
  );
  app.post(
    "/api/v1/tasks/:id/diagnosis/hypotheses/:hypothesisId",
    (req, res) => {
      const body = z
        .object({
          revision: z.number().int().positive(),
          changes: z.record(z.string(), z.unknown()),
        })
        .parse(req.body);
      res.json(
        diagnosis.updateHypothesis(
          req.params.id,
          req.params.hypothesisId,
          body.revision,
          body.changes,
        ),
      );
    },
  );
  app.post("/api/v1/tasks/:id/diagnosis/reports", (req, res) =>
    res.status(201).json(diagnosis.report(req.params.id, req.body)),
  );
  app.get("/api/v1/resources", (_req, res) =>
    res.json(
      store
        .list<{
          id: string;
          kind: string;
          name: string;
          projectId: string | null;
        }>("resource")
        .map((resource) => ({
          ...resource,
          status: store.get<{ state: string }>("resource_status", resource.id)
            ?.state,
          familyId: digest([resource.kind, resource.name, resource.projectId]),
          current:
            store.get<{ resourceId: string }>(
              "resource_release",
              digest([resource.kind, resource.name, resource.projectId]),
            )?.resourceId === resource.id,
        })),
    ),
  );
  app.get("/api/v1/capabilities", (_req, res) => res.json(defaultPlan));
  app.post("/api/v1/resources", (req, res) =>
    res.status(201).json(resources.create(req.body)),
  );
  app.post("/api/v1/resources/:id/publish", (req, res) =>
    res.json(resources.publish(req.params.id)),
  );
  app.post("/api/v1/resources/:id/revoke", (req, res) => {
    resources.revoke(req.params.id);
    res.json({ status: "revoked" });
  });
  app.post("/api/v1/runs/:id/plan-proposals", (req, res) => {
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        nodes: z.unknown(),
        reason: z.string(),
      })
      .parse(req.body);
    res.json(
      service.replan(
        req.params.id,
        body.expectedRevision,
        body.nodes,
        body.reason,
      ),
    );
  });
  app.post("/api/v1/flows/preview", (req, res) => {
    const input = z.object({
      type: z.enum(["development", "diagnosis"]),
      projectId: z.string().uuid().nullable().default(null),
      workflowVersionId: z.string().uuid().nullable().default(null),
      resourceFamilyIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(30).default([]),
      flowRequirements: FlowRequirementsInput.nullable().default(null),
    }).parse(req.body);
    if (input.projectId && !store.get("project", input.projectId))
      throw new DomainError("not_found", "项目不存在", 404);
    const context = resources.context(
      [], [], input.workflowVersionId, input.projectId,
      input.type, input.resourceFamilyIds, undefined, input.flowRequirements,
    );
    res.json({ plan: context.plan, workflow: context.workflow });
  });
  app.post("/api/v1/tasks", (req, res) =>
    res.status(201).json(service.createTask(req.body)),
  );
  app.patch("/api/v1/tasks/:id", (req, res) =>
    res.json(
      service.updateTask(
        req.params.id,
        z.coerce.number().int().positive().parse(req.get("if-match")),
        req.body,
      ),
    ),
  );
  app.get("/api/v1/projects", (_req, res) => res.json(store.list("project")));
  app.post("/api/v1/projects", (req, res) =>
    res.status(201).json(service.createProject(req.body)),
  );
  app.post("/api/v1/tasks/:id/prepare", (req, res) =>
    res.json(service.prepare(req.params.id)),
  );
  app.post("/api/v1/tasks/:id/runs", (req, res) => {
    const body = z.object({ preparationDigest: z.string() }).parse(req.body);
    res
      .status(202)
      .json(
        service.start(
          req.params.id,
          body.preparationDigest,
          req.get("idempotency-key") ?? "",
        ),
      );
  });
  app.get("/api/v1/runs", (_req, res) => res.json(store.list("run")));
  app.get("/api/v1/runs/:id", (req, res) =>
    res.json(service.required("run", req.params.id)),
  );
  app.get("/api/v1/runs/:id/recovery", (req, res) =>
    res.json(inspectRecovery(store, service, req.params.id)),
  );
  app.post("/api/v1/runs/:id/recovery", (req, res) =>
    res.json(reconcileManually(store, service, req.params.id, req.body)),
  );
  for (const action of ["pause", "resume", "cancel"])
    app.post(`/api/v1/runs/:id/${action}`, (req, res) =>
      res.json(service.control(req.params.id, action)),
    );
  app.get("/api/v1/runs/:id/events", (req, res) => {
    service.required("run", req.params.id);
    res.json(
      store.events(
        req.params.id,
        z.coerce
          .number()
          .int()
          .nonnegative()
          .default(0)
          .parse(req.query.afterSeq),
      ),
    );
  });
  app.post("/api/v1/runs/:id/deliveries", (req, res) =>
    res
      .status(201)
      .json(
        service.submit(
          req.params.id,
          z.object({ summary: z.string() }).parse(req.body).summary,
        ),
      ),
  );
  app.get("/api/v1/runs/:id/artifacts/:name", (req, res) => {
    const delivery = store
      .list<{
        runId: string;
        artifacts?: string[];
        artifactDigests?: Record<string, string>;
        artifactSubdir?: string;
      }>("delivery")
      .find((d) => d.runId === req.params.id);
    const name = req.params.name;
    if (
      !dataDir ||
      !delivery?.artifacts?.includes(name) ||
      !/^[a-zA-Z0-9.-]+$/.test(name)
    )
      throw new DomainError("not_found", "产物不存在", 404);
    const content = readFileSync(
      join(
        dataDir,
        "artifacts",
        req.params.id,
        ...(delivery.artifactSubdir
          ? [z.string().uuid().parse(delivery.artifactSubdir)]
          : []),
        name,
      ),
    );
    if (
      createHash("sha256").update(content).digest("hex") !==
      delivery.artifactDigests?.[name]
    )
      throw new DomainError(
        "artifact_changed",
        "产物摘要校验失败，不能作为有效交付使用",
      );
    res.type("application/octet-stream").attachment(name).send(content);
  });
  app.get("/api/v1/deliveries", (_req, res) =>
    res.json(store.list("delivery")),
  );
  app.post("/api/v1/tasks/:id/acceptances", (req, res) => {
    const body = z
      .object({
        deliveryId: z.string().uuid(),
        accepted: z.boolean(),
        reason: z.string().max(10000).default(""),
      })
      .parse(req.body);
    res.json(
      service.accept(
        req.params.id,
        body.deliveryId,
        body.accepted,
        body.reason,
      ),
    );
  });
  app.get("/api/v1/analytics", (_req, res) => {
    const tasks = store.list<Task>("task"),
      runs = store.list<Run>("run");
    res.json({
      tasks: tasks.length,
      accepted: tasks.filter((t) => t.status === "done").length,
      awaitingAcceptance: tasks.filter(
        (t) => t.status === "awaiting_acceptance",
      ).length,
      runs: runs.length,
      failedRuns: runs.filter((r) => r.status === "failed").length,
      observations: [
        "统计覆盖人工与Agent运行；模型用量与优化评估指标尚未接入。",
      ],
    });
  });
  // Adaptive Work OS V2: versioned capability/knowledge assets and event-driven runs.
  const adaptiveAssets = new AssetService(store);
  const skillSources = new ExternalSkillService(store);
  app.get("/api/v2/capabilities", (_req, res) => res.json(adaptiveAssets.listCapabilities()));
  app.post("/api/v2/capabilities", (req, res) =>
    res.status(201).json(adaptiveAssets.createCapability(req.body)));
  app.post("/api/v2/capabilities/:id/candidate", (req, res) =>
    res.json(adaptiveAssets.updateCandidate(req.params.id, req.body)));
  app.post("/api/v2/capabilities/:id/validate", (req, res) => {
    const b = z.object({
      evidence: z.string(),
      sample: z.object({ input: z.unknown(), output: z.unknown() }).optional(),
    }).parse(req.body);
    res.json(adaptiveAssets.validateCapability(req.params.id, b.evidence, b.sample));
  });
  app.post("/api/v2/capabilities/:id/publish", (req, res) => res.json(adaptiveAssets.publishCapability(req.params.id)));
  app.post("/api/v2/capabilities/:id/revoke", (req, res) => {
    adaptiveAssets.revokeCapability(req.params.id); res.json({ status: "revoked" });
  });
  const mcpRegistry = new McpRegistry(store);
  app.get("/api/v2/mcp-servers", (_req, res) => res.json(mcpRegistry.list()));
  app.post("/api/v2/mcp-servers", (req, res) =>
    res.status(201).json(mcpRegistry.register(req.body)));
  app.post("/api/v2/mcp-servers/:id/publish", (req, res) =>
    res.json(mcpRegistry.publish(req.params.id)));
  app.post("/api/v2/mcp-servers/:id/revoke", (req, res) =>
    res.json(mcpRegistry.revoke(req.params.id)));
  app.get("/api/v2/profiles", (_req, res) => res.json(store.list("adaptive_profile")));
  app.post("/api/v2/profiles", (req, res) => res.status(201).json(adaptiveAssets.createProfile(req.body)));
  app.post("/api/v2/profiles/:id/publish", (req, res) => res.json(adaptiveAssets.publishProfile(req.params.id)));
  app.get("/api/v2/knowledge", (_req, res) => res.json(adaptiveAssets.listKnowledge()));
  app.post("/api/v2/knowledge", (req, res) => res.status(201).json(adaptiveAssets.createKnowledge(req.body)));
  app.post("/api/v2/knowledge/:id/publish", (req, res) => res.json(adaptiveAssets.publishKnowledge(req.params.id)));
  app.post("/api/v2/knowledge/:id/revoke", (req, res) => {
    adaptiveAssets.revokeKnowledge(req.params.id); res.json({ status: "revoked" });
  });
  app.get("/api/v2/knowledge-bindings", (_req, res) => res.json(store.list("adaptive_knowledge_binding")));
  app.post("/api/v2/knowledge-bindings", (req, res) =>
    res.status(201).json(adaptiveAssets.bindKnowledge(req.body)));
  app.post("/api/v2/knowledge/search", (req, res) => {
    const b = z.object({
      query: z.string().max(2000), projectId: z.string().uuid().nullable().default(null),
      taskId: z.string().uuid().nullable().default(null), capabilityName: z.string().min(1).max(120),
    }).parse(req.body);
    res.json(adaptiveAssets.retrieveKnowledge(b.query, b.projectId, b.taskId, b.capabilityName));
  });
  app.get("/api/v1/skill-sources", (_req, res) => res.json(skillSources.sources()));
  app.post("/api/v1/skill-sources", (req, res) => res.status(201).json(skillSources.register(req.body)));
  app.post("/api/v1/skill-sources/:id/scan", (req, res) => res.json(skillSources.scan(req.params.id)));
  app.get("/api/v1/external-skills", (_req, res) => res.json(skillSources.skills()));
  app.get("/api/v2/skill-sources", (_req, res) => res.json(skillSources.sources()));
  app.post("/api/v2/skill-sources", (req, res) => res.status(201).json(skillSources.register(req.body)));
  app.post("/api/v2/skill-sources/:id/scan", (req, res) => res.json(skillSources.scan(req.params.id)));
  app.get("/api/v2/external-skills", (_req, res) => res.json(skillSources.skills()));
  app.post("/api/v2/skill-candidates", async (req, res) => {
    const b = z.object({
      skillId: z.string().uuid(), projectId: z.string().uuid().optional(),
      profileRef: z.string().optional(), ai: z.boolean().default(false),
    }).parse(req.body);
    if (b.ai) {
      if (!adaptiveRuntime || !b.projectId) throw new DomainError("model_required", "AI 分析需要可用模型和项目", 422);
      res.status(201).json(await adaptiveRuntime.createSkillCandidate(b.skillId, b.projectId, b.profileRef));
    } else res.status(201).json(adaptiveAssets.draftFromSkill(b.skillId));
  });
  app.post("/api/v2/workflows/validate", (req, res) => {
    const b = z.object({ projectId: z.string().uuid().nullable().default(null),
      taskId: z.string().uuid().optional(), plan: z.unknown() }).parse(req.body);
    res.json({ plan: adaptive.validate(b.plan, b.projectId, b.taskId) });
  });
  app.post("/api/v2/tasks/:id/standard-plan", (req, res) => {
    const task = service.required<Task>("task", req.params.id);
    const plan = standardAdaptivePlan(task);
    res.json({ plan: adaptive.validate(plan, task.projectId, task.id), source: "deterministic-template" });
  });
  app.post("/api/v2/tasks/:id/compose", async (req, res) =>
    res.json({ plan: await adaptive.compose(req.params.id) }));
  app.get("/api/v2/adaptive-runs", (_req, res) => res.json(store.list("adaptive_run")));
  app.post("/api/v2/adaptive-runs", (req, res) => {
    const b = z.object({ taskId: z.string().uuid(), plan: z.unknown() }).parse(req.body);
    res.status(201).json(adaptive.createRun(b.taskId, b.plan));
  });
  app.get("/api/v2/adaptive-runs/:id", (req, res) => res.json(adaptive.get(req.params.id)));
  app.get("/api/v2/adaptive-runs/:id/events", (req, res) => res.json(store.events(req.params.id, Number(req.query.after ?? 0))));
  app.get("/api/v2/adaptive-runs/:id/side-effects", (req, res) =>
    res.json(store.list<{ runId: string }>("adaptive_side_effect").filter((item) => item.runId === req.params.id)));
  app.get("/api/v2/adaptive-runs/:id/invocations", (req, res) =>
    res.json(store.list<{ runId: string }>("adaptive_invocation").filter((i) => i.runId === req.params.id)));
  app.get("/api/v2/adaptive-runs/:id/plan-revisions", (req, res) =>
    res.json(store.list<{ runId: string }>("adaptive_plan_revision").filter((i) => i.runId === req.params.id)));
  app.post("/api/v2/adaptive-runs/:id/manual/:nodeId/complete", (req, res) => {
    const b = z.object({ output: z.unknown() }).parse(req.body);
    res.json(adaptive.completeManual(req.params.id, req.params.nodeId, b.output));
  });
  app.post("/api/v2/adaptive-runs/:id/reconcile/:nodeId", (req, res) => {
    const b = z.object({ stoppedConfirmed: z.boolean(), note: z.string() }).parse(req.body);
    res.json(adaptive.reconcileUncertain(req.params.id, req.params.nodeId, b.stoppedConfirmed, b.note));
  });
  app.post("/api/v2/adaptive-runs/:id/accept", (req, res) => {
    const b = z.object({ accepted: z.boolean(), reason: z.string().default("") }).parse(req.body);
    res.json(adaptive.accept(req.params.id, b.accepted, b.reason));
  });
  app.post("/api/v2/adaptive-runs/:id/cancel", (req, res) => res.json(adaptive.cancel(req.params.id)));
  app.post("/api/v2/adaptive-runs/:id/retry", (req, res) => {
    const b = z.object({ nodeId: z.string().min(1) }).parse(req.body);
    res.json(adaptive.retry(req.params.id, b.nodeId));
  });
  app.post("/api/v2/adaptive-runs/:id/observations/:checkpointId/decision", (req, res) =>
    res.json(adaptive.resolveWaiting(req.params.id, req.params.checkpointId, req.body)));
  app.get("/api/v2/asset-events/:kind/:id", (req, res) =>
    res.json(store.events("asset:" + req.params.kind + ":" + req.params.id)));
  app.use("/api", (_req, res) =>
    res.status(404).json({ code: "not_found", message: "接口不存在" }),
  );
  app.use(express.static(resolve("dist/web")));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ZodError) {
        res.status(422).json({
          code: "validation_error",
          message: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
        return;
      }
      if (error instanceof DomainError) {
        res
          .status(error.status)
          .json({ code: error.code, message: error.message });
        return;
      }
      if (error instanceof SyntaxError) {
        res
          .status(400)
          .json({ code: "invalid_json", message: "JSON 格式无效" });
        return;
      }
      console.error(error);
      res.status(500).json({
        code: "internal_error",
        message: "服务内部错误，请查看本机日志",
      });
    },
  );
  return app;
}
