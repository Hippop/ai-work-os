import { basename } from "node:path";
import type { AdaptiveRun, Plan } from "../adaptive/engine.js";
import { DomainError } from "../domain/index.js";
import type { Store } from "../persistence/index.js";
import { mergeRunEvents } from "./events-merge.js";
export { mergeRunEvents } from "./events-merge.js";
import type {
  AgentSession,
  EffectRecord,
  InterventionRecord,
  NodeSpec,
  PlanDraft,
  ResolvedContextManifest,
  ResultValidity,
} from "./types.js";

export type GraphNode = {
  id: string;
  sourceId: string;
  stableNodeId?: string;
  kind: "capability" | "observation";
  title: string;
  state: string;
  capabilityRef: string | null;
  profileRef: string | null;
  runner: string;
  cwd: string | null;
  sideEffect: string;
  skills: string[];
  knowledge: { id: string; digest: string }[];
  knowledgeRecorded: boolean;
  invocationId: string | null;
  artifactCount: number;
  failure: string | null;
  question?: string;
  decision?: { decision: string; reason: string };
  validity?: ResultValidity["state"] | "invalidated" | "uncertain-effect" | "unknown";
  effectState?: string | null;
  contextManifestId?: string | null;
  activeInterventionId?: string | null;
  activeSessionId?: string | null;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kinds: ("dependency" | "data" | "condition" | "observation")[];
  mappings: { input: string; output: string }[];
  condition?: { field: string; equals: unknown };
};

export type RunGraph = {
  runId: string;
  taskId: string;
  revision: number;
  status: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  rationale: string;
  lastSeq?: number;
  compiledPlanRef?: string | null;
  draftId?: string | null;
  dispatchGate?: {
    state: "open" | "paused" | "draining" | "intervention" | "change_pending" | "reconciling";
    reason?: string;
  };
  allowedActions?: string[];
  resultValidity?: Record<string, { state: string; reason?: string; invocationId: string | null }>;
  effectStates?: Record<string, { state: string; actionKey: string; kind: string }>;
  contextManifestIds?: Record<string, string>;
  knowledgeCards?: {
    id: string;
    title: string;
    scope: string;
    status: string;
    digest: string;
    usedByNodeIds: string[];
  }[];
  artifactCards?: {
    id: string;
    nodeId: string;
    name: string;
    path: string;
    digest?: string;
  }[];
  gaps?: unknown[];
  revisions?: { revision: number; rationale: string; createdAt?: string }[];
  interventions?: InterventionRecord[];
  sessions?: AgentSession[];
  historicalView?: boolean;
};

type Invocation = {
  id: string;
  runId: string;
  nodeId: string;
  planRevision: number;
  startedAt: string;
  knowledgeRefs?: { id: string; digest: string }[];
};

type RunV3ProjectionSource = AdaptiveRun & {
  schemaVersion?: number;
  contextMode?: string;
  compiledPlanId?: string;
  draftId?: string;
  nodeSpecs?: NodeSpec[];
  dispatchGate?: "open" | "paused" | "draining" | "intervention" | "change_pending" | "reconciling";
  resultValidity?: Record<string, string>;
};

export const capabilityKey = (id: string) => "cap:" + id;
export const observationKey = (id: string) => "obs:" + id;

/** Presentation only: use frozen snapshots and recorded hits, never current asset versions. */
export function projectRun(run: AdaptiveRun, invocations: Invocation[]): RunGraph {
  const extRun = run as RunV3ProjectionSource;
  const specByKey = new Map<string, NodeSpec>();
  for (const s of extRun.nodeSpecs ?? []) {
    specByKey.set(s.engineKey, s);
  }

  const nodes: GraphNode[] = run.plan.nodes.map((node) => {
    const snapshot = run.snapshots[node.id];
    const result = run.results[node.id];
    const invocation =
      invocations.find(
        (i) => i.runId === run.id && i.nodeId === node.id && i.id === result?.invocationId,
      ) ??
      invocations
        .filter(
          (i) =>
            i.runId === run.id &&
            i.nodeId === node.id &&
            i.planRevision === run.planRevision,
        )
        .sort(
          (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
        )[0];
    const spec = specByKey.get(node.id);
    const baseValidity = extRun.resultValidity?.[node.id] as
      | GraphNode["validity"]
      | undefined;
    return {
      id: capabilityKey(node.id),
      sourceId: node.id,
      ...(spec ? { stableNodeId: spec.id } : {}),
      kind: "capability",
      title: snapshot?.capability.title ?? node.id,
      state: run.nodeStates[node.id] ?? "pending",
      capabilityRef: node.capabilityRef,
      profileRef: snapshot?.profileRef ?? null,
      runner: snapshot?.profile.agent ?? snapshot?.profile.executor ?? "unknown",
      cwd:
        snapshot?.profile.workspaceMode === "none"
          ? null
          : snapshot?.profile.workspaceSubdir ?? ".",
      sideEffect: snapshot?.capability.sideEffect ?? "unknown",
      skills: snapshot?.skillInstructions.map((s) => s.name) ?? [],
      knowledge: invocation?.knowledgeRefs ?? [],
      knowledgeRecorded: invocation?.knowledgeRefs !== undefined,
      invocationId: invocation?.id ?? null,
      artifactCount: result?.artifactRefs.length ?? 0,
      failure: run.failures[node.id] ?? null,
      ...(baseValidity ? { validity: baseValidity } : {}),
    };
  });

  const edges: GraphEdge[] = [];
  for (const node of run.plan.nodes) {
    for (const from of node.dependsOn) {
      const mappings = Object.entries(node.bindings)
        .filter(([, b]) => b.fromNode === from)
        .map(([input, b]) => ({ input, output: b.field }));
      const condition =
        node.condition?.fromNode === from
          ? { field: node.condition.field, equals: node.condition.equals }
          : undefined;
      edges.push({
        id: `dep:${from}:${node.id}`,
        source: capabilityKey(from),
        target: capabilityKey(node.id),
        kinds: [
          "dependency",
          ...(mappings.length ? ["data" as const] : []),
          ...(condition ? ["condition" as const] : []),
        ],
        mappings,
        ...(condition ? { condition } : {}),
      });
    }
  }

  for (const obs of run.plan.observations) {
    nodes.push({
      id: observationKey(obs.id),
      sourceId: obs.id,
      kind: "observation",
      title: obs.id,
      state: run.observationStates[obs.id] ?? "pending",
      capabilityRef: null,
      profileRef: null,
      runner: obs.barrier ? "阻塞观察点" : "观察点",
      cwd: null,
      sideEffect: "none",
      skills: [],
      knowledge: [],
      knowledgeRecorded: false,
      invocationId: null,
      artifactCount: 0,
      failure: null,
      question: obs.question,
      decision: run.decisions[obs.id],
    });
    edges.push({
      id: "observation:" + obs.id,
      source: capabilityKey(obs.afterNode),
      target: observationKey(obs.id),
      kinds: ["observation"],
      mappings: [],
    });
  }

  return {
    runId: run.id,
    taskId: run.taskId,
    revision: run.planRevision,
    status: run.status,
    rationale: run.plan.rationale,
    nodes,
    edges,
  };
}

type PlanRevisionRecord = {
  id: string;
  runId: string;
  number: number;
  plan: Plan;
  states?: Record<string, string>;
  results?: AdaptiveRun["results"];
  snapshots?: AdaptiveRun["snapshots"];
  reason?: string;
  createdAt?: string;
};

function computeAllowedActions(
  run: RunV3ProjectionSource,
  interventions: InterventionRecord[],
  effects: EffectRecord[],
): string[] {
  const actions: string[] = [];
  const hasUncertain = effects.some((e) => e.state === "uncertain");
  const hasOpenIntervention = interventions.some((i) => i.reviewState === "pending");
  const hasWaitingObs = Object.values(run.observationStates).some(
    (s) => s === "waiting",
  );
  const terminal = ["done", "cancelled"].includes(run.status);

  if (!terminal) {
    if (run.status === "running" || run.status === "queued") {
      actions.push("pause", "cancel", "requestIntervention");
    }
    if (run.status === "paused") {
      actions.push("resume", "cancel", "proposeChange", "requestIntervention");
    }
    if (run.status === "awaiting_acceptance") {
      actions.push("accept", "reject", "proposeChange");
    }
    if (run.status === "failed") {
      actions.push("retry", "proposeChange", "requestIntervention", "cancel");
    }
    if (run.status === "reconciling" || hasUncertain) {
      actions.push("reconcileEffect", "cancel");
    }
    if (!hasUncertain && !hasOpenIntervention && run.status !== "reconciling") {
      actions.push("proposeChange");
    }
    if (hasWaitingObs) {
      actions.push("resolveObservation");
    }
    if (hasOpenIntervention) {
      actions.push("adoptIntervention", "discardIntervention");
    }
  }
  return [...new Set(actions)];
}

export function getRunGraph(store: Store, id: string, revision?: number): RunGraph {
  const rawRun = store.get<RunV3ProjectionSource>("adaptive_run", id);
  if (!rawRun) throw new DomainError("run_missing", "运行不存在", 404);

  const invocations = store
    .list<Invocation>("adaptive_invocation")
    .filter((i) => i.runId === id);

  const revisionRecords = store
    .list<PlanRevisionRecord>("adaptive_plan_revision")
    .filter((r) => r.runId === id)
    .sort((a, b) => a.number - b.number);

  let targetRun: RunV3ProjectionSource = rawRun;
  let historicalView = false;

  if (revision !== undefined && revision !== rawRun.planRevision) {
    const revRec = revisionRecords.find((r) => r.number === revision);
    if (!revRec) {
      throw new DomainError(
        "revision_not_found",
        `运行 ${id} 的计划版本 ${revision} 不存在`,
        404,
      );
    }
    historicalView = true;
    const revInvocations = invocations.filter((i) => i.planRevision === revision);
    const derivedStates: Record<string, string> = {};
    for (const node of revRec.plan.nodes) {
      if (revRec.states && revRec.states[node.id] !== undefined) {
        derivedStates[node.id] = revRec.states[node.id];
      } else if (revRec.results && revRec.results[node.id]) {
        derivedStates[node.id] = "succeeded";
      } else if (revInvocations.some((i) => i.nodeId === node.id)) {
        derivedStates[node.id] = "recorded";
      } else {
        derivedStates[node.id] = "unrecorded";
      }
    }
    targetRun = {
      ...rawRun,
      planRevision: revision,
      plan: revRec.plan as AdaptiveRun["plan"],
      nodeStates: derivedStates as AdaptiveRun["nodeStates"],
      results: revRec.results ?? {},
      snapshots: revRec.snapshots ?? rawRun.snapshots,
      failures: {},
      observationStates: Object.fromEntries(
        revRec.plan.observations.map((o) => [o.id, "completed" as const]),
      ),
      decisions: {},
    };
  }

  const base = projectRun(targetRun, invocations);

  const validityRecords = store
    .list<ResultValidity>("result_validity")
    .filter((v) => v.runId === id && (!historicalView || v.assessedAtRevision === targetRun.planRevision));
  const effectRecords = store
    .list<EffectRecord>("effect_record")
    .filter((e) => e.runId === id);
  const manifests = store
    .list<ResolvedContextManifest>("context_manifest")
    .filter((m) => m.runId === id);
  const interventions = store
    .list<InterventionRecord>("intervention")
    .filter((iv) => iv.runId === id);
  const sessions = store
    .list<AgentSession>("agent_session")
    .filter((s) => s.runId === id);
  const draft = rawRun.draftId
    ? store.get<PlanDraft>("graph_draft", rawRun.draftId)
    : undefined;

  const resultValidityMap: RunGraph["resultValidity"] = {};
  for (const node of base.nodes) {
    if (node.kind !== "capability") continue;
    const rec = validityRecords
      .filter((r) => r.nodeId === node.sourceId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const eff = effectRecords
      .filter((e) => e.nodeId === node.sourceId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const manifest = manifests
      .filter(
        (m) =>
          m.nodeId === node.sourceId &&
          (!node.invocationId || m.invocationId === node.invocationId),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    const activeIv = interventions.find(
      (iv) => iv.reviewState === "pending" && (!iv.nodeId || iv.nodeId === node.sourceId || iv.nodeId === node.stableNodeId),
    );
    const activeSess = sessions.find(
      (s) =>
        (s.processState === "running" || s.processState === "stop-unconfirmed") &&
        (activeIv ? s.interventionId === activeIv.id : s.nodeId === node.sourceId),
    );

    const effectiveValidity =
      rec?.state ??
      (rawRun.resultValidity?.[node.sourceId] as GraphNode["validity"] | undefined);
    if (effectiveValidity) {
      node.validity = effectiveValidity;
      resultValidityMap[node.sourceId] = {
        state: effectiveValidity,
        reason: rec?.reasons?.join("; "),
        invocationId: rec?.invocationId ?? node.invocationId,
      };
    }
    if (eff) node.effectState = eff.state;
    if (manifest) node.contextManifestId = manifest.id;
    if (activeIv) node.activeInterventionId = activeIv.id;
    if (activeSess) node.activeSessionId = activeSess.id;
  }

  const effectStatesMap: RunGraph["effectStates"] = {};
  for (const eff of effectRecords) {
    effectStatesMap[eff.nodeId] = {
      state: eff.state,
      actionKey: eff.actionKey,
      kind: eff.sideEffect,
    };
  }

  const contextManifestIds: Record<string, string> = {};
  for (const m of manifests) {
    contextManifestIds[m.nodeId] = m.id;
  }

  // Build knowledgeCards from recorded invocations + manifest selections without leaking unselected items
  const allKnowledge = store.list<{
    id: string;
    title: string;
    scope: string;
    status: string;
    content?: string;
    updatedAt?: string;
  }>("adaptive_knowledge");
  const knowledgeById = new Map(allKnowledge.map((k) => [k.id, k]));
  const knowledgeCardMap = new Map<
    string,
    { id: string; title: string; scope: string; status: string; digest: string; usedByNodeIds: string[] }
  >();
  for (const node of base.nodes) {
    if (node.kind !== "capability") continue;
    for (const kRef of node.knowledge) {
      const k = knowledgeById.get(kRef.id);
      const existingCard = knowledgeCardMap.get(kRef.id);
      if (existingCard) {
        if (!existingCard.usedByNodeIds.includes(node.sourceId)) {
          existingCard.usedByNodeIds.push(node.sourceId);
        }
      } else {
        knowledgeCardMap.set(kRef.id, {
          id: kRef.id,
          title: k?.title ?? kRef.id,
          scope: k?.scope ?? "unknown",
          status: k?.status ?? "unknown",
          digest: kRef.digest,
          usedByNodeIds: [node.sourceId],
        });
      }
    }
  }

  const artifactCards: NonNullable<RunGraph["artifactCards"]> = [];
  for (const [nodeId, res] of Object.entries(targetRun.results)) {
    for (const ref of res.artifactRefs) {
      artifactCards.push({
        id: `${nodeId}:${basename(ref)}`,
        nodeId,
        name: basename(ref),
        path: ref,
        ...(res.artifactDigests?.[ref] ? { digest: res.artifactDigests[ref] } : {}),
      });
    }
  }

  const revisions = revisionRecords.map((r) => ({
    revision: r.number,
    rationale: r.plan.rationale || r.reason || "",
    ...(r.createdAt ? { createdAt: r.createdAt } : {}),
  }));
  if (!revisions.some((r) => r.revision === rawRun.planRevision)) {
    revisions.push({
      revision: rawRun.planRevision,
      rationale: rawRun.plan.rationale,
      createdAt: rawRun.updatedAt,
    });
  }

  const gateState = rawRun.dispatchGate ?? (rawRun.status === "paused" ? "paused" : "open");

  return {
    ...base,
    lastSeq: store.lastSeq(id),
    compiledPlanRef: rawRun.compiledPlanId ?? null,
    draftId: rawRun.draftId ?? null,
    dispatchGate: { state: gateState },
    allowedActions: historicalView
      ? []
      : computeAllowedActions(rawRun, interventions, effectRecords),
    resultValidity: resultValidityMap,
    effectStates: effectStatesMap,
    contextManifestIds,
    knowledgeCards: [...knowledgeCardMap.values()],
    artifactCards,
    gaps: draft?.gaps ?? [],
    revisions,
    interventions,
    sessions,
    historicalView,
  };
}
