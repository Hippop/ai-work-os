import { randomUUID } from "node:crypto";
import {
  AssetService,
  checkSchema,
  type Capability,
  type Knowledge,
  type Profile,
} from "../adaptive/assets.js";
import { verifyArtifact } from "../adaptive/artifacts.js";
import type { AdaptiveRun, Plan } from "../adaptive/engine.js";
import { DomainError, digest, type Task } from "../domain/index.js";
import {
  getValueAtPointer,
  semanticDigest,
  setValueAtPointer,
  type KnowledgeRequirement,
  type NodeSpec,
  type ResolvedContextManifest,
  type ResourceManifest,
} from "../graph/types.js";
import type { Store } from "../persistence/index.js";
import {
  KnowledgeCurationService,
  type ProducerKnowledgeRecord,
} from "./knowledge-governance.js";

export const CONTEXT_ASSEMBLER_VERSION = "v3.1.0";
export const DEFAULT_MAX_CONTEXT_CHARS = 32000;

export function knowledgeVersionDigest(knowledge: Knowledge): string {
  return semanticDigest({
    id: knowledge.id,
    version: knowledge.version,
    content: knowledge.content,
    scope: knowledge.scope,
    projectId: knowledge.projectId ?? null,
    taskId: knowledge.taskId ?? null,
    capabilityNames: [...(knowledge.capabilityNames ?? [])].sort(),
  });
}

export type AssembleContextParams = {
  run: AdaptiveRun & {
    nodeSpecs?: NodeSpec[];
    resourceManifest?: ResourceManifest;
    contextMode?: "contract-v3" | "legacy-ancestors";
  };
  node: Plan["nodes"][number];
  nodeSpec?: NodeSpec;
  capability: Capability;
  profileRef: string | null;
  profile: Profile;
  skillInstructions: AdaptiveRun["snapshots"][string]["skillInstructions"];
  task: Task;
  invocationId: string;
  workspaceDir: string;
  workspaceDigest: string;
  effectiveConfig?: Record<string, unknown>;
  maxContextChars?: number;
};

export type AssembledKnowledgeEntry = Knowledge & {
  digest: string;
  requirementId?: string;
  reason?: string;
};

export type AssembleContextResult = {
  resolvedInputs: Record<string, unknown>;
  knowledge: AssembledKnowledgeEntry[];
  manifest: ResolvedContextManifest;
};

function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStringValues(v, out);
    }
  }
  return out;
}

function matchesQuery(knowledge: Knowledge, query: string): boolean {
  const tokens = query
    .toLowerCase()
    .split(/[\s,，;；]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return true;
  const haystack = [
    knowledge.name,
    knowledge.title,
    knowledge.content,
    ...(knowledge.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return tokens.some((tok) => haystack.includes(tok));
}

function matchesScopeRefs(knowledge: Knowledge, scopeRefs: string[]): boolean {
  if (!scopeRefs.length) return true;
  return scopeRefs.some((ref) => {
    if (ref === knowledge.id || ref === knowledge.name || ref === knowledge.scope) {
      return true;
    }
    if (ref.startsWith("project:") && knowledge.projectId === ref.slice(8)) {
      return true;
    }
    if (ref.startsWith("task:") && knowledge.taskId === ref.slice(5)) {
      return true;
    }
    if (
      ref.startsWith("capability:") &&
      knowledge.capabilityNames.includes(ref.slice(11))
    ) {
      return true;
    }
    return false;
  });
}

export class ContextAssembler {
  private assets: AssetService;
  private curation: KnowledgeCurationService;

  constructor(private store: Store) {
    this.assets = new AssetService(store);
    this.curation = new KnowledgeCurationService(store);
  }

  assemble(params: AssembleContextParams): AssembleContextResult {
    const {
      run,
      node,
      nodeSpec,
      capability,
      profileRef,
      profile,
      skillInstructions,
      task,
      invocationId,
      workspaceDir,
      workspaceDigest,
      effectiveConfig = {},
      maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
    } = params;

    const resolvedInputs: Record<string, unknown> = structuredClone(
      nodeSpec?.literals ?? node.inputs ?? {},
    );
    const bindingSources: ResolvedContextManifest["bindingSources"] = [];
    const omissions: ResolvedContextManifest["omissions"] = [];
    const referencedSourceNodes = new Set<string>();

    if (nodeSpec) {
      for (const binding of nodeSpec.bindings) {
        referencedSourceNodes.add(binding.source.nodeId);
        const upstreamState = run.nodeStates[binding.source.nodeId];
        if (upstreamState === "skipped") {
          if (binding.missing === "use-default") {
            const val = structuredClone(binding.defaultValue);
            setValueAtPointer(resolvedInputs, binding.target, val);
            bindingSources.push({
              target: binding.target,
              fromNode: binding.source.nodeId,
              pointer: `${binding.source.pointer}#default`,
              digest: semanticDigest(val),
            });
            continue;
          }
          if (binding.missing === "omit" && !binding.required) {
            omissions.push({
              kind: "binding",
              id: binding.id,
              reason: "upstream_skipped_omitted",
            });
            continue;
          }
          throw new DomainError(
            "binding_input_unavailable",
            `节点 ${node.id} 的必需绑定 ${binding.id} 来源于已跳过节点 ${binding.source.nodeId}`,
            422,
          );
        }

        const upstreamOutput = run.results[binding.source.nodeId]?.output;
        const lookup = getValueAtPointer(upstreamOutput, binding.source.pointer);
        if (!lookup.found) {
          if (binding.missing === "use-default") {
            const val = structuredClone(binding.defaultValue);
            setValueAtPointer(resolvedInputs, binding.target, val);
            bindingSources.push({
              target: binding.target,
              fromNode: binding.source.nodeId,
              pointer: `${binding.source.pointer}#default`,
              digest: semanticDigest(val),
            });
            continue;
          }
          if (binding.missing === "omit" && !binding.required) {
            omissions.push({
              kind: "binding",
              id: binding.id,
              reason: "upstream_field_missing_omitted",
            });
            continue;
          }
          throw new DomainError(
            "binding_value_missing",
            `上游节点 ${binding.source.nodeId} 未产出绑定字段 ${binding.source.pointer}`,
            422,
          );
        }

        const cloned = structuredClone(lookup.value);
        setValueAtPointer(resolvedInputs, binding.target, cloned);
        bindingSources.push({
          target: binding.target,
          fromNode: binding.source.nodeId,
          pointer: binding.source.pointer,
          digest: semanticDigest(cloned),
        });
      }
    } else {
      for (const [field, binding] of Object.entries(node.bindings)) {
        referencedSourceNodes.add(binding.fromNode);
        const upstreamOutput = run.results[binding.fromNode]?.output as
          | Record<string, unknown>
          | undefined;
        if (!upstreamOutput || !(binding.field in upstreamOutput)) {
          throw new DomainError(
            "binding_value_missing",
            `上游节点 ${binding.fromNode} 未产出字段 ${binding.field}`,
            422,
          );
        }
        const cloned = structuredClone(upstreamOutput[binding.field]);
        resolvedInputs[field] = cloned;
        bindingSources.push({
          target: `/${field}`,
          fromNode: binding.fromNode,
          pointer: `/${binding.field}`,
          digest: semanticDigest(cloned),
        });
      }
    }

    // Validate resolved inputs against frozen capability inputSchema
    try {
      checkSchema(capability.inputSchema, resolvedInputs);
    } catch (error) {
      if (error instanceof DomainError) {
        throw new DomainError(
          "input_schema_mismatch",
          `节点 ${node.id} 输入不满足能力契约: ${error.message}`,
          error.status >= 400 ? error.status : 422,
        );
      }
      throw new DomainError(
        "input_schema_mismatch",
        `节点 ${node.id} 输入不满足能力契约`,
        422,
      );
    }

    // Verify all referenced upstream artifacts fail-closed against tampered or missing files (A22)
    const artifactInputs: ResolvedContextManifest["artifactInputs"] = [];
    const seenArtifacts = new Set<string>();
    const inputStrings = new Set(collectStringValues(resolvedInputs));
    const nodesToVerifyArtifacts = new Set<string>([
      ...referencedSourceNodes,
      ...node.dependsOn,
    ]);
    for (const sourceNodeId of nodesToVerifyArtifacts) {
      const upstreamResult = run.results[sourceNodeId];
      if (!upstreamResult) continue;
      const digestsMap = upstreamResult.artifactDigests ?? {};
      const shouldVerifyAll = referencedSourceNodes.has(sourceNodeId);
      for (const ref of upstreamResult.artifactRefs) {
        if (!shouldVerifyAll && !inputStrings.has(ref)) continue;
        if (seenArtifacts.has(ref)) continue;
        seenArtifacts.add(ref);
        const expectedDigest = digestsMap[ref];
        if (!expectedDigest) {
          throw new DomainError(
            "artifact_changed",
            `上游工件 ${ref} 缺少完整性摘要记录，拒绝注入上下文`,
            422,
          );
        }
        try {
          verifyArtifact(ref, expectedDigest);
        } catch (error) {
          if (error instanceof DomainError) {
            throw new DomainError(
              "artifact_changed",
              error.message,
              error.status >= 400 ? error.status : 422,
            );
          }
          throw new DomainError(
            "artifact_changed",
            `上游工件校验失败: ${ref}`,
            422,
          );
        }
        artifactInputs.push({ ref, digest: expectedDigest });
      }
    }

    // Resolve knowledge requirements with live revocation, scope, producer-output, and conflict checks
    const allClaims = this.curation.listClaims();
    const claimByKnowledgeId = new Map(allClaims.map((c) => [c.knowledgeId, c]));
    const selectedEntries: Array<{
      item: AssembledKnowledgeEntry;
      required: boolean;
      digest: string;
    }> = [];
    const seenKnowledgeIds = new Set<string>();

    const assertKnowledgeUsable = (
      knowledge: Knowledge,
      req: KnowledgeRequirement,
    ) => {
      if (knowledge.status === "revoked") {
        throw new DomainError(
          "knowledge_revoked",
          `知识 ${knowledge.id} 已被撤销，阻断节点 ${node.id} 调度`,
          422,
        );
      }
      if (knowledge.status !== "published") {
        throw new DomainError(
          "knowledge_not_published",
          `知识 ${knowledge.id} 尚未发布 (${knowledge.status})，不能用于执行`,
          422,
        );
      }
      if (
        !this.assets.accessible(
          knowledge,
          task.projectId,
          task.id,
          capability.name,
        )
      ) {
        throw new DomainError(
          "knowledge_scope_denied",
          `知识 ${knowledge.id} 不在当前项目/任务/能力作用域内`,
          403,
        );
      }
      const claim = claimByKnowledgeId.get(knowledge.id);
      const claimKind = claim?.kind ?? "pattern";
      if (!req.acceptedKinds.includes(claimKind)) {
        throw new DomainError(
          "knowledge_kind_mismatch",
          `知识 ${knowledge.id} 类型为 ${claimKind}，不符合节点需求 ${req.id} (${req.acceptedKinds.join(",")})`,
          422,
        );
      }
    };

    const requirements = nodeSpec?.knowledgeInputs ?? [];
    for (const req of requirements) {
      if (req.source.kind === "pinned") {
        let knowledge: Knowledge;
        try {
          knowledge = this.assets.getKnowledge(req.source.ref.id);
        } catch {
          throw new DomainError(
            "knowledge_missing",
            `固定引用的知识 ${req.source.ref.id} 不存在`,
            422,
          );
        }
        assertKnowledgeUsable(knowledge, req);
        const contentHash = digest(knowledge.content);
        const fullDigest = knowledgeVersionDigest(knowledge);
        if (
          knowledge.version !== req.source.ref.version ||
          (req.source.ref.digest !== fullDigest &&
            req.source.ref.digest !== contentHash)
        ) {
          throw new DomainError(
            "knowledge_digest_mismatch",
            `固定知识 ${knowledge.id} 版本或内容摘要与计划快照不一致`,
            422,
          );
        }
        if (!seenKnowledgeIds.has(knowledge.id)) {
          seenKnowledgeIds.add(knowledge.id);
          selectedEntries.push({
            item: {
              ...knowledge,
              digest: contentHash,
              requirementId: req.id,
              reason: `pinned:${req.purpose}`,
            },
            required: req.required,
            digest: req.source.ref.digest,
          });
        }
      } else if (req.source.kind === "query") {
        const candidates = this.assets
          .listKnowledge()
          .filter(
            (k) =>
              k.status === "published" &&
              this.assets.accessible(
                k,
                task.projectId,
                task.id,
                capability.name,
              ) &&
              matchesQuery(k, req.source.kind === "query" ? req.source.query : "") &&
              matchesScopeRefs(
                k,
                req.source.kind === "query" ? req.source.scopeRefs : [],
              ) &&
              req.acceptedKinds.includes(
                claimByKnowledgeId.get(k.id)?.kind ?? "pattern",
              ),
          )
          .sort((a, b) => a.id.localeCompare(b.id));

        if (candidates.length === 0) {
          if (req.required) {
            throw new DomainError(
              "required_knowledge_missing",
              `节点 ${node.id} 缺少必需的知识查询结果 (${req.id})`,
              422,
            );
          }
          omissions.push({
            kind: "knowledge",
            id: req.id,
            reason: "query_no_match",
          });
          continue;
        }
        for (const k of candidates) {
          if (seenKnowledgeIds.has(k.id)) continue;
          seenKnowledgeIds.add(k.id);
          selectedEntries.push({
            item: {
              ...k,
              digest: digest(k.content),
              requirementId: req.id,
              reason: `query:${req.purpose}`,
            },
            required: req.required,
            digest: knowledgeVersionDigest(k),
          });
        }
      } else {
        // node-output resolved at producer completion (A09)
        const producerId = req.source.nodeId;
        if (run.nodeStates[producerId] !== "succeeded") {
          if (req.required) {
            throw new DomainError(
              "producer_knowledge_missing",
              `前置知识生产节点 ${producerId} 尚未成功完成`,
              422,
            );
          }
          omissions.push({
            kind: "knowledge",
            id: req.id,
            reason: "producer_not_succeeded",
          });
          continue;
        }
        if (run.resultValidity?.[producerId] === "invalid") {
          throw new DomainError(
            "producer_result_invalid",
            `前置知识生产节点 ${producerId} 结果已失效`,
            422,
          );
        }
        const recordKey = `${run.id}:${producerId}:${req.source.outputId}`;
        const producerRecord = this.store.get<ProducerKnowledgeRecord>(
          "producer_knowledge",
          recordKey,
        );
        if (!producerRecord) {
          if (req.required) {
            throw new DomainError(
              "producer_knowledge_missing",
              `上游节点 ${producerId} 未产出约定知识 ${req.source.outputId}`,
              422,
            );
          }
          omissions.push({
            kind: "knowledge",
            id: req.id,
            reason: "producer_output_missing",
          });
          continue;
        }
        if (!req.acceptedKinds.includes(producerRecord.kind)) {
          throw new DomainError(
            "knowledge_kind_mismatch",
            `节点产出知识 ${producerRecord.outputId} 类型 (${producerRecord.kind}) 不符合需求 ${req.id}`,
            422,
          );
        }
        const synthetic: AssembledKnowledgeEntry = {
          id: producerRecord.claimId,
          name: `node-output.${producerId}.${producerRecord.outputId}`,
          version: "1.0.0",
          title: `Node Output: ${producerId}/${producerRecord.outputId}`,
          content: producerRecord.content,
          scope: "task",
          projectId: task.projectId,
          taskId: task.id,
          capabilityNames: [capability.name],
          status: "published",
          source: `node-output:${producerRecord.invocationId}`,
          evidenceRefs: producerRecord.evidenceRefs,
          tags: [producerRecord.kind],
          digest: producerRecord.contentDigest,
          createdAt: producerRecord.createdAt,
          requirementId: req.id,
          reason: `node-output:${producerId}:${producerRecord.outputId}`,
        };
        if (!seenKnowledgeIds.has(synthetic.id)) {
          seenKnowledgeIds.add(synthetic.id);
          selectedEntries.push({
            item: synthetic,
            required: req.required,
            digest: producerRecord.contentDigest,
          });
        }
      }
    }

    // Fail closed on unresolved conflict relations among selected knowledge entries (A21)
    const selectedIds = new Set(selectedEntries.map((e) => e.item.id));
    for (const entry of selectedEntries) {
      const conflicts = this.curation.conflictsFor(entry.item.id);
      for (const rel of conflicts) {
        const partnerId =
          rel.sourceId === entry.item.id ? rel.targetId : rel.sourceId;
        if (selectedIds.has(partnerId)) {
          throw new DomainError(
            "knowledge_conflict",
            `节点 ${node.id} 存在未解决的知识冲突: ${entry.item.id} <-> ${partnerId} (${rel.reason})`,
            422,
          );
        }
      }
    }

    // Also inspect frozen run.resourceManifest.knowledge for any revoked entries referenced by this node
    if (run.resourceManifest?.knowledge && nodeSpec) {
      for (const req of nodeSpec.knowledgeInputs) {
        if (req.source.kind === "pinned" && run.resourceManifest.knowledge[req.source.ref.id]) {
          const live = this.store.get<Knowledge>(
            "adaptive_knowledge",
            req.source.ref.id,
          );
          if (live?.status === "revoked") {
            throw new DomainError(
              "knowledge_revoked",
              `知识 ${live.id} 已被撤销`,
              422,
            );
          }
        }
      }
    }

    // Enforce deterministic context budget without silently truncating required items (A10)
    const baseChars =
      task.objective.length +
      (task.acceptanceCriteria ?? []).join("\n").length +
      JSON.stringify(resolvedInputs).length +
      skillInstructions.reduce(
        (sum, s) =>
          sum +
          s.content.length +
          s.references.reduce((rSum, r) => rSum + r.content.length, 0),
        0,
      );

    const requiredEntries = selectedEntries.filter((e) => e.required);
    const optionalEntries = selectedEntries.filter((e) => !e.required);
    const requiredKnowledgeChars = requiredEntries.reduce(
      (sum, e) => sum + e.item.content.length,
      0,
    );
    if (baseChars + requiredKnowledgeChars > maxContextChars) {
      throw new DomainError(
        "context_budget_exceeded",
        `节点 ${node.id} 的必需上下文长度 (${baseChars + requiredKnowledgeChars}) 超出预算 (${maxContextChars})`,
        422,
      );
    }

    let runningChars = baseChars + requiredKnowledgeChars;
    const keptEntries = [...requiredEntries];
    for (const opt of optionalEntries) {
      const addLen = opt.item.content.length;
      if (runningChars + addLen > maxContextChars) {
        omissions.push({
          kind: "knowledge",
          id: opt.item.id,
          reason: "context_budget_omitted",
        });
        continue;
      }
      runningChars += addLen;
      keptEntries.push(opt);
    }

    const knowledgeHits: ResolvedContextManifest["knowledgeHits"] = keptEntries.map(
      (e) => ({
        id: e.item.id,
        version: e.item.version,
        digest: e.digest,
        ...(e.item.requirementId ? { requirementId: e.item.requirementId } : {}),
        reason: e.item.reason ?? "contract",
      }),
    );

    const knowledgeList = keptEntries.map((e) => e.item);
    const profileId = profileRef ?? profile.id ?? `${profile.name}@${profile.version}`;

    const manifest: ResolvedContextManifest = {
      id: randomUUID(),
      runId: run.id,
      nodeId: node.id,
      invocationId,
      planRevision: run.planRevision,
      contextMode: run.contextMode ?? "contract-v3",
      capabilityRef: {
        id: capability.id,
        version: capability.version,
        digest: semanticDigest({
          id: capability.id,
          version: capability.version,
          inputSchema: capability.inputSchema,
          outputSchema: capability.outputSchema,
          sideEffect: capability.sideEffect,
        }),
      },
      profileRef: {
        id: profileId,
        version: profile.version,
        digest: semanticDigest({
          id: profile.id,
          version: profile.version,
          executor: profile.executor,
          workspaceMode: profile.workspaceMode,
          workspaceSubdir: profile.workspaceSubdir,
        }),
      },
      skillRefs: skillInstructions.map((s) => ({
        id: s.id,
        name: s.name,
        digest: s.digest,
      })),
      resolvedInputs,
      inputDigest: semanticDigest(resolvedInputs),
      bindingSources,
      artifactInputs,
      knowledgeHits,
      taskObjectiveDigest: digest(task.objective),
      acceptanceCriteriaDigest: digest(task.acceptanceCriteria ?? []),
      cwdRef: digest(workspaceDir),
      workspaceDigest,
      effectiveConfigDigest: semanticDigest(effectiveConfig),
      omissions,
      totalChars: runningChars,
      budgetChars: maxContextChars,
      assemblerVersion: CONTEXT_ASSEMBLER_VERSION,
      assembledPromptDigest: semanticDigest({
        inputDigest: semanticDigest(resolvedInputs),
        skillRefs: skillInstructions.map((s) => s.digest),
        knowledgeHits: knowledgeHits.map((k) => k.digest),
        artifactInputs,
        taskObjectiveDigest: digest(task.objective),
      }),
      createdAt: new Date().toISOString(),
    };

    this.store.put("context_manifest", manifest);
    return {
      resolvedInputs,
      knowledge: knowledgeList,
      manifest,
    };
  }
}

export type NodeContextLookup =
  | {
      available: true;
      contextMode: "contract-v3" | "legacy-ancestors";
      manifest: ResolvedContextManifest;
    }
  | {
      available: false;
      contextMode: "contract-v3" | "legacy-ancestors";
      reason: string;
      invocationId: string | null;
    };

export function getNodeContextManifest(
  store: Store,
  runId: string,
  nodeId: string,
  invocationId?: string,
): NodeContextLookup {
  const run = store.get<
    AdaptiveRun & { schemaVersion?: number; contextMode?: "contract-v3" | "legacy-ancestors" }
  >("adaptive_run", runId);
  if (!run) {
    throw new DomainError("run_missing", "运行不存在", 404);
  }
  const nodeExists = run.plan.nodes.some((n) => n.id === nodeId);
  if (!nodeExists) {
    throw new DomainError("node_missing", `节点 ${nodeId} 不存在`, 404);
  }
  const targetInvId = invocationId ?? run.results[nodeId]?.invocationId ?? null;
  const manifests = store
    .list<ResolvedContextManifest>("context_manifest")
    .filter((m) => m.runId === runId && m.nodeId === nodeId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const matched = targetInvId
    ? manifests.find((m) => m.invocationId === targetInvId) ?? manifests[0]
    : manifests[0];

  if (matched) {
    return {
      available: true,
      contextMode: matched.contextMode,
      manifest: matched,
    };
  }

  const contextMode =
    run.contextMode ??
    (run.schemaVersion && run.schemaVersion >= 3 ? "contract-v3" : "legacy-ancestors");
  if (contextMode === "legacy-ancestors") {
    return {
      available: false,
      contextMode: "legacy-ancestors",
      reason:
        "该运行为历史 V2 运行（contextMode=legacy-ancestors），未记录 V3 上下文装配清单，系统不会事后伪造依赖视图。",
      invocationId: targetInvId,
    };
  }
  return {
    available: false,
    contextMode: "contract-v3",
    reason: "节点尚未调度执行或尚无匹配的调用记录。",
    invocationId: targetInvId,
  };
}
