import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { Store } from "../persistence/index.js";
import { ResourceService, validatePlan } from "../resources/index.js";
import { workspaceDigest } from "../workspace/index.js";
import { validateTaskRelations } from "../planning/index.js";
import { DiagnosisService } from "../diagnosis/index.js";
import {
  TaskInput,
  ProjectInput,
  DomainError,
  digest,
  workflow,
  terminal,
  assertTransition,
  type Task,
  type Run,
  type Project,
} from "../domain/index.js";

export class WorkService {
  constructor(
    public store: Store,
    public runtime: {
      available: boolean;
      version: string | null;
      model?: string | null;
      reasoning?: string | null;
      configurationDigest?: string;
    } = {
      available: false,
      version: null,
    },
    public evaluationOptions?: {
      candidateIds: string[];
      evaluation: { trialId: string; caseId: string; arm: string };
      projectSnapshot: Project;
      baseCommit: string;
    },
  ) {}
  required<T>(kind: string, id: string): T {
    const item = this.store.get<T>(kind, id);
    if (!item) throw new DomainError("not_found", "记录不存在", 404);
    return item;
  }
  createTask(input: unknown): Task {
    const data = TaskInput.parse(input);
    if (data.type === "manual" && data.flowRequirements)
      throw new DomainError("manual_flow", "人工任务不支持Agent流程配置", 422);
    if (data.projectId) this.required("project", data.projectId);
    const now = new Date().toISOString();
    const task: Task = {
      ...data,
      id: randomUUID(),
      status: "inbox",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      validateTaskRelations(this.store, task);
      this.store.put("task", task);
      this.store.put("task_revision", {
        ...task,
        id: `${task.id}:1`,
        taskId: task.id,
      });
      return task;
    });
  }
  createProject(input: unknown): Project {
    const data = ProjectInput.parse(input);
    let repositoryPath: string;
    try {
      repositoryPath = realpathSync(data.repositoryPath);
      execFileSync(
        "git",
        ["-C", repositoryPath, "rev-parse", "--show-toplevel"],
        { encoding: "utf8", stdio: "pipe", timeout: 10000 },
      );
    } catch {
      throw new DomainError(
        "invalid_repository",
        "请选择已有 Git 仓库目录",
        422,
      );
    }
    const project = {
      ...data,
      repositoryPath,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.store.put("project", project);
    return project;
  }
  updateTask(id: string, revision: number, input: unknown): Task {
    return this.store.transaction(() => {
      const task = this.required<Task>("task", id);
      if (task.revision !== revision)
        throw new DomainError("revision_conflict", "任务已改变，请刷新后重试");
      if (
        this.store
          .list<Run>("run")
          .some((r) => r.taskId === id && !terminal.has(r.status))
      )
        throw new DomainError(
          "active_run",
          "执行期间请先暂停并结束当前运行，再修改任务",
        );
      if (this.store.list<{taskId:string;status:string}>("adaptive_run").some((run) =>
        run.taskId === id && !["done","cancelled","failed"].includes(run.status)))
        throw new DomainError("active_run", "该任务已有活跃的自适应运行，不能修改", 409);
      const data = TaskInput.parse({ ...task, ...(input as object) });
      if (data.type === "manual" && data.flowRequirements)
        throw new DomainError("manual_flow", "人工任务不支持Agent流程配置", 422);
      if (data.projectId) this.required("project", data.projectId);
      const updated = {
        ...task,
        ...data,
        revision: revision + 1,
        status: "planned",
        updatedAt: new Date().toISOString(),
      };
      validateTaskRelations(this.store, updated);
      this.store.put("task", updated);
      this.store.put("task_revision", {
        ...updated,
        id: `${id}:${updated.revision}`,
        taskId: id,
      });
      return updated;
    });
  }
  prepare(id: string) {
    const saved = this.required<Task>("task", id);
    const task = { ...saved, ...TaskInput.parse(saved) };
    const project =
      this.evaluationOptions?.projectSnapshot ??
      (task.projectId
        ? this.required<Project>("project", task.projectId)
        : null);
    const checks: { label: string; passed: boolean; detail: string }[] = [];
    checks.push({
      label: "任务状态",
      passed: !["done", "cancelled", "awaiting_acceptance"].includes(
        task.status,
      ),
      detail: ["done", "cancelled", "awaiting_acceptance"].includes(task.status)
        ? "请先验收当前交付或显式建立新的任务版本"
        : "任务可进入执行准备",
    });
    const blockedBy = task.dependsOn.filter(
      (id) => this.store.get<Task>("task", id)?.status !== "done",
    );
    checks.push({
      label: "任务依赖",
      passed: blockedBy.length === 0,
      detail: blockedBy.length
        ? `等待${blockedBy.length}项前置任务验收`
        : "前置任务已满足",
    });
    let baseCommit: string | null = null;
    if (project) {
      try {
        baseCommit = execFileSync(
          "git",
          [
            "-C",
            project.repositoryPath,
            "rev-parse",
            "--verify",
            this.evaluationOptions?.baseCommit ?? "HEAD",
          ],
          { encoding: "utf8", timeout: 10000 },
        ).trim();
        checks.push({ label: "仓库基线", passed: true, detail: baseCommit });
      } catch {
        checks.push({
          label: "仓库基线",
          passed: false,
          detail: "仓库需要至少一个提交",
        });
      }
    }
    checks.push({
      label: "验收标准",
      passed: task.acceptanceCriteria.length > 0,
      detail: `${task.acceptanceCriteria.length} 项`,
    });
    checks.push({
      label: "执行方式",
      passed:
        task.type === "manual" ||
        (this.runtime.available &&
          !!project?.allowAgent &&
          (task.type === "diagnosis" || !!project?.testCommand) &&
          !!baseCommit),
      detail:
        task.type === "manual"
          ? "人工执行：提交成果后验收"
          : this.runtime.available
            ? task.type === "diagnosis"
              ? "需要仓库与Agent授权；全流程只读，不执行修复"
              : "需要开发任务、仓库授权和可执行测试命令"
            : "Codex未检测到，不能派发真实执行",
    });
    const context = new ResourceService(
      this.store,
      this.evaluationOptions?.candidateIds,
    ).context(
      task.skillVersionIds,
      task.knowledgeVersionIds,
      task.workflowVersionId,
      task.projectId,
      task.type === "diagnosis" ? "diagnosis" : "development",
      task.resourceFamilyIds,
      {
        taskId: task.id,
        runtimeConfigurationDigest: this.runtime.configurationDigest ?? null,
      },
      task.flowRequirements,
      task.externalSkillIds,
    );
    if (context.canaryBindings.length)
      checks.push({
        label: "灰度资源",
        passed: true,
        detail: context.canaryBindings
          .map((binding) => {
            const resource = this.required<{ name: string; version: string }>(
              "resource",
              binding.candidateId,
            );
            return `${resource.name} @${resource.version}`;
          })
          .join("；"),
      });
    const manifest = {
      taskId: id,
      taskRevision: task.revision,
      taskDigest: digest(task),
      task,
      evaluation: this.evaluationOptions?.evaluation ?? null,
      diagnosis:
        task.type === "diagnosis"
          ? new DiagnosisService(this.store).snapshot(task.id)
          : null,
      context,
      planRevision: 1,
      runtimeVersion: this.runtime.version,
      model: this.runtime.model ?? null,
      modelReasoning: this.runtime.reasoning ?? null,
      runtimeConfigurationDigest: this.runtime.configurationDigest ?? null,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      project,
      baseCommit,
      workflowVersion: task.flowRequirements && task.flowRequirements.mode !== "standard"
        ? `task-${task.flowRequirements.mode}@1.0.0`
        : context.workflow
          ? `${context.workflow.name}@${context.workflow.version}`
        : task.type === "diagnosis"
          ? "incident-diagnosis@1.0.0"
          : "feature-development@1.0.0",
      runtime:
        task.type === "manual"
          ? "manual"
          : this.runtime.available
            ? "codex"
            : "unavailable",
    };
    return {
      manifest,
      preparationDigest: digest(manifest),
      checks,
      ready: checks.every((c) => c.passed),
    };
  }
  start(id: string, preparationDigest: string, key: string): Run {
    if (!key || key.length > 200)
      throw new DomainError(
        "idempotency_required",
        "需要有效的 Idempotency-Key",
        422,
      );
    return this.store.transaction(() => {
      const scope = `start:${id}`,
        requestDigest = digest({ preparationDigest });
      const cached = this.store.db
        .prepare(
          "SELECT digest,response FROM idempotency WHERE scope=? AND key=?",
        )
        .get(scope, key) as { digest: string; response: string } | undefined;
      if (cached) {
        if (cached.digest !== requestDigest)
          throw new DomainError(
            "idempotency_conflict",
            "同一请求键不能用于不同内容",
          );
        return JSON.parse(cached.response);
      }
      const prepared = this.prepare(id);
      if (prepared.preparationDigest !== preparationDigest)
        throw new DomainError(
          "stale_preparation",
          "执行准备已过期，请重新检查",
        );
      if (!prepared.ready)
        throw new DomainError("not_ready", "执行准备未通过", 422);
      for (const binding of prepared.manifest.context.canaryBindings) {
        const canary = this.required<any>("resource_canary", binding.id);
        if (canary.rolloutId !== binding.rolloutId)
          throw new DomainError("canary_changed", "灰度版本已变化");
        if (!canary.selectedTaskIds.includes(id)) {
          if (canary.selectedTaskIds.length >= canary.maxTasks)
            throw new DomainError("canary_full", "灰度名额已变化，请重新准备");
          this.store.put("resource_canary", {
            ...canary,
            selectedTaskIds: [...canary.selectedTaskIds, id],
          });
        }
      }
      if (
        this.store
          .list<Run>("run")
          .some((r) => r.taskId === id && !terminal.has(r.status))
      )
        throw new DomainError("active_run", "该任务已有活跃运行");
      if (this.store.list<{taskId:string;status:string}>("adaptive_run").some((run) =>
        run.taskId === id && !["done","cancelled","failed"].includes(run.status)))
        throw new DomainError("active_run", "该任务已有活跃的自适应运行，不能启动旧执行路径", 409);
      const task = this.required<Task>("task", id),
        now = new Date().toISOString();
      const run: Run = {
        id: randomUUID(),
        taskId: id,
        taskRevision: task.revision,
        status: "queued",
        workflowVersion: prepared.manifest.workflowVersion,
        steps:
          task.type === "manual"
            ? [
                {
                  id: randomUUID(),
                  key: "manual",
                  title: "人工执行与成果提交",
                  status: "pending",
                  attempts: 0,
                },
              ]
            : prepared.manifest.context.plan.map(
                ({ key, title, operation, dependsOn }) => ({
                  id: randomUUID(),
                  key,
                  title,
                  operation,
                  dependsOn,
                  status: "pending",
                  attempts: 0,
                }),
              ),
        createdAt: now,
        updatedAt: now,
        runtime: prepared.manifest.runtime,
        manifest: prepared.manifest,
      };
      this.store.put("run", run);
      this.store.put("task", {
        ...task,
        status: "in_progress",
        updatedAt: now,
      });
      this.store.event(run.id, "run.created", { manifest: run.manifest });
      this.store.db
        .prepare("INSERT INTO outbox(id,run_id,created_at) VALUES(?,?,?)")
        .run(randomUUID(), run.id, now);
      if (run.runtime === "manual") {
        this.transition(run.id, "preparing");
        this.transition(run.id, "running");
        this.store.db
          .prepare("UPDATE outbox SET state='done' WHERE run_id=?")
          .run(run.id);
      }
      const result = this.required<Run>("run", run.id);
      this.store.db
        .prepare("INSERT INTO idempotency VALUES(?,?,?,?)")
        .run(scope, key, requestDigest, JSON.stringify(result));
      return result;
    });
  }
  transition(id: string, status: string) {
    const run = this.required<Run>("run", id);
    assertTransition(run.status, status);
    const updated = {
      ...run,
      status,
      steps:
        run.runtime === "manual" &&
        ["running", "paused", "cancelled"].includes(status)
          ? run.steps.map((step) => ({ ...step, status }))
          : run.steps,
      updatedAt: new Date().toISOString(),
    };
    this.store.put("run", updated);
    if (status === "failed") {
      const task = this.store.get<Task>("task", run.taskId);
      if (task?.status === "in_progress")
        this.store.put("task", {
          ...task,
          status: "blocked",
          blockedReason: "运行失败；请查看执行记录并重新准备",
          updatedAt: new Date().toISOString(),
        });
    }
    if (status === "failed")
      for (const binding of (
        run.manifest.context as { canaryBindings?: { rolloutId: string }[] }
      )?.canaryBindings ?? [])
        this.store.put("canary_alert", {
          id: binding.rolloutId,
          runId: id,
          at: new Date().toISOString(),
        });
    this.store.event(id, "run.status_changed", {
      from: run.status,
      to: status,
    });
    return updated;
  }
  control(id: string, action: string) {
    return this.store.transaction(() => {
      const run = this.required<Run>("run", id);
      if (run.runtime !== "manual") {
        if (action === "cancel" && run.status === "queued") {
          this.transition(id, "cancelling");
          const result = this.transition(id, "cancelled");
          const task = this.required<Task>("task", run.taskId);
          this.store.put("task", { ...task, status: "planned" });
          return result;
        }
        if (action === "pause") return this.transition(id, "pausing");
        if (action === "cancel") return this.transition(id, "cancelling");
        if (action === "resume" && run.status === "paused") {
          const frozenTask = run.manifest.task as Task;
          const frozenContext = run.manifest.context as {
            skills: { id: string }[];
            knowledge: { id: string }[];
            workflow: { id: string } | null;
            canaryBindings?: {
              id: string;
              candidateId: string;
              rolloutId: string;
            }[];
          };
          if (
            (frozenTask.dependsOn ?? []).some(
              (id) => this.store.get<Task>("task", id)?.status !== "done",
            )
          )
            throw new DomainError(
              "dependency_incomplete",
              "前置任务需要先完成验收",
            );
          new ResourceService(
            this.store,
            run.manifest.evaluation
              ? [
                  ...frozenTask.skillVersionIds,
                  ...frozenTask.knowledgeVersionIds,
                  ...(frozenTask.workflowVersionId
                    ? [frozenTask.workflowVersionId]
                    : []),
                ]
              : (frozenContext.canaryBindings ?? [])
                  .filter((binding) => {
                    const current = this.store.get<any>(
                        "resource_canary",
                        binding.id,
                      ),
                      history = this.store
                        .list<any>("canary_history")
                        .find(
                          (h) =>
                            h.rolloutId === binding.rolloutId &&
                            h.selectedTaskIds?.includes(run.taskId),
                        );
                    return (
                      (current?.rolloutId === binding.rolloutId &&
                        current.selectedTaskIds.includes(run.taskId)) ||
                      history
                    );
                  })
                  .map((binding) => binding.candidateId),
          ).context(
            frozenContext.skills.map((r) => r.id),
            frozenContext.knowledge.map((r) => r.id),
            frozenContext.workflow?.id ?? null,
            frozenTask.projectId,
            frozenTask.type === "diagnosis" ? "diagnosis" : "development",
          );
          const binding = this.required<{
            id: string;
            workspace: string;
            locked: boolean;
            checkpointDigest?: string;
          }>("workspace", id);
          if (binding.locked || !binding.checkpointDigest)
            throw new DomainError(
              "recovery_required",
              "尚未确认旧执行停止或缺少检查点",
            );
          const currentDigest = workspaceDigest(binding.workspace);
          if (currentDigest !== binding.checkpointDigest)
            throw new DomainError(
              "workspace_changed",
              "暂停后代码已变化，请通过重新规划重建验证证据",
            );
          if (Number(run.manifest.deadline) <= Date.now())
            throw new DomainError(
              "budget_exhausted",
              "运行时间预算已耗尽，请创建新运行",
            );
          const result = this.transition(id, "preparing");
          this.store.put("run", {
            ...result,
            steps: result.steps.map((s) =>
              ["running", "paused"].includes(s.status)
                ? { ...s, status: "pending" }
                : s,
            ),
          });
          this.store.db
            .prepare("INSERT INTO outbox(id,run_id,created_at) VALUES(?,?,?)")
            .run(randomUUID(), id, new Date().toISOString());
          this.store.event(id, "run.resume_requested", {
            checkpointDigest: currentDigest,
          });
          return this.required<Run>("run", id);
        }
        throw new DomainError(
          "recovery_required",
          "需要核对原进程与工作区，暂不自动重跑",
        );
      }
      if (action === "pause") {
        this.transition(id, "pausing");
        return this.transition(id, "paused");
      }
      if (action === "resume") {
        this.transition(id, "preparing");
        return this.transition(id, "running");
      }
      if (action === "cancel") {
        this.transition(id, "cancelling");
        const result = this.transition(id, "cancelled");
        const task = this.required<Task>("task", run.taskId);
        this.store.put("task", { ...task, status: "planned" });
        return result;
      }
      throw new DomainError("invalid_action", "未知操作", 422);
    });
  }
  submit(id: string, summary: string) {
    return this.store.transaction(() => {
      const run = this.required<Run>("run", id);
      if (run.status !== "running" || run.runtime !== "manual")
        throw new DomainError(
          "invalid_delivery",
          "只有运行中的人工任务可提交人工成果",
        );
      if (!summary.trim() || summary.length > 30000)
        throw new DomainError(
          "invalid_delivery",
          "请提供成果说明（最多30000字）",
          422,
        );
      const delivery = {
        id: randomUUID(),
        runId: id,
        taskRevision: run.taskRevision,
        summary: summary.trim(),
        createdAt: new Date().toISOString(),
      };
      this.store.put("delivery", delivery);
      this.store.put("run", {
        ...run,
        steps: run.steps.map((s) => ({ ...s, status: "succeeded" })),
      });
      this.store.event(id, "delivery.submitted", delivery, "user");
      this.transition(id, "succeeded");
      const task = this.required<Task>("task", run.taskId);
      this.store.put("task", { ...task, status: "awaiting_acceptance" });
      return delivery;
    });
  }
  replan(id: string, expectedRevision: number, nodes: unknown, reason: string) {
    const type = this.required<Run>("run", id).manifest.task as Task;
    const plan = validatePlan(
      nodes,
      type.type === "diagnosis" ? "diagnosis" : "development",
    );
    if (!reason.trim() || reason.length > 4000)
      throw new DomainError(
        "reason_required",
        "请填写流程变更及证据失效原因",
        422,
      );
    return this.store.transaction(() => {
      const run = this.required<Run>("run", id),
        revision = Number(run.manifest.planRevision) || 1;
      if (run.runtime === "manual" || run.status !== "paused")
        throw new DomainError(
          "pause_required",
          "请先暂停Agent运行并等待执行停止",
        );
      if (revision !== expectedRevision || revision >= 5)
        throw new DomainError(
          "revision_conflict",
          "计划版本冲突或已达5个版本上限",
        );
      const binding = this.required<{
        id: string;
        workspace: string;
        locked: boolean;
      }>("workspace", id);
      if (binding.locked)
        throw new DomainError("workspace_locked", "旧执行未确认停止");
      this.store.put("plan_revision", {
        id: `${id}:${revision}`,
        runId: id,
        revision,
        steps: run.steps,
        plan:
          run.manifest.activePlan ??
          (run.manifest.context as { plan: unknown }).plan,
        reason,
      });
      const updated = {
        ...run,
        steps: plan.map((node) => ({
          ...node,
          id: randomUUID(),
          status: "pending",
          attempts: 0,
        })),
        manifest: {
          ...run.manifest,
          activePlan: plan,
          planRevision: revision + 1,
        },
      };
      this.store.put("run", updated);
      this.store.put("workspace", {
        ...binding,
        checkpointDigest: workspaceDigest(binding.workspace),
      });
      this.store.event(
        id,
        "plan.revised",
        {
          from: revision,
          to: revision + 1,
          reason,
          invalidatedStepIds: run.steps.map((s) => s.id),
        },
        "user",
      );
      return updated;
    });
  }
  accept(
    taskId: string,
    deliveryId: string,
    accepted: boolean,
    reason: string,
  ) {
    return this.store.transaction(() => {
      const task = this.required<Task>("task", taskId),
        delivery = this.required<{
          id: string;
          runId: string;
          taskRevision: number;
        }>("delivery", deliveryId),
        run = this.required<Run>("run", delivery.runId);
      if (
        run.taskId !== taskId ||
        task.revision !== delivery.taskRevision ||
        task.status !== "awaiting_acceptance"
      )
        throw new DomainError("stale_delivery", "交付物不属于当前待验收版本");
      if (!accepted && !reason.trim())
        throw new DomainError("reason_required", "退回时请填写原因", 422);
      if (
        accepted &&
        this.store
          .list<Task>("task")
          .some((child) => child.parentId === taskId && child.status !== "done")
      )
        throw new DomainError("children_incomplete", "必需子任务尚未全部验收");
      if (
        accepted &&
        (task.dependsOn ?? []).some(
          (id) => this.store.get<Task>("task", id)?.status !== "done",
        )
      )
        throw new DomainError("dependency_incomplete", "前置任务尚未全部验收");
      this.store.put("acceptance", {
        id: randomUUID(),
        taskId,
        deliveryId,
        accepted,
        reason,
        createdAt: new Date().toISOString(),
      });
      const updated = {
        ...task,
        status: accepted ? "done" : "planned",
        revision: accepted ? task.revision : task.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.store.put("task", updated);
      this.store.event(
        run.id,
        accepted ? "task.accepted" : "task.rejected",
        { deliveryId, reason },
        "user",
      );
      return updated;
    });
  }
}
