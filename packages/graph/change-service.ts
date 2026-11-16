import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AssetService,
  type Capability,
  type Profile,
} from "../adaptive/assets.js";
import type { AdaptiveRun, Plan } from "../adaptive/engine.js";
import { DomainError, digest, type Task } from "../domain/index.js";
import { ExternalSkillService } from "../external-skills/index.js";
import type { Store } from "../persistence/index.js";
import { GraphCompiler } from "./compiler.js";
import {
  DraftOperationSchema,
  applyDraftOperationToGraph,
} from "./draft-service.js";
import {
  ImpactAnalyzer,
  computeRunBaseStateDigest,
  persistValidityRecords,
} from "./impact.js";
import {
  NodeSpecSchema,
  ObservationSpecSchema,
  semanticDigest,
  type AgentSession,
  type ChangeProposal,
  type EffectRecord,
  type InterventionRecord,
  type NodeSpec,
  type ResourceManifest,
  type ResultValidity,
} from "./types.js";

const ProposalPatchSchema = z.union([
  z
    .object({
      operations: z.array(DraftOperationSchema).min(1).max(100),
      goal: z.string().trim().min(1).max(20000).optional(),
    })
    .strict(),
  z
    .object({
      nodes: z.array(NodeSpecSchema).min(1).max(30),
      observations: z.array(ObservationSpecSchema).max(20).optional(),
      goal: z.string().trim().min(1).max(20000).optional(),
    })
    .strict(),
]);

const CreateProposalInput = z
  .object({
    expectedRevision: z.number().int().positive(),
    instruction: z.string().trim().min(1).max(10000).optional(),
    patch: ProposalPatchSchema.optional(),
    budgetDeltaUsd: z.number().finite().min(-100000).max(100000).default(0),
  })
  .strict()
  .refine((v) => v.instruction !== undefined || v.patch !== undefined, {
    message: "instruction 或 patch 至少需提供一项",
  });

const CommitProposalInput = z
  .object({
    expectedRunRevision: z.number().int().positive(),
    proposalDigest: z.string().min(8).max(128),
  })
  .strict();

export type ChangeComposeHook = (args: {
  run: AdaptiveRun;
  baseNodeSpecs: NodeSpec[];
  instruction: string;
}) => Promise<{
  nodes: NodeSpec[];
  observations?: z.infer<typeof ObservationSpecSchema>[];
}>;

type RunV3Extended = AdaptiveRun & {
  schemaVersion?: number;
  nodeSpecs?: NodeSpec[];
  resourceManifest?: ResourceManifest;
  dispatchGate?: "open" | "paused" | "intervention" | "change_pending" | "reconciling";
  resultValidity?: Record<string, ResultValidity["state"]>;
};

export class PlanChangeService {
  private compiler: GraphCompiler;
  private impact: ImpactAnalyzer;
  private assets: AssetService;

  constructor(private store: Store) {
    this.compiler = new GraphCompiler(store);
    this.impact = new ImpactAnalyzer(store);
    this.assets = new AssetService(store);
  }

  private currentNodeSpecs(run: RunV3Extended): NodeSpec[] {
    if (run.nodeSpecs && run.nodeSpecs.length > 0) {
      return structuredClone(run.nodeSpecs);
    }
    return run.plan.nodes.map((n) => {
      const snapCap = run.snapshots[n.id]?.capability;
      const snapProfile = run.snapshots[n.id]?.profile;
      return {
        id: n.id,
        engineKey: n.id,
        capabilityRef: {
          id: snapCap?.id ?? n.capabilityRef,
          version: snapCap?.version ?? "1.0.0",
          digest: semanticDigest({
            id: snapCap?.id ?? n.capabilityRef,
            version: snapCap?.version ?? "1.0.0",
          }),
        },
        profileRef: snapProfile
          ? {
              id: snapProfile.id,
              version: snapProfile.version,
              digest: semanticDigest({
                id: snapProfile.id,
                version: snapProfile.version,
              }),
            }
          : null,
        literals: structuredClone(n.inputs ?? {}),
        bindings: Object.entries(n.bindings ?? {}).map(([target, b]) => ({
          id: `legacy-${target}`,
          target: `/${target}`,
          source: { nodeId: b.fromNode, pointer: `/${b.field}` },
          required: true,
          missing: "block" as const,
        })),
        dependsOn: [...(n.dependsOn ?? [])],
        ...(n.condition
          ? {
              condition: {
                fromNode: n.condition.fromNode,
                pointer: "/" + n.condition.field,
                equals: n.condition.equals,
              },
            }
          : {}),
        knowledgeInputs: [],
        knowledgeOutputs: [],
        workspace: { policy: "run-shared" as const, subdir: "." },
      };
    });
  }

  async createProposal(
    runId: string,
    input: unknown,
    composeHook?: ChangeComposeHook,
  ): Promise<{ operationId: string; proposal: ChangeProposal }> {
    const data = CreateProposalInput.parse(input);
    const run = this.store.get<RunV3Extended>("adaptive_run", runId);
    if (!run) {
      throw new DomainError("run_missing", "运行不存在", 404);
    }
    if (["done", "cancelled"].includes(run.status)) {
      throw new DomainError(
        "run_terminal",
        `终态运行 (${run.status}) 不再接受变更提案`,
        409,
      );
    }
    if (run.planRevision !== data.expectedRevision) {
      const err = new DomainError(
        "revision_conflict",
        `运行版本冲突，期望 planRevision=${data.expectedRevision}，当前为 ${run.planRevision}`,
        409,
      ) as DomainError & { currentRevision?: number };
      err.currentRevision = run.planRevision;
      throw err;
    }

    const task = this.store.get<Task>("task", run.taskId);
    if (!task) {
      throw new DomainError("task_missing", "运行关联的任务不存在", 404);
    }

    const baseNodeSpecs = this.currentNodeSpecs(run);
    let nextNodeSpecs = structuredClone(baseNodeSpecs);
    let nextObservations = structuredClone(run.plan.observations);
    let nextGoal = run.plan.rationale || task.objective;

    if (data.patch) {
      if ("operations" in data.patch) {
        const mutableGraph = {
          nodes: nextNodeSpecs,
          gaps: [],
          observations: nextObservations,
        };
        for (const op of data.patch.operations) {
          applyDraftOperationToGraph(mutableGraph, op);
        }
        nextNodeSpecs = mutableGraph.nodes;
        nextObservations = mutableGraph.observations;
        if (data.patch.goal !== undefined) nextGoal = data.patch.goal;
      } else {
        nextNodeSpecs = structuredClone(data.patch.nodes);
        if (data.patch.observations !== undefined) {
          nextObservations = structuredClone(data.patch.observations);
        }
        if (data.patch.goal !== undefined) nextGoal = data.patch.goal;
      }
    } else if (data.instruction && composeHook) {
      const composed = await composeHook({
        run,
        baseNodeSpecs,
        instruction: data.instruction,
      });
      nextNodeSpecs = structuredClone(composed.nodes);
      if (composed.observations !== undefined) {
        nextObservations = structuredClone(composed.observations);
      }
    }

    const compiled = this.compiler.compileNodes({
      goal: nextGoal,
      nodes: nextNodeSpecs,
      gaps: [],
      observations: nextObservations,
      projectId: task.projectId,
      taskId: task.id,
    });

    if (!compiled.ok || !compiled.executablePlan) {
      const err = new DomainError(
        "compile_failed",
        `变更提案编译失败: ${compiled.diagnostics.map((d) => d.message).join("; ")}`,
        422,
      ) as DomainError & { details?: Record<string, unknown> };
      err.details = { diagnostics: compiled.diagnostics };
      throw err;
    }

    const impactResult = this.impact.analyze({
      run,
      nextNodeSpecs: compiled.nodeSpecs,
    });
    if (impactResult.blockingErrors.length > 0) {
      const err = new DomainError(
        "write_replan_unsafe",
        impactResult.blockingErrors.join("; "),
        409,
      ) as DomainError & { details?: Record<string, unknown> };
      err.details = {
        blockingErrors: impactResult.blockingErrors,
        impact: impactResult.items,
      };
      throw err;
    }

    const baseStateDigest = computeRunBaseStateDigest(this.store, run);
    const approvalDigest = semanticDigest({
      runId: run.id,
      baseRevision: run.planRevision,
      baseStateDigest,
      nextNodeSpecs: compiled.nodeSpecs,
      nextPlan: compiled.executablePlan,
      impact: impactResult.items,
      requiredActions: impactResult.requiredActions,
    });

    const proposal: ChangeProposal = {
      id: randomUUID(),
      runId: run.id,
      baseRevision: run.planRevision,
      baseStateDigest,
      ...(data.instruction ? { instruction: data.instruction } : {}),
      nextPlan: compiled.executablePlan,
      nextNodeSpecs: compiled.nodeSpecs,
      diff: impactResult.diff,
      impact: impactResult.items,
      requiredActions: impactResult.requiredActions,
      budgetDeltaUsd: data.budgetDeltaUsd,
      approvalDigest,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.store.transaction(() => {
      this.store.put("plan_change", proposal);
      this.store.event(
        run.id,
        "change.proposed",
        {
          proposalId: proposal.id,
          baseRevision: proposal.baseRevision,
          approvalDigest: proposal.approvalDigest,
          diff: proposal.diff,
          impactCount: proposal.impact.filter((i) => i.action !== "keep").length,
        },
        "user",
        { planRevision: run.planRevision },
      );
    });

    return { operationId: proposal.id, proposal };
  }

  getProposal(id: string): ChangeProposal {
    const proposal = this.store.get<ChangeProposal>("plan_change", id);
    if (!proposal) {
      throw new DomainError("proposal_missing", "变更提案不存在", 404);
    }
    return proposal;
  }

  listProposals(runId: string): ChangeProposal[] {
    return this.store
      .list<ChangeProposal>("plan_change")
      .filter((p) => p.runId === runId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  commitProposal(
    proposalId: string,
    input: unknown,
    options: { wake?: () => void } = {},
  ): { run: RunV3Extended; proposal: ChangeProposal } {
    const data = CommitProposalInput.parse(input);
    const result = this.store.transaction(() => {
      const proposal = this.getProposal(proposalId);
      if (proposal.status !== "pending") {
        throw new DomainError(
          "proposal_not_pending",
          `变更提案状态为 ${proposal.status}，无法提交`,
          409,
        );
      }
      if (proposal.approvalDigest !== data.proposalDigest) {
        throw new DomainError(
          "proposal_digest_mismatch",
          "变更提案摘要与批准内容不一致",
          409,
        );
      }

      const run = this.store.get<RunV3Extended>("adaptive_run", proposal.runId);
      if (!run) {
        throw new DomainError("run_missing", "运行不存在", 404);
      }
      if (run.planRevision !== data.expectedRunRevision || run.planRevision !== proposal.baseRevision) {
        const err = new DomainError(
          "revision_conflict",
          `运行版本已推进至 planRevision=${run.planRevision}，提案基于 revision=${proposal.baseRevision}`,
          409,
        ) as DomainError & { currentRevision?: number };
        err.currentRevision = run.planRevision;
        throw err;
      }

      // A15: Reject commit if execution state advanced since proposal generation
      const liveStateDigest = computeRunBaseStateDigest(this.store, run);
      if (liveStateDigest !== proposal.baseStateDigest) {
        const err = new DomainError(
          "proposal_stale",
          "运行节点或副作用状态已在提案审批期间发生变化，请重新生成变更提案",
          409,
        ) as DomainError & { currentRevision?: number };
        err.currentRevision = run.planRevision;
        throw err;
      }

      const hasActiveNodes = Object.values(run.nodeStates).some((s) =>
        ["running", "waiting"].includes(s),
      );
      if (hasActiveNodes) {
        throw new DomainError(
          "active_invocations_present",
          "存在正在运行或等待中的节点，请在节点暂停后提交变更",
          409,
        );
      }

      const hasUncertainEffects = this.store
        .list<EffectRecord>("effect_record")
        .some((e) => e.runId === run.id && e.state === "uncertain");
      if (hasUncertainEffects) {
        throw new DomainError(
          "uncertain_effects_present",
          "存在尚未核对的 uncertain 副作用，必须先完成人工核对后方可变更图",
          409,
        );
      }

      const hasLiveSessions = this.store
        .list<AgentSession>("agent_session")
        .some(
          (s) =>
            s.runId === run.id &&
            ["creating", "running", "stop-unconfirmed"].includes(s.processState),
        );
      if (hasLiveSessions) {
        throw new DomainError(
          "active_session_present",
          "存在尚未停止的交互终端会话，不能在会话运行期间提交图结构变更",
          409,
        );
      }

      const pendingInterventions = this.store
        .list<InterventionRecord>("intervention")
        .some((iv) => iv.runId === run.id && iv.reviewState === "pending");
      if (pendingInterventions) {
        throw new DomainError(
          "pending_intervention_present",
          "存在未采纳/未放弃的人工干预记录，请先处理后再提交图变更",
          409,
        );
      }

      // Re-verify protected effects right before commit
      const liveImpact = this.impact.analyze({
        run,
        nextNodeSpecs: proposal.nextNodeSpecs,
      });
      if (liveImpact.blockingErrors.length > 0) {
        throw new DomainError(
          "write_replan_unsafe",
          liveImpact.blockingErrors.join("; "),
          409,
        );
      }

      const nextPlan = structuredClone(proposal.nextPlan) as Plan;
      const allProfiles = this.store.list<Profile>("adaptive_profile");
      const nextSnapshots: AdaptiveRun["snapshots"] = {};

      for (const spec of proposal.nextNodeSpecs) {
        const cap = this.assets.getCapability(spec.capabilityRef.id);
        if (cap.status !== "published") {
          throw new DomainError(
            "capability_not_published",
            `能力 ${cap.id} 已不可用 (${cap.status})`,
            422,
          );
        }
        const profile = spec.profileRef?.id
          ? this.assets.getProfile(spec.profileRef.id)
          : (cap.profileRef
              ? allProfiles.find(
                  (p) =>
                    (p.id === cap.profileRef ||
                      `${p.name}@${p.version}` === cap.profileRef ||
                      p.name === cap.profileRef) &&
                    p.status === "published",
                )
              : undefined) ?? allProfiles.find((p) => p.status === "published");
        if (!profile) {
          throw new DomainError(
            "profile_missing",
            `节点 ${spec.id} 缺少已发布执行档案`,
            422,
          );
        }
        const skillIds = [
          ...new Set([
            ...(profile.skillIds ?? []),
            ...(cap.sourceSkillId ? [cap.sourceSkillId] : []),
          ]),
        ];
        let skillInstructions: AdaptiveRun["snapshots"][string]["skillInstructions"] =
          [];
        if (skillIds.length) {
          try {
            skillInstructions = new ExternalSkillService(this.store)
              .snapshot(skillIds)
              .map((s) => ({
                id: s.id,
                name: s.name,
                content: s.content,
                digest: s.contentDigest,
                references: s.referenceFiles,
              }));
          } catch {
            skillInstructions = [];
          }
        }
        nextSnapshots[spec.engineKey] = {
          capability: cap,
          profileRef: profile.id,
          profile,
          skillInstructions,
        };
      }

      const nextNodeStates: AdaptiveRun["nodeStates"] = {};
      const nextResults: AdaptiveRun["results"] = {};
      const nextFailures: AdaptiveRun["failures"] = {};
      const nextValidity: Record<string, ResultValidity["state"]> = {};
      const reasonsByKey: Record<string, string[]> = {};

      for (const item of proposal.impact) {
        if (item.action === "remove") continue;
        const key = item.engineKey;
        reasonsByKey[key] = item.reasons;
        if (item.action === "keep") {
          nextNodeStates[key] = run.nodeStates[key] ?? "pending";
          if (run.results[key]) nextResults[key] = run.results[key];
          if (run.failures[key]) nextFailures[key] = run.failures[key];
          nextValidity[key] =
            run.nodeStates[key] === "succeeded" ? "valid" : item.validityAfter;
        } else {
          // invalidate / add / modify -> schedule cleanly as pending with stale marker
          nextNodeStates[key] = "pending";
          nextValidity[key] = "stale";
        }
      }

      const nextObsStates: AdaptiveRun["observationStates"] = {};
      for (const obs of nextPlan.observations) {
        const prevObs = run.observationStates[obs.id];
        const targetImpact = proposal.impact.find(
          (i) => i.engineKey === obs.afterNode,
        );
        nextObsStates[obs.id] =
          prevObs && targetImpact?.action === "keep" ? prevObs : "pending";
      }

      const now = new Date().toISOString();
      this.store.put("adaptive_plan_revision", {
        id: `${run.id}:${run.planRevision}`,
        runId: run.id,
        number: run.planRevision,
        plan: structuredClone(run.plan),
        states: structuredClone(run.nodeStates),
        results: structuredClone(run.results),
        snapshots: structuredClone(run.snapshots),
        digest: digest(run.plan),
        reason: proposal.instruction || "before_change_proposal",
        createdAt: run.updatedAt,
      });
      run.plan = nextPlan as AdaptiveRun["plan"];
      run.nodeSpecs = structuredClone(proposal.nextNodeSpecs);
      run.snapshots = nextSnapshots;
      run.nodeStates = nextNodeStates;
      run.observationStates = nextObsStates;
      run.results = nextResults;
      run.failures = nextFailures;
      run.resultValidity = nextValidity;
      run.planRevision += 1;
      run.revisionCount += 1;
      if (proposal.budgetDeltaUsd !== 0) {
        run.budgetUsd = (run.budgetUsd ?? 0) + proposal.budgetDeltaUsd;
      }
      if (
        run.status === "awaiting_acceptance" ||
        run.status === "failed"
      ) {
        const hasPending = Object.values(nextNodeStates).some(
          (s) => s === "pending",
        );
        if (hasPending) run.status = "running";
      }
      if (run.dispatchGate === "change_pending") {
        run.dispatchGate = "open";
      }
      run.updatedAt = now;

      this.store.put("adaptive_run", run);
      this.store.put("adaptive_plan_revision", {
        id: `${run.id}:${run.planRevision}`,
        runId: run.id,
        number: run.planRevision,
        plan: structuredClone(run.plan),
        digest: digest(run.plan),
        reason: proposal.instruction || `change_proposal:${proposal.id}`,
        createdAt: now,
      });
      persistValidityRecords(this.store, run, nextValidity, reasonsByKey);

      const committed: ChangeProposal = {
        ...proposal,
        status: "committed",
        committedAt: now,
      };
      this.store.put("plan_change", committed);

      for (const other of this.listProposals(run.id)) {
        if (other.id !== committed.id && other.status === "pending") {
          this.store.put("plan_change", { ...other, status: "superseded" });
        }
      }

      this.store.event(
        run.id,
        "change.committed",
        {
          proposalId: committed.id,
          planRevision: run.planRevision,
          invalidatedNodes: proposal.impact
            .filter((i) => i.action !== "keep")
            .map((i) => i.engineKey),
        },
        "user",
        { correlationId: committed.id, planRevision: run.planRevision },
      );

      return { run, proposal: committed };
    });

    if (["queued", "running"].includes(result.run.status)) {
      options.wake?.();
    }
    return result;
  }
}
