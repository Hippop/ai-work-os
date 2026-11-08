import express from "express";
import { z, ZodError } from "zod";
import { resolve, join } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Store } from "../../packages/persistence/index.js";
import { WorkService } from "../../packages/workflow/service.js";
import {
  DomainError,
  type Run,
  type Task,
} from "../../packages/domain/index.js";

export function createApp(
  store: Store,
  token: string,
  service = new WorkService(store),
  dataDir?: string,
) {
  const app = express();
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
  app.get("/api/v1/tasks", (_req, res) => res.json(store.list("task")));
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
      join(dataDir, "artifacts", req.params.id, name),
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
      observations: ["当前分析覆盖人工任务；Agent 用量与优化评估尚未接入。"],
    });
  });
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
