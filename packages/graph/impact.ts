import { randomUUID } from "node:crypto";
import type { Knowledge } from "../adaptive/assets.js";
import type { AdaptiveRun } from "../adaptive/engine.js";
import { DomainError } from "../domain/index.js";
import type { Store } from "../persistence/index.js";
import {
  findNodeSpecByAnyId,
} from "./compiler.js";
import {
  semanticDigest,
  type EffectRecord,
  type NodeImpact,
  type NodeSpec,
  type ResourceManifest,
  type ResultValidity,
} from "./types.js";

export type ImpactAnalysisResult = {
  items: NodeImpact[];
  validityMap: Record<string, ResultValidity["state"]>;
  requiredActions: string[];
  blockingErrors: string[];
  diff: {
    addedNodes: string[];
    removedNodes: string[];
    modifiedNodes: string[];
    bindingChanges: string[];
    knowledgeChanges: string[];
  };
};

function synthesizeSpecFromRunNode(
  run: AdaptiveRun,
  node: AdaptiveRun["plan"]["nodes"][number],
): NodeSpec {
  const snapCap = run.snapshots[node.id]?.capability;
  return {
    id: node.id,
    engineKey: node.id,
    capabilityRef: {
      id: snapCap?.id ?? node.capabilityRef,
      version: snapCap?.version ?? "1.0.0",
      digest: semanticDigest({
        id: snapCap?.id ?? node.capabilityRef,
        version: snapCap?.version ?? "1.0.0",
      }),
    },
    profileRef: null,
    literals: node.inputs ?? {},
    bindings: Object.entries(node.bindings ?? {}).map(([target, b]) => ({
      id: `legacy-${target}`,
      target: `/${target}`,
      source: { nodeId: b.fromNode, pointer: `/${b.field}` },
      required: true,
      missing: "block" as const,
    })),
    dependsOn: [...(node.dependsOn ?? [])],
    ...(node.condition
      ? {
          condition: {
            fromNode: node.condition.fromNode,
            pointer: "/" + node.condition.field.split(".").join("/"),
            equals: node.condition.equals,
          },
        }
      : {}),
    knowledgeInputs: [],
    knowledgeOutputs: [],
    workspace: { policy: "run-shared", subdir: "." },
  };
}

function getEffectiveDeps(
  specs: NodeSpec[],
  spec: NodeSpec,
): string[] {
  const byAny = new Map<string, string>();
  for (const s of specs) {
    byAny.set(s.id, s.engineKey);
    byAny.set(s.engineKey, s.engineKey);
  }
  const deps = new Set<string>();
  for (const d of spec.dependsOn) {
    deps.add(byAny.get(d) ?? d);
  }
  for (const b of spec.bindings) {
    deps.add(byAny.get(b.source.nodeId) ?? b.source.nodeId);
  }
  if (spec.condition) {
    deps.add(byAny.get(spec.condition.fromNode) ?? spec.condition.fromNode);
  }
  for (const kr of spec.knowledgeInputs) {
    if (kr.source.kind === "node-output") {
      deps.add(byAny.get(kr.source.nodeId) ?? kr.source.nodeId);
    }
  }
  return [...deps].sort();
}

export function nodeActionKeyForSpec(spec: NodeSpec, sideEffect?: string): string {
  return (
    spec.actionKey ??
    `${spec.capabilityRef.id}:${spec.engineKey}:${sideEffect ?? "unknown"}`
  );
}

export class ImpactAnalyzer {
  constructor(private store: Store) {}

  analyze(params: {
    run: AdaptiveRun & {
      nodeSpecs?: NodeSpec[];
      resourceManifest?: ResourceManifest;
      resultValidity?: Record<string, ResultValidity["state"]>;
    };
    nextNodeSpecs: NodeSpec[];
    workspaceChangedNodeIds?: string[];
    manualReason?: string;
  }): ImpactAnalysisResult {
    const { run, nextNodeSpecs, workspaceChangedNodeIds = [], manualReason } = params;

    const oldSpecs: NodeSpec[] =
      run.nodeSpecs && run.nodeSpecs.length > 0
        ? run.nodeSpecs
        : run.plan.nodes.map((n) => synthesizeSpecFromRunNode(run, n));

    const effects = this.store
      .list<EffectRecord>("effect_record")
      .filter((e) => e.runId === run.id);

    const protectedEffectsByEngineKey = new Map<string, EffectRecord[]>();
    const protectedEffectsByActionKey = new Map<string, EffectRecord[]>();
    for (const eff of effects) {
      if (eff.state === "confirmed" || eff.state === "uncertain") {
        const list = protectedEffectsByEngineKey.get(eff.nodeId) ?? [];
        list.push(eff);
        protectedEffectsByEngineKey.set(eff.nodeId, list);
        const byAction = protectedEffectsByActionKey.get(eff.actionKey) ?? [];
        byAction.push(eff);
        protectedEffectsByActionKey.set(eff.actionKey, byAction);
      }
    }

    const oldByEngineKey = new Map(oldSpecs.map((s) => [s.engineKey, s]));
    const nextByEngineKey = new Map(nextNodeSpecs.map((s) => [s.engineKey, s]));

    const addedNodes: string[] = [];
    const removedNodes: string[] = [];
    const modifiedNodes: string[] = [];
    const bindingChanges: string[] = [];
    const knowledgeChanges: string[] = [];
    const blockingErrors: string[] = [];
    const directReasons = new Map<string, string[]>();
    const directActions = new Map<string, NodeImpact["action"]>();
    const preservedEffects = new Set<string>();

    const workspaceChangedSet = new Set<string>();
    for (const rawId of workspaceChangedNodeIds) {
      const matched =
        findNodeSpecByAnyId(nextNodeSpecs, rawId) ??
        findNodeSpecByAnyId(oldSpecs, rawId);
      workspaceChangedSet.add(matched?.engineKey ?? rawId);
    }

    const hasProtectedWrite = (oldSpec: NodeSpec): EffectRecord | undefined => {
      const nodeEffects = protectedEffectsByEngineKey.get(oldSpec.engineKey) ?? [];
      if (nodeEffects.length > 0) return nodeEffects[0];
      const cap = run.snapshots[oldSpec.engineKey]?.capability;
      const ak = nodeActionKeyForSpec(oldSpec, cap?.sideEffect);
      const akEffects = protectedEffectsByActionKey.get(ak) ?? [];
      if (akEffects.length > 0) return akEffects[0];
      if (
        cap?.sideEffect === "external-write" &&
        ["succeeded", "running", "reconciling", "uncertain"].includes(
          run.nodeStates[oldSpec.engineKey],
        )
      ) {
        return {
          id: `${run.id}:${oldSpec.engineKey}`,
          runId: run.id,
          nodeId: oldSpec.engineKey,
          invocationId: run.results[oldSpec.engineKey]?.invocationId ?? "",
          actionKey: ak,
          capabilityRef: oldSpec.capabilityRef.id,
          sideEffect: "external-write",
          targetDigest: "",
          argsDigest: semanticDigest(oldSpec.literals),
          state: "confirmed",
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        };
      }
      return undefined;
    };

    const getSpecFingerprint = (specs: NodeSpec[], spec: NodeSpec) =>
      semanticDigest({
        capabilityRef: spec.capabilityRef,
        profileRef: spec.profileRef ?? null,
        literals: spec.literals,
        bindings: spec.bindings,
        dependsOn: getEffectiveDeps(specs, spec),
        condition: spec.condition ?? null,
        knowledgeInputs: spec.knowledgeInputs,
        knowledgeOutputs: spec.knowledgeOutputs,
        workspace: spec.workspace,
        actionKey: spec.actionKey ?? null,
      });

    // 1. Detect removed nodes & protect confirmed/uncertain write effects (A12)
    for (const oldSpec of oldSpecs) {
      const stillPresent = nextByEngineKey.has(oldSpec.engineKey);
      if (!stillPresent) {
        removedNodes.push(oldSpec.engineKey);
        const protectedEff = hasProtectedWrite(oldSpec);
        if (protectedEff) {
          blockingErrors.push(
            `已 ${protectedEff.state} 的写入节点 ${oldSpec.engineKey} (actionKey=${protectedEff.actionKey}) 不能被删除或通过改名重置`,
          );
        }
      }
    }

    // 2. Also ensure no existing protected actionKey was relocated onto a new/renamed node to bypass protection (A12)
    for (const [actionKey, effs] of protectedEffectsByActionKey.entries()) {
      for (const eff of effs) {
        const nextSameKey = nextNodeSpecs.find(
          (n) =>
            n.engineKey === eff.nodeId ||
            n.actionKey === actionKey ||
            `${n.capabilityRef.id}:${n.engineKey}:${eff.sideEffect}` === actionKey,
        );
        if (!nextSameKey || nextSameKey.engineKey !== eff.nodeId) {
          const msg = `外部写入动作 ${actionKey} (原节点 ${eff.nodeId}) 状态为 ${eff.state}，禁止改名、替换或重置`;
          if (!blockingErrors.includes(msg)) blockingErrors.push(msg);
        }
      }
    }

    // 3. Direct diff & knowledge revocation checks on surviving / added nodes
    for (const nextSpec of nextNodeSpecs) {
      const oldSpec = oldByEngineKey.get(nextSpec.engineKey);
      const reasons: string[] = [];

      if (!oldSpec) {
        // Also check if another node claims the same protected actionKey
        if (nextSpec.actionKey && protectedEffectsByActionKey.has(nextSpec.actionKey)) {
          blockingErrors.push(
            `不能通过新节点 ${nextSpec.engineKey} 重建受保护动作 ${nextSpec.actionKey}`,
          );
        }
        addedNodes.push(nextSpec.engineKey);
        directReasons.set(nextSpec.engineKey, ["node_added"]);
        directActions.set(nextSpec.engineKey, "add");
        continue;
      }

      const oldState = run.nodeStates[nextSpec.engineKey];
      const oldFp = getSpecFingerprint(oldSpecs, oldSpec);
      const nextFp = getSpecFingerprint(nextNodeSpecs, nextSpec);

      if (oldFp !== nextFp) {
        modifiedNodes.push(nextSpec.engineKey);
        if (
          semanticDigest(oldSpec.capabilityRef) !==
          semanticDigest(nextSpec.capabilityRef)
        ) {
          reasons.push("capability_changed");
        }
        if (
          semanticDigest(oldSpec.profileRef ?? null) !==
          semanticDigest(nextSpec.profileRef ?? null)
        ) {
          reasons.push("profile_changed");
        }
        if (semanticDigest(oldSpec.literals) !== semanticDigest(nextSpec.literals)) {
          reasons.push("literals_changed");
        }
        if (semanticDigest(oldSpec.bindings) !== semanticDigest(nextSpec.bindings)) {
          bindingChanges.push(nextSpec.engineKey);
          reasons.push("bindings_changed");
        }
        if (
          semanticDigest(oldSpec.knowledgeInputs) !==
          semanticDigest(nextSpec.knowledgeInputs)
        ) {
          knowledgeChanges.push(nextSpec.engineKey);
          reasons.push("knowledge_contract_changed");
        }
        if (
          semanticDigest(oldSpec.condition ?? null) !==
          semanticDigest(nextSpec.condition ?? null)
        ) {
          reasons.push("condition_changed");
        }
        if (
          semanticDigest(getEffectiveDeps(oldSpecs, oldSpec)) !==
          semanticDigest(getEffectiveDeps(nextNodeSpecs, nextSpec))
        ) {
          reasons.push("dependencies_changed");
        }
        if (
          semanticDigest(oldSpec.workspace) !== semanticDigest(nextSpec.workspace)
        ) {
          reasons.push("workspace_changed");
        }

        const protectedEff = hasProtectedWrite(oldSpec);
        if (protectedEff) {
          // Confirmed/uncertain external-write or write effect cannot be structurally modified and reset to pending (A12)
          if (protectedEff.sideEffect === "external-write" || protectedEff.state === "uncertain") {
            blockingErrors.push(
              `节点 ${oldSpec.engineKey} 存在状态为 ${protectedEff.state} 的 ${protectedEff.sideEffect} 副作用，禁止直接重跑或篡改`,
            );
          }
        }
        directActions.set(nextSpec.engineKey, "modify");
      }

      // Check live knowledge revocation affecting existing manifest or pinned inputs
      for (const kr of nextSpec.knowledgeInputs) {
        if (kr.source.kind === "pinned") {
          const liveK = this.store.get<Knowledge>(
            "adaptive_knowledge",
            kr.source.ref.id,
          );
          if (liveK?.status === "revoked") {
            reasons.push(`knowledge_revoked:${liveK.id}`);
          }
        }
      }

      if (workspaceChangedSet.has(nextSpec.engineKey)) {
        reasons.push(manualReason ?? "workspace_modified");
      }

      if (run.resultValidity?.[nextSpec.engineKey] === "stale") {
        reasons.push("already_stale");
      } else if (run.resultValidity?.[nextSpec.engineKey] === "invalid") {
        reasons.push("already_invalid");
      }

      if (reasons.length > 0 && !directActions.has(nextSpec.engineKey)) {
        directActions.set(nextSpec.engineKey, "invalidate");
      }
      if (reasons.length > 0) {
        directReasons.set(nextSpec.engineKey, reasons);
      } else if (oldState === "succeeded") {
        const eff = hasProtectedWrite(oldSpec);
        if (eff) preservedEffects.add(nextSpec.engineKey);
      }
    }

    // 4. Transitive invalidation closure in topological order
    const depsMap = new Map<string, string[]>();
    for (const s of nextNodeSpecs) {
      depsMap.set(s.engineKey, getEffectiveDeps(nextNodeSpecs, s));
    }

    const impactedSet = new Set<string>(directReasons.keys());
    let changed = true;
    while (changed) {
      changed = false;
      for (const spec of nextNodeSpecs) {
        if (impactedSet.has(spec.engineKey)) continue;
        const deps = depsMap.get(spec.engineKey) ?? [];
        const dirtyUpstream = deps.filter((d) => impactedSet.has(d));
        if (dirtyUpstream.length > 0) {
          const oldState = run.nodeStates[spec.engineKey];
          const oldSpec = oldByEngineKey.get(spec.engineKey);
          const protectedEff = oldSpec ? hasProtectedWrite(oldSpec) : undefined;
          // If an already-confirmed external write sits downstream of an invalidated node, it cannot silently reset (A12)
          if (
            protectedEff &&
            (protectedEff.sideEffect === "external-write" ||
              protectedEff.state === "uncertain") &&
            oldState === "succeeded"
          ) {
            blockingErrors.push(
              `上游变更将使已确认外部写入节点 ${spec.engineKey} 失效，系统拒绝重置该副作用，请人工介入核对`,
            );
          }
          impactedSet.add(spec.engineKey);
          directReasons.set(
            spec.engineKey,
            dirtyUpstream.map((u) => `upstream_invalidated:${u}`),
          );
          if (oldState === "succeeded" || oldState === "skipped" || oldState === "failed") {
            directActions.set(spec.engineKey, "invalidate");
          }
          changed = true;
        }
      }
    }

    // 5. Assemble NodeImpact list & final validity map
    const items: NodeImpact[] = [];
    const validityMap: Record<string, ResultValidity["state"]> = {};
    const requiredActions: string[] = [];

    for (const removed of removedNodes) {
      items.push({
        nodeId: removed,
        engineKey: removed,
        action: "remove",
        validityAfter: "invalid",
        reasons: ["node_removed"],
      });
    }

    for (const spec of nextNodeSpecs) {
      const reasons = directReasons.get(spec.engineKey) ?? [];
      const action =
        directActions.get(spec.engineKey) ??
        (reasons.length > 0 ? "invalidate" : "keep");
      const oldState = run.nodeStates[spec.engineKey];
      const preserved = preservedEffects.has(spec.engineKey);

      const rawValidity =
        action === "keep" && oldState === "succeeded"
          ? "valid"
          : reasons.length > 0 || action !== "keep"
            ? "stale"
            : (run.resultValidity?.[spec.engineKey] ??
              (oldState === "succeeded" ? "valid" : "stale"));
      const validityAfter: NodeImpact["validityAfter"] =
        rawValidity === "unknown" ? "stale" : rawValidity;

      validityMap[spec.engineKey] = validityAfter;
      items.push({
        nodeId: spec.id,
        engineKey: spec.engineKey,
        action,
        validityAfter,
        reasons,
        ...(preserved ? { preservedEffect: true } : {}),
      });
    }

    if (blockingErrors.length > 0) {
      requiredActions.push("resolve_protected_effects");
    }
    if (items.some((i) => i.action === "invalidate" || i.action === "add" || i.action === "modify")) {
      requiredActions.push("rerun_affected_nodes");
    }

    return {
      items,
      validityMap,
      requiredActions,
      blockingErrors,
      diff: {
        addedNodes,
        removedNodes,
        modifiedNodes,
        bindingChanges,
        knowledgeChanges,
      },
    };
  }

  /**
   * Mark nodes downstream of workspace mutations (e.g. interactive-write adoption) stale
   * while preserving already confirmed prior writes unless explicitly requested.
   */
  computeWorkspaceInterventionImpact(
    run: AdaptiveRun & {
      nodeSpecs?: NodeSpec[];
      resourceManifest?: ResourceManifest;
      resultValidity?: Record<string, ResultValidity["state"]>;
    },
    targetNodeId?: string,
  ): { invalidatedEngineKeys: string[]; preservedWriteKeys: string[]; reasons: Record<string, string[]> } {
    const specs: NodeSpec[] =
      run.nodeSpecs && run.nodeSpecs.length > 0
        ? run.nodeSpecs
        : run.plan.nodes.map((n) => synthesizeSpecFromRunNode(run, n));

    const downstreamMap = new Map<string, Set<string>>();
    for (const s of specs) downstreamMap.set(s.engineKey, new Set());
    for (const s of specs) {
      for (const dep of getEffectiveDeps(specs, s)) {
        downstreamMap.get(dep)?.add(s.engineKey);
      }
    }

    const collectDownstream = (start: string): Set<string> => {
      const out = new Set<string>();
      const q = [...(downstreamMap.get(start) ?? [])];
      while (q.length > 0) {
        const cur = q.shift()!;
        if (out.has(cur)) continue;
        out.add(cur);
        for (const nxt of downstreamMap.get(cur) ?? []) {
          if (!out.has(nxt)) q.push(nxt);
        }
      }
      return out;
    };

    const seeds: string[] = [];
    if (targetNodeId) {
      const found = findNodeSpecByAnyId(specs, targetNodeId);
      if (found) seeds.push(found.engineKey);
    }
    if (seeds.length === 0) {
      for (const s of specs) {
        const cap = run.snapshots[s.engineKey]?.capability;
        if (cap?.sideEffect === "workspace-write") {
          seeds.push(s.engineKey);
        }
      }
    }

    const candidateInvalid = new Set<string>();
    const preservedWriteKeys: string[] = [];
    for (const seed of seeds) {
      const cap = run.snapshots[seed]?.capability;
      const seedState = run.nodeStates[seed];
      // A confirmed earlier workspace-write completed before human intervention stays preserved;
      // downstream test/review/deliver MUST rerun against the modified workspace (A11, A26).
      if (cap?.sideEffect === "workspace-write" && seedState === "succeeded") {
        preservedWriteKeys.push(seed);
      } else {
        candidateInvalid.add(seed);
      }
      for (const desc of collectDownstream(seed)) {
        candidateInvalid.add(desc);
      }
    }

    // Fallback: also mark any succeeded test / review / deliver nodes stale if workspace digest changed
    for (const s of specs) {
      const cap = run.snapshots[s.engineKey]?.capability;
      const isGate =
        cap?.name === "core.project.test" ||
        cap?.name === "core.builtin.deliver" ||
        cap?.name === "core.conclude" ||
        cap?.name.includes("test") ||
        cap?.name.includes("review") ||
        s.engineKey.includes("test") ||
        s.engineKey.includes("review") ||
        s.engineKey.includes("deliver");
      if (isGate && !preservedWriteKeys.includes(s.engineKey)) {
        candidateInvalid.add(s.engineKey);
      }
    }

    const reasons: Record<string, string[]> = {};
    const invalidatedEngineKeys: string[] = [];
    for (const s of specs) {
      if (!candidateInvalid.has(s.engineKey)) continue;
      const cap = run.snapshots[s.engineKey]?.capability;
      if (cap?.sideEffect === "external-write" && run.nodeStates[s.engineKey] === "succeeded") {
        preservedWriteKeys.push(s.engineKey);
        continue;
      }
      invalidatedEngineKeys.push(s.engineKey);
      reasons[s.engineKey] = [
        targetNodeId
          ? `intervention_workspace_modified:${targetNodeId}`
          : "intervention_workspace_modified",
      ];
    }

    return { invalidatedEngineKeys, preservedWriteKeys, reasons };
  }
}

export function computeRunBaseStateDigest(
  store: Store,
  run: AdaptiveRun,
): string {
  const effects = store
    .list<EffectRecord>("effect_record")
    .filter((e) => e.runId === run.id)
    .map((e) => ({ id: e.id, nodeId: e.nodeId, state: e.state, updatedAt: e.updatedAt }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return semanticDigest({
    planRevision: run.planRevision,
    nodeStates: run.nodeStates,
    observationStates: run.observationStates,
    resultsDigest: semanticDigest(run.results),
    effects,
  });
}

export function assertEffectsSafeOnReplan(
  store: Store,
  run: AdaptiveRun,
  nextNodeIds: string[],
  actionKeysByNextNode: Record<string, string | undefined> = {},
): void {
  const nextSet = new Set(nextNodeIds);
  const effects = store
    .list<EffectRecord>("effect_record")
    .filter((e) => e.runId === run.id);
  for (const eff of effects) {
    if (eff.state !== "confirmed" && eff.state !== "uncertain") continue;
    if (!nextSet.has(eff.nodeId)) {
      throw new DomainError(
        "write_replan_unsafe",
        `已 ${eff.state} 的写入节点 ${eff.nodeId} (${eff.actionKey}) 不能从计划中移除或改名`,
        409,
      );
    }
    const nextActionKey = actionKeysByNextNode[eff.nodeId];
    if (nextActionKey && nextActionKey !== eff.actionKey) {
      throw new DomainError(
        "write_replan_unsafe",
        `节点 ${eff.nodeId} 已 ${eff.state} 的写入动作 (${eff.actionKey}) 不允许替换为 (${nextActionKey})`,
        409,
      );
    }
  }
}

export function persistValidityRecords(
  store: Store,
  run: AdaptiveRun,
  validityMap: Record<string, ResultValidity["state"]>,
  reasonsByKey: Record<string, string[]>,
): void {
  const now = new Date().toISOString();
  for (const [nodeId, state] of Object.entries(validityMap)) {
    const invId = run.results[nodeId]?.invocationId ?? "";
    if (!invId && state === "unknown") continue;
    const record: ResultValidity = {
      id: `${run.id}:${nodeId}:${run.planRevision}`,
      runId: run.id,
      nodeId,
      invocationId: invId || randomUUID(),
      state,
      reasons: reasonsByKey[nodeId] ?? [],
      assessedAtRevision: run.planRevision,
      updatedAt: now,
    };
    store.put("result_validity", record);
  }
}
