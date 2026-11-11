import { ExternalSkillService } from "../external-skills/index.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../persistence/index.js";
import {
  DomainError,
  digest,
  workflow,
  FlowNodeInput,
  FlowRequirementsInput,
  type FlowRequirements,
  type Run,
  type Task,
} from "../domain/index.js";

export const NodeInput = FlowNodeInput;
export type PlanNode = z.infer<typeof NodeInput>;
export const defaultPlan: PlanNode[] = workflow.map(([key, title], i) => ({
  key,
  operation: key,
  title,
  dependsOn: i ? [workflow[i - 1][0]] : [],
}));
export const diagnosisPlan: PlanNode[] = [
  "collect",
  "hypothesize",
  "verify",
  "conclude",
  "deliver",
].map((key, i, keys) => ({
  key,
  operation: key as PlanNode["operation"],
  title: [
    "故障证据收集",
    "建立候选假设",
    "验证假设与反证",
    "形成根因结论",
    "交付诊断报告",
  ][i],
  dependsOn: i ? [keys[i - 1]] : [],
}));
export function validatePlan(
  input: unknown,
  taskType = "development",
): PlanNode[] {
  const nodes = z
    .array(NodeInput)
    .min(taskType === "diagnosis" ? 5 : 6)
    .max(30)
    .parse(input);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  if (byKey.size !== nodes.length)
    throw new DomainError("invalid_plan", "步骤名称重复", 422);
  const ordered: PlanNode[] = [],
    visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key))
      throw new DomainError("invalid_plan", "步骤存在循环依赖", 422);
    if (visited.has(key)) return;
    const node = byKey.get(key);
    if (!node) throw new DomainError("invalid_plan", "依赖步骤不存在", 422);
    visiting.add(key);
    node.dependsOn.forEach(visit);
    visiting.delete(key);
    visited.add(key);
    ordered.push(node);
  }
  nodes.forEach((n) => visit(n.key));
  // Every step must be in the dependency ancestry of the single delivery node.
  const deliveries = ordered.filter((n) => n.operation === "deliver");
  if (deliveries.length !== 1 || deliveries[0] !== ordered.at(-1))
    throw new DomainError("invalid_plan", "需要唯一的最终交付步骤", 422);
  const ancestors = new Set<string>();
  function collect(key: string) {
    if (ancestors.has(key)) return;
    ancestors.add(key);
    byKey.get(key)!.dependsOn.forEach(collect);
  }
  collect(deliveries[0].key);
  if (ancestors.size !== nodes.length)
    throw new DomainError("invalid_plan", "所有步骤必须连接到交付节点", 422);
  const required =
    taskType === "diagnosis"
      ? ["collect", "hypothesize", "verify", "conclude"]
      : ["analyze", "design", "implement", "test", "review"];
  if (ordered.some((n) => ![...required, "deliver"].includes(n.operation)))
    throw new DomainError(
      "invalid_plan",
      "工作流包含当前任务类型不允许的操作",
      422,
    );
  for (const operation of required)
    if (!ordered.some((n) => n.operation === operation))
      throw new DomainError(
        "invalid_plan",
        `不能省略必需操作：${operation}`,
        422,
      );
  const operations = ordered.map((n) => n.operation);
  if (
    taskType === "diagnosis" &&
    ["collect", "hypothesize", "verify", "conclude"].some(
      (op, i, all) =>
        i > 0 &&
        operations.lastIndexOf(op as PlanNode["operation"]) <
          operations.lastIndexOf(all[i - 1] as PlanNode["operation"]),
    )
  )
    throw new DomainError(
      "invalid_plan",
      "诊断必须先收集、建立假设、验证，再形成结论",
      422,
    );
  const lastWrite = operations.lastIndexOf("implement"),
    lastTest = operations.lastIndexOf("test"),
    lastReview = operations.lastIndexOf("review");
  if (
    taskType !== "diagnosis" &&
    (lastTest < lastWrite || lastReview < lastTest)
  )
    throw new DomainError(
      "invalid_plan",
      "最终实现后必须测试，测试后必须审查",
      422,
    );
  // Linear execution order is not a substitute for actual DAG ancestry:
  // every code change must precede the final test, which must precede review.
  function precedes(earlier: PlanNode, later: PlanNode): boolean {
    const pending = [...later.dependsOn];
    const seen = new Set<string>();
    while (pending.length) {
      const key = pending.pop()!;
      if (key === earlier.key) return true;
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push(...(byKey.get(key)?.dependsOn ?? []));
    }
    return false;
  }
  const last = (operation: PlanNode["operation"]) =>
    [...ordered].reverse().find((node) => node.operation === operation)!;
  if (taskType === "diagnosis") {
    const stages = ["collect", "hypothesize", "verify", "conclude", "deliver"] as const;
    for (let i = 1; i < stages.length; i++)
      if (!precedes(last(stages[i - 1]), last(stages[i])))
        throw new DomainError("invalid_plan", "诊断阶段必须具备真实的依赖关系", 422);
  } else {
    for (const operation of ["implement", "test", "review"] as const) {
      const target = operation === "implement" ? last("test") :
        operation === "test" ? last("review") : last("deliver");
      if (ordered.some((node) =>
        node.operation === operation && !precedes(node, target)))
        throw new DomainError(
          "invalid_plan",
          "实现、测试、审查、交付必须形成完整的依赖链",
          422,
        );
    }
  }
  return ordered;
}
/** Resolve the task's declarative request into a validated DAG. */
export function assemblePlan(
  templatePlan: PlanNode[],
  request: FlowRequirements | null | undefined,
  taskType = "development",
): PlanNode[] {
  if (!request) return validatePlan(templatePlan, taskType);
  const requirements = FlowRequirementsInput.parse(request);
  if (requirements.mode === "standard")
    return validatePlan(templatePlan, taskType);
  if (requirements.mode === "graph")
    return validatePlan(requirements.nodes, taskType);
  const counts = new Map<string, number>();
  let previous: string | null = null;
  const composed: PlanNode[] = requirements.stages.map((stage) => {
    const number = (counts.get(stage.operation) ?? 0) + 1;
    counts.set(stage.operation, number);
    const key = stage.operation + "_" + number;
    const node: PlanNode = {
      ...stage,
      key,
      dependsOn: previous ? [previous] : [],
    };
    previous = key;
    return node;
  });
  return validatePlan(composed, taskType);
}
const VersionInput = z.object({
  kind: z.enum(["skill", "knowledge", "workflow"]),
  name: z.string().trim().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  projectId: z.string().uuid().nullable().default(null),
  content: z.string().min(1).max(40000),
  sources: z.array(z.string().min(1).max(2000)).max(50).default([]),
  nodes: z.array(NodeInput).optional(),
  taskType: z.enum(["development", "diagnosis"]).default("development"),
});
export type ResourceVersion = z.infer<typeof VersionInput> & {
  id: string;
  contentDigest: string;
  createdAt: string;
};
export class ResourceService {
  constructor(
    public store: Store,
    public candidateIds: string[] = [],
  ) {}
  create(input: unknown) {
    const data = VersionInput.parse(input);
    if (data.projectId && !this.store.get("project", data.projectId))
      throw new DomainError("not_found", "项目不存在", 404);
    if (data.kind === "knowledge" && !data.sources.length)
      throw new DomainError("sources_required", "知识必须标明来源", 422);
    if (data.kind === "workflow")
      data.nodes = validatePlan(data.nodes, data.taskType);
    if (data.kind !== "workflow" && data.nodes)
      throw new DomainError("invalid_resource", "只有工作流可以定义步骤", 422);
    return this.store.transaction(() => {
      if (
        this.store
          .list<ResourceVersion>("resource")
          .some(
            (v) =>
              v.kind === data.kind &&
              v.name === data.name &&
              v.version === data.version &&
              v.projectId === data.projectId,
          )
      )
        throw new DomainError("version_exists", "版本已存在，内容不可覆盖");
      const resource = {
        ...data,
        id: randomUUID(),
        contentDigest: digest(data),
        createdAt: new Date().toISOString(),
      };
      this.store.put("resource", resource);
      this.store.put("resource_status", {
        id: resource.id,
        state: "candidate",
      });
      return resource;
    });
  }
  publish(
    id: string,
    proof?: { evaluationId?: string; rollbackReleaseId?: string },
  ) {
    return this.store.transaction(() => {
      const resource = this.store.get<ResourceVersion>("resource", id);
      if (!resource) throw new DomainError("not_found", "资源不存在", 404);
      const proposals = this.store
        .list<{ id: string; candidateId: string }>("improvement")
        .filter((p) => p.candidateId === id);
      if (proposals.length) {
        const evaluation = proof?.evaluationId
          ? this.store.get<{ proposalId: string; result: { gate: string } }>(
              "evaluation",
              proof.evaluationId,
            )
          : null;
        const rollback = proof?.rollbackReleaseId
          ? this.store.get<{ previousResourceId: string }>(
              "improvement_release",
              proof.rollbackReleaseId,
            )
          : null;
        if (
          !(
            evaluation?.result.gate === "passed" &&
            proposals.some((p) => p.id === evaluation.proposalId)
          ) &&
          rollback?.previousResourceId !== id
        )
          throw new DomainError(
            "evaluation_required",
            "优化候选须通过评估与发布流程",
          );
      }
      if (
        this.store.get<{ state: string }>("resource_status", id)?.state ===
        "revoked"
      )
        throw new DomainError("revoked", "撤销版本不能重新发布");
      this.store.put("resource_status", { id, state: "published" });
      const pointer = {
        id: digest([resource.kind, resource.name, resource.projectId]),
        resourceId: id,
        updatedAt: new Date().toISOString(),
      };
      this.store.put("resource_release", pointer);
      return pointer;
    });
  }
  revoke(id: string) {
    if (!this.store.get("resource", id))
      throw new DomainError("not_found", "资源不存在", 404);
    this.store.transaction(() => {
      this.store.put("resource_status", { id, state: "revoked" });
      for (const run of this.store.list<Run>("run")) {
        const frozenContext = run.manifest.context as {
          skills?: ResourceVersion[];
          knowledge?: ResourceVersion[];
          workflow?: ResourceVersion;
        };
        const task = run.manifest.task as {
          skillVersionIds?: string[];
          knowledgeVersionIds?: string[];
          workflowVersionId?: string;
        };
        if (
          ![
            ...(task?.skillVersionIds ?? []),
            ...(task?.knowledgeVersionIds ?? []),
            task?.workflowVersionId,
            ...[
              ...(frozenContext?.skills ?? []),
              ...(frozenContext?.knowledge ?? []),
              ...(frozenContext?.workflow ? [frozenContext.workflow] : []),
            ].map((r) => r.id),
          ].includes(id)
        )
          continue;
        if (
          run.runtime !== "manual" &&
          ["running", "queued", "preparing"].includes(run.status)
        ) {
          const status =
            run.status === "queued"
              ? "cancelled"
              : run.status === "preparing"
                ? "reconciling"
                : "pausing";
          this.store.put("run", { ...run, status });
          if (status === "cancelled") {
            const task = this.store.get<Task>("task", run.taskId);
            if (task) this.store.put("task", { ...task, status: "planned" });
          }
          this.store.event(run.id, "resource.revoked", {
            resourceId: id,
            from: run.status,
            to: status,
          });
        }
      }
    });
  }
  resolve(
    ids: string[],
    kind: string,
    projectId: string | null,
  ): ResourceVersion[] {
    return ids.map((id) => {
      const resource = this.store.get<ResourceVersion>("resource", id);
      if (
        !resource ||
        resource.kind !== kind ||
        (resource.projectId !== null && resource.projectId !== projectId)
      )
        throw new DomainError(
          "resource_scope",
          "资源不存在或超出项目范围",
          422,
        );
      if (
        this.store.get<{ state: string }>("resource_status", id)?.state !==
          "published" &&
        !(
          this.candidateIds.includes(id) &&
          this.store.get<{ state: string }>("resource_status", id)?.state ===
            "candidate"
        )
      )
        throw new DomainError(
          "resource_unpublished",
          "只能选择已发布且未撤销的资源",
          422,
        );
      return resource;
    });
  }
  context(
    skillIds: string[],
    knowledgeIds: string[],
    workflowId: string | null,
    projectId: string | null,
    taskType = "development",
    familyIds: string[] = [],
    rollout?: { taskId: string; runtimeConfigurationDigest?: string | null },
    flowRequirements: FlowRequirements | null = null,
    externalSkillIds: string[] = [],
  ) {
    const canaryBindings: {
      id: string;
      candidateId: string;
      rolloutId: string;
    }[] = [];
    const active = familyIds.map((id) => {
      const pointer = this.store.get<{ resourceId: string }>(
        "resource_release",
        id,
      );
      if (!pointer)
        throw new DomainError("release_not_found", "资源发布指针不存在", 422);
      const canary = this.store.get<any>("resource_canary", id);
      if (
        rollout &&
        canary?.status === "active" &&
        !this.store.get("canary_alert", canary.rolloutId) &&
        canary.baselineId === pointer.resourceId &&
        canary.projectIds.includes(projectId) &&
        canary.runtimeConfigurationDigest ===
          (rollout.runtimeConfigurationDigest ?? null) &&
        (canary.selectedTaskIds.includes(rollout.taskId) ||
          canary.selectedTaskIds.length < canary.maxTasks) &&
        this.store.get<{ state: string }>("resource_status", canary.candidateId)
          ?.state !== "revoked"
      ) {
        canaryBindings.push({
          id,
          candidateId: canary.candidateId,
          rolloutId: canary.rolloutId,
        });
        return this.store.get<ResourceVersion>("resource", canary.candidateId)!;
      }
      return this.store.get<ResourceVersion>("resource", pointer.resourceId)!;
    });
    if (
      active.filter((r) => r.kind === "workflow").length +
        (workflowId ? 1 : 0) >
      1
    )
      throw new DomainError(
        "workflow_conflict",
        "只能选择一个工作流版本或发布绑定",
        422,
      );
    skillIds = [
      ...skillIds,
      ...active.filter((r) => r.kind === "skill").map((r) => r.id),
    ];
    knowledgeIds = [
      ...knowledgeIds,
      ...active.filter((r) => r.kind === "knowledge").map((r) => r.id),
    ];
    workflowId =
      workflowId ?? active.find((r) => r.kind === "workflow")?.id ?? null;
    const resolver = new ResourceService(this.store, [
      ...this.candidateIds,
      ...canaryBindings.map((c) => c.candidateId),
    ]);
    const skills = [
        ...resolver.resolve(skillIds, "skill", projectId),
        ...new ExternalSkillService(this.store).snapshot(externalSkillIds),
      ],
      knowledge = resolver.resolve(knowledgeIds, "knowledge", projectId),
      template = workflowId
        ? resolver.resolve([workflowId], "workflow", projectId)[0]
        : null;
    if (template && (template.taskType ?? "development") !== taskType)
      throw new DomainError("workflow_type", "模板与任务类型不匹配", 422);
    const result = {
      skills,
      knowledge,
      workflow: template,
      canaryBindings,
      plan: assemblePlan(
        template?.nodes ?? (taskType === "diagnosis" ? diagnosisPlan : defaultPlan),
        flowRequirements,
        taskType,
      ),
    };
    const keys = [...skills, ...knowledge].map((r) => `${r.kind}:${r.name}`);
    if (new Set(keys).size !== keys.length)
      throw new DomainError(
        "resource_conflict",
        "同名资源版本冲突，请选择唯一版本",
        422,
      );
    if (JSON.stringify(result).length > 80000)
      throw new DomainError(
        "context_budget",
        "上下文超过80000字符预算，请减少资源",
        422,
      );
    return { ...result, digest: digest(result) };
  }
}
