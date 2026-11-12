import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../persistence/index.js";
import { DomainError, digest, type Task } from "../domain/index.js";

export const EvidenceInput = z
  .object({
    title: z.string().min(1).max(200),
    source: z.string().min(1).max(2000),
    observedAt: z.iso.datetime(),
    kind: z.enum(["observation", "experiment"]),
    content: z.string().min(1).max(20000),
    verified: z.boolean().default(false),
    causal: z.boolean().default(false),
  })
  .refine((v) => !v.causal || (v.kind === "experiment" && v.verified), {
    message: "因果证据必须是经用户验证的实验",
  });
export type Evidence = z.infer<typeof EvidenceInput> & {
  id: string;
  taskId: string;
  contentDigest: string;
  createdAt: string;
};
export const HypothesisInput = z.object({
  claim: z.string().min(1).max(4000),
  supportingEvidence: z.array(z.string().uuid()).default([]),
  contradictingEvidence: z.array(z.string().uuid()).default([]),
  nextExperiment: z.string().max(4000).default(""),
  status: z.enum(["open", "supported", "rejected"]).default("open"),
});
export type Hypothesis = z.infer<typeof HypothesisInput> & {
  id: string;
  taskId: string;
  revision: number;
  createdAt: string;
};
export const DiagnosisResult = z.object({
  summary: z.string().min(1),
  hypotheses: z.array(HypothesisInput).min(1).max(30),
  conclusion: z.object({
    status: z.enum(["confirmed", "likely", "unresolved"]),
    hypothesisIndex: z.number().int().nonnegative().nullable(),
    reason: z.string().min(1).max(10000),
    unknowns: z.array(z.string().min(1)).max(50),
  }),
});
export type DiagnosisReport = z.infer<typeof DiagnosisResult>;
export function validateDiagnosis(
  input: unknown,
  evidence: Evidence[],
): DiagnosisReport {
  const report = DiagnosisResult.parse(input),
    byId = new Map(evidence.map((e) => [e.id, e]));
  for (const hypothesis of report.hypotheses) {
    if (
      hypothesis.status === "supported" &&
      !hypothesis.supportingEvidence.length
    )
      throw new DomainError(
        "insufficient_evidence",
        "有支持的假设必须引用证据",
        422,
      );
    for (const id of [
      ...hypothesis.supportingEvidence,
      ...hypothesis.contradictingEvidence,
    ])
      if (!byId.has(id))
        throw new DomainError(
          "invalid_evidence",
          "结论引用了未知或其他任务的证据",
          422,
        );
    if (
      hypothesis.supportingEvidence.some((id) =>
        hypothesis.contradictingEvidence.includes(id),
      )
    )
      throw new DomainError(
        "evidence_conflict",
        "同一证据不能同时支持与反驳同一假设",
        422,
      );
  }
  const { status, hypothesisIndex } = report.conclusion;
  const selected =
    hypothesisIndex === null ? undefined : report.hypotheses[hypothesisIndex];
  if (hypothesisIndex !== null && !selected)
    throw new DomainError("invalid_hypothesis", "结论指向不存在的假设", 422);
  if (
    status !== "unresolved" &&
    (!selected ||
      selected.status === "rejected" ||
      !selected.supportingEvidence.length)
  )
    throw new DomainError(
      "insufficient_evidence",
      "可能或确认根因必须有支持证据",
      422,
    );
  if (
    status === "confirmed" &&
    (!selected!.supportingEvidence.some(
      (id) => byId.get(id)!.causal && byId.get(id)!.verified,
    ) ||
      selected!.contradictingEvidence.length)
  )
    throw new DomainError(
      "insufficient_causality",
      "确认根因需要经用户验证的因果实验且没有未解决反证",
      422,
    );
  if (status === "unresolved" && !report.conclusion.unknowns.length)
    throw new DomainError("unknowns_required", "证据不足时必须列出未知项", 422);
  return report;
}
export class DiagnosisService {
  constructor(public store: Store) {}
  requireTask(taskId: string) {
    const task = this.store.get<Task>("task", taskId);
    if (!task || task.type !== "diagnosis")
      throw new DomainError("diagnosis_task_required", "需要故障诊断任务", 422);
    return task;
  }
  evidence(taskId: string) {
    return this.store
      .list<Evidence>("evidence")
      .filter((e) => e.taskId === taskId);
  }
  snapshot(taskId: string) {
    this.requireTask(taskId);
    const evidence = this.evidence(taskId),
      hypotheses = this.store
        .list<Hypothesis>("hypothesis")
        .filter((h) => h.taskId === taskId);
    const result = { evidence, hypotheses };
    if (JSON.stringify(result).length > 80000)
      throw new DomainError(
        "diagnosis_budget",
        "诊断输入超过80000字符，请缩小采集范围",
        422,
      );
    return { ...result, digest: digest(result) };
  }
  addEvidence(taskId: string, input: unknown) {
    this.requireTask(taskId);
    const data = EvidenceInput.parse(input);
    const item = {
      ...data,
      id: randomUUID(),
      taskId,
      contentDigest: digest(data),
      createdAt: new Date().toISOString(),
    };
    this.store.put("evidence", item);
    return item;
  }
  addHypothesis(taskId: string, input: unknown) {
    this.requireTask(taskId);
    const data = HypothesisInput.parse(input);
    validateDiagnosis(
      {
        summary: "候选假设",
        hypotheses: [data],
        conclusion: {
          status: "unresolved",
          hypothesisIndex: null,
          reason: "尚待验证",
          unknowns: ["尚待完成证据验证"],
        },
      },
      this.evidence(taskId),
    );
    const item = {
      ...data,
      id: randomUUID(),
      taskId,
      revision: 1,
      createdAt: new Date().toISOString(),
    };
    this.store.put("hypothesis", item);
    return item;
  }
  updateHypothesis(
    taskId: string,
    id: string,
    revision: number,
    input: unknown,
  ) {
    this.requireTask(taskId);
    return this.store.transaction(() => {
      const existing = this.store.get<Hypothesis>("hypothesis", id);
      if (!existing || existing.taskId !== taskId)
        throw new DomainError("not_found", "假设不存在", 404);
      if (existing.revision !== revision)
        throw new DomainError("revision_conflict", "假设已变化，请刷新");
      const data = HypothesisInput.parse({ ...existing, ...(input as object) });
      validateDiagnosis(
        {
          summary: "修订假设",
          hypotheses: [data],
          conclusion: {
            status: "unresolved",
            hypothesisIndex: null,
            reason: "继续验证",
            unknowns: ["尚待完成验证"],
          },
        },
        this.evidence(taskId),
      );
      this.store.put("hypothesis_revision", {
        ...existing,
        id: `${id}:${revision}`,
        hypothesisId: id,
      });
      const updated = { ...existing, ...data, revision: revision + 1 };
      this.store.put("hypothesis", updated);
      return updated;
    });
  }
  reportFromSnapshot(taskId:string,input:unknown,snapshot:ReturnType<DiagnosisService["snapshot"]>,runId:string,nodeId:string) {
    this.requireTask(taskId);
    const result=validateDiagnosis(input,snapshot.evidence);
    if(digest({evidence:snapshot.evidence,hypotheses:snapshot.hypotheses})!==snapshot.digest)
      throw new DomainError("diagnosis_snapshot_changed","诊断证据快照摘要不一致",409);
    const report={...result,id:randomUUID(),taskId,runId,nodeId,inputDigest:snapshot.digest,
      evidenceSnapshot:snapshot.evidence,createdAt:new Date().toISOString()};
    this.store.put("diagnosis_report",report);return report;
  }
  report(taskId: string, input: unknown) {
    const snapshot = this.snapshot(taskId),
      result = validateDiagnosis(input, snapshot.evidence);
    const report = {
      ...result,
      id: randomUUID(),
      taskId,
      inputDigest: snapshot.digest,
      evidenceSnapshot: snapshot.evidence,
      createdAt: new Date().toISOString(),
    };
    this.store.put("diagnosis_report", report);
    return report;
  }
}
