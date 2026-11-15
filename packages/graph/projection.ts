import type { AdaptiveRun } from "../adaptive/engine.js";
import { DomainError } from "../domain/index.js";
import type { Store } from "../persistence/index.js";

export type GraphNode = {
  id: string; sourceId: string; kind: "capability" | "observation";
  title: string; state: string; capabilityRef: string | null; profileRef: string | null;
  runner: string; cwd: string | null; sideEffect: string; skills: string[];
  knowledge: { id: string; digest: string }[]; knowledgeRecorded: boolean;
  invocationId: string | null; artifactCount: number; failure: string | null;
  question?: string; decision?: { decision: string; reason: string };
};
export type GraphEdge = {
  id: string; source: string; target: string;
  kinds: ("dependency" | "data" | "condition" | "observation")[];
  mappings: { input: string; output: string }[];
  condition?: { field: string; equals: unknown };
};
export type RunGraph = {
  runId: string; taskId: string; revision: number; status: string;
  nodes: GraphNode[]; edges: GraphEdge[]; rationale: string;
};
type Invocation = {
  id: string; runId: string; nodeId: string; planRevision: number;
  startedAt: string; knowledgeRefs?: { id: string; digest: string }[];
};
export const capabilityKey = (id: string) => "cap:" + id;
export const observationKey = (id: string) => "obs:" + id;

/** Presentation only: use frozen snapshots and recorded hits, never current asset versions. */
export function projectRun(run: AdaptiveRun, invocations: Invocation[]): RunGraph {
  const nodes: GraphNode[] = run.plan.nodes.map(node => {
    const snapshot = run.snapshots[node.id];
    const result = run.results[node.id];
    const invocation = invocations.find(i => i.runId === run.id && i.nodeId === node.id && i.id === result?.invocationId)
      ?? invocations.filter(i => i.runId === run.id && i.nodeId === node.id && i.planRevision === run.planRevision)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))[0];
    return {
      id: capabilityKey(node.id), sourceId: node.id, kind: "capability", title: snapshot?.capability.title ?? node.id,
      state: run.nodeStates[node.id] ?? "pending", capabilityRef: node.capabilityRef,
      profileRef: snapshot?.profileRef ?? null,
      runner: snapshot?.profile.agent ?? snapshot?.profile.executor ?? "unknown",
      cwd: snapshot?.profile.workspaceMode === "none" ? null : snapshot?.profile.workspaceSubdir ?? ".",
      sideEffect: snapshot?.capability.sideEffect ?? "unknown",
      skills: snapshot?.skillInstructions.map(s => s.name) ?? [],
      knowledge: invocation?.knowledgeRefs ?? [], knowledgeRecorded: invocation?.knowledgeRefs !== undefined,
      invocationId: invocation?.id ?? null, artifactCount: result?.artifactRefs.length ?? 0,
      failure: run.failures[node.id] ?? null,
    };
  });
  const edges: GraphEdge[] = [];
  for (const node of run.plan.nodes) {
    for (const from of node.dependsOn) {
      const mappings = Object.entries(node.bindings).filter(([, b]) => b.fromNode === from)
        .map(([input, b]) => ({ input, output: b.field }));
      const condition = node.condition?.fromNode === from ? {field: node.condition.field, equals: node.condition.equals} : undefined;
      edges.push({id: `dep:${from}:${node.id}`, source: capabilityKey(from), target: capabilityKey(node.id),
        kinds: ["dependency", ...(mappings.length ? ["data" as const] : []), ...(condition ? ["condition" as const] : [])],
        mappings, ...(condition ? {condition} : {})});
    }
  }
  for (const obs of run.plan.observations) {
    nodes.push({id: observationKey(obs.id), sourceId: obs.id, kind: "observation", title: obs.id,
      state: run.observationStates[obs.id] ?? "pending", capabilityRef: null, profileRef: null,
      runner: obs.barrier ? "阻塞观察点" : "观察点", cwd: null, sideEffect: "none", skills: [], knowledge: [],
      knowledgeRecorded: false, invocationId: null, artifactCount: 0, failure: null,
      question: obs.question, decision: run.decisions[obs.id]});
    edges.push({id: "observation:" + obs.id, source: capabilityKey(obs.afterNode), target: observationKey(obs.id),
      kinds: ["observation"], mappings: []});
  }
  return {runId: run.id, taskId: run.taskId, revision: run.planRevision, status: run.status,
    rationale: run.plan.rationale, nodes, edges};
}
export function getRunGraph(store: Store, id: string): RunGraph {
  const run = store.get<AdaptiveRun>("adaptive_run", id);
  if (!run) throw new DomainError("run_missing", "运行不存在", 404);
  return projectRun(run, store.list<Invocation>("adaptive_invocation").filter(i => i.runId === id));
}
