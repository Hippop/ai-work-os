import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DomainError,
  digest,
  type Run,
  type Project,
} from "../domain/index.js";
import type { ResourceVersion } from "../resources/index.js";
import type { OptimizationService, Proposal } from "./index.js";
export class RolloutService {
  constructor(public engine: OptimizationService) {}
  start(proposalId: string, input: unknown) {
    const data = z
      .object({
        evaluationId: z.string().uuid(),
        projectIds: z.array(z.string().uuid()).min(1).max(20),
        maxTasks: z.number().int().min(1).max(20).default(5),
        mode: z.enum(["manual", "automatic"]).default("manual"),
        approvalReason: z.string().max(10000).default(""),
      })
      .parse(input);
    const { engine: e } = this,
      proposal = e.required<Proposal>("improvement", proposalId),
      evaluation = e.required<any>("evaluation", data.evaluationId),
      resource = e.required<ResourceVersion>("resource", proposal.candidateId);
    if (
      evaluation.proposalId !== proposalId ||
      evaluation.result.gate !== "passed"
    )
      throw new DomainError("evaluation_gate", "评估未通过，不能灰度");
    if (data.mode === "manual" && !data.approvalReason.trim())
      throw new DomainError("approval_required", "灰度需要人工审核理由", 422);
    if (
      data.mode === "automatic" &&
      (proposal.risk !== "low" ||
        evaluation.result.holdoutCases < 20 ||
        !e.store.get<{ enabled: boolean }>(
          "optimization_policy",
          "auto_low_risk",
        )?.enabled ||
        evaluation.pairs.some((p: any) => {
          const run = e.required<Run>("run", p.candidateRunId);
          return (
            !run.manifest.model || !run.manifest.runtimeConfigurationDigest
          );
        }))
    )
      throw new DomainError(
        "approval_required",
        "自动灰度需要低风险、20个留出案例及已知模型配置",
      );
    for (const projectId of data.projectIds) {
      e.required<Project>("project", projectId);
      if (resource.projectId && resource.projectId !== projectId)
        throw new DomainError("resource_scope", "灰度项目超出资源范围", 422);
    }
    if (
      e.required<{ state: string }>("resource_status", resource.id).state ===
      "revoked"
    )
      throw new DomainError("revoked", "候选已撤销");
    for (const pair of evaluation.pairs)
      if (!e.inspectRun(e.required<Run>("run", pair.candidateRunId)).pass)
        throw new DomainError("evidence_changed", "评估证据已失效");
    const id = digest([resource.kind, resource.name, resource.projectId]),
      current = e.store.get<any>("resource_canary", id);
    if (current?.status === "active") {
      if (current.evaluationId === evaluation.id) return current;
      throw new DomainError("canary_conflict", "该资源已有灰度");
    }
    if (
      e.required<{ resourceId: string }>("resource_release", id).resourceId !==
      proposal.baselineId
    )
      throw new DomainError("release_conflict", "发布指针已离开基线");
    const run = e.required<Run>("run", evaluation.pairs[0].candidateRunId);
    const canary = {
      id,
      rolloutId: randomUUID(),
      proposalId,
      evaluationId: evaluation.id,
      baselineId: proposal.baselineId,
      candidateId: resource.id,
      projectIds: data.projectIds,
      maxTasks: data.maxTasks,
      selectedTaskIds: [] as string[],
      acceptedTaskIds: [] as string[],
      runtimeConfigurationDigest:
        run.manifest.runtimeConfigurationDigest ?? null,
      status: "active",
      mode: data.mode,
      approvalReason: data.approvalReason,
      createdAt: new Date().toISOString(),
    };
    e.store.transaction(() => {
      e.store.put("resource_canary", canary);
      e.store.put("canary_history", {
        ...canary,
        id: randomUUID(),
        action: "started",
      });
    });
    return canary;
  }
  inspect(canary: any) {
    const { engine: e } = this,
      runs = e.store
        .list<Run>("run")
        .filter((run) =>
          (run.manifest.context as any)?.canaryBindings?.some(
            (b: any) => b.rolloutId === canary.rolloutId,
          ),
        );
    const failed =
      !!e.store.get("canary_alert", canary.rolloutId) ||
      runs.some((run) => run.status === "failed");
    const acceptedTaskIds = [
      ...new Set(
        runs
          .filter((run) => {
            const delivery = e.store
              .list<any>("delivery")
              .find((d) => d.runId === run.id);
            return (
              delivery &&
              e.inspectRun(run).pass &&
              e.store
                .list<any>("acceptance")
                .some((a) => a.deliveryId === delivery.id && a.accepted)
            );
          })
          .map((run) => run.taskId),
      ),
    ];
    return { failed, acceptedTaskIds };
  }
  stop(id: string, rolloutId: string, reason: string) {
    const e = this.engine,
      canary = e.required<any>("resource_canary", id);
    if (canary.rolloutId !== rolloutId || canary.status !== "active")
      throw new DomainError("canary_conflict", "灰度状态已变化");
    if (!reason.trim())
      throw new DomainError("reason_required", "需要停止原因", 422);
    const stopped = {
      ...canary,
      status: "stopped",
      reason,
      stoppedAt: new Date().toISOString(),
    };
    e.store.transaction(() => {
      e.store.put("resource_canary", stopped);
      e.store.put("canary_history", {
        ...stopped,
        id: randomUUID(),
        action: "stopped",
      });
    });
    return stopped;
  }
  promote(id: string, input: unknown) {
    const data = z
        .object({
          rolloutId: z.string().uuid(),
          approvalReason: z.string().max(10000).default(""),
        })
        .parse(input),
      e = this.engine,
      canary = e.required<any>("resource_canary", id);
    if (canary.rolloutId !== data.rolloutId || canary.status !== "active")
      throw new DomainError("canary_conflict", "灰度状态已变化");
    const observed = this.inspect(canary);
    if(canary.mode==='automatic'&&canary.projectIds.some((projectId:string)=>!this.engine.store.get<{projectIds:string[]}>('optimization_policy','auto_low_risk')?.projectIds?.includes(projectId)))throw new DomainError('policy_changed','自动灰度项目范围已变化');
    if (observed.failed || observed.acceptedTaskIds.length < canary.maxTasks)
      throw new DomainError(
        "canary_gate",
        "灰度需要达到已验收任务数且无执行失败",
      );
    return e.store.transaction(() => {
      const release = e.release(
        canary.proposalId,
        {
          evaluationId: canary.evaluationId,
          mode: canary.mode,
          approvalReason: data.approvalReason || canary.approvalReason,
        },
        { id: canary.id, rolloutId: canary.rolloutId },
      );
      const completed = {
        ...canary,
        status: "published",
        acceptedTaskIds: observed.acceptedTaskIds,
        releaseId: release.id,
      };
      e.store.put("resource_canary", completed);
      e.store.put("canary_history", {
        ...completed,
        id: randomUUID(),
        action: "promoted",
      });
      return release;
    });
  }
  tick() {
    const e = this.engine;
    for (const canary of e.store
      .list<any>("resource_canary")
      .filter((c) => c.status === "active")) {
      const observed = this.inspect(canary),
        revoked =
          e.store.get<{ state: string }>("resource_status", canary.candidateId)
            ?.state === "revoked";
      const policy=e.store.get<{enabled:boolean;projectIds:string[]}>('optimization_policy','auto_low_risk');
      if (
        observed.failed ||
        revoked ||
        (canary.mode === "automatic" && (!policy?.enabled||canary.projectIds.some((id:string)=>!policy.projectIds?.includes(id))))
      ) {
        this.stop(
          canary.id,
          canary.rolloutId,
          revoked
            ? "候选被撤销"
            : observed.failed
              ? "灰度任务执行失败，停止新采用"
              : "自动策略已关闭",
        );
        continue;
      }
      e.store.put("resource_canary", {
        ...canary,
        acceptedTaskIds: observed.acceptedTaskIds,
      });
      if (
        canary.mode === "automatic" &&
        observed.acceptedTaskIds.length >= canary.maxTasks
      ) {
        try {
          this.promote(canary.id, { rolloutId: canary.rolloutId });
        } catch (error) {
          e.store.put("optimization_notice", {
            id: `canary:${canary.rolloutId}`,
            message: (error as Error).message,
          });
        }
      }
    }
  }
}
