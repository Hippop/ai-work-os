import express from "express";
import { z, ZodError } from "zod";
import type { AdaptiveEngine } from "../../../packages/adaptive/engine.js";
import type { AdaptiveRuntime } from "../../../packages/adaptive/runtime.js";
import { getNodeContextManifest } from "../../../packages/context/assembler.js";
import { KnowledgeCurationService } from "../../../packages/context/knowledge-governance.js";
import { DomainError } from "../../../packages/domain/index.js";
import { PlanChangeService } from "../../../packages/graph/change-service.js";
import { GraphCompiler } from "../../../packages/graph/compiler.js";
import { GraphDraftService } from "../../../packages/graph/draft-service.js";
import {
  patchLayout,
  readLayout,
  saveLayout,
} from "../../../packages/graph/layout-service.js";
import { getRunGraph } from "../../../packages/graph/projection.js";
import type { Store } from "../../../packages/persistence/index.js";
import {
  AgentSessionManager,
  InterventionService,
} from "../../../packages/runtime/sessions/index.js";
import type { WorkService } from "../../../packages/workflow/service.js";
import { WorkspaceAccessCoordinator } from "../../../packages/workspace/access.js";

export type V3RouterDeps = {
  store: Store;
  service: WorkService;
  adaptive: AdaptiveEngine;
  adaptiveRuntime?: AdaptiveRuntime;
  sessions: AgentSessionManager;
  interventions: InterventionService;
};

const CompileBodySchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

const DiscardBodySchema = z
  .object({
    note: z.string().trim().min(1).max(2000).default("用户放弃该人工干预结果"),
  })
  .strict();

const SessionInputBodySchema = z
  .object({
    connectionId: z.string().min(1).max(120),
    data: z.string().max(65536),
  })
  .strict();

const DisconnectBodySchema = z
  .object({
    connectionId: z.string().min(1).max(120).optional(),
  })
  .strict();

const RevokeKnowledgeBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

const ReconcileWorkspaceBodySchema = z
  .object({
    workspacePath: z.string().min(1).max(2000),
    stoppedConfirmed: z.boolean(),
    note: z.string().trim().min(1).max(3000),
  })
  .strict();

const EventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export function createV3Router({
  store,
  adaptive,
  adaptiveRuntime,
  sessions,
  interventions,
}: V3RouterDeps): express.Router {
  const router = express.Router();
  const drafts = new GraphDraftService(store);
  const compiler = new GraphCompiler(store);
  const changes = new PlanChangeService(store);
  const curation = new KnowledgeCurationService(store);
  const workspaceAccess = new WorkspaceAccessCoordinator(store);

  // Plan drafts & composition
  router.post("/plan-drafts", (req, res) => {
    res.status(201).json(drafts.createDraft(req.body));
  });

  router.get("/plan-drafts", (req, res) => {
    const projectId =
      typeof req.query.projectId === "string" && req.query.projectId
        ? req.query.projectId
        : undefined;
    const taskId =
      typeof req.query.taskId === "string" && req.query.taskId
        ? req.query.taskId
        : undefined;
    res.json(drafts.listDrafts({ projectId, taskId }));
  });

  router.get("/plan-drafts/:id", (req, res) => {
    res.json(drafts.getDraft(req.params.id));
  });

  router.patch("/plan-drafts/:id", (req, res) => {
    res.json(drafts.patchDraft(req.params.id, req.body));
  });

  router.post("/plan-drafts/:id/compose", async (req, res) => {
    const result = await drafts.composeDraft(req.params.id, req.body);
    res.status(202).json(result);
  });

  router.get("/plan-drafts/:id/compose/:opId", (req, res) => {
    const op = drafts.getComposeOperation(req.params.opId);
    if (op.draftId !== req.params.id) {
      throw new DomainError("compose_op_mismatch", "编排操作不属于指定草稿", 404);
    }
    res.json(op);
  });

  router.post("/plan-drafts/:id/compile", (req, res) => {
    const body = CompileBodySchema.parse(req.body);
    const result = compiler.compile(req.params.id, body.expectedRevision);
    if (!result.ok) {
      res.status(422).json({
        code: "compile_failed",
        message:
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("；") ||
          "方案草稿编译未通过",
        details: { diagnostics: result.diagnostics },
        retryable: false,
        currentRevision: body.expectedRevision,
      });
      return;
    }
    res.json(result);
  });

  router.post("/plan-drafts/:id/start", async (req, res) => {
    const headerKey = req.get("idempotency-key")?.trim();
    const rawBody =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? ({ ...(req.body as Record<string, unknown>) } as Record<string, unknown>)
        : req.body;
    const bodyKey =
      rawBody && typeof rawBody === "object" && "idempotencyKey" in rawBody
        ? String(rawBody.idempotencyKey ?? "").trim()
        : undefined;
    if (rawBody && typeof rawBody === "object" && "idempotencyKey" in rawBody) {
      delete rawBody.idempotencyKey;
    }
    const idempotencyKey = headerKey || bodyKey || undefined;

    const result = await compiler.startCompiledPlan(req.params.id, rawBody, {
      idempotencyKey,
      preflight: adaptiveRuntime
        ? async (plan, task) => {
            const pre = adaptiveRuntime.preflight(
              task,
              adaptive.validate(plan, task.projectId, task.id),
            );
            if (!pre.ready) {
              throw new DomainError(
                "preflight_failed",
                pre.checks
                  .filter((c) => !c.passed)
                  .map((c) => `${c.label}：${c.detail}`)
                  .join("；"),
                422,
              );
            }
          }
        : undefined,
      wake: () => adaptive.triggerWake(),
    });
    res.status(201).json(result);
  });

  // Run projection, events, context & layout
  router.get("/runs/:id/graph", (req, res) => {
    let revision: number | undefined;
    if (req.query.revision !== undefined) {
      revision = z.coerce.number().int().positive().parse(req.query.revision);
    }
    res.json(getRunGraph(store, req.params.id, revision));
  });

  router.get("/runs/:id/events", (req, res) => {
    const run = store.get("adaptive_run", req.params.id);
    if (!run) {
      throw new DomainError("run_missing", "运行不存在", 404);
    }
    const query = EventsQuerySchema.parse(req.query);
    res.json(store.eventsPage(req.params.id, query.after, query.limit));
  });

  router.get("/runs/:id/nodes/:nodeId/context", (req, res) => {
    const invocationId =
      typeof req.query.invocationId === "string" && req.query.invocationId
        ? req.query.invocationId
        : undefined;
    res.json(
      getNodeContextManifest(store, req.params.id, req.params.nodeId, invocationId),
    );
  });

  router.get("/runs/:id/layout", (req, res) => {
    res.json(readLayout(store, req.params.id));
  });

  router.post("/runs/:id/layout", (req, res) => {
    res.json(saveLayout(store, req.params.id, req.body));
  });

  router.patch("/canvas-layouts/:id", (req, res) => {
    res.json(patchLayout(store, req.params.id, req.body));
  });

  // Change proposals
  router.post("/runs/:id/change-proposals", async (req, res) => {
    const result = await changes.createProposal(req.params.id, req.body);
    res.status(201).json(result);
  });

  router.get("/runs/:id/change-proposals", (req, res) => {
    if (!store.get("adaptive_run", req.params.id)) {
      throw new DomainError("run_missing", "运行不存在", 404);
    }
    res.json(changes.listProposals(req.params.id));
  });

  router.get("/change-proposals/:id", (req, res) => {
    res.json(changes.getProposal(req.params.id));
  });

  router.post("/change-proposals/:id/commit", (req, res) => {
    res.json(
      changes.commitProposal(req.params.id, req.body, {
        wake: () => adaptive.triggerWake(),
      }),
    );
  });

  // Interventions & Interactive CLI sessions
  router.post("/runs/:id/interventions", (req, res) => {
    res.status(201).json(interventions.requestIntervention(req.params.id, req.body));
  });

  router.get("/runs/:id/interventions", (req, res) => {
    if (!store.get("adaptive_run", req.params.id)) {
      throw new DomainError("run_missing", "运行不存在", 404);
    }
    res.json(interventions.listInterventions(req.params.id));
  });

  const activeSessions = (req: express.Request): AgentSessionManager =>
    (req.app?.locals?.v3Sessions as AgentSessionManager | undefined) ?? sessions;

  router.post("/interventions/:id/sessions", (req, res) => {
    res
      .status(201)
      .json(activeSessions(req).startSession(req.params.id, req.body ?? {}));
  });

  router.post("/interventions/:id/adopt", (req, res) => {
    res.json(
      interventions.adoptIntervention(req.params.id, req.body, {
        wake: () => adaptive.triggerWake(),
      }),
    );
  });

  router.post("/interventions/:id/discard", (req, res) => {
    const body = DiscardBodySchema.parse(req.body ?? {});
    res.json(interventions.discardIntervention(req.params.id, body.note));
  });

  // Agent session routes (/adapters must precede /:id)
  router.get("/agent-sessions/adapters", (req, res) => {
    res.json(activeSessions(req).listAdapters());
  });

  router.get("/agent-sessions/:id", (req, res) => {
    res.json(activeSessions(req).getSession(req.params.id));
  });

  router.post("/agent-sessions/:id/connect-ticket", (req, res) => {
    res.json(activeSessions(req).issueConnectTicket(req.params.id));
  });

  router.get("/agent-sessions/:id/output", (req, res) => {
    const afterSeq = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse(req.query.afterSeq ?? 0);
    res.json(activeSessions(req).readOutput(req.params.id, afterSeq));
  });

  router.post("/agent-sessions/:id/input", (req, res) => {
    const body = SessionInputBodySchema.parse(req.body);
    activeSessions(req).sendInput(req.params.id, body.connectionId, body.data);
    res.json({ ok: true });
  });

  router.post("/agent-sessions/:id/resize", (req, res) => {
    res.json(activeSessions(req).resize(req.params.id, req.body));
  });

  router.post("/agent-sessions/:id/disconnect", (req, res) => {
    const body = DisconnectBodySchema.parse(req.body ?? {});
    res.json(activeSessions(req).disconnect(req.params.id, body.connectionId));
  });

  router.post("/agent-sessions/:id/stop", async (req, res) => {
    res.json(await activeSessions(req).stopSession(req.params.id, req.body));
  });

  // Knowledge governance V3 endpoints
  router.post("/knowledge-candidates", (req, res) => {
    res.status(201).json(curation.proposeCandidate(req.body));
  });

  router.post("/knowledge-claims/:id/publish", (req, res) => {
    res.json(curation.publishClaim(req.params.id));
  });

  router.post("/knowledge-conflicts", (req, res) => {
    res.status(201).json(curation.registerConflict(req.body));
  });

  router.get("/knowledge-claims", (req, res) => {
    let claims = curation.listClaims();
    if (typeof req.query.projectId === "string" && req.query.projectId) {
      claims = claims.filter((c) => c.projectId === req.query.projectId);
    }
    if (typeof req.query.knowledgeId === "string" && req.query.knowledgeId) {
      claims = claims.filter((c) => c.knowledgeId === req.query.knowledgeId);
    }
    res.json(claims);
  });

  router.post("/knowledge/:id/revoke", (req, res) => {
    const body = RevokeKnowledgeBodySchema.parse(req.body ?? {});
    res.json(curation.revokeAndPropagate(req.params.id, body.reason));
  });

  // Workspace reconciliation
  router.post("/workspaces/reconcile", (req, res) => {
    const body = ReconcileWorkspaceBodySchema.parse(req.body);
    res.json(
      workspaceAccess.reconcile(
        body.workspacePath,
        body.stoppedConfirmed,
        body.note,
      ),
    );
  });

  // Uniform V3 error envelope
  router.use(
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
          details: { issues: error.issues },
          retryable: false,
          currentRevision: null,
        });
        return;
      }
      if (error instanceof DomainError) {
        const extra = error as DomainError & {
          details?: unknown;
          retryable?: boolean;
          currentRevision?: number | null;
        };
        res.status(error.status).json({
          code: error.code,
          message: error.message,
          details: extra.details ?? null,
          retryable: extra.retryable ?? false,
          currentRevision: extra.currentRevision ?? null,
        });
        return;
      }
      if (error instanceof SyntaxError) {
        res.status(400).json({
          code: "invalid_json",
          message: "JSON 格式无效",
          details: null,
          retryable: false,
          currentRevision: null,
        });
        return;
      }
      console.error(error);
      res.status(500).json({
        code: "internal_error",
        message: "服务内部错误，请查看本机日志",
        details: null,
        retryable: false,
        currentRevision: null,
      });
    },
  );

  return router;
}
