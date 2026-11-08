import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../persistence/index.js";
import { DomainError, type Task } from "../domain/index.js";

export const GoalInput = z.object({
  name: z.string().trim().min(1).max(200),
  objective: z.string().min(1).max(10000),
  successCriteria: z.array(z.string().min(1).max(2000)).min(1).max(30),
  projectIds: z.array(z.string().uuid()).default([]),
});
export type Goal = z.infer<typeof GoalInput> & {
  id: string;
  createdAt: string;
};
export function validateTaskRelations(store: Store, candidate: Task) {
  const tasks = store.list<Task>("task").filter((t) => t.id !== candidate.id);
  tasks.push(candidate);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (candidate.goalId && !store.get("goal", candidate.goalId))
    throw new DomainError("goal_not_found", "目标不存在", 422);
  if (candidate.parentId && !byId.has(candidate.parentId))
    throw new DomainError("parent_not_found", "父任务不存在", 422);
  if (candidate.parentId && byId.get(candidate.parentId)?.status === "done")
    throw new DomainError("parent_closed", "不能向已验收父任务添加未验收工作");
  for (const id of candidate.dependsOn)
    if (!byId.has(id))
      throw new DomainError("dependency_not_found", "依赖任务不存在", 422);
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id))
      throw new DomainError(
        "dependency_cycle",
        "任务依赖或父子关系形成完成条件循环",
        422,
      );
    if (done.has(id)) return;
    visiting.add(id);
    const task = byId.get(id)!;
    const prerequisites = [
      ...(task.dependsOn ?? []),
      ...tasks.filter((t) => t.parentId === id).map((t) => t.id),
    ];
    prerequisites.forEach(visit);
    visiting.delete(id);
    done.add(id);
  }
  tasks.forEach((t) => visit(t.id));
}
export class PlanningService {
  constructor(public store: Store) {}
  createGoal(input: unknown) {
    const data = GoalInput.parse(input);
    for (const id of data.projectIds)
      if (!this.store.get("project", id))
        throw new DomainError("not_found", "目标关联项目不存在", 404);
    const goal = {
      ...data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.store.put("goal", goal);
    return goal;
  }
  goals() {
    return this.store.list<Goal>("goal").map((g) => {
      const tasks = this.store
        .list<Task>("task")
        .filter((t) => t.goalId === g.id);
      return {
        ...g,
        taskCount: tasks.length,
        acceptedTasks: tasks.filter((t) => t.status === "done").length,
      };
    });
  }
  summary(from: string, to: string) {
    z.iso.date().parse(from);
    z.iso.date().parse(to);
    if (from > to)
      throw new DomainError("invalid_window", "起始日期不能晚于结束日期", 422);
    const day = (date: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(date));
    const within = (date: string | null | undefined) =>
      !!date && date >= from && date <= to;
    const tasks = this.store.list<Task>("task");
    const accepted = tasks.filter(
      (t) => t.status === "done" && within(day(t.updatedAt)),
    );
    const planned = tasks.filter((t) => within(t.plannedFor));
    const active = tasks.filter((t) => t.status === "in_progress");
    const overdue = tasks.filter(
      (t) =>
        t.status !== "done" &&
        t.status !== "cancelled" &&
        t.dueAt &&
        t.dueAt < to,
    );
    return {
      from,
      to,
      timeZone: "Asia/Shanghai",
      accepted,
      planned,
      active,
      overdue,
      note: "验收完成按实际验收更新时间统计；计划日期与截止日期来自用户设置。",
    };
  }
}
