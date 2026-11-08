import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../persistence/index.js";
import {
  DomainError,
  digest,
  workflow,
  type Run,
  type Task,
} from "../domain/index.js";

export const NodeInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
  operation: z.enum([
    "analyze",
    "design",
    "implement",
    "test",
    "review",
    "deliver",
  ]),
  title: z.string().min(1).max(200),
  dependsOn: z.array(z.string()).default([]),
});
export type PlanNode = z.infer<typeof NodeInput>;
export const defaultPlan: PlanNode[] = workflow.map(([key, title], i) => ({
  key,
  operation: key,
  title,
  dependsOn: i ? [workflow[i - 1][0]] : [],
}));
export function validatePlan(input: unknown): PlanNode[] {
  const nodes = z.array(NodeInput).min(6).max(30).parse(input);
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
  for (const operation of ["analyze", "design", "implement", "test", "review"])
    if (!ordered.some((n) => n.operation === operation))
      throw new DomainError(
        "invalid_plan",
        `不能省略必需操作：${operation}`,
        422,
      );
  const operations = ordered.map((n) => n.operation);
  const lastWrite = operations.lastIndexOf("implement"),
    lastTest = operations.lastIndexOf("test"),
    lastReview = operations.lastIndexOf("review");
  if (lastTest < lastWrite || lastReview < lastTest)
    throw new DomainError(
      "invalid_plan",
      "最终实现后必须测试，测试后必须审查",
      422,
    );
  return ordered;
}
const VersionInput = z.object({
  kind: z.enum(["skill", "knowledge", "workflow"]),
  name: z.string().trim().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  projectId: z.string().uuid().nullable().default(null),
  content: z.string().min(1).max(40000),
  sources: z.array(z.string().min(1).max(2000)).max(50).default([]),
  nodes: z.array(NodeInput).optional(),
});
export type ResourceVersion = z.infer<typeof VersionInput> & {
  id: string;
  contentDigest: string;
  createdAt: string;
};
export class ResourceService {
  constructor(public store: Store) {}
  create(input: unknown) {
    const data = VersionInput.parse(input);
    if (data.projectId && !this.store.get("project", data.projectId))
      throw new DomainError("not_found", "项目不存在", 404);
    if (data.kind === "knowledge" && !data.sources.length)
      throw new DomainError("sources_required", "知识必须标明来源", 422);
    if (data.kind === "workflow") data.nodes = validatePlan(data.nodes);
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
  publish(id: string) {
    return this.store.transaction(() => {
      const resource = this.store.get<ResourceVersion>("resource", id);
      if (!resource) throw new DomainError("not_found", "资源不存在", 404);
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
        "published"
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
  ) {
    const skills = this.resolve(skillIds, "skill", projectId),
      knowledge = this.resolve(knowledgeIds, "knowledge", projectId),
      template = workflowId
        ? this.resolve([workflowId], "workflow", projectId)[0]
        : null;
    const result = {
      skills,
      knowledge,
      workflow: template,
      plan: template ? validatePlan(template.nodes) : defaultPlan,
    };
    if (JSON.stringify(result).length > 80000)
      throw new DomainError(
        "context_budget",
        "上下文超过80000字符预算，请减少资源",
        422,
      );
    return { ...result, digest: digest(result) };
  }
}
