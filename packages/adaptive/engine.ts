import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../persistence/index.js";
import { DomainError, digest, type Task } from "../domain/index.js";
import { AssetService, checkSchema, type Capability, type Profile } from "./assets.js";
import { ExternalSkillService } from "../external-skills/index.js";
import { McpRegistry } from "./mcp.js";
import type { WriteIntent } from "./mcp-write.js";
import { selectCoreAgent, type AgentBackend } from "./agent-selection.js";

const nodeId = z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/);
export const PlanNodeInput = z.object({
  id: nodeId,
  capabilityRef: z.string().min(3).max(180),
  profileRef: z.string().max(180).optional(),
  dependsOn: z.array(nodeId).max(30).default([]),
  condition: z.object({
    fromNode: nodeId,
    field: z.string().regex(/^[a-zA-Z_][\w]{0,99}$/),
    equals: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  }).optional(),
  inputs: z.record(z.string(), z.unknown()).default({}),
  bindings: z.record(z.string(), z.object({
    fromNode: nodeId,
    field: z.string().regex(/^[a-zA-Z_][\w.]{0,99}$/),
  })).default({}),
});
export const ObservationInput = z.object({
  id: nodeId, afterNode: nodeId,
  on: z.array(z.enum(["succeeded", "failed"])).min(1).max(2).default(["succeeded"]),
  barrier: z.boolean().default(true),
  question: z.string().trim().min(1).max(2000),
  maxInvocations: z.number().int().min(1).max(5).default(1),
});
export const PlanInput = z.object({
  nodes: z.array(PlanNodeInput).min(1).max(30),
  observations: z.array(ObservationInput).max(20).default([]),
  rationale: z.string().max(6000).default(""),
});
export type Plan = z.infer<typeof PlanInput>;
type NState = "pending" | "running" | "succeeded" | "skipped" | "failed" | "waiting" | "uncertain" | "invalidated";
type OState = "pending" | "running" | "waiting" | "completed";
export type AdaptiveRun = {
  id: string; taskId: string; status: "queued" | "running" | "waiting" | "reconciling" | "failed" | "awaiting_acceptance" | "done" | "cancelled";
  planRevision: number; plan: Plan; snapshots: Record<string, { capability: Capability; profileRef: string | null; profile: Profile; skillInstructions: { id: string; name: string; content: string; digest: string; references: {relativePath:string;content:string;digest:string}[] }[] }>;
  nodeStates: Record<string, NState>; observationStates: Record<string, OState>;
  results: Record<string, { output: unknown; artifactRefs: string[]; invocationId: string; digest: string }>;
  failures: Record<string, string>; decisions: Record<string, Decision>; revisionCount: number;
  createdAt: string; updatedAt: string; budgetUsd?: number | null;
};
export const DecisionInput = z.object({
  decision: z.enum(["CONTINUE", "REPLAN", "RETRY", "WAIT_INPUT", "WAIT_APPROVAL", "STOP"]),
  reason: z.string().trim().min(1).max(4000),
  affectedNodeIds: z.array(nodeId).max(30).default([]),
  evidenceRefs: z.array(z.string().max(500)).max(40).default([]),
});
export type Decision = z.infer<typeof DecisionInput>;
export type CapabilityCall = {
  run: AdaptiveRun; node: Plan["nodes"][number]; capability: Capability;
  profileRef: string | null; input: Record<string, unknown>; invocationId: string;
  task: Task; knowledge: ReturnType<AssetService["retrieveKnowledge"]>;
};
export type EvalCall = {
  run: AdaptiveRun; checkpoint: Plan["observations"][number]; task: Task;
};
export type Planner = {
  compose(task: Task, catalog: Capability[], knowledge: ReturnType<AssetService["retrieveKnowledge"]>, previous?: AdaptiveRun): Promise<Plan>;
  evaluate(context: EvalCall): Promise<Decision>;
};
export type Executor = (call: CapabilityCall) => Promise<{
  output: unknown; artifacts?: string[];
  businessStatus?: "accepted" | "rejected" | "unknown";
  modelUsage?: { inputTokens?: number; outputTokens?: number };
  pendingApproval?: { intentId: string };
}>;

function byId<T extends { id: string }>(items: T[]) { return new Map(items.map((item) => [item.id, item])); }
export class AdaptiveEngine {
  private busy = new Set<string>();
  private stopping = false;
  private wake?: () => void;
  setWake(handler: () => void) { this.wake = handler; }
  private notify() { this.wake?.(); }
  constructor(public store: Store, public assets = new AssetService(store),
    public executor?: Executor, public planner?: Planner) {}
  validate(input: unknown, projectId: string | null, taskId?: string): Plan {
    const plan = PlanInput.parse(input);
    const by = byId(plan.nodes);
    if (by.size !== plan.nodes.length) throw new DomainError("duplicate_node", "节点标识重复", 422);
    const visited = new Set<string>(), visiting = new Set<string>(), sorted: Plan["nodes"] = [];
    function visit(id: string) {
      if (visiting.has(id)) throw new DomainError("plan_cycle", "工作流存在循环", 422);
      if (visited.has(id)) return;
      const n = by.get(id); if (!n) throw new DomainError("plan_dependency", "节点依赖不存在", 422);
      visiting.add(id); for (const dep of n.dependsOn) visit(dep);
      visiting.delete(id); visited.add(id); sorted.push(n);
    }
    for (const n of plan.nodes) visit(n.id);
    const capabilities = new Map<string, Capability>();
    for (const node of sorted) {
      const cap = this.assets.getCapability(node.capabilityRef);
      if (cap.projectId && cap.projectId !== projectId)
        throw new DomainError("capability_scope", "能力不属于当前项目", 403);
      capabilities.set(node.id, cap);
      const profile = node.profileRef ?? cap.profileRef;
      if (!profile) throw new DomainError("profile_required", "能力未绑定执行配置：" + node.id, 422);
      const resolved = this.assets.getProfile(profile);
      if (resolved.projectId && resolved.projectId !== projectId)
        throw new DomainError("profile_scope", "执行配置不属于当前项目", 403);
      if (resolved.mcpGrants.length)
        new McpRegistry(this.store).resolve(resolved.mcpGrants, projectId);
      if (cap.sideEffect === "external-write") {
        if (resolved.executor !== "mcp-write" || !resolved.mcpWrite)
          throw new DomainError("approval_required", "外部写入节点必须绑定独立 MCP 人工审批配置", 422);
        checkSchema(cap.outputSchema, {
          summary:"MCP approved write executed",evidence:[],risks:[],
        });
      } else if (resolved.executor === "mcp-write") {
        throw new DomainError("mcp_write_mismatch","只允许外部写入能力使用 MCP 写入配置",422);
      }
      if (cap.sideEffect === "workspace-write" && resolved.workspaceMode !== "worktree-write")
        throw new DomainError("workspace_denied", "代码写入必须使用隔离工作区", 422);
      if (cap.sideEffect !== "workspace-write" && resolved.workspaceMode === "worktree-write")
        throw new DomainError("workspace_denied", "只读能力不可使用写权限配置", 422);
      const schema = cap.inputSchema as Record<string, unknown>;
      checkSchema(schema);
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      for (const field of Object.keys(node.inputs)) if (!Object.hasOwn(props, field))
        throw new DomainError("binding_invalid", "输入字段不在契约中：" + field, 422);
      for (const [name, binding] of Object.entries(node.bindings)) {
        if (!Object.hasOwn(props, name) || !node.dependsOn.includes(binding.fromNode))
          throw new DomainError("binding_invalid", "必须引用直接前驱及已声明的输入字段", 422);
        const source = capabilities.get(binding.fromNode);
        const outputProps = (source?.outputSchema.properties ?? {}) as Record<string, unknown>;
        const root = binding.field.split(".")[0];
        if (!Object.hasOwn(outputProps, root)) throw new DomainError("binding_invalid", "前驱无此输出字段：" + binding.field, 422);
        const expected = (props[name] as Record<string, unknown>).type;
        const actual = (outputProps[root] as Record<string, unknown>).type;
        if (expected !== actual && !binding.field.includes("."))
          throw new DomainError("binding_type", "上下游字段类型不兼容", 422);
      }
      if (node.condition) {
        if (!node.dependsOn.includes(node.condition.fromNode))
          throw new DomainError("condition_dependency", "分支条件必须引用直接前驱", 422);
        const source = capabilities.get(node.condition.fromNode);
        const out = (source?.outputSchema.properties ?? {}) as Record<string, unknown>;
        const property = out[node.condition.field] as Record<string, unknown> | undefined;
        if (!property) throw new DomainError("condition_field", "条件字段不存在于前驱输出中", 422);
        const actual = node.condition.equals === null ? "null" : typeof node.condition.equals;
        if (property.type !== actual && !(property.type === "integer" && actual === "number"))
          throw new DomainError("condition_type", "条件比较值与输出字段不匹配", 422);
      }
      for (const field of (schema.required ?? []) as string[]) if (!Object.hasOwn(node.inputs, field) && !Object.hasOwn(node.bindings, field))
        throw new DomainError("binding_missing", "缺少能力必填输入：" + node.id + "." + field, 422);
    }
    const terminals = sorted.filter((n) => !sorted.some((other) => other.dependsOn.includes(n.id)));
    if (terminals.length !== 1 || terminals[0].condition || !capabilities.get(terminals[0].id)?.tags.includes("deliver"))
      throw new DomainError("delivery_required", "必须有唯一交付汇合节点", 422);
    function precedes(from: string, to: string): boolean {
      const q = [...(by.get(to)?.dependsOn ?? [])], seen = new Set<string>();
      while (q.length) { const k = q.pop()!; if (k === from) return true;
        if (!seen.has(k)) { seen.add(k); q.push(...(by.get(k)?.dependsOn ?? [])); } }
      return false;
    }
    const tests = sorted.filter((n) => capabilities.get(n.id)?.tags.includes("test"));
    const reviews = sorted.filter((n) => capabilities.get(n.id)?.tags.includes("review"));
    const writes = sorted.filter((n) => capabilities.get(n.id)?.sideEffect === "workspace-write");
    if (writes.length) {
      if (!tests.length || !reviews.length) throw new DomainError("quality_gate", "写入代码任务必须包含测试与审查", 422);
      if (writes.some((w) => !tests.some((t) => precedes(w.id, t.id))) ||
          tests.some((t) => !reviews.some((r) => precedes(t.id, r.id))) ||
          reviews.some((r) => !precedes(r.id, terminals[0].id)))
        throw new DomainError("quality_gate", "实现、测试、审查、交付必须有真实依赖", 422);
    }
    const obsIds = new Set<string>();
    for (const obs of plan.observations) {
      if (obsIds.has(obs.id) || !by.has(obs.afterNode)) throw new DomainError("invalid_observation", "观察点重复或前驱节点缺失", 422);
      obsIds.add(obs.id);
      if (obs.barrier && obs.afterNode === terminals[0].id)
        throw new DomainError("invalid_observation", "交付终点不能有阻塞观察点", 422);
    }
    if (taskId) {
      const task = this.store.get<Task>("task", taskId);
      if (!task || task.projectId !== projectId)
        throw new DomainError("task_scope", "任务与项目不匹配", 422);
      // Explicit task requirements are constraints, not merely suggestions in the planner prompt.
      const requirements = task.flowRequirements;
      if (requirements?.mode === "compose") {
        let previous: string | undefined;
        const consumed = new Set<string>();
        for (const stage of requirements.stages) {
          const match = sorted.find((node) =>
            !consumed.has(node.id) &&
            (capabilities.get(node.id)?.name === "core." + stage.operation ||
             capabilities.get(node.id)?.tags.includes(stage.operation)) &&
            (!previous || precedes(previous, node.id))
          );
          if (!match)
            throw new DomainError("task_flow_mismatch",
              "编排未保留用户指定的阶段及顺序：" + stage.operation, 422);
          consumed.add(match.id); previous = match.id;
        }
      }
      if (requirements?.mode === "graph") {
        for (const requested of requirements.nodes) {
          const actual = by.get(requested.key);
          if (!actual ||
              !(capabilities.get(actual.id)?.name === "core." + requested.operation ||
                capabilities.get(actual.id)?.tags.includes(requested.operation)) ||
              requested.dependsOn.some((dep) => !actual.dependsOn.includes(dep)))
            throw new DomainError("task_flow_mismatch",
              "编排未保留用户指定的图节点或直接依赖：" + requested.key, 422);
        }
      }
    }
    return { ...plan, nodes: sorted };
  }
  async compose(taskId: string, executionAgent: AgentBackend = "codex") {
    if (!this.planner) throw new DomainError("planner_unavailable", "尚未配置编排 Agent，仍可提交手动工作流", 503);
    const task = this.store.get<Task>("task", taskId);
    if (!task) throw new DomainError("task_missing", "任务不存在", 404);
    const catalog = this.assets.listCapabilities().filter((c) => c.status === "published" && (!c.projectId || c.projectId === task.projectId));
    const knowledge = this.assets.retrieveKnowledge(task.objective, task.projectId, task.id, "workflow.planner");
    try {
      const proposal = await this.planner.compose(task, catalog, knowledge);
      const plan = this.validate(selectCoreAgent(proposal,executionAgent), task.projectId, task.id);
      this.store.event("task:" + task.id, "adaptive.plan.proposed", {
        planDigest: digest(plan), capabilityRefs: plan.nodes.map((n) => n.capabilityRef),
        observationIds: plan.observations.map((o) => o.id),
      });
      return plan;
    } catch (error) {
      this.store.event("task:" + task.id, "adaptive.plan.rejected", {
        errorCode: (error as Error).name,
      });
      throw error;
    }
  }
  createRun(taskId: string, planInput: unknown, budgetUsd: number | null = null): AdaptiveRun {
    if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 1000))
      throw new DomainError("budget_invalid","运行预算必须在 0 到 1000 美元之间",422);
    const task = this.store.get<Task>("task", taskId);
    if (!task) throw new DomainError("task_missing", "任务不存在", 404);
    const plan = this.validate(planInput, task.projectId, task.id);
    const created = this.store.transaction(() => {
      if (this.store.list<AdaptiveRun>("adaptive_run").some((r) => r.taskId === task.id && !["done", "failed", "cancelled"].includes(r.status)))
        throw new DomainError("active_run", "任务已有活跃的自适应运行");
      if (this.store.list<{taskId:string;status:string}>("run").some((r) =>
        r.taskId === task.id && !["succeeded","failed","cancelled"].includes(r.status)))
        throw new DomainError("active_run", "任务已有活跃的旧版运行，不能同时启动自适应路径", 409);
      const id = randomUUID(), now = new Date().toISOString();
      const snapshots: AdaptiveRun["snapshots"] = {};
      for (const node of plan.nodes) {
        const cap = this.assets.getCapability(node.capabilityRef);
        const profileRef = node.profileRef ?? cap.profileRef;
        if (!profileRef) throw new DomainError("profile_required", "未绑定执行配置", 422);
        const profile = this.assets.getProfile(profileRef);
        const skillInstructions = new ExternalSkillService(this.store).snapshot(profile.skillIds)
          .map((skill) => ({ id: skill.id, name: skill.name, content: skill.content, digest: skill.contentDigest, references: skill.referenceFiles }));
        if (JSON.stringify(skillInstructions).length > 80000)
          throw new DomainError("skill_context_budget", "Skill 指令快照超过运行预算", 422);
        if (cap.sourceSkillId) {
          const source = skillInstructions.find((sk) => sk.id === cap.sourceSkillId);
          if (!source || source.digest !== cap.sourceDigest)
            throw new DomainError("source_skill_changed", "能力原始 Skill 已变化，需要验证新版本", 422);
        }
        if (budgetUsd !== null && profile.executor === "agent" && !profile.billing)
          throw new DomainError("billing_rates_missing","费用预算模式要求所有 Agent Profile 配置单价和预留 token",422);
        snapshots[node.id] = { capability: cap, profileRef, profile, skillInstructions };
      }
      const run: AdaptiveRun = {
        id, taskId, status: "queued", planRevision: 1, plan, snapshots,
        nodeStates: Object.fromEntries(plan.nodes.map((n) => [n.id, "pending"])),
        observationStates: {}, results: {}, failures: {}, decisions: {},
        revisionCount: 1, createdAt: now, updatedAt: now, budgetUsd,
      };
      this.store.put("adaptive_run", run);
      this.store.put("adaptive_plan_revision", { id: id + ":1", runId: id, number: 1, plan, digest: digest(plan), reason: "initial" });
      this.store.event(id, "adaptive.run.created", { taskId, planDigest: digest(plan), budgetUsd });
      this.store.put("task", { ...task, status: "in_progress", updatedAt: now });
      return run;
    });
    this.notify();
    return created;
  }
  get(id: string) {
    const run = this.store.get<AdaptiveRun>("adaptive_run", id);
    if (!run) throw new DomainError("not_found", "自适应运行不存在", 404);
    return run;
  }
  private save(run: AdaptiveRun) {
    run.updatedAt = new Date().toISOString(); this.store.put("adaptive_run", run);
  }
  /** Keep the task aggregate synchronized with the adaptive execution lifecycle. */
  private setTaskStatus(taskId: string, status: "planned" | "awaiting_acceptance") {
    const task = this.store.get<Task>("task", taskId);
    if (task) this.store.put("task", { ...task, status, updatedAt: new Date().toISOString() });
  }
  /** Running capabilities remain uncertain; interrupted read-only evaluations can be manually resumed. */
  recover() {
    this.store.transaction(() => {
      for (const run of this.store.list<AdaptiveRun>("adaptive_run")) {
        const runningNodes = Object.entries(run.nodeStates).filter(([, state]) => state === "running");
        const runningObservations = Object.entries(run.observationStates).filter(([, state]) => state === "running");
        if (!runningNodes.length && !runningObservations.length) continue;
        for (const [key] of runningNodes) {
          run.nodeStates[key] = "uncertain";
          for (const invocation of this.store.list<any>("adaptive_invocation").filter((x) =>
            x.runId === run.id && x.nodeId === key && x.status === "running")) {
            this.store.put("adaptive_invocation", { ...invocation, status: "uncertain" });
            const effect = this.store.get<any>("adaptive_side_effect", invocation.id);
            if (effect) this.store.put("adaptive_side_effect",
              { ...effect, state: "uncertain", reason: "controller_restart" });
          }
        }
        for (const [id] of runningObservations) run.observationStates[id] = "waiting";
        run.status = runningNodes.length ? "reconciling" : "waiting";
        this.save(run);
        this.store.event(run.id, "adaptive.recovery.required", {
          uncertainNodes: runningNodes.map(([id]) => id),
          interruptedCheckpoints: runningObservations.map(([id]) => id),
          reason: runningNodes.length ? "running_invocation_needs_reconciliation" : "evaluation_interrupted",
        });
      }
    });
  }
  private input(run: AdaptiveRun, node: Plan["nodes"][number]) {
    const input: Record<string, unknown> = { ...node.inputs };
    for (const [name, binding] of Object.entries(node.bindings)) {
      let result: unknown = run.results[binding.fromNode]?.output;
      for (const part of binding.field.split(".")) {
        if (!result || typeof result !== "object" || !Object.hasOwn(result, part))
          throw new DomainError("binding_unavailable", "前驱结果字段不存在", 422);
        result = (result as Record<string, unknown>)[part];
      }
      input[name] = result;
    }
    checkSchema(run.snapshots[node.id].capability.inputSchema, input);
    return input;
  }
  private observationBlocked(run: AdaptiveRun, node: Plan["nodes"][number]) {
    const ancestors = new Set<string>();
    const by = byId(run.plan.nodes);
    const q = [...node.dependsOn];
    while (q.length) {
      const id = q.pop()!;
      if (ancestors.has(id)) continue;
      ancestors.add(id); q.push(...(by.get(id)?.dependsOn ?? []));
    }
    return run.plan.observations.some((obs) => obs.barrier && ancestors.has(obs.afterNode) &&
      ["pending", "running", "waiting"].includes(run.observationStates[obs.id] ?? ""));
  }
  private dependenciesSettled(run: AdaptiveRun, node: Plan["nodes"][number]) {
    return node.dependsOn.every((id) => ["succeeded", "skipped"].includes(run.nodeStates[id]));
  }
  private ready(run: AdaptiveRun) {
    return run.plan.nodes.filter((n) => run.nodeStates[n.id] === "pending" &&
      this.dependenciesSettled(run, n) && !this.observationBlocked(run, n));
  }
  /** A skipped input cannot be consumed; downstream nodes with no such binding may join normally. */
  private skipConditional(runId: string, candidates: Plan["nodes"]) {
    return this.store.transaction(() => {
      const run = this.get(runId);
      let changed = false;
      for (const node of candidates) {
        if (run.nodeStates[node.id] !== "pending" || !this.dependenciesSettled(run, node)) continue;
        const unavailable = Object.values(node.bindings).some((binding) =>
          run.nodeStates[binding.fromNode] === "skipped");
        const result = node.condition
          ? run.results[node.condition.fromNode]?.output as Record<string, unknown> | undefined : undefined;
        const mismatch = node.condition && (
          run.nodeStates[node.condition.fromNode] === "skipped" ||
          !result || result[node.condition.field] !== node.condition.equals
        );
        if (!unavailable && !mismatch) continue;
        run.nodeStates[node.id] = "skipped";
        this.store.event(runId, "adaptive.node.skipped", {
          nodeId: node.id, reason: unavailable ? "upstream_skipped" : "condition_not_met",
        });
        changed = true;
      }
      if (changed) this.save(run);
      return changed;
    });
  }
  /** Per-run independent branches can execute in parallel, with a single writer per worktree. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const jobs = this.store.list<AdaptiveRun>("adaptive_run")
      .filter((r) => !this.busy.has(r.id) && ["queued", "running"].includes(r.status));
    await Promise.all(jobs.map(async (snapshot) => {
      this.busy.add(snapshot.id);
      try {
        let run = this.get(snapshot.id);
        const task = this.store.get<Task>("task", run.taskId);
        const expiresAt = Date.parse(run.createdAt) + (task?.maxMinutes ?? 30) * 60_000;
        if (Date.now() > expiresAt) {
          this.store.transaction(() => {
            const stale = this.get(run.id);
            if (!["queued", "running"].includes(stale.status)) return;
            stale.status = "failed";
            this.save(stale);
            this.setTaskStatus(stale.taskId, "planned");
            this.store.event(run.id, "adaptive.budget.time_exceeded", {
              taskId:run.taskId, maxMinutes:task?.maxMinutes ?? 30,
              elapsedMinutes:Math.floor((Date.now()-Date.parse(stale.createdAt))/60000),
            });
          });
          return;
        }
        let readyNodes = this.ready(run);
        // Resolve false conditions before launching work; repeated passes propagate branch skips.
        while (this.skipConditional(run.id, readyNodes)) {
          run = this.get(run.id); readyNodes = this.ready(run);
        }
        const obs = run.plan.observations.find((o) => run.observationStates[o.id] === "pending");
        if (obs && (obs.barrier || readyNodes.length === 0)) {
          await this.observe(run.id, obs.id);
          return;
        }
        if (readyNodes.length > 0) {
          const writes = readyNodes.filter((n) =>
            run.snapshots[n.id].capability.sideEffect === "workspace-write");
          // Never let any read/write invocation race with a mutating worktree invocation.
          const batch = writes.length ? [writes[0]] : readyNodes.slice(0, 4);
          await Promise.all(batch.map((node) => this.executeNode(run.id, node.id)));
          return;
        }
        const settled = run.plan.nodes.every((n) => ["succeeded", "skipped"].includes(run.nodeStates[n.id]));
        const observationsDone = run.plan.observations.every((o) =>
          !["pending", "running", "waiting"].includes(run.observationStates[o.id] ?? ""));
        if (settled && observationsDone) {
          this.store.transaction(() => {
            const current = this.get(run.id);
            current.status = "awaiting_acceptance"; this.save(current);
            this.setTaskStatus(current.taskId, "awaiting_acceptance");
            this.store.event(current.id, "adaptive.run.delivered", {
              results: Object.keys(current.results),
              skipped: Object.entries(current.nodeStates).filter(([,v]) => v === "skipped").map(([k]) => k),
            });
          });
        } else if (Object.values(run.nodeStates).some((v) => v === "failed") &&
          !run.plan.observations.some((o) => run.observationStates[o.id] === "pending")) {
          this.store.transaction(() => {
            const current = this.get(run.id); current.status = "failed"; this.save(current);
            this.setTaskStatus(current.taskId, "planned");
            this.store.event(current.id, "adaptive.run.failed", { failures: current.failures });
          });
        }
      } finally {
        this.busy.delete(snapshot.id);
        // Avoid idle wakeup spinning: only notify if there is immediately ready work.
        const current = this.get(snapshot.id);
        if (["queued","running"].includes(current.status) &&
            (this.ready(current).length > 0 ||
              current.plan.observations.some((o) => current.observationStates[o.id] === "pending") ||
              current.plan.nodes.every((n) => ["succeeded", "skipped"].includes(current.nodeStates[n.id]))))
          this.notify();
      }
    }));
  }
  private async executeNode(id: string, nodeId: string) {
    const prepared = this.store.transaction(() => {
      const run = this.get(id), node = run.plan.nodes.find((n) => n.id === nodeId)!;
      if (run.nodeStates[nodeId] !== "pending") return null;
      const input = this.input(run, node);
      const cap = run.snapshots[nodeId].capability;
      const invocationId = randomUUID();
      const profileRef = run.snapshots[nodeId].profileRef;
      // Snapshot knowledge hits at invocation time, then reuse those exact hits in the invocation record.
      const task = this.store.get<Task>("task", run.taskId)!;
      const knowledge = this.assets.retrieveKnowledge(task.objective, task.projectId, task.id, cap.name);
      this.store.put("adaptive_invocation", {
        id: invocationId, runId: id, planRevision: run.planRevision,
        nodeId, profileRef, inputDigest: digest(input), knowledgeRefs: knowledge.map((k) => ({ id:k.id, digest:k.digest })),
        status: "running", startedAt: new Date().toISOString(),
      });
      if (cap.sideEffect === "workspace-write" || cap.sideEffect === "external-write")
        this.store.put("adaptive_side_effect", {
          id: invocationId, runId: id, nodeId, capabilityRef: cap.id,
          inputDigest: digest(input),
          state: cap.sideEffect === "external-write" ? "awaiting_approval" : "started",
          createdAt: new Date().toISOString(),
        });
      run.nodeStates[nodeId] = "running"; run.status = "running"; this.save(run);
      this.store.event(id, "adaptive.invocation.started", { invocationId, nodeId, profileRef, inputDigest: digest(input) });
      return { run, node, capability: cap, profileRef, input, invocationId, task, knowledge };
    });
    if (!prepared) return;
    const profile = this.assets.getProfile(prepared.profileRef!);
    if (profile.executor === "manual") {
      this.store.transaction(() => {
        const run = this.get(id);
        const invocation = this.store.get<any>("adaptive_invocation", prepared.invocationId)!;
        run.nodeStates[nodeId] = "waiting"; run.status = "waiting"; this.save(run);
        this.store.put("adaptive_invocation", { ...invocation, status: "waiting" });
        this.store.event(id, "adaptive.invocation.waiting_for_user", { nodeId, invocationId: prepared.invocationId });
      });
      return;
    }
    try {
      if (!this.executor) throw new DomainError("executor_unavailable", "未配置能力执行器", 503);
      const response = await this.executor(prepared);
      if (response.pendingApproval) {
        this.store.transaction(() => {
          const run=this.get(id);
          if(run.nodeStates[nodeId]!=="running")return;
          const intent=this.store.get<WriteIntent>("adaptive_mcp_write",response.pendingApproval!.intentId);
          if(!intent || intent.runId!==id || intent.status!=="requested")
            throw new DomainError("mcp_approval_invalid","MCP 审批请求与当前运行不匹配",409);
          const record=this.store.get<any>("adaptive_invocation",prepared.invocationId)!;
          run.nodeStates[nodeId]="waiting";run.status="waiting";this.save(run);
          this.store.put("adaptive_invocation",{
            ...record,status:"waiting",mcpIntentId:intent.id,
          });
          this.store.event(id,"adaptive.mcp.approval_requested",{
            nodeId,invocationId:prepared.invocationId,intentId:intent.id,
            tool:intent.server+"/"+intent.tool,argsDigest:intent.argsDigest,
          });
        });
        return;
      }
      checkSchema(prepared.capability.outputSchema, response.output);
      if (response.businessStatus === "rejected")
        throw new DomainError("business_rejected", "原子能力执行完成，但业务验收未通过", 422);
      if (prepared.capability.tags.includes("review")) {
        const report = response.output as { risks?: unknown };
        if (!Array.isArray(report.risks))
          throw new DomainError("review_invalid", "代码审查没有结构化风险输出", 422);
        if (report.risks.length)
          throw new DomainError("review_blocked", "代码审查发现未解决的风险，禁止交付", 422);
      }
      this.store.transaction(() => {
        const run = this.get(id);
        if (run.nodeStates[nodeId] !== "running") return;
        const record = this.store.get<any>("adaptive_invocation", prepared.invocationId)!;
        this.store.put("adaptive_invocation", { ...record, status: "succeeded",
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(record.startedAt),
          modelUsage: response.modelUsage ?? null,
          outputDigest: digest(response.output) });
        const effect = this.store.get<any>("adaptive_side_effect", prepared.invocationId);
        if (effect) this.store.put("adaptive_side_effect", {
          ...effect, state: "confirmed", outputDigest: digest(response.output),
          confirmedAt: new Date().toISOString(),
        });
        run.results[nodeId] = { output: response.output, artifactRefs: response.artifacts ?? [], invocationId: prepared.invocationId, digest: digest(response.output) };
        run.nodeStates[nodeId] = "succeeded"; this.activateObservations(run, nodeId, "succeeded");
        this.save(run); this.store.event(id, "adaptive.invocation.completed", { nodeId, invocationId: prepared.invocationId, outputDigest: digest(response.output) });
      });
    } catch (error) {
      this.store.transaction(() => {
        const run = this.get(id);
        if (run.nodeStates[nodeId] !== "running") return;
        const record = this.store.get<any>("adaptive_invocation", prepared.invocationId)!;
        const message = String((error as Error).message).slice(0, 2000);
        const effect = this.store.get<any>("adaptive_side_effect", prepared.invocationId);
        const uncertain = !!effect && effect.state !== "awaiting_approval";
        this.store.put("adaptive_invocation", { ...record, status: uncertain ? "uncertain" : "failed",
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(record.startedAt), error: message });
        if (effect) this.store.put("adaptive_side_effect", {
          ...effect, state: uncertain ? "uncertain" : "not_executed",
          reason:message,at:new Date().toISOString(),
        });
        run.nodeStates[nodeId] = uncertain ? "uncertain" : "failed";
        run.failures[nodeId] = message;
        if (uncertain) run.status = "reconciling";
        else this.activateObservations(run, nodeId, "failed");
        this.save(run);
        this.store.event(id, uncertain ? "adaptive.side_effect.uncertain" : "adaptive.invocation.failed",
          { nodeId, invocationId: prepared.invocationId, message });
      });
    }
  }
  /** Idempotently fold a separate, human-approved MCP result back into the DAG. */
  syncMcpWriteIntent(intentId:string) {
    const intent=this.store.get<WriteIntent>("adaptive_mcp_write",intentId);
    if(!intent || !intent.runId) return null;
    const pending=this.store.list<any>("adaptive_invocation").filter((inv) =>
      inv.runId===intent.runId && inv.mcpIntentId===intentId);
    if(pending.length!==1)return null;
    const invocation=pending[0];
    if(invocation.status!=="waiting")return this.get(intent.runId);
    if(!["succeeded","rejected","uncertain","reconciled"].includes(intent.status))
      return this.get(intent.runId);
    const run=this.store.transaction(()=>{
      const current=this.get(intent.runId!);
      const record=this.store.get<any>("adaptive_invocation",invocation.id);
      if(record?.status!=="waiting" || current.nodeStates[invocation.nodeId]!=="waiting" ||
          current.status!=="waiting") return current;
      const id=invocation.nodeId;
      const effect=this.store.get<any>("adaptive_side_effect",record.id);
      if(intent.status==="succeeded") {
        const output={
          summary:"MCP write completed after exact human approval",
          evidence:["mcp-intent:"+intent.id,"result-sha256:"+intent.resultDigest],
          risks:[],
        };
        checkSchema(current.snapshots[id].capability.outputSchema,output);
        this.store.put("adaptive_invocation",{
          ...record,status:"succeeded",finishedAt:new Date().toISOString(),
          outputDigest:digest(output),mcpResultDigest:intent.resultDigest,
        });
        if(effect)this.store.put("adaptive_side_effect",{
          ...effect,state:"confirmed",outputDigest:intent.resultDigest,
          confirmedAt:new Date().toISOString(),
        });
        current.results[id]={
          output,artifactRefs:[],invocationId:record.id,digest:digest(output),
        };
        current.nodeStates[id]="succeeded";
        current.status="running";
        this.activateObservations(current,id,"succeeded");
        this.store.event(current.id,"adaptive.mcp.approval_completed",{
          nodeId:id,invocationId:record.id,intentId:intent.id,
          resultDigest:intent.resultDigest,
        });
      }else{
        const uncertain=intent.status==="uncertain"||intent.status==="reconciled";
        current.nodeStates[id]=uncertain?"uncertain":"failed";
        current.status=uncertain?"reconciling":"failed";
        const reason=uncertain
          ? "MCP 写操作结果不确定，或仅有人工核对记录；不得自动继续 DAG"
          : "MCP 写操作审批已拒绝";
        current.failures[id]=reason;
        this.store.put("adaptive_invocation",{
          ...record,status:uncertain?"uncertain":"failed",
          finishedAt:new Date().toISOString(),error:reason,
        });
        if(effect)this.store.put("adaptive_side_effect",{
          ...effect,state:uncertain?"uncertain":"not_executed",
          reason,at:new Date().toISOString(),
        });
        if(!uncertain)this.setTaskStatus(current.taskId,"planned");
        this.store.event(current.id,uncertain?"adaptive.mcp.uncertain":"adaptive.mcp.rejected",{
          nodeId:id,invocationId:record.id,intentId:intent.id,
        });
      }
      this.save(current);
      return current;
    });
    if(run.status==="running")this.notify();
    return run;
  }
  syncPendingMcpWrites() {
    for(const intent of this.store.list<WriteIntent>("adaptive_mcp_write")) {
      if(intent.runId && ["succeeded","rejected","uncertain","reconciled"].includes(intent.status))
        this.syncMcpWriteIntent(intent.id);
    }
  }
  private activateObservations(run: AdaptiveRun, nodeId: string, state: "succeeded" | "failed") {
    for (const obs of run.plan.observations.filter((o) => o.afterNode === nodeId && o.on.includes(state)))
      if (!run.observationStates[obs.id]) run.observationStates[obs.id] = "pending";
  }
  private async observe(id: string, checkpointId: string) {
    const context = this.store.transaction(() => {
      const run = this.get(id);
      if (run.observationStates[checkpointId] !== "pending") return null;
      const checkpoint = run.plan.observations.find((o) => o.id === checkpointId)!;
      run.observationStates[checkpointId] = "running"; this.save(run);
      this.store.event(id, "adaptive.observation.started", { checkpointId });
      return { run, checkpoint, task: this.store.get<Task>("task", run.taskId)! };
    });
    if (!context) return;
    try {
      if (!this.planner) throw new DomainError("evaluator_unavailable", "未配置进度评估 Agent", 503);
      const decision = DecisionInput.parse(await this.planner.evaluate(context));
      this.store.transaction(() => {
        const run = this.get(id);
        run.decisions[checkpointId] = decision;
        run.observationStates[checkpointId] = "completed";
        if (decision.decision === "WAIT_INPUT" || decision.decision === "WAIT_APPROVAL" || decision.decision === "REPLAN" ||
            decision.decision === "STOP" || decision.decision === "RETRY") run.status = "waiting";
        if (decision.decision === "STOP") {
          run.status = "failed";
          this.setTaskStatus(run.taskId, "planned");
        }
        this.save(run); this.store.event(id, "adaptive.observation.decided", { checkpointId, decision });
      });
      if (decision.decision === "REPLAN") await this.replan(id, checkpointId);
      if (decision.decision === "RETRY") this.retry(id, decision.affectedNodeIds[0] ?? context.checkpoint.afterNode);
    } catch (error) {
      this.store.transaction(() => {
        const run = this.get(id);
        if (!["running", "completed"].includes(run.observationStates[checkpointId])) return;
        // A failed replan after a persisted REPLAN decision must remain actionable.
        if (run.observationStates[checkpointId] === "running")
          run.observationStates[checkpointId] = "waiting";
        if (run.status !== "reconciling") run.status = "waiting";
        this.save(run);
        this.store.event(id, "adaptive.observation.blocked", {
          checkpointId, decision: run.decisions[checkpointId]?.decision ?? null,
          reason: String(error).slice(0, 1000),
        });
      });
    }
  }
  /** Explicit retry for a previously blocked REPLAN decision (e.g. unavailable Codex). */
  async resumeReplan(id: string, checkpointId: string): Promise<AdaptiveRun> {
    const run = this.get(id);
    if (run.status !== "waiting" ||
        run.decisions[checkpointId]?.decision !== "REPLAN" ||
        run.observationStates[checkpointId] !== "completed")
      throw new DomainError("replan_not_waiting", "无待恢复的重规划决策", 422);
    const revised = await this.replan(id, checkpointId);
    this.notify();
    return revised;
  }
  async replan(id: string, checkpointId: string): Promise<AdaptiveRun> {
    const before = this.get(id), decision = before.decisions[checkpointId];
    if (!decision || decision.decision !== "REPLAN") throw new DomainError("replan_not_requested", "没有有效重规划决策", 422);
    if (!this.planner) throw new DomainError("planner_unavailable", "未配置编排 Agent", 503);
    if (before.status === "reconciling") throw new DomainError("recovery_required", "必须先核对未确认的执行副作用", 409);
    if (this.store.list<{runId:string;status:string;mcpIntentId?:string}>("adaptive_invocation")
        .some((i)=>i.runId===id && i.status==="waiting" && !!i.mcpIntentId))
      throw new DomainError("pending_mcp_approval","MCP 写入节点仍在等待审批，不能通过重规划绕过或删除它",409);
    if (before.revisionCount >= 5) throw new DomainError("replan_limit", "已达到重规划上限", 422);
    if (Object.values(before.nodeStates).includes("running")) throw new DomainError("active_invocation", "执行中节点不能热替换", 409);
    const task = this.store.get<Task>("task", before.taskId)!;
    const candidates = this.assets.listCapabilities().filter((c) => c.status === "published" && (!c.projectId || c.projectId === task.projectId));
    const knowledge = this.assets.retrieveKnowledge(task.objective, task.projectId, task.id, "workflow.planner");
    const proposal = await this.planner.compose(task, candidates, knowledge, before);
    const plan = this.validate(proposal, task.projectId, task.id);
    return this.store.transaction(() => {
      const run = this.get(id);
      if (run.planRevision !== before.planRevision || Object.values(run.nodeStates).includes("running")) throw new DomainError("revision_conflict", "运行状态发生变化");
      const oldNodes = byId(run.plan.nodes), states: AdaptiveRun["nodeStates"] = {}, results: AdaptiveRun["results"] = {};
      const nextSnapshots: AdaptiveRun["snapshots"] = {};
      for (const node of plan.nodes) {
        const cap = this.assets.getCapability(node.capabilityRef);
        const profileRef = node.profileRef ?? cap.profileRef;
        if (!profileRef) throw new DomainError("profile_required", "执行配置缺失", 422);
        const profile = this.assets.getProfile(profileRef);
        const skillInstructions = new ExternalSkillService(this.store).snapshot(profile.skillIds)
          .map((sk) => ({ id:sk.id, name:sk.name, content:sk.content, digest:sk.contentDigest, references:sk.referenceFiles }));
        if (JSON.stringify(skillInstructions).length > 80000)
          throw new DomainError("skill_context_budget", "Skill 快照超过预算", 422);
        if (cap.sourceSkillId && !skillInstructions.some((sk) => sk.id === cap.sourceSkillId && sk.digest === cap.sourceDigest))
          throw new DomainError("source_skill_changed", "能力原始 Skill 已变化", 422);
        nextSnapshots[node.id] = { capability: cap, profileRef, profile, skillInstructions };
        const previous = run.snapshots[node.id], old = oldNodes.get(node.id);
        const same = !!old && digest(old) === digest(node) &&
          !!previous && digest(previous) === digest(nextSnapshots[node.id]);
        const depsKept = node.dependsOn.every((dep) => states[dep] === "succeeded");
        let knowledgeUnchanged = true;
        if (same && depsKept && run.nodeStates[node.id] === "succeeded") {
          const invocation = this.store.get<{knowledgeRefs?:{id:string;digest:string}[]}>(
            "adaptive_invocation", run.results[node.id]?.invocationId ?? "");
          const currentKnowledge = this.assets.retrieveKnowledge(task.objective, task.projectId, task.id, cap.name);
          const refs = (invocation?.knowledgeRefs ?? []).map((k) => k.id + ":" + k.digest).sort();
          const current = currentKnowledge.map((k) => k.id + ":" + k.digest).sort();
          knowledgeUnchanged = JSON.stringify(refs) === JSON.stringify(current);
        }
        const retained = same && depsKept && knowledgeUnchanged && run.nodeStates[node.id] === "succeeded";
        states[node.id] = retained ? "succeeded" : "pending";
        if (retained) results[node.id] = run.results[node.id];
      }
      // A completed write has already changed the worktree. It cannot disappear or be replayed
      // merely because the planner changed the upstream plan. Require a new downstream write node.
      for (const [oldId, oldState] of Object.entries(run.nodeStates)) {
        if (oldState !== "succeeded" ||
            run.snapshots[oldId]?.capability.sideEffect !== "workspace-write") continue;
        if (states[oldId] !== "succeeded")
          throw new DomainError("write_replan_unsafe",
            "重规划不能删除或重放已经完成的写入能力；请保留原节点并新增后续能力", 409);
      }
      // Non-reused results remain in the history/event log and plan-revision record.
      this.store.put("adaptive_plan_revision", { id: id + ":" + run.planRevision, runId: id, number: run.planRevision,
        plan: run.plan, states: run.nodeStates, results: run.results, reason: decision.reason });
      run.plan = plan; run.planRevision++; run.revisionCount++; run.nodeStates = states; run.results = results;
      run.observationStates = {}; run.decisions = {}; run.failures = {};
      run.snapshots = nextSnapshots;
      run.status = "running"; this.save(run);
      this.store.put("adaptive_plan_revision", { id: id + ":" + run.planRevision, runId: id,
        number: run.planRevision, plan, digest: digest(plan), reason: decision.reason });
      this.store.event(id, "adaptive.plan.revised", { from: before.planRevision, to: run.planRevision, reason: decision.reason });
      return run;
    });
  }
  retry(id: string, nodeId: string) {
    return this.store.transaction(() => {
      const run = this.get(id);
      if (run.status === "reconciling" ||
          Object.values(run.nodeStates).includes("uncertain"))
        throw new DomainError("recovery_required", "仍有未核对的能力副作用", 409);
      if (!["failed", "waiting"].includes(run.nodeStates[nodeId])) throw new DomainError("retry_invalid", "节点当前无法重试", 422);
      if (Object.values(run.nodeStates).includes("running")) throw new DomainError("active_invocation", "仍有正在执行的能力");
      const attempts = this.store.list<{runId:string;nodeId:string}>("adaptive_invocation").filter((i)=>i.runId===id && i.nodeId===nodeId).length;
      if (attempts >= 3) throw new DomainError("retry_limit", "已达到重试次数限制", 422);
      const cap = run.snapshots[nodeId]?.capability;
      if (!cap || cap.sideEffect === "external-write" || cap.sideEffect === "workspace-write")
        throw new DomainError("side_effect_uncertain", "写入能力需要先核查副作用，不能自动重试", 422);
      run.nodeStates[nodeId] = "pending"; run.status = "running"; delete run.failures[nodeId];
      this.save(run); this.store.event(id, "adaptive.invocation.retry_requested", { nodeId });
      return run;
    });
  }
  resolveWaiting(id: string, checkpointId: string, decisionInput: unknown) {
    const decision = DecisionInput.parse(decisionInput);
    if (!["CONTINUE", "STOP"].includes(decision.decision)) throw new DomainError("manual_decision", "人工恢复只能继续或停止", 422);
    return this.store.transaction(() => {
      const run = this.get(id);
      const currentDecision = run.decisions[checkpointId]?.decision;
      const canResolve = run.status === "waiting" &&
        (run.observationStates[checkpointId] === "waiting" ||
          (run.observationStates[checkpointId] === "completed" &&
           ["WAIT_INPUT", "WAIT_APPROVAL"].includes(currentDecision ?? "")));
      if (!canResolve)
        throw new DomainError("not_waiting", "观察点并非等待人工审批；REPLAN 必须完成安全重编排", 422);
      run.decisions[checkpointId] = decision; run.observationStates[checkpointId] = "completed";
      run.status = decision.decision === "STOP" ? "failed" : "running";
      this.save(run); this.store.event(id, "adaptive.observation.manually_resolved", { checkpointId, decision }, "user");
      return run;
    });
  }
  completeManual(id: string, nodeId: string, output: unknown) {
    return this.store.transaction(() => {
      const run = this.get(id);
      if (run.nodeStates[nodeId] !== "waiting")
        throw new DomainError("manual_not_waiting", "该节点未等待人工输入", 422);
      const cap = run.snapshots[nodeId]?.capability;
      const profile = this.assets.getProfile(run.snapshots[nodeId]?.profileRef ?? "");
      if (!cap || profile.executor !== "manual")
        throw new DomainError("manual_forbidden", "不能伪造自动能力执行结果", 403);
      checkSchema(cap.outputSchema, output);
      const invocation = this.store.list<any>("adaptive_invocation").find((v) =>
        v.runId === id && v.nodeId === nodeId && v.status === "waiting");
      if (!invocation) throw new DomainError("invocation_missing", "待确认调用不存在", 404);
      this.store.put("adaptive_invocation", { ...invocation, status: "succeeded",
        finishedAt: new Date().toISOString(), outputDigest: digest(output) });
      run.nodeStates[nodeId] = "succeeded";
      run.results[nodeId] = { output, artifactRefs: [], invocationId: invocation.id, digest: digest(output) };
      this.activateObservations(run, nodeId, "succeeded");
      run.status = "running"; this.save(run);
      this.store.event(id, "adaptive.invocation.manually_completed",
        { nodeId, invocationId: invocation.id, outputDigest: digest(output) }, "user");
      return run;
    });
  }
  reconcileUncertain(id: string, nodeId: string, stoppedConfirmed: boolean, note: string) {
    return this.store.transaction(() => {
      const run = this.get(id);
      if (run.status !== "reconciling" || run.nodeStates[nodeId] !== "uncertain")
        throw new DomainError("not_reconciling", "节点不处于待人工核对状态", 422);
      if (!stoppedConfirmed || note.trim().length < 10)
        throw new DomainError("recovery_proof_required", "必须人工确认相关进程和外部副作用已核对，并说明依据", 422);
      const cap = run.snapshots[nodeId]?.capability;
      if (!cap) throw new DomainError("not_found", "能力快照不存在", 404);
      // Never automatically replay a write after a crash: put entire run into failed state for explicit new task/revision.
      run.nodeStates[nodeId] = "failed";
      const otherUncertain = Object.values(run.nodeStates).includes("uncertain");
      if (otherUncertain) {
        run.status = "reconciling";
      } else {
        const writesHaveFailed = Object.entries(run.nodeStates).some(([key, state]) =>
          state === "failed" && ["workspace-write", "external-write"]
            .includes(run.snapshots[key]?.capability.sideEffect ?? ""));
        run.status = writesHaveFailed ? "failed" : "waiting";
        if (writesHaveFailed) this.setTaskStatus(run.taskId, "planned");
      }
      this.save(run);
      for (const invocation of this.store.list<any>("adaptive_invocation").filter((x) =>
        x.runId === id && x.nodeId === nodeId && x.status === "uncertain")) {
        this.store.put("adaptive_invocation", { ...invocation, status: "reconciled", reconciliationNote: note });
        const effect = this.store.get<any>("adaptive_side_effect", invocation.id);
        if (effect) this.store.put("adaptive_side_effect", {
          ...effect, state: "reconciled", note, confirmedStopped: stoppedConfirmed, at: new Date().toISOString(),
        });
      }
      this.store.event(id, "adaptive.recovery.reconciled",
        { nodeId, stoppedConfirmed, note, sideEffect: cap.sideEffect }, "user");
      return run;
    });
  }
  accept(id: string, accepted: boolean, reason: string) {
    return this.store.transaction(() => {
      const run = this.get(id);
      if (run.status !== "awaiting_acceptance") throw new DomainError("not_delivered", "尚未形成可验收交付", 422);
      if (!accepted && !reason.trim()) throw new DomainError("reason_required", "拒绝验收需说明原因", 422);
      run.status = accepted ? "done" : "failed"; this.save(run);
      const task = this.store.get<Task>("task", run.taskId)!;
      this.store.put("task", { ...task, status: accepted ? "done" : "planned", updatedAt: new Date().toISOString() });
      this.store.event(id, "adaptive.acceptance", { accepted, reason }, "user");
      return run;
    });
  }
  cancel(id: string) {
    return this.store.transaction(() => {
      const run = this.get(id);
      if (Object.values(run.nodeStates).includes("running") || Object.values(run.nodeStates).includes("uncertain"))
        throw new DomainError("unsafe_cancel", "执行器未确认停止，无法直接释放工作流", 409);
      run.status = "cancelled"; this.save(run);
      const task = this.store.get<Task>("task", run.taskId);
      if (task) this.store.put("task", { ...task, status: "planned", updatedAt: new Date().toISOString() });
      this.store.event(id, "adaptive.run.cancelled", {}, "user"); return run;
    });
  }
  close() { this.stopping = true; }
}
