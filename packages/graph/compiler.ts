import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AssetService,
  checkSchema,
  type Capability,
  type Knowledge,
  type Profile,
} from "../adaptive/assets.js";
import type { AdaptiveRun, Plan } from "../adaptive/engine.js";
import { knowledgeVersionDigest } from "../context/assembler.js";
import { KnowledgeCurationService } from "../context/knowledge-governance.js";
import { DomainError, digest, type Task } from "../domain/index.js";
import { ExternalSkillService } from "../external-skills/index.js";
import type { Store } from "../persistence/index.js";
import { GraphDraftService } from "./draft-service.js";
import {
  parseJsonPointer,
  resolveSchemaAtPointer,
  semanticDigest,
  type CompiledPlan,
  type CompilerDiagnostic,
  type NodeSpec,
  type ObservationSpecSchema,
  type PlanDraft,
  type PlanGap,
  type ResourceManifest,
  type VersionRef,
} from "./types.js";

export const COMPILER_VERSION = "v3.1.0";
export const MAX_DRAFT_NODES = 30;
export const MAX_DRAFT_OBSERVATIONS = 20;

export function capabilityVersionDigest(cap: Capability): string {
  return semanticDigest({
    id: cap.id,
    version: cap.version,
    inputSchema: cap.inputSchema,
    outputSchema: cap.outputSchema,
    sideEffect: cap.sideEffect,
  });
}

export function profileVersionDigest(profile: Profile): string {
  return semanticDigest({
    id: profile.id,
    version: profile.version,
    executor: profile.executor,
    workspaceMode: profile.workspaceMode,
    workspaceSubdir: profile.workspaceSubdir,
    skillIds: [...(profile.skillIds ?? [])].sort(),
  });
}

function collectSkillInstructions(
  store: Store,
  cap: Capability,
  profile: Profile | null,
): AdaptiveRun["snapshots"][string]["skillInstructions"] {
  const skillIds = [
    ...new Set([
      ...(profile?.skillIds ?? []),
      ...(cap.sourceSkillId ? [cap.sourceSkillId] : []),
    ]),
  ];
  if (!skillIds.length) return [];
  try {
    return new ExternalSkillService(store).snapshot(skillIds).map((s) => ({
      id: s.id,
      name: s.name,
      content: s.content,
      digest: s.contentDigest,
      references: s.referenceFiles,
    }));
  } catch {
    return [];
  }
}

function readOptionalDigest(entity: unknown): string | undefined {
  if (
    entity &&
    typeof entity === "object" &&
    "digest" in entity &&
    typeof (entity as { digest?: unknown }).digest === "string"
  ) {
    return (entity as { digest: string }).digest;
  }
  return undefined;
}

function isDeliverCapability(cap: Capability): boolean {
  return (
    cap.name === "core.builtin.deliver" ||
    cap.name === "core.conclude" ||
    cap.name.endsWith(".deliver")
  );
}

function isTestCapability(cap: Capability, node: NodeSpec): boolean {
  return (
    cap.name === "core.project.test" ||
    cap.name.endsWith(".test") ||
    node.engineKey.includes("test")
  );
}

function areJsonSchemasCompatible(
  srcSchema: Record<string, unknown>,
  tgtSchema: Record<string, unknown>,
): boolean {
  const srcType = srcSchema.type;
  const tgtType = tgtSchema.type;
  if (srcType !== undefined && tgtType !== undefined) {
    const srcTypes = Array.isArray(srcType) ? srcType.map(String) : [String(srcType)];
    const tgtTypes = Array.isArray(tgtType) ? tgtType.map(String) : [String(tgtType)];
    const ok = srcTypes.some(
      (st) =>
        tgtTypes.includes(st) || (st === "integer" && tgtTypes.includes("number")),
    );
    if (!ok) return false;
  }
  if (Array.isArray(srcSchema.enum) && Array.isArray(tgtSchema.enum)) {
    const overlap = srcSchema.enum.some((v) =>
      (tgtSchema.enum as unknown[]).some(
        (tv) => semanticDigest(v) === semanticDigest(tv),
      ),
    );
    if (!overlap) return false;
  }
  return true;
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

export type NodeCompileInput = {
  goal: string;
  nodes: NodeSpec[];
  gaps?: PlanGap[];
  observations?: z.infer<typeof ObservationSpecSchema>[];
  projectId: string | null;
  taskId: string | null;
};

export type CompileNodesResult = {
  ok: boolean;
  executablePlan: Plan | null;
  nodeSpecs: NodeSpec[];
  resourceManifest: ResourceManifest;
  pendingProducerBindings: string[];
  diagnostics: CompilerDiagnostic[];
  semanticDigest: string | null;
};

export function findNodeSpecByAnyId(
  nodeSpecs: NodeSpec[],
  idOrKey: string,
): NodeSpec | undefined {
  return nodeSpecs.find((n) => n.id === idOrKey || n.engineKey === idOrKey);
}

export function resolveRunNodeKey(
  run: Pick<AdaptiveRun, "plan"> & { nodeSpecs?: NodeSpec[] },
  idOrKey: string,
): { nodeSpec?: NodeSpec; engineKey: string } | undefined {
  if (run.nodeSpecs) {
    const spec = findNodeSpecByAnyId(run.nodeSpecs, idOrKey);
    if (spec) {
      return { nodeSpec: spec, engineKey: spec.engineKey };
    }
  }
  const node = run.plan.nodes.find((n) => n.id === idOrKey);
  if (node) {
    return { engineKey: node.id };
  }
  return undefined;
}

const StartCompiledInput = z
  .object({
    expectedRevision: z.number().int().positive(),
    compiledDigest: z.string().min(8).max(128),
    budgetUsd: z.number().positive().max(100000).nullable().optional(),
  })
  .strict();

export class GraphCompiler {
  private assets: AssetService;
  private curation: KnowledgeCurationService;
  private drafts: GraphDraftService;

  constructor(private store: Store) {
    this.assets = new AssetService(store);
    this.curation = new KnowledgeCurationService(store);
    this.drafts = new GraphDraftService(store);
  }

  compileNodes(input: NodeCompileInput): CompileNodesResult {
    const diagnostics: CompilerDiagnostic[] = [];
    const resourceManifest: ResourceManifest = {
      capabilities: {},
      profiles: {},
      skills: {},
      knowledge: {},
    };
    const pendingProducerBindings: string[] = [];

    const addDiag = (diag: CompilerDiagnostic) => {
      diagnostics.push(diag);
    };

    const nodes = input.nodes;
    const gaps = input.gaps ?? [];
    const observations = input.observations ?? [];

    // Step 1: Structure & scale checks
    if (nodes.length === 0) {
      addDiag({
        code: "empty_plan",
        severity: "error",
        message: "方案至少需要包含一个可执行节点",
        suggestedActions: ["add_node"],
      });
    }
    if (nodes.length > MAX_DRAFT_NODES) {
      addDiag({
        code: "too_many_nodes",
        severity: "error",
        message: `节点数量 (${nodes.length}) 超过上限 ${MAX_DRAFT_NODES}`,
        suggestedActions: ["split_plan"],
      });
    }
    if (observations.length > MAX_DRAFT_OBSERVATIONS) {
      addDiag({
        code: "too_many_observations",
        severity: "error",
        message: `观察点数量 (${observations.length}) 超过上限 ${MAX_DRAFT_OBSERVATIONS}`,
        suggestedActions: ["reduce_observations"],
      });
    }

    const byId = new Map<string, NodeSpec>();
    const byEngineKey = new Map<string, NodeSpec>();
    for (const node of nodes) {
      if (byId.has(node.id)) {
        addDiag({
          code: "duplicate_node_id",
          severity: "error",
          nodeId: node.id,
          message: `存在重复节点 ID: ${node.id}`,
          suggestedActions: ["rename_node"],
        });
      } else {
        byId.set(node.id, node);
      }
      if (byEngineKey.has(node.engineKey)) {
        addDiag({
          code: "duplicate_engine_key",
          severity: "error",
          nodeId: node.id,
          message: `存在重复执行键 engineKey: ${node.engineKey}`,
          suggestedActions: ["rename_engine_key"],
        });
      } else {
        byEngineKey.set(node.engineKey, node);
      }
    }

    const lookupNode = (ref: string): NodeSpec | undefined =>
      byId.get(ref) ?? byEngineKey.get(ref);

    const obsIds = new Set<string>();
    for (const obs of observations) {
      if (obsIds.has(obs.id)) {
        addDiag({
          code: "duplicate_observation_id",
          severity: "error",
          message: `重复的观察点 ID: ${obs.id}`,
          suggestedActions: ["rename_observation"],
        });
      }
      obsIds.add(obs.id);
      if (!lookupNode(obs.afterNode)) {
        addDiag({
          code: "observation_target_missing",
          severity: "error",
          message: `观察点 ${obs.id} 引用了不存在的节点 ${obs.afterNode}`,
          suggestedActions: ["fix_observation"],
        });
      }
    }

    // Step 2: PlanGap resolution check (A02)
    for (const gap of gaps) {
      if (gap.status === "open") {
        addDiag({
          code: "open_plan_gap",
          severity: "error",
          ...(gap.affectedNodeIds[0] ? { nodeId: gap.affectedNodeIds[0] } : {}),
          message: `存在未解决的方案缺口 (${gap.id}): ${gap.reason}`,
          suggestedActions:
            gap.kind === "capability"
              ? ["open_capability_builder", "resolve_gap"]
              : ["resolve_gap"],
        });
      }
    }

    // Step 3: Capability & Profile snapshot resolution (A01, A02)
    const capByNodeId = new Map<string, Capability>();
    const profileByNodeId = new Map<string, Profile | null>();
    const allProfiles = this.store.list<Profile>("adaptive_profile");

    for (const node of nodes) {
      let cap: Capability | undefined;
      try {
        cap = this.assets.getCapability(node.capabilityRef.id, false);
      } catch {
        cap = undefined;
      }
      if (!cap) {
        addDiag({
          code: "capability_missing",
          severity: "error",
          nodeId: node.id,
          message: `节点 ${node.id} 引用的能力不存在: ${node.capabilityRef.id}`,
          suggestedActions: ["open_capability_builder"],
        });
        continue;
      }
      if (cap.status !== "published") {
        addDiag({
          code: "capability_not_published",
          severity: "error",
          nodeId: node.id,
          message: `节点 ${node.id} 引用的能力 ${cap.name}@${cap.version} 尚未发布 (${cap.status})`,
          suggestedActions: ["validate_and_publish_capability"],
        });
        continue;
      }
      if (cap.version !== node.capabilityRef.version) {
        addDiag({
          code: "capability_version_mismatch",
          severity: "error",
          nodeId: node.id,
          message: `节点 ${node.id} 的能力版本不匹配: 期望 ${node.capabilityRef.version}，实际 ${cap.version}`,
          suggestedActions: ["refresh_capability_ref"],
        });
        continue;
      }
      const computedCapDigest = capabilityVersionDigest(cap);
      const rawCapDigest = readOptionalDigest(cap);
      if (
        node.capabilityRef.digest !== computedCapDigest &&
        (!rawCapDigest || node.capabilityRef.digest !== rawCapDigest)
      ) {
        addDiag({
          code: "capability_digest_mismatch",
          severity: "error",
          nodeId: node.id,
          message: `节点 ${node.id} 的能力摘要校验失败 (${cap.id})`,
          suggestedActions: ["refresh_capability_ref"],
        });
        continue;
      }

      capByNodeId.set(node.id, cap);
      resourceManifest.capabilities[cap.id] = {
        id: cap.id,
        version: cap.version,
        digest: computedCapDigest,
      };

      // Resolve Profile
      if (node.profileRef) {
        let profile: Profile | undefined;
        try {
          profile = this.assets.getProfile(node.profileRef.id, false);
        } catch {
          profile = undefined;
        }
        if (!profile) {
          addDiag({
            code: "profile_missing",
            severity: "error",
            nodeId: node.id,
            message: `节点 ${node.id} 引用的执行档案不存在: ${node.profileRef.id}`,
            suggestedActions: ["select_profile"],
          });
          continue;
        }
        if (profile.status !== "published") {
          addDiag({
            code: "profile_not_published",
            severity: "error",
            nodeId: node.id,
            message: `节点 ${node.id} 引用的执行档案尚未发布: ${profile.id}`,
            suggestedActions: ["publish_profile"],
          });
          continue;
        }
        if (profile.version !== node.profileRef.version) {
          addDiag({
            code: "profile_version_mismatch",
            severity: "error",
            nodeId: node.id,
            message: `节点 ${node.id} 的执行档案版本不匹配`,
            suggestedActions: ["refresh_profile_ref"],
          });
          continue;
        }
        const computedProfileDigest = profileVersionDigest(profile);
        const rawProfileDigest = readOptionalDigest(profile);
        if (
          node.profileRef.digest !== computedProfileDigest &&
          (!rawProfileDigest || node.profileRef.digest !== rawProfileDigest)
        ) {
          addDiag({
            code: "profile_digest_mismatch",
            severity: "error",
            nodeId: node.id,
            message: `节点 ${node.id} 的执行档案摘要不匹配`,
            suggestedActions: ["refresh_profile_ref"],
          });
          continue;
        }
        profileByNodeId.set(node.id, profile);
        resourceManifest.profiles[profile.id] = {
          id: profile.id,
          version: profile.version,
          digest: computedProfileDigest,
        };
      } else {
        const matchedProfile =
          (cap.profileRef
            ? allProfiles.find(
                (p) =>
                  (p.id === cap.profileRef ||
                    `${p.name}@${p.version}` === cap.profileRef ||
                    p.name === cap.profileRef) &&
                  p.status === "published",
              )
            : undefined) ??
          allProfiles.find((p) => p.status === "published") ??
          null;
        profileByNodeId.set(node.id, matchedProfile);
        if (matchedProfile) {
          resourceManifest.profiles[matchedProfile.id] = {
            id: matchedProfile.id,
            version: matchedProfile.version,
            digest: profileVersionDigest(matchedProfile),
          };
        }
      }

      // Track skills used by profile & capability
      const resolvedProfile = profileByNodeId.get(node.id) ?? null;
      for (const s of collectSkillInstructions(this.store, cap, resolvedProfile)) {
        resourceManifest.skills[s.id] = {
          id: s.id,
          name: s.name,
          digest: s.digest,
        };
      }
    }

    // Step 4: Bindings, JSON Pointer validation, type checking & condition verification (A04, A05)
    for (const node of nodes) {
      const cap = capByNodeId.get(node.id);
      if (!cap) continue;

      const boundTopLevelFields = new Set<string>();
      const bindingIds = new Set<string>();

      for (const binding of node.bindings) {
        if (bindingIds.has(binding.id)) {
          addDiag({
            code: "duplicate_binding_id",
            severity: "error",
            nodeId: node.id,
            bindingId: binding.id,
            fieldPointer: binding.target,
            message: `节点 ${node.id} 存在重复绑定 ID: ${binding.id}`,
            suggestedActions: ["rename_binding"],
          });
          continue;
        }
        bindingIds.add(binding.id);

        let targetSegments: string[] = [];
        try {
          targetSegments = parseJsonPointer(binding.target);
        } catch (err) {
          addDiag({
            code: "invalid_binding_pointer",
            severity: "error",
            nodeId: node.id,
            bindingId: binding.id,
            fieldPointer: binding.target,
            message: err instanceof Error ? err.message : "非法目标 JSON Pointer",
            suggestedActions: ["fix_binding_pointer"],
          });
          continue;
        }
        try {
          parseJsonPointer(binding.source.pointer);
        } catch (err) {
          addDiag({
            code: "invalid_binding_pointer",
            severity: "error",
            nodeId: node.id,
            bindingId: binding.id,
            fieldPointer: binding.source.pointer,
            message: err instanceof Error ? err.message : "非法源 JSON Pointer",
            suggestedActions: ["fix_binding_pointer"],
          });
          continue;
        }

        if (targetSegments[0]) {
          boundTopLevelFields.add(targetSegments[0]);
          if (Object.hasOwn(node.literals, targetSegments[0]) && targetSegments.length === 1) {
            addDiag({
              code: "binding_literal_conflict",
              severity: "error",
              nodeId: node.id,
              bindingId: binding.id,
              fieldPointer: binding.target,
              message: `节点 ${node.id} 的绑定 ${binding.id} 与静态字面量冲突 (${binding.target})`,
              suggestedActions: ["remove_literal_or_binding"],
            });
          }
        }

        const srcNode = lookupNode(binding.source.nodeId);
        if (!srcNode) {
          addDiag({
            code: "binding_source_node_missing",
            severity: "error",
            nodeId: node.id,
            bindingId: binding.id,
            fieldPointer: binding.source.pointer,
            message: `绑定 ${binding.id} 引用了不存在的上游节点 ${binding.source.nodeId}`,
            suggestedActions: ["fix_binding_source"],
          });
          continue;
        }
        if (srcNode.id === node.id) {
          addDiag({
            code: "self_binding",
            severity: "error",
            nodeId: node.id,
            bindingId: binding.id,
            fieldPointer: binding.target,
            message: `节点 ${node.id} 不能绑定自身输出 (${binding.id})`,
            suggestedActions: ["remove_binding"],
          });
          continue;
        }

        const srcCap = capByNodeId.get(srcNode.id);
        let targetSubSchema: Record<string, unknown> | null = null;
        if (cap.inputSchema && typeof cap.inputSchema === "object") {
          const schemaObj = cap.inputSchema as Record<string, unknown>;
          if (schemaObj.properties) {
            targetSubSchema = resolveSchemaAtPointer(schemaObj, binding.target);
            if (!targetSubSchema) {
              addDiag({
                code: "binding_target_schema_missing",
                severity: "error",
                nodeId: node.id,
                bindingId: binding.id,
                fieldPointer: binding.target,
                message: `目标字段 ${binding.target} 不在节点 ${node.id} 能力输入 Schema 中`,
                suggestedActions: ["fix_binding_target"],
              });
            }
          }
        }

        let sourceSubSchema: Record<string, unknown> | null = null;
        if (srcCap?.outputSchema && typeof srcCap.outputSchema === "object") {
          const srcSchemaObj = srcCap.outputSchema as Record<string, unknown>;
          if (srcSchemaObj.properties) {
            sourceSubSchema = resolveSchemaAtPointer(
              srcSchemaObj,
              binding.source.pointer,
            );
            if (!sourceSubSchema) {
              addDiag({
                code: "binding_source_schema_missing",
                severity: "error",
                nodeId: node.id,
                bindingId: binding.id,
                fieldPointer: binding.source.pointer,
                message: `源字段 ${binding.source.pointer} 不在上游节点 ${srcNode.id} 的输出 Schema 中`,
                suggestedActions: ["fix_binding_source_pointer"],
              });
            }
          }
        }

        if (
          sourceSubSchema &&
          targetSubSchema &&
          !areJsonSchemasCompatible(sourceSubSchema, targetSubSchema)
        ) {
          addDiag({
            code: "binding_type_mismatch",
            severity: "error",
            nodeId: node.id,
            bindingId: binding.id,
            fieldPointer: binding.target,
            message: `绑定 ${binding.id} 类型不兼容: ${srcNode.id}${binding.source.pointer} (${String(sourceSubSchema.type)}) -> ${node.id}${binding.target} (${String(targetSubSchema.type)})`,
            suggestedActions: ["fix_binding_type"],
          });
        }

        if (binding.missing === "omit" && binding.required) {
          addDiag({
            code: "required_binding_cannot_omit",
            severity: "error",
            nodeId: node.id,
            bindingId: binding.id,
            fieldPointer: binding.target,
            message: `必需绑定 ${binding.id} 不能设置 missing="omit"`,
            suggestedActions: ["set_missing_block_or_default"],
          });
        }

        if (binding.missing === "use-default") {
          if (binding.defaultValue === undefined) {
            addDiag({
              code: "binding_default_missing",
              severity: "error",
              nodeId: node.id,
              bindingId: binding.id,
              fieldPointer: binding.target,
              message: `绑定 ${binding.id} 设置了 use-default，但未提供 defaultValue`,
              suggestedActions: ["provide_default_value"],
            });
          } else if (targetSubSchema) {
            try {
              checkSchema(
                {
                  type: "object",
                  properties: { defaultValue: targetSubSchema },
                  required: ["defaultValue"],
                },
                { defaultValue: binding.defaultValue },
              );
            } catch (err) {
              addDiag({
                code: "binding_invalid_default",
                severity: "error",
                nodeId: node.id,
                bindingId: binding.id,
                fieldPointer: binding.target,
                message: `绑定 ${binding.id} 的默认值不符合目标 Schema: ${err instanceof Error ? err.message : String(err)}`,
                suggestedActions: ["fix_default_value"],
              });
            }
          }
        }
      }

      // Check condition validity & conditional branch completeness (A04, A05)
      if (node.condition) {
        const condNode = lookupNode(node.condition.fromNode);
        if (!condNode) {
          addDiag({
            code: "condition_source_missing",
            severity: "error",
            nodeId: node.id,
            fieldPointer: node.condition.pointer,
            message: `条件引用了不存在的上游节点: ${node.condition.fromNode}`,
            suggestedActions: ["fix_condition"],
          });
        } else if (condNode.id === node.id) {
          addDiag({
            code: "self_condition",
            severity: "error",
            nodeId: node.id,
            fieldPointer: node.condition.pointer,
            message: `节点 ${node.id} 的条件不能引用自身`,
            suggestedActions: ["fix_condition"],
          });
        } else {
          const condCap = capByNodeId.get(condNode.id);
          if (
            condCap?.outputSchema &&
            typeof condCap.outputSchema === "object" &&
            (condCap.outputSchema as Record<string, unknown>).properties
          ) {
            const condSubSchema = resolveSchemaAtPointer(
              condCap.outputSchema as Record<string, unknown>,
              node.condition.pointer,
            );
            if (!condSubSchema) {
              addDiag({
                code: "condition_pointer_missing",
                severity: "error",
                nodeId: node.id,
                fieldPointer: node.condition.pointer,
                message: `条件字段 ${node.condition.pointer} 不存在于节点 ${condNode.id} 输出 Schema 中`,
                suggestedActions: ["fix_condition_pointer"],
              });
            }
          }
        }
      }

      // Check required inputSchema properties and literal validity
      if (cap.inputSchema && typeof cap.inputSchema === "object") {
        const schemaObj = cap.inputSchema as Record<string, unknown>;
        const reqFields = Array.isArray(schemaObj.required)
          ? (schemaObj.required as string[])
          : [];
        for (const reqField of reqFields) {
          const hasLiteral = Object.hasOwn(node.literals, reqField);
          const hasBinding = boundTopLevelFields.has(reqField);
          if (!hasLiteral && !hasBinding) {
            addDiag({
              code: "missing_required_input",
              severity: "error",
              nodeId: node.id,
              fieldPointer: `/${reqField}`,
              message: `节点 ${node.id} 缺少必需输入字段 /${reqField}`,
              suggestedActions: ["provide_literal_or_binding"],
            });
          }
        }
        // Validate literal values present using a stripped schema for bound-only required keys
        const remainingRequired = reqFields.filter(
          (f) => !boundTopLevelFields.has(f) || Object.hasOwn(node.literals, f),
        );
        const literalSchema: Record<string, unknown> = {
          ...schemaObj,
          required: remainingRequired,
        };
        if (reqFields.every((f) => Object.hasOwn(node.literals, f) || boundTopLevelFields.has(f))) {
          try {
            checkSchema(literalSchema, node.literals);
          } catch (err) {
            addDiag({
              code: "invalid_literal_input",
              severity: "error",
              nodeId: node.id,
              message: `节点 ${node.id} 字面量输入不符合契约: ${err instanceof Error ? err.message : String(err)}`,
              suggestedActions: ["fix_literals"],
            });
          }
        }
      }
    }

    // Step 5: Compute merged dependencies, verify dangling edges & cycle detection (A06)
    const depsByNodeId = new Map<string, Set<string>>();
    for (const node of nodes) {
      const deps = new Set<string>();
      for (const depRef of node.dependsOn) {
        const target = lookupNode(depRef);
        if (!target) {
          addDiag({
            code: "dangling_dependency",
            severity: "error",
            nodeId: node.id,
            message: `节点 ${node.id} 依赖了不存在的节点 ${depRef}`,
            suggestedActions: ["remove_dependency"],
          });
        } else {
          deps.add(target.id);
        }
      }
      for (const b of node.bindings) {
        const target = lookupNode(b.source.nodeId);
        if (target) deps.add(target.id);
      }
      if (node.condition) {
        const target = lookupNode(node.condition.fromNode);
        if (target) deps.add(target.id);
      }
      for (const kr of node.knowledgeInputs) {
        if (kr.source.kind === "node-output") {
          const producer = lookupNode(kr.source.nodeId);
          if (!producer) {
            addDiag({
              code: "producer_node_missing",
              severity: "error",
              nodeId: node.id,
              message: `知识依赖 ${kr.id} 引用了不存在的生产节点 ${kr.source.nodeId}`,
              suggestedActions: ["fix_knowledge_requirement"],
            });
          } else {
            deps.add(producer.id);
          }
        }
      }
      depsByNodeId.set(node.id, deps);
    }

    // Cycle check via 3-color DFS reporting exact cycle nodes (A06)
    const stateMap = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];
    let foundCycle: string[] | null = null;

    const dfs = (currentId: string) => {
      if (foundCycle) return;
      stateMap.set(currentId, 1);
      stack.push(currentId);
      const deps = depsByNodeId.get(currentId) ?? new Set<string>();
      for (const depId of deps) {
        if (foundCycle) return;
        const depState = stateMap.get(depId) ?? 0;
        if (depState === 1) {
          const startIdx = stack.indexOf(depId);
          foundCycle = stack.slice(startIdx);
          return;
        }
        if (depState === 0) {
          dfs(depId);
        }
      }
      stack.pop();
      stateMap.set(currentId, 2);
    };

    for (const node of nodes) {
      if ((stateMap.get(node.id) ?? 0) === 0) {
        dfs(node.id);
      }
    }
    if (foundCycle) {
      const cycleIds = foundCycle as string[];
      addDiag({
        code: "cycle_detected",
        severity: "error",
        nodeId: cycleIds[0],
        message: `检测到有向无环图成环，涉环节点: ${cycleIds.join(", ")}`,
        suggestedActions: cycleIds.map((id) => `break_cycle:${id}`),
      });
    }

    // Step 6: Single deliver terminal & workspace-write quality gates (Sec 6.2)
    const deliverNodes = nodes.filter((n) => {
      const c = capByNodeId.get(n.id);
      return c ? isDeliverCapability(c) : false;
    });
    if (deliverNodes.length > 1) {
      addDiag({
        code: "multiple_deliver_terminals",
        severity: "error",
        nodeId: deliverNodes[1].id,
        message: `只允许存在一个 deliver 终节点，当前存在 ${deliverNodes.length} 个`,
        suggestedActions: ["keep_single_deliver"],
      });
    }

    // Build downstream adjacency (upstream -> Set<downstream>)
    const downstreamMap = new Map<string, Set<string>>();
    for (const n of nodes) downstreamMap.set(n.id, new Set());
    for (const [nodeId, deps] of depsByNodeId.entries()) {
      for (const dep of deps) {
        downstreamMap.get(dep)?.add(nodeId);
      }
    }
    const collectDescendants = (startId: string): Set<string> => {
      const visited = new Set<string>();
      const queue = [...(downstreamMap.get(startId) ?? [])];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        for (const nxt of downstreamMap.get(cur) ?? []) {
          if (!visited.has(nxt)) queue.push(nxt);
        }
      }
      return visited;
    };

    if (!foundCycle && deliverNodes.length > 0) {
      for (const node of nodes) {
        const cap = capByNodeId.get(node.id);
        if (!cap || cap.sideEffect !== "workspace-write") continue;
        const descendants = collectDescendants(node.id);
        const testNodes = nodes.filter((n) => {
          if (!descendants.has(n.id)) return false;
          const dc = capByNodeId.get(n.id);
          return dc ? isTestCapability(dc, n) : false;
        });
        if (testNodes.length === 0) {
          addDiag({
            code: "missing_test_gate",
            severity: "error",
            nodeId: node.id,
            message: `工作区写入节点 ${node.id} 缺少下游测试门禁 (test)`,
            suggestedActions: ["add_test_gate"],
          });
          continue;
        }
        const hasReviewOrDeliverAfterTest = testNodes.some((tn) => {
          const testDesc = collectDescendants(tn.id);
          return [...testDesc].some((id) => {
            const c = capByNodeId.get(id);
            const dn = byId.get(id);
            return (
              c !== undefined &&
              (isDeliverCapability(c) ||
                c.name.includes("review") ||
                Boolean(dn?.engineKey.includes("review")) ||
                c.sideEffect === "read")
            );
          });
        });
        if (!hasReviewOrDeliverAfterTest && deliverNodes.length > 0) {
          addDiag({
            code: "missing_review_or_deliver_gate",
            severity: "error",
            nodeId: node.id,
            message: `写入节点 ${node.id} 后的测试节点需通向下游 review / deliver 门禁`,
            suggestedActions: ["connect_deliver_gate"],
          });
        }
      }
    }

    // Step 7 & 8: Knowledge contract resolution & conflict checks (A07, A08, A09, A21)
    const allClaims = this.curation.listClaims();
    const claimByKnowledgeId = new Map(allClaims.map((c) => [c.knowledgeId, c]));
    const runKnowledgeIds = new Set<string>();

    for (const node of nodes) {
      const cap = capByNodeId.get(node.id);
      if (!cap) continue;
      const nodeKnowledgeIds = new Set<string>();
      const ancestors = depsByNodeId.get(node.id) ?? new Set<string>();

      const collectTransitiveAncestors = (startId: string): Set<string> => {
        const res = new Set<string>();
        const q = [...(depsByNodeId.get(startId) ?? [])];
        while (q.length > 0) {
          const cur = q.shift()!;
          if (res.has(cur)) continue;
          res.add(cur);
          for (const p of depsByNodeId.get(cur) ?? []) {
            if (!res.has(p)) q.push(p);
          }
        }
        return res;
      };
      const allAncestors = collectTransitiveAncestors(node.id);

      for (const req of node.knowledgeInputs) {
        if (req.source.kind === "pinned") {
          let knowledge: Knowledge | undefined;
          try {
            knowledge = this.assets.getKnowledge(req.source.ref.id);
          } catch {
            knowledge = undefined;
          }
          if (!knowledge) {
            addDiag({
              code: "knowledge_missing",
              severity: "error",
              nodeId: node.id,
              message: `节点 ${node.id} 引用的知识不存在: ${req.source.ref.id}`,
              suggestedActions: ["fix_knowledge_ref"],
            });
            continue;
          }
          if (knowledge.status === "revoked") {
            addDiag({
              code: "knowledge_revoked",
              severity: "error",
              nodeId: node.id,
              message: `节点 ${node.id} 引用的知识已被撤销: ${knowledge.id}`,
              suggestedActions: ["replace_revoked_knowledge"],
            });
            continue;
          }
          if (knowledge.status !== "published") {
            addDiag({
              code: "knowledge_not_published",
              severity: "error",
              nodeId: node.id,
              message: `节点 ${node.id} 引用的知识尚未发布 (${knowledge.status}): ${knowledge.id}`,
              suggestedActions: ["publish_knowledge"],
            });
            continue;
          }
          if (
            !this.assets.accessible(
              knowledge,
              input.projectId,
              input.taskId,
              cap.name,
            )
          ) {
            addDiag({
              code: "knowledge_scope_denied",
              severity: "error",
              nodeId: node.id,
              message: `知识 ${knowledge.id} (scope=${knowledge.scope}) 不允许在当前项目/任务/能力中复用`,
              suggestedActions: ["remove_out_of_scope_knowledge"],
            });
            continue;
          }
          if (knowledge.version !== req.source.ref.version) {
            addDiag({
              code: "knowledge_version_mismatch",
              severity: "error",
              nodeId: node.id,
              message: `知识 ${knowledge.id} 版本不匹配`,
              suggestedActions: ["refresh_knowledge_ref"],
            });
            continue;
          }
          const kDigest = knowledgeVersionDigest(knowledge);
          const cDigest = digest(knowledge.content);
          if (
            req.source.ref.digest !== kDigest &&
            req.source.ref.digest !== cDigest
          ) {
            addDiag({
              code: "knowledge_digest_mismatch",
              severity: "error",
              nodeId: node.id,
              message: `知识 ${knowledge.id} 内容摘要与锁定快照不一致`,
              suggestedActions: ["refresh_knowledge_ref"],
            });
            continue;
          }
          const claimKind = claimByKnowledgeId.get(knowledge.id)?.kind ?? "pattern";
          if (!req.acceptedKinds.includes(claimKind)) {
            addDiag({
              code: "knowledge_kind_mismatch",
              severity: "error",
              nodeId: node.id,
              message: `知识 ${knowledge.id} 类型 (${claimKind}) 不符合节点 ${node.id} 需求 (${req.acceptedKinds.join(",")})`,
              suggestedActions: ["fix_knowledge_requirement"],
            });
            continue;
          }
          nodeKnowledgeIds.add(knowledge.id);
          runKnowledgeIds.add(knowledge.id);
          resourceManifest.knowledge[knowledge.id] = {
            id: knowledge.id,
            version: knowledge.version,
            digest: req.source.ref.digest,
          };
        } else if (req.source.kind === "query") {
          const hits = this.assets
            .listKnowledge()
            .filter(
              (k) =>
                k.status === "published" &&
                this.assets.accessible(
                  k,
                  input.projectId,
                  input.taskId,
                  cap.name,
                ) &&
                matchesQuery(
                  k,
                  req.source.kind === "query" ? req.source.query : "",
                ) &&
                matchesScopeRefs(
                  k,
                  req.source.kind === "query" ? req.source.scopeRefs : [],
                ) &&
                req.acceptedKinds.includes(
                  claimByKnowledgeId.get(k.id)?.kind ?? "pattern",
                ),
            );
          if (hits.length === 0 && req.required) {
            addDiag({
              code: "required_knowledge_missing",
              severity: "error",
              nodeId: node.id,
              message: `节点 ${node.id} 的必需知识查询 ${req.id} 未命中任何合法知识`,
              suggestedActions: ["curate_knowledge_or_mark_optional"],
            });
            continue;
          }
          for (const k of hits) {
            nodeKnowledgeIds.add(k.id);
            runKnowledgeIds.add(k.id);
            resourceManifest.knowledge[k.id] = {
              id: k.id,
              version: k.version,
              digest: knowledgeVersionDigest(k),
            };
          }
        } else {
          // node-output: must reference an upstream node that declares matching outputSpec (A09)
          const producer = lookupNode(req.source.nodeId);
          if (!producer) continue; // Already flagged in dependency step
          if (!ancestors.has(producer.id) && !allAncestors.has(producer.id)) {
            addDiag({
              code: "knowledge_producer_not_upstream",
              severity: "error",
              nodeId: node.id,
              message: `知识输出生产节点 ${producer.id} 必须是当前节点的上游依赖`,
              suggestedActions: ["add_dependency"],
            });
            continue;
          }
          const outSpec = producer.knowledgeOutputs.find(
            (o) => o.id === (req.source.kind === "node-output" ? req.source.outputId : ""),
          );
          if (!outSpec) {
            addDiag({
              code: "producer_knowledge_output_missing",
              severity: "error",
              nodeId: node.id,
              message: `上游节点 ${producer.id} 未声明知识产出 ${req.source.outputId}`,
              suggestedActions: ["declare_knowledge_output"],
            });
            continue;
          }
          if (!req.acceptedKinds.includes(outSpec.kind)) {
            addDiag({
              code: "knowledge_kind_mismatch",
              severity: "error",
              nodeId: node.id,
              message: `上游产出知识 ${outSpec.id} (${outSpec.kind}) 不符合 ${req.id} 接受的类型`,
              suggestedActions: ["fix_knowledge_requirement"],
            });
            continue;
          }
          pendingProducerBindings.push(`${node.id}:${req.id}`);
        }
      }

      // Check per-node conflicts (A21)
      for (const kid of nodeKnowledgeIds) {
        for (const rel of this.curation.conflictsFor(kid)) {
          const partner = rel.sourceId === kid ? rel.targetId : rel.sourceId;
          if (nodeKnowledgeIds.has(partner)) {
            addDiag({
              code: "knowledge_conflict",
              severity: "error",
              nodeId: node.id,
              message: `节点 ${node.id} 同时引入了冲突知识 ${kid} 与 ${partner}: ${rel.reason}`,
              suggestedActions: ["resolve_knowledge_conflict"],
            });
          }
        }
      }
    }

    // Also detect unresolved conflicts inside the run-wide knowledge manifest (A21)
    for (const kid of runKnowledgeIds) {
      for (const rel of this.curation.conflictsFor(kid)) {
        const partner = rel.sourceId === kid ? rel.targetId : rel.sourceId;
        if (runKnowledgeIds.has(partner) && kid < partner) {
          addDiag({
            code: "knowledge_conflict",
            severity: "error",
            message: `编译知识集合中存在未解决的知识冲突: ${kid} 与 ${partner} (${rel.reason})`,
            suggestedActions: ["resolve_knowledge_conflict"],
          });
        }
      }
    }

    const hasErrors = diagnostics.some((d) => d.severity === "error");
    if (hasErrors) {
      return {
        ok: false,
        executablePlan: null,
        nodeSpecs: nodes,
        resourceManifest,
        pendingProducerBindings,
        diagnostics,
        semanticDigest: null,
      };
    }

    // Step 9 & 10: Build compatible executablePlan (engine.ts Plan) and canonical semanticDigest
    const engineNodes: Plan["nodes"] = nodes.map((node) => {
      const cap = capByNodeId.get(node.id)!;
      const profile = profileByNodeId.get(node.id);
      const mergedDeps = [...(depsByNodeId.get(node.id) ?? [])]
        .map((id) => byId.get(id)!.engineKey)
        .sort();

      const legacyBindings: Record<string, { fromNode: string; field: string }> = {};
      for (const b of node.bindings) {
        if (b.missing !== "block") continue;
        const tgtSegs = parseJsonPointer(b.target);
        const srcSegs = parseJsonPointer(b.source.pointer);
        if (tgtSegs.length === 1 && srcSegs.length === 1) {
          const srcNode = lookupNode(b.source.nodeId)!;
          legacyBindings[tgtSegs[0]] = {
            fromNode: srcNode.engineKey,
            field: srcSegs[0],
          };
        }
      }

      let conditionCompat:
        | { fromNode: string; field: string; equals: string | number | boolean | null }
        | undefined;
      if (node.condition) {
        const condNode = lookupNode(node.condition.fromNode)!;
        const segs = parseJsonPointer(node.condition.pointer);
        if (segs.length === 1 && /^[a-zA-Z_]\w{0,99}$/.test(segs[0])) {
          conditionCompat = {
            fromNode: condNode.engineKey,
            field: segs[0],
            equals: node.condition.equals,
          };
        }
      }

      return {
        id: node.engineKey,
        capabilityRef: cap.id,
        ...(profile ? { profileRef: profile.id } : {}),
        dependsOn: mergedDeps,
        ...(conditionCompat ? { condition: conditionCompat } : {}),
        inputs: node.literals,
        bindings: legacyBindings,
      };
    });

    const mappedObservations = observations.map((o) => ({
      ...o,
      afterNode: lookupNode(o.afterNode)!.engineKey,
    }));

    const executablePlan: Plan = {
      nodes: engineNodes,
      observations: mappedObservations,
      rationale: input.goal,
    };

    const canonicalDigest = semanticDigest({
      compilerVersion: COMPILER_VERSION,
      goal: input.goal,
      nodes,
      observations,
      resourceManifest,
    });

    return {
      ok: true,
      executablePlan,
      nodeSpecs: structuredClone(nodes),
      resourceManifest,
      pendingProducerBindings,
      diagnostics,
      semanticDigest: canonicalDigest,
    };
  }

  compile(
    draftId: string,
    expectedRevision: number,
  ): {
    ok: boolean;
    compiledPlanRef: string | null;
    compiledDigest: string | null;
    compiledPlan: CompiledPlan | null;
    diagnostics: CompilerDiagnostic[];
  } {
    const draft = this.drafts.getDraft(draftId);
    if (draft.revision !== expectedRevision) {
      const err = new DomainError(
        "revision_conflict",
        `草稿版本冲突，期望 revision=${expectedRevision}，当前为 ${draft.revision}`,
        409,
      ) as DomainError & { currentRevision?: number };
      err.currentRevision = draft.revision;
      throw err;
    }

    const res = this.compileNodes({
      goal: draft.goal,
      nodes: draft.nodes,
      gaps: draft.gaps,
      observations: draft.observations,
      projectId: draft.projectId,
      taskId: draft.taskId ?? null,
    });

    if (!res.ok || !res.executablePlan || !res.semanticDigest) {
      return {
        ok: false,
        compiledPlanRef: null,
        compiledDigest: null,
        compiledPlan: null,
        diagnostics: res.diagnostics,
      };
    }

    const compiled: CompiledPlan = {
      id: randomUUID(),
      draftId: draft.id,
      draftRevision: draft.revision,
      taskId: draft.taskId ?? null,
      projectId: draft.projectId,
      semanticDigest: res.semanticDigest,
      compilerVersion: COMPILER_VERSION,
      executablePlan: res.executablePlan,
      nodeSpecs: res.nodeSpecs,
      resourceManifestRef: semanticDigest(res.resourceManifest),
      resourceManifest: res.resourceManifest,
      pendingProducerBindings: res.pendingProducerBindings,
      preflightDigest: semanticDigest({
        compilerVersion: COMPILER_VERSION,
        semanticDigest: res.semanticDigest,
      }),
      diagnostics: res.diagnostics,
      createdAt: new Date().toISOString(),
    };

    this.store.transaction(() => {
      this.store.put("compiled_plan", compiled);
      this.store.event(
        draft.id,
        "draft.compiled",
        {
          draftId: draft.id,
          compiledPlanId: compiled.id,
          draftRevision: draft.revision,
          semanticDigest: compiled.semanticDigest,
        },
        "compiler",
        { planRevision: draft.revision },
      );
    });

    return {
      ok: true,
      compiledPlanRef: compiled.id,
      compiledDigest: compiled.semanticDigest,
      compiledPlan: compiled,
      diagnostics: res.diagnostics,
    };
  }

  async startCompiledPlan(
    draftId: string,
    input: unknown,
    options: {
      idempotencyKey?: string;
      prepareWorkspace?: (task: Task) => Promise<string>;
      preflight?: (plan: Plan, task: Task) => Promise<void>;
      wake?: () => void;
    } = {},
  ): Promise<{ runId: string; run: AdaptiveRun }> {
    const data = StartCompiledInput.parse(input);
    const idempScope = `v3.draft.start:${draftId}`;
    const idempDigest = semanticDigest(data);
    if (options.idempotencyKey) {
      const existing = this.store.idempotencyGet(idempScope, options.idempotencyKey);
      if (existing) {
        if (existing.digest !== idempDigest) {
          throw new DomainError(
            "idempotency_conflict",
            "相同 Idempotency-Key 使用了不同的启动参数",
            409,
          );
        }
        return JSON.parse(existing.response) as { runId: string; run: AdaptiveRun };
      }
    }

    const draft = this.drafts.getDraft(draftId);
    if (draft.revision !== data.expectedRevision) {
      const err = new DomainError(
        "revision_conflict",
        `草稿版本冲突，当前为 ${draft.revision}`,
        409,
      ) as DomainError & { currentRevision?: number };
      err.currentRevision = draft.revision;
      throw err;
    }
    if (!draft.taskId) {
      throw new DomainError(
        "task_required",
        "启动执行前必须将方案草稿关联到任务 (taskId)",
        422,
      );
    }
    const task = this.store.get<Task>("task", draft.taskId);
    if (!task) {
      throw new DomainError("task_missing", "关联任务不存在", 404);
    }

    const compiled = this.store
      .list<CompiledPlan>("compiled_plan")
      .filter(
        (c) =>
          c.draftId === draft.id &&
          c.draftRevision === draft.revision &&
          c.semanticDigest === data.compiledDigest,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (!compiled) {
      throw new DomainError(
        "compiled_plan_missing",
        "找不到对应版本与摘要的编译结果，请先重新 compile",
        409,
      );
    }

    // Run outside-transaction workspace / preflight preparation
    let projectDigest = "";
    if (options.prepareWorkspace) {
      projectDigest = await options.prepareWorkspace(task);
    }
    const plan = compiled.executablePlan as Plan;
    if (options.preflight) {
      await options.preflight(plan, task);
    }

    const result = this.store.transaction(() => {
      if (options.idempotencyKey) {
        const again = this.store.idempotencyGet(idempScope, options.idempotencyKey);
        if (again) {
          if (again.digest !== idempDigest) {
            throw new DomainError(
              "idempotency_conflict",
              "相同 Idempotency-Key 使用了不同的启动参数",
              409,
            );
          }
          return JSON.parse(again.response) as { runId: string; run: AdaptiveRun };
        }
      }

      const freshDraft = this.drafts.getDraft(draftId);
      if (freshDraft.revision !== data.expectedRevision) {
        const err = new DomainError(
          "revision_conflict",
          `草稿版本冲突，当前为 ${freshDraft.revision}`,
          409,
        ) as DomainError & { currentRevision?: number };
        err.currentRevision = freshDraft.revision;
        throw err;
      }

      const activeRun = this.store
        .list<AdaptiveRun>("adaptive_run")
        .find(
          (r) =>
            r.taskId === task.id &&
            !["done", "cancelled", "failed"].includes(r.status),
        );
      if (activeRun) {
        throw new DomainError(
          "active_run_exists",
          `任务 ${task.id} 已有运行中的执行实例 (${activeRun.id})`,
          409,
        );
      }

      // Freeze runtime snapshots directly from validated compiled resource manifest
      const snapshots: AdaptiveRun["snapshots"] = {};
      const nodeStates: AdaptiveRun["nodeStates"] = {};
      for (const spec of compiled.nodeSpecs) {
        const cap = this.assets.getCapability(spec.capabilityRef.id, false);
        if (cap.status !== "published") {
          throw new DomainError(
            "capability_not_published",
            `能力 ${cap.id} 已不可用 (${cap.status})`,
            422,
          );
        }
        const profileRefId =
          spec.profileRef?.id ??
          Object.values(compiled.resourceManifest.profiles)[0]?.id ??
          null;
        const profile = profileRefId
          ? this.assets.getProfile(profileRefId)
          : this.store.list<Profile>("adaptive_profile")[0];
        if (!profile) {
          throw new DomainError(
            "profile_missing",
            `缺少可用执行档案以冻结节点 ${spec.id}`,
            422,
          );
        }
        const skillInstructions = collectSkillInstructions(
          this.store,
          cap,
          profile,
        );

        snapshots[spec.engineKey] = {
          capability: cap,
          profileRef: profile.id ?? profileRefId,
          profile,
          skillInstructions,
        };
        nodeStates[spec.engineKey] = "pending";
      }

      // Re-verify pinned knowledge live before creation (A08)
      for (const kRef of Object.values(compiled.resourceManifest.knowledge)) {
        const k = this.assets.getKnowledge(kRef.id);
        if (k.status !== "published") {
          throw new DomainError(
            "knowledge_revoked",
            `知识 ${k.id} 已撤销或未发布，拒绝启动运行`,
            422,
          );
        }
      }

      const observationStates: AdaptiveRun["observationStates"] = {};
      for (const obs of plan.observations) {
        observationStates[obs.id] = "pending";
      }

      const now = new Date().toISOString();
      const run: AdaptiveRun & {
        schemaVersion: number;
        compilerVersion: string;
        contextMode: "contract-v3";
        compiledPlanId: string;
        draftId: string;
        nodeSpecs: NodeSpec[];
        resourceManifest: ResourceManifest;
        dispatchGate: "open" | "paused" | "intervention" | "change_pending" | "reconciling";
        resultValidity: Record<string, "valid" | "stale" | "invalid" | "unknown">;
      } = {
        id: randomUUID(),
        taskId: task.id,
        taskRevision: (task as { revision?: number }).revision,
        ...(projectDigest ? { projectDigest } : {}),
        status: "queued",
        planRevision: 1,
        plan: structuredClone(plan) as AdaptiveRun["plan"],
        snapshots,
        nodeStates,
        observationStates,
        results: {},
        failures: {},
        decisions: {},
        revisionCount: 0,
        budgetUsd: data.budgetUsd ?? null,
        schemaVersion: 3,
        compilerVersion: COMPILER_VERSION,
        contextMode: "contract-v3",
        compiledPlanId: compiled.id,
        draftId: draft.id,
        nodeSpecs: structuredClone(compiled.nodeSpecs),
        resourceManifest: structuredClone(compiled.resourceManifest),
        dispatchGate: "open",
        resultValidity: {},
        createdAt: now,
        updatedAt: now,
      };

      this.store.put("adaptive_run", run);
      this.store.put("adaptive_plan_revision", {
        id: `${run.id}:1`,
        runId: run.id,
        number: 1,
        plan: structuredClone(plan),
        digest: digest(plan),
        reason: "initial",
        createdAt: now,
      });
      this.store.event(
        run.id,
        "run.started",
        {
          runId: run.id,
          draftId: draft.id,
          compiledPlanId: compiled.id,
          semanticDigest: compiled.semanticDigest,
          schemaVersion: 3,
        },
        "user",
        { planRevision: 1 },
      );

      const response = { runId: run.id, run };
      if (options.idempotencyKey) {
        this.store.idempotencyPut(
          idempScope,
          options.idempotencyKey,
          idempDigest,
          JSON.stringify(response),
        );
      }
      return response;
    });

    options.wake?.();
    return result;
  }
}
