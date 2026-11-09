import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Store } from "../persistence/index.js";
import { DomainError, digest, type Run, type Task } from "../domain/index.js";
import { ResourceService, type ResourceVersion } from "../resources/index.js";
import { WorkService } from "../workflow/service.js";
import { DiagnosisService } from "../diagnosis/index.js";
import type { Project } from "../domain/index.js";
import { RolloutService } from "./rollout.js";

type Delivery = {
  id: string;
  runId: string;
  artifactSubdir?: string;
  artifacts?: string[];
  artifactDigests?: Record<string, string>;
};
export type Proposal = {
  minVerifiedDeliveryGain: number;
  id: string;
  title: string;
  reason: string;
  baselineId: string;
  candidateId: string;
  evidenceRunIds: string[];
  risk: "low" | "review_required";
  createdAt: string;
};
type Case = {
  id: string;
  label: string;
  sourceRunId: string;
  split: "development" | "holdout";
  inputDigest: string;
};
type Dataset = {
  id: string;
  name: string;
  version: string;
  baselineId: string;
  cases: Case[];
  digest: string;
  createdAt: string;
};
type Pair = { caseId: string; baselineRunId: string; candidateRunId: string };
type Evaluation = {
  id: string;
  proposalId: string;
  datasetId: string;
  datasetDigest: string;
  pairs: Pair[];
  policy: { minHoldoutCases: number };
  result: {
    baselinePass: number;
    candidatePass: number;
    holdoutCases: number;
    regressions: string[];
    gain: number;
    gate: "passed" | "regression" | "insufficient_samples" | "no_measured_gain";
    cost: "unknown";
    cases: any[];
  };
  createdAt: string;
};
const PairInput = z.object({
  caseId: z.string().uuid(),
  baselineRunId: z.string().uuid(),
  candidateRunId: z.string().uuid(),
});
export class OptimizationService {
  constructor(
    public store: Store,
    public dataDir?: string,
    public runtime: {
      available: boolean;
      version: string | null;
      model?: string | null;
      reasoning?: string | null;
      configurationDigest?: string;
    } = { available: false, version: null as string | null },
  ) {}
  required<T>(kind: string, id: string) {
    const value = this.store.get<T>(kind, id);
    if (!value) throw new DomainError("not_found", `${kind}不存在`, 404);
    return value;
  }
  targetIn(run: Run, target: ResourceVersion) {
    const context = run.manifest.context as {
      skills?: ResourceVersion[];
      knowledge?: ResourceVersion[];
      workflow?: ResourceVersion | null;
    };
    return target.kind === "workflow"
      ? context?.workflow
      : [...(context?.skills ?? []), ...(context?.knowledge ?? [])].find(
          (r) =>
            r.kind === target.kind &&
            r.name === target.name &&
            r.projectId === target.projectId,
        );
  }
  fingerprint(run: Run, target: ResourceVersion) {
    const task = run.manifest.task as Task,
      context = run.manifest.context as any,
      project = run.manifest.project as any;
    if (
      !task ||
      run.runtime === "manual" ||
      !context ||
      !this.targetIn(run, target)
    )
      throw new DomainError(
        "invalid_case",
        "评估案例需要引用目标资源的Agent运行",
        422,
      );
    const keep = (resource: ResourceVersion) =>
      !(
        resource.kind === target.kind &&
        resource.name === target.name &&
        resource.projectId === target.projectId
      );
    const resources = [
      ...(context.skills ?? []),
      ...(context.knowledge ?? []),
      ...(context.workflow ? [context.workflow] : []),
    ]
      .filter(keep)
      .map((r: ResourceVersion) => r.contentDigest)
      .sort();
    const diagnosis = run.manifest.diagnosis as any;
    return digest({
      type: task.type,
      objective: task.objective,
      criteria: task.acceptanceCriteria,
      maxMinutes: task.maxMinutes,
      baseCommit: run.manifest.baseCommit,
      projectId: project?.id,
      testCommand: project?.testCommand,
      runtime: run.runtime,
      runtimeVersion: run.manifest.runtimeVersion,
      model: run.manifest.model ?? null,
      modelReasoning: run.manifest.modelReasoning ?? null,
      environment: run.manifest.environment ?? null,
      runtimeConfigurationDigest:
        run.manifest.runtimeConfigurationDigest ?? null,
      resources,
      plan:
        target.kind === "workflow"
          ? null
          : (run.manifest.activePlan ?? context.plan),
      diagnosis: diagnosis
        ? {
            evidence: diagnosis.evidence
              .map((e: any) => e.contentDigest)
              .sort(),
            hypotheses: diagnosis.hypotheses
              .map((h: any) => ({
                claim: h.claim,
                status: h.status,
                nextExperiment: h.nextExperiment,
                supportingEvidence: h.supportingEvidence
                  .map(
                    (id: string) =>
                      diagnosis.evidence.find((e: any) => e.id === id)
                        ?.contentDigest,
                  )
                  .sort(),
                contradictingEvidence: h.contradictingEvidence
                  .map(
                    (id: string) =>
                      diagnosis.evidence.find((e: any) => e.id === id)
                        ?.contentDigest,
                  )
                  .sort(),
              }))
              .sort((a: any, b: any) => digest(a).localeCompare(digest(b))),
          }
        : null,
    });
  }
  propose(input: unknown) {
    const data = z
      .object({
        title: z.string().min(1).max(200),
        reason: z.string().min(1).max(10000),
        baselineId: z.string().uuid(),
        candidateId: z.string().uuid(),
        evidenceRunIds: z.array(z.string().uuid()).min(1).max(100),
        minVerifiedDeliveryGain: z.number().int().min(0).max(100).default(1),
      })
      .parse(input);
    const baseline = this.required<ResourceVersion>(
        "resource",
        data.baselineId,
      ),
      candidate = this.required<ResourceVersion>("resource", data.candidateId);
    if (
      baseline.id === candidate.id ||
      baseline.kind !== candidate.kind ||
      baseline.name !== candidate.name ||
      baseline.projectId !== candidate.projectId ||
      (baseline.taskType ?? "development") !==
        (candidate.taskType ?? "development")
    )
      throw new DomainError(
        "target_mismatch",
        "基线和候选必须属于同一资源及范围的不同版本",
        422,
      );
    if (
      this.store
        .list<Proposal>("improvement")
        .some((p) => p.candidateId === candidate.id)
    )
      throw new DomainError(
        "candidate_linked",
        "该候选已有提案，请继续使用原提案",
      );
    new ResourceService(this.store).resolve(
      [baseline.id],
      baseline.kind,
      baseline.projectId,
    );
    for (const id of data.evidenceRunIds)
      if (
        this.targetIn(this.required<Run>("run", id), baseline)?.id !==
        baseline.id
      )
        throw new DomainError(
          "evidence_target",
          "优化依据必须使用该基线资源",
          422,
        );
    const low =
      baseline.content === candidate.content &&
      digest(baseline.nodes ?? null) === digest(candidate.nodes ?? null) &&
      digest([...baseline.sources].sort()) ===
        digest([...candidate.sources].sort());
    const proposal: Proposal = {
      ...data,
      id: randomUUID(),
      risk: low ? "low" : "review_required",
      minVerifiedDeliveryGain: low ? 0 : data.minVerifiedDeliveryGain,
      createdAt: new Date().toISOString(),
    };
    this.store.put("improvement", proposal);
    return proposal;
  }
  dataset(input: unknown) {
    const data = z
      .object({
        name: z.string().min(1).max(200),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        baselineId: z.string().uuid(),
        cases: z
          .array(
            z.object({
              label: z.string().min(1).max(200),
              sourceRunId: z.string().uuid(),
              split: z.enum(["development", "holdout"]),
            }),
          )
          .min(1)
          .max(100),
      })
      .parse(input);
    if (
      this.store
        .list<Dataset>("evaluation_dataset")
        .some((d) => d.name === data.name && d.version === data.version)
    )
      throw new DomainError("dataset_exists", "数据集版本不可覆盖");
    const baseline = this.required<ResourceVersion>(
      "resource",
      data.baselineId,
    );
    const cases = data.cases.map((c) => {
      const source = this.required<Run>("run", c.sourceRunId);
      if (!["succeeded", "failed", "cancelled"].includes(source.status))
        throw new DomainError("case_unfinished", "案例来源必须已结束", 422);
      if (this.targetIn(source, baseline)?.id !== baseline.id)
        throw new DomainError("case_target", "案例未使用指定基线", 422);
      return {
        ...c,
        id: randomUUID(),
        inputDigest: this.fingerprint(source, baseline),
      };
    });
    if (new Set(cases.map((c) => c.inputDigest)).size !== cases.length)
      throw new DomainError("duplicate_case", "重复输入不能计为独立案例", 422);
    const dataset = {
      ...data,
      cases,
      id: randomUUID(),
      digest: digest({ baseline: baseline.contentDigest, cases }),
      createdAt: new Date().toISOString(),
    };
    this.store.put("evaluation_dataset", dataset);
    return dataset;
  }
  inspectRun(run: Run) {
    if (!["succeeded", "failed", "cancelled"].includes(run.status))
      throw new DomainError("run_unfinished", "只能评估已结束的运行", 422);
    if (run.status !== "succeeded")
      return {
        pass: false,
        reason: run.status,
        durationMs: Date.parse(run.updatedAt) - Date.parse(run.createdAt),
      };
    const delivery = this.store
      .list<Delivery>("delivery")
      .find((d) => d.runId === run.id);
    if (
      !this.dataDir ||
      !delivery?.artifacts?.length ||
      run.steps.some((s) => s.status !== "succeeded")
    )
      return {
        pass: false,
        reason: "missing_verification_evidence",
        durationMs: null,
      };
    try {
      if (delivery.artifactSubdir)
        z.string().uuid().parse(delivery.artifactSubdir);
      for (const name of delivery.artifacts) {
        if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw new Error("unsafe_path");
        const bytes = readFileSync(
          join(
            this.dataDir,
            "artifacts",
            run.id,
            ...(delivery.artifactSubdir ? [delivery.artifactSubdir] : []),
            name,
          ),
        );
        if (
          createHash("sha256").update(bytes).digest("hex") !==
          delivery.artifactDigests?.[name]
        )
          throw new Error("artifact_changed");
      }
      return {
        pass: true,
        reason: "verified_delivery",
        durationMs: Date.parse(run.updatedAt) - Date.parse(run.createdAt),
      };
    } catch {
      return {
        pass: false,
        reason: "artifact_integrity_failed",
        durationMs: null,
      };
    }
  }
  evaluate(proposalId: string, input: unknown) {
    const data = z
      .object({
        datasetId: z.string().uuid(),
        pairs: z.array(PairInput).min(1).max(100),
        minHoldoutCases: z.number().int().min(3).max(100).default(20),
      })
      .parse(input);
    const proposal = this.required<Proposal>("improvement", proposalId),
      dataset = this.required<Dataset>("evaluation_dataset", data.datasetId),
      baseline = this.required<ResourceVersion>(
        "resource",
        proposal.baselineId,
      ),
      candidate = this.required<ResourceVersion>(
        "resource",
        proposal.candidateId,
      );
    if (dataset.baselineId !== baseline.id)
      throw new DomainError("dataset_target", "数据集基线与提案不一致", 422);
    this.checkHoldout(proposal, dataset);
    if (
      data.pairs.length !== dataset.cases.length ||
      new Set(data.pairs.map((p) => p.caseId)).size !== data.pairs.length
    )
      throw new DomainError(
        "pair_coverage",
        "每个固定案例必须恰好有一对执行结果",
        422,
      );
    const runIds = data.pairs.flatMap((p) => [
      p.baselineRunId,
      p.candidateRunId,
    ]);
    if (new Set(runIds).size !== runIds.length)
      throw new DomainError(
        "duplicate_run",
        "不同案例或分组不能重复使用同一运行",
        422,
      );
    const cases = data.pairs.map((pair) => {
      const fixed = dataset.cases.find((c) => c.id === pair.caseId);
      if (!fixed) throw new DomainError("unknown_case", "未知案例", 422);
      if (
        fixed.split === "holdout" &&
        proposal.evidenceRunIds.some(
          (id) =>
            this.fingerprint(this.required<Run>("run", id), baseline) ===
            fixed.inputDigest,
        )
      )
        throw new DomainError(
          "holdout_leakage",
          "用于优化候选的输入不能再次计入独立留出案例",
          422,
        );
      const baseRun = this.required<Run>("run", pair.baselineRunId),
        candidateRun = this.required<Run>("run", pair.candidateRunId);
      if (
        this.targetIn(baseRun, baseline)?.id !== baseline.id ||
        this.targetIn(candidateRun, candidate)?.id !== candidate.id ||
        this.fingerprint(baseRun, baseline) !== fixed.inputDigest ||
        this.fingerprint(candidateRun, candidate) !== fixed.inputDigest
      )
        throw new DomainError(
          "input_mismatch",
          "配对运行的输入、基线、环境或资源版本不一致",
          422,
        );
      return {
        ...pair,
        split: fixed.split,
        baseline: this.inspectRun(baseRun),
        candidate: this.inspectRun(candidateRun),
      };
    });
    const holdoutCases = cases.filter((c) => c.split === "holdout").length,
      regressions = cases.filter((c) => !c.candidate.pass).map((c) => c.caseId);
    const gain =
      cases.filter((c) => c.split === "holdout" && c.candidate.pass).length -
      cases.filter((c) => c.split === "holdout" && c.baseline.pass).length;
    const result = {
      baselinePass: cases.filter((c) => c.baseline.pass).length,
      candidatePass: cases.filter((c) => c.candidate.pass).length,
      holdoutCases,
      regressions,
      gain,
      gate: regressions.length
        ? ("regression" as const)
        : holdoutCases < data.minHoldoutCases
          ? ("insufficient_samples" as const)
          : gain < (proposal.minVerifiedDeliveryGain ?? 1)
            ? ("no_measured_gain" as const)
            : ("passed" as const),
      cost: "unknown" as const,
      cases,
    };
    const evaluation: Evaluation = {
      id: randomUUID(),
      proposalId,
      datasetId: dataset.id,
      datasetDigest: dataset.digest,
      pairs: data.pairs,
      policy: { minHoldoutCases: data.minHoldoutCases },
      result,
      createdAt: new Date().toISOString(),
    };
    this.store.put("evaluation", evaluation);
    return evaluation;
  }
  release(
    proposalId: string,
    input: unknown,
    canaryProof?: { id: string; rolloutId: string },
  ) {
    const data = z
      .object({
        evaluationId: z.string().uuid(),
        mode: z.enum(["manual", "automatic"]).default("manual"),
        approvalReason: z.string().max(10000).default(""),
      })
      .parse(input);
    const proposal = this.required<Proposal>("improvement", proposalId),
      evaluation = this.required<Evaluation>("evaluation", data.evaluationId);
    if (
      evaluation.proposalId !== proposalId ||
      evaluation.result.gate !== "passed"
    )
      throw new DomainError("evaluation_gate", "评估未满足发布门槛");
    if (data.mode === "manual" && !data.approvalReason.trim())
      throw new DomainError(
        "approval_required",
        "人工发布需要记录审核理由",
        422,
      );
    if (
      data.mode === "automatic" &&
      (proposal.risk !== "low" ||
        evaluation.result.holdoutCases < 20 ||
        evaluation.pairs.some((pair) => {
          const run = this.required<Run>("run", pair.candidateRunId);
          return (
            !run.manifest.model || !run.manifest.runtimeConfigurationDigest
          );
        }) ||
        !this.store.get<{ enabled: boolean }>(
          "optimization_policy",
          "auto_low_risk",
        )?.enabled)
    )
      throw new DomainError(
        "approval_required",
        "自动发布需要低风险、至少20个留出案例和显式启用的策略",
      );
    if (data.mode === "automatic") {
      const canary = canaryProof
        ? this.store.get<any>("resource_canary", canaryProof.id)
        : null;
      const observed = canary ? new RolloutService(this).inspect(canary) : null;
      if (
        !canary ||
        canary.rolloutId !== canaryProof?.rolloutId ||
        canary.evaluationId !== evaluation.id ||
        canary.status !== "active" ||
        observed?.failed ||
        observed!.acceptedTaskIds.length < canary.maxTasks
      )
        throw new DomainError(
          "canary_gate",
          "自动发布必须先完成限定项目灰度与任务验收",
        );
    }
    // Recheck current evidence immediately before changing the release pointer.
    for (const pair of evaluation.pairs) {
      if (!this.inspectRun(this.required<Run>("run", pair.candidateRunId)).pass)
        throw new DomainError("evidence_changed", "候选执行证据已失效");
    }
    const resource = this.required<ResourceVersion>(
        "resource",
        proposal.candidateId,
      ),
      pointerId = digest([resource.kind, resource.name, resource.projectId]),
      previous = this.store.get<{ resourceId: string }>(
        "resource_release",
        pointerId,
      );
    if (previous?.resourceId === resource.id) {
      const existing = this.store
        .list<any>("improvement_release")
        .find((r) => r.evaluationId === evaluation.id);
      if (existing) return existing;
      throw new DomainError("release_conflict", "候选已由其他发布记录激活");
    }
    if (previous && previous.resourceId !== proposal.baselineId)
      throw new DomainError(
        "release_conflict",
        "当前版本已离开提案基线，请重新评估",
      );
    const release = {
      id: randomUUID(),
      proposalId,
      evaluationId: evaluation.id,
      resourceId: resource.id,
      previousResourceId: previous?.resourceId ?? proposal.baselineId,
      pointerId,
      approvalReason: data.approvalReason,
      mode: data.mode,
      createdAt: new Date().toISOString(),
    };
    return this.store.transaction(() => {
      new ResourceService(this.store).publish(resource.id, {
        evaluationId: evaluation.id,
      });
      this.store.put("improvement_release", release);
      return release;
    });
  }
  rollback(releaseId: string, reason: string) {
    if (!reason.trim())
      throw new DomainError("reason_required", "回滚需要理由", 422);
    const release = this.required<any>("improvement_release", releaseId),
      pointer = this.required<{ resourceId: string }>(
        "resource_release",
        release.pointerId,
      );
    if (pointer.resourceId !== release.resourceId)
      throw new DomainError(
        "release_conflict",
        "当前发布指针已变化，不能覆盖后续发布",
      );
    return this.store.transaction(() => {
      new ResourceService(this.store).publish(release.previousResourceId, {
        rollbackReleaseId: releaseId,
      });
      const record = {
        id: randomUUID(),
        releaseId,
        reason,
        from: release.resourceId,
        to: release.previousResourceId,
        createdAt: new Date().toISOString(),
      };
      this.store.put("improvement_rollback", record);
      return record;
    });
  }
  analyze(from: string, to: string) {
    z.iso.datetime().parse(from);
    z.iso.datetime().parse(to);
    if (from > to) throw new DomainError("invalid_window", "分析窗口无效", 422);
    const id = digest([from, to]);
    const existing = this.store.get<any>("analysis_batch", id);
    if (existing) return existing;
    const runs = this.store
      .list<Run>("run")
      .filter((r) => r.updatedAt >= from && r.updatedAt <= to);
    const groups = new Map<
      string,
      { signature: string; runIds: string[]; recommendation: string }
    >();
    for (const run of runs) {
      const errors = (
        this.store.db
          .prepare("SELECT data FROM events WHERE run_id=? ORDER BY seq")
          .all(run.id) as { data: string }[]
      )
        .map((row) => JSON.parse(row.data))
        .filter((e) => e.type === "run.error");
      if (run.status === "failed" || errors.length) {
        const signature = String(
          (errors.at(-1)?.payload as any)?.message ?? run.status,
        ).slice(0, 500);
        const group = groups.get(signature) ?? {
          signature,
          runIds: [],
          recommendation: signature.toLowerCase().includes("test")
            ? "补充失败测试证据、最小复现与修复验证方法"
            : "检查步骤输入、权限、环境与失败证据，形成可复现评估案例",
        };
        group.runIds.push(run.id);
        groups.set(signature, group);
      }
    }
    const batch = {
      id,
      from,
      to,
      runIds: runs.map((r) => r.id),
      groups: [...groups.values()],
      createdAt: new Date().toISOString(),
    };
    this.store.put("analysis_batch", batch);
    return batch;
  }
  generateCandidate(baselineId: string, evidenceRunIds: string[]) {
    const baseline = this.required<ResourceVersion>("resource", baselineId);
    if (baseline.kind !== "skill")
      throw new DomainError(
        "skill_required",
        "自动候选生成目前只支持Skill，不自动生成知识事实",
        422,
      );
    if (!evidenceRunIds.length)
      throw new DomainError("evidence_required", "需要真实失败运行", 422);
    for (const id of evidenceRunIds) {
      const run = this.required<Run>("run", id);
      if (
        run.status !== "failed" ||
        this.targetIn(run, baseline)?.id !== baselineId
      )
        throw new DomainError(
          "evidence_required",
          "来源必须是使用该基线的失败运行",
          422,
        );
    }
    const parts = baseline.version.split(".").map(Number);
    let version: string;
    do {
      version = `${parts[0]}.${parts[1]}.${++parts[2]}`;
    } while (
      this.store
        .list<ResourceVersion>("resource")
        .some(
          (r) =>
            r.kind === baseline.kind &&
            r.name === baseline.name &&
            r.projectId === baseline.projectId &&
            r.version === version,
        )
    );
    const candidate = new ResourceService(this.store).create({
      ...baseline,
      version,
      content:
        baseline.content +
        "\n\n执行改进候选：验证失败时保存原始错误、输入版本与复现条件；区分环境失败和实现错误；修复后重新运行对应验证；不要把进程退出成功或未执行检查当成验收通过。",
    });
    return this.propose({
      title: `改进 ${baseline.name} 的失败处理`,
      reason: "依据实际失败轨迹生成执行方法候选，尚未证明有效",
      baselineId,
      candidateId: candidate.id,
      evidenceRunIds,
    });
  }
  trials(proposalId: string, input: unknown) {
    const data = z
      .object({
        datasetId: z.string().uuid(),
        consentToLocalExecution: z.literal(true),
      })
      .parse(input);
    const proposal = this.required<Proposal>("improvement", proposalId),
      dataset = this.required<Dataset>("evaluation_dataset", data.datasetId);
    if (dataset.baselineId !== proposal.baselineId)
      throw new DomainError("dataset_target", "数据集与提案基线不一致", 422);
    this.checkHoldout(proposal, dataset);
    if (!this.runtime.available)
      throw new DomainError("runtime_unavailable", "执行器不可用", 422);
    const baseline = this.required<ResourceVersion>(
        "resource",
        proposal.baselineId,
      ),
      trialId = randomUUID(),
      pairs: Pair[] = [],
      createdRuns: string[] = [];
    try {
      for (const fixed of dataset.cases) {
        const source = this.required<Run>("run", fixed.sourceRunId),
          sourceTask = source.manifest.task as Task,
          project = source.manifest.project as Project;
        if (!this.required<Project>("project", project.id).allowAgent)
          throw new DomainError(
            "project_not_authorized",
            "项目当前未授权Agent执行",
            422,
          );
        if (
          source.runtime !== "codex" ||
          source.manifest.runtimeVersion !== this.runtime.version ||
          (source.manifest.runtimeConfigurationDigest ?? null) !==
            (this.runtime.configurationDigest ?? null)
        )
          throw new DomainError(
            "runtime_changed",
            "需要与案例相同的执行器及版本",
            422,
          );
        const ids: string[] = [];
        for (const [arm, resourceId] of [
          ["baseline", proposal.baselineId],
          ["candidate", proposal.candidateId],
        ]) {
          const engine = new WorkService(this.store, this.runtime, {
            candidateIds: arm === "candidate" ? [resourceId] : [],
            evaluation: { trialId, caseId: fixed.id, arm },
            projectSnapshot: project,
            baseCommit: String(source.manifest.baseCommit),
          });
          const replace = (values: string[]) =>
            values.map((id) => (id === baseline.id ? resourceId : id));
          const fixedContext = source.manifest.context as {
            skills: ResourceVersion[];
            knowledge: ResourceVersion[];
            workflow: ResourceVersion | null;
          };
          const task = engine.createTask({
            ...sourceTask,
            title: `[评估 ${arm}] ${fixed.label}`,
            parentId: null,
            goalId: null,
            dependsOn: [],
            plannedFor: null,
            dueAt: null,
            resourceFamilyIds: [],
            skillVersionIds: replace(fixedContext.skills.map((r) => r.id)),
            knowledgeVersionIds: replace(
              fixedContext.knowledge.map((r) => r.id),
            ),
            workflowVersionId:
              fixedContext.workflow?.id === baseline.id
                ? resourceId
                : (fixedContext.workflow?.id ?? null),
          });
          if (task.type === "diagnosis") {
            const diagnosis = new DiagnosisService(this.store),
              snapshot = source.manifest.diagnosis as any,
              mapping = new Map<string, string>();
            for (const evidence of snapshot.evidence)
              mapping.set(
                evidence.id,
                diagnosis.addEvidence(task.id, evidence).id,
              );
            for (const hypothesis of snapshot.hypotheses)
              diagnosis.addHypothesis(task.id, {
                ...hypothesis,
                supportingEvidence: hypothesis.supportingEvidence.map(
                  (id: string) => mapping.get(id),
                ),
                contradictingEvidence: hypothesis.contradictingEvidence.map(
                  (id: string) => mapping.get(id),
                ),
              });
          }
          const prepared = engine.prepare(task.id);
          if (
            this.fingerprint(
              { ...source, manifest: prepared.manifest },
              baseline,
            ) !== fixed.inputDigest
          )
            throw new DomainError(
              "case_drift",
              "案例输入已无法按固定环境复现",
              422,
            );
          const run = engine.start(
            task.id,
            prepared.preparationDigest,
            `${trialId}:${fixed.id}:${arm}`,
          );
          ids.push(run.id);
          createdRuns.push(run.id);
        }
        pairs.push({
          caseId: fixed.id,
          baselineRunId: ids[0],
          candidateRunId: ids[1],
        });
      }
      const trial = {
        id: trialId,
        proposalId,
        datasetId: dataset.id,
        pairs,
        createdAt: new Date().toISOString(),
      };
      this.store.put("evaluation_trial", trial);
      return trial;
    } catch (error) {
      for (const id of createdRuns) {
        const run = this.required<Run>("run", id);
        if (run.status === "queued")
          new WorkService(this.store).control(id, "cancel");
      }
      throw error;
    }
  }
  checkHoldout(proposal: Proposal, dataset: Dataset) {
    const baseline = this.required<ResourceVersion>(
        "resource",
        proposal.baselineId,
      ),
      seen = new Set(
        proposal.evidenceRunIds.map((id) =>
          this.fingerprint(this.required<Run>("run", id), baseline),
        ),
      );
    if (
      dataset.cases.some(
        (c) => c.split === "holdout" && seen.has(c.inputDigest),
      )
    )
      throw new DomainError(
        "holdout_leakage",
        "用于优化候选的输入不能再次计入独立留出案例",
        422,
      );
  }
  configureSchedule(input: unknown) {
    const data = z
      .object({
        enabled: z.boolean(),
        intervalDays: z.number().int().min(1).max(90).default(7),
      })
      .parse(input);
    const schedule = {
      id: "periodic_analysis",
      ...data,
      nextAt: new Date(Date.now() + data.intervalDays * 86400000).toISOString(),
      lastAt: null as string | null,
    };
    this.store.put("optimization_schedule", schedule);
    return schedule;
  }
  tick(now = new Date()) {
    new RolloutService(this).tick();
    const schedule = this.store.get<{
      id: string;
      enabled: boolean;
      intervalDays: number;
      nextAt: string;
      lastAt: string | null;
    }>("optimization_schedule", "periodic_analysis");
    if (schedule?.enabled && schedule.nextAt <= now.toISOString()) {
      const from =
        schedule.lastAt ??
        new Date(
          now.getTime() - schedule.intervalDays * 86400000,
        ).toISOString();
      this.store.transaction(() => {
        this.analyze(from, now.toISOString());
        this.store.put("optimization_schedule", {
          ...schedule,
          lastAt: now.toISOString(),
          nextAt: new Date(
            now.getTime() + schedule.intervalDays * 86400000,
          ).toISOString(),
        });
      });
    }
    if (
      this.store.get<{ enabled: boolean }>(
        "optimization_policy",
        "auto_low_risk",
      )?.enabled
    ) {
      for (const evaluation of this.store.list<Evaluation>("evaluation")) {
        const proposal = this.required<Proposal>(
          "improvement",
          evaluation.proposalId,
        );
        if (
          proposal.risk === "low" &&
          evaluation.result.gate === "passed" &&
          evaluation.result.holdoutCases >= 20 &&
          !this.store
            .list<any>("improvement_release")
            .some((r) => r.evaluationId === evaluation.id) &&
          !this.store
            .list<any>("canary_history")
            .some((r) => r.evaluationId === evaluation.id)
        ) {
          try {
            new RolloutService(this).start(proposal.id, {
              evaluationId: evaluation.id,
              mode: "automatic",
              projectIds:
                this.store.get<{ projectIds: string[] }>(
                  "optimization_policy",
                  "auto_low_risk",
                )?.projectIds ?? [],
            });
          } catch (error) {
            this.store.put("optimization_notice", {
              id: `release:${evaluation.id}`,
              evaluationId: evaluation.id,
              message: (error as Error).message,
            });
          }
        }
      }
    }
  }
}
