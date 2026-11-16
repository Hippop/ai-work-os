import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AssetService, type Knowledge } from "../adaptive/assets.js";
import { verifyArtifact } from "../adaptive/artifacts.js";
import type { AdaptiveRun } from "../adaptive/engine.js";
import { DomainError, digest, type Task } from "../domain/index.js";
import {
  KnowledgeKindSchema,
  type KnowledgeClaim,
  type KnowledgeOutputSpec,
  type KnowledgeRelation,
  type ResolvedContextManifest,
  type ResultValidity,
} from "../graph/types.js";
import type { Store } from "../persistence/index.js";

const KnowledgeCandidateInput = z
  .object({
    runId: z.string().uuid(),
    invocationId: z.string().uuid().optional(),
    nodeId: z.string().min(1).max(120).optional(),
    name: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)
      .max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: z.string().trim().min(1).max(160),
    kind: KnowledgeKindSchema.default("pattern"),
    verification: z
      .enum(["evidence-backed", "experiment-verified", "unverified"])
      .default("unverified"),
    scope: z.enum(["global", "project", "capability", "task"]).default("project"),
    capabilityNames: z.array(z.string().min(1).max(120)).max(40).default([]),
    applicableConditions: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    counterEvidence: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    artifactRefs: z.array(z.string().max(500)).max(50).default([]),
    content: z.string().trim().min(1).max(200000),
    tags: z.array(z.string().max(60)).max(30).default([]),
  })
  .strict();

const ConflictInput = z
  .object({
    sourceId: z.string().min(1).max(180),
    targetId: z.string().min(1).max(180),
    reason: z.string().trim().min(5).max(2000),
  })
  .strict();

export type ProducerKnowledgeRecord = {
  id: string;
  runId: string;
  nodeId: string;
  outputId: string;
  invocationId: string;
  claimId: string;
  kind: KnowledgeClaim["kind"];
  content: string;
  contentDigest: string;
  evidenceRefs: string[];
  createdAt: string;
};

export class KnowledgeCurationService {
  private assets: AssetService;

  constructor(private store: Store) {
    this.assets = new AssetService(store);
  }

  proposeCandidate(input: unknown): { knowledge: Knowledge; claim: KnowledgeClaim } {
    const data = KnowledgeCandidateInput.parse(input);
    if (data.scope === "global") {
      throw new DomainError(
        "scope_promotion_denied",
        "项目运行提炼的知识候选不能直接提升为全局知识，请先在项目或能力作用域审核发布",
        403,
      );
    }
    const run = this.store.get<AdaptiveRun>("adaptive_run", data.runId);
    if (!run) {
      throw new DomainError("run_missing", "来源运行不存在", 404);
    }
    const task = this.store.get<Task>("task", run.taskId);
    if (!task) {
      throw new DomainError("task_missing", "来源任务不存在", 404);
    }
    if (data.scope === "project" && !task.projectId) {
      throw new DomainError(
        "scope_required",
        "项目知识候选必须关联所属项目",
        422,
      );
    }
    if (data.invocationId) {
      const inv = this.store.get<{ id: string; runId: string; nodeId: string }>(
        "adaptive_invocation",
        data.invocationId,
      );
      if (!inv || inv.runId !== run.id) {
        throw new DomainError(
          "invocation_mismatch",
          "引用的执行调用不属于该运行",
          422,
        );
      }
    }
    // Verify referenced run artifacts match recorded digests when present.
    const allDigests: Record<string, string> = {};
    for (const res of Object.values(run.results)) {
      Object.assign(allDigests, res.artifactDigests ?? {});
    }
    for (const ref of data.artifactRefs) {
      if (Object.hasOwn(allDigests, ref)) {
        verifyArtifact(ref, allDigests[ref]);
      } else {
        const knownRef = Object.values(run.results).some((r) =>
          r.artifactRefs.includes(ref),
        );
        if (!knownRef) {
          throw new DomainError(
            "evidence_not_from_run",
            `证据工件不属于当前运行: ${ref}`,
            422,
          );
        }
      }
    }

    const now = new Date().toISOString();
    const claimId = randomUUID();
    return this.store.transaction(() => {
      const knowledge = this.assets.createKnowledge({
        name: data.name,
        version: data.version,
        title: data.title,
        content: [
          data.content,
          "",
          `适用条件：${data.applicableConditions.join("；")}`,
          ...(data.counterEvidence.length
            ? [`反证/限制：${data.counterEvidence.join("；")}`]
            : []),
        ].join("\n"),
        scope: data.scope,
        projectId: task.projectId,
        taskId: data.scope === "task" ? task.id : null,
        capabilityNames: data.capabilityNames,
        source: `adaptive-run:${run.id}${data.invocationId ? `:inv:${data.invocationId}` : ""}`,
        evidenceRefs: [
          `run:${run.id}`,
          ...(data.invocationId ? [`invocation:${data.invocationId}`] : []),
          ...data.artifactRefs,
        ],
        tags: data.tags,
      });
      const claim: KnowledgeClaim = {
        id: claimId,
        knowledgeId: knowledge.id,
        name: knowledge.name,
        version: knowledge.version,
        kind: data.kind,
        lifecycle: "draft",
        verification: data.verification,
        scope: knowledge.scope,
        projectId: knowledge.projectId,
        taskId: knowledge.taskId,
        capabilityNames: knowledge.capabilityNames,
        content: knowledge.content,
        contentDigest: digest(knowledge.content),
        sourceRunId: run.id,
        ...(data.invocationId ? { sourceInvocationId: data.invocationId } : {}),
        evidenceRefs: knowledge.evidenceRefs,
        applicableConditions: data.applicableConditions,
        counterEvidence: data.counterEvidence,
        createdAt: now,
      };
      this.store.put("knowledge_claim", claim);
      this.store.event(
        run.id,
        "knowledge.candidate_proposed",
        {
          claimId: claim.id,
          knowledgeId: knowledge.id,
          kind: claim.kind,
          verification: claim.verification,
        },
        "user",
      );
      return { knowledge, claim };
    });
  }

  publishClaim(claimId: string): { knowledge: Knowledge; claim: KnowledgeClaim } {
    return this.store.transaction(() => {
      const claim = this.store.get<KnowledgeClaim>("knowledge_claim", claimId);
      if (!claim) {
        throw new DomainError("claim_missing", "知识声明不存在", 404);
      }
      const knowledge = this.assets.publishKnowledge(claim.knowledgeId);
      // Publishing never automatically promotes unverified claims to verified facts.
      const updated: KnowledgeClaim = { ...claim, lifecycle: "published" };
      this.store.put("knowledge_claim", updated);
      return { knowledge, claim: updated };
    });
  }

  registerConflict(input: unknown): KnowledgeRelation {
    const data = ConflictInput.parse(input);
    if (data.sourceId === data.targetId) {
      throw new DomainError(
        "conflict_self",
        "不能将同一知识版本标记为与自身冲突",
        422,
      );
    }
    this.assets.getKnowledge(data.sourceId);
    this.assets.getKnowledge(data.targetId);
    const id = digest(["conflict", [data.sourceId, data.targetId].sort()]);
    const relation: KnowledgeRelation = {
      id,
      sourceId: data.sourceId,
      targetId: data.targetId,
      relationType: "conflict",
      reason: data.reason,
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.put("knowledge_relation", relation);
      this.store.event("knowledge:conflicts", "knowledge.conflict_recorded", {
        relationId: id,
        sourceId: data.sourceId,
        targetId: data.targetId,
        reason: data.reason,
      });
    });
    return relation;
  }

  conflictsFor(knowledgeId: string): KnowledgeRelation[] {
    return this.store
      .list<KnowledgeRelation>("knowledge_relation")
      .filter(
        (r) =>
          r.relationType === "conflict" &&
          (r.sourceId === knowledgeId || r.targetId === knowledgeId),
      );
  }

  listClaims(): KnowledgeClaim[] {
    return this.store.list<KnowledgeClaim>("knowledge_claim");
  }

  /**
   * Persist validated knowledge outputs emitted by an upstream node so downstream
   * consumers with resolution="producer-completion" read pinned, immutable claims.
   */
  recordNodeKnowledgeOutputs(
    run: AdaptiveRun,
    nodeId: string,
    invocationId: string,
    specs: KnowledgeOutputSpec[],
    output: unknown,
  ): ProducerKnowledgeRecord[] {
    if (!specs.length) return [];
    const outputObj =
      output && typeof output === "object"
        ? (output as Record<string, unknown>)
        : {};
    const evidenceList = Array.isArray(outputObj.evidence)
      ? outputObj.evidence.map(String).filter(Boolean)
      : [];
    const summaryText =
      typeof outputObj.summary === "string"
        ? outputObj.summary
        : JSON.stringify(output);
    const declaredOutputs =
      outputObj.knowledgeOutputs &&
      typeof outputObj.knowledgeOutputs === "object" &&
      !Array.isArray(outputObj.knowledgeOutputs)
        ? (outputObj.knowledgeOutputs as Record<string, unknown>)
        : {};

    const records: ProducerKnowledgeRecord[] = [];
    const now = new Date().toISOString();
    for (const spec of specs) {
      const explicit = declaredOutputs[spec.id] as
        | { content?: string; evidenceRefs?: string[] }
        | undefined;
      const content =
        typeof explicit?.content === "string" && explicit.content.trim()
          ? explicit.content
          : summaryText;
      const evidenceRefs = Array.isArray(explicit?.evidenceRefs)
        ? explicit.evidenceRefs.map(String).filter(Boolean)
        : evidenceList;
      if (spec.evidenceRequired && evidenceRefs.length === 0) {
        throw new DomainError(
          "knowledge_evidence_required",
          `节点 ${nodeId} 产出的知识 ${spec.id} 缺少必需证据引用`,
          422,
        );
      }
      const claimId = `${run.id}:${nodeId}:${spec.id}`;
      const record: ProducerKnowledgeRecord = {
        id: claimId,
        runId: run.id,
        nodeId,
        outputId: spec.id,
        invocationId,
        claimId,
        kind: spec.kind,
        content,
        contentDigest: digest(content),
        evidenceRefs,
        createdAt: now,
      };
      this.store.put("producer_knowledge", record);
      records.push(record);
    }
    return records;
  }

  /**
   * Revoke knowledge and propagate staleness to active runs that consumed it.
   */
  revokeAndPropagate(
    knowledgeId: string,
    reason = "knowledge_revoked",
  ): { affectedRunIds: string[]; invalidatedNodes: number } {
    return this.store.transaction(() => {
      this.assets.revokeKnowledge(knowledgeId);
      for (const claim of this.listClaims()) {
        if (claim.knowledgeId === knowledgeId) {
          this.store.put("knowledge_claim", { ...claim, lifecycle: "revoked" });
        }
      }
      const manifests = this.store.list<ResolvedContextManifest>(
        "context_manifest",
      );
      const affectedRunIds: string[] = [];
      let invalidatedNodes = 0;
      const now = new Date().toISOString();

      for (const run of this.store.list<AdaptiveRun>("adaptive_run")) {
        if (["done", "cancelled", "failed"].includes(run.status)) continue;
        let runTouched = false;
        const runManifests = manifests.filter((m) => m.runId === run.id);
        for (const node of run.plan.nodes) {
          const usedInManifest = runManifests.some(
            (m) =>
              m.nodeId === node.id &&
              m.knowledgeHits.some((hit) => hit.id === knowledgeId),
          );
          const invId = run.results[node.id]?.invocationId;
          const inv = invId
            ? this.store.get<{ knowledgeRefs?: { id: string }[] }>(
                "adaptive_invocation",
                invId,
              )
            : undefined;
          const usedInInv =
            inv?.knowledgeRefs?.some((k) => k.id === knowledgeId) ?? false;
          if (!usedInManifest && !usedInInv) continue;

          runTouched = true;
          invalidatedNodes++;
          run.resultValidity = {
            ...(run.resultValidity ?? {}),
            [node.id]: "stale",
          };
          if (invId) {
            const valRecord: ResultValidity = {
              id: `${run.id}:${node.id}:${run.planRevision}`,
              runId: run.id,
              nodeId: node.id,
              invocationId: invId,
              state: "stale",
              reasons: [`${reason}:${knowledgeId}`],
              assessedAtRevision: run.planRevision,
              updatedAt: now,
            };
            this.store.put("result_validity", valRecord);
          }
          const sideEffect = run.snapshots[node.id]?.capability.sideEffect;
          if (
            run.nodeStates[node.id] === "succeeded" &&
            !["workspace-write", "external-write"].includes(sideEffect ?? "")
          ) {
            run.nodeStates[node.id] = "pending";
            delete run.results[node.id];
          }
        }
        if (runTouched) {
          if (run.status === "awaiting_acceptance") {
            run.status = "running";
          }
          run.updatedAt = now;
          this.store.put("adaptive_run", run);
          this.store.event(run.id, "result.invalidated", {
            reason,
            knowledgeId,
          });
          affectedRunIds.push(run.id);
        }
      }
      return { affectedRunIds, invalidatedNodes };
    });
  }
}
