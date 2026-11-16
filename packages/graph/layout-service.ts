import { z } from "zod";
import { DomainError } from "../domain/index.js";
import type { Store } from "../persistence/index.js";
import { getRunGraph } from "./projection.js";
import type { CanvasLayout } from "./layout.js";
import type { PlanDraft } from "./types.js";

const PointSchema = z
  .object({
    x: z.number().finite().min(0).max(20000),
    y: z.number().finite().min(0).max(20000),
  })
  .strict();

const ViewportSchema = z
  .object({
    x: z.number().finite().min(-50000).max(50000),
    y: z.number().finite().min(-50000).max(50000),
    zoom: z.number().finite().min(0.1).max(8),
  })
  .strict();

const PositionsSchema = z
  .record(z.string().max(80), PointSchema)
  .refine((p) => Object.keys(p).length <= 50, "最多保存 50 个画布对象");

const input = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    positions: PositionsSchema,
    viewport: ViewportSchema.optional(),
    collapsedGroups: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict();

const patchInput = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    graphId: z.string().min(1).max(120).optional(),
    viewerKey: z.string().min(1).max(120).optional(),
    positions: PositionsSchema.optional(),
    viewport: ViewportSchema.optional(),
    collapsedGroups: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict();

export function readLayout(store: Store, runId: string): CanvasLayout {
  getRunGraph(store, runId);
  return (
    store.get<CanvasLayout>("canvas_layout", runId) ?? {
      id: runId,
      revision: 0,
      positions: {},
    }
  );
}

export function saveLayout(store: Store, runId: string, body: unknown): CanvasLayout {
  const data = input.parse(body);
  return store.transaction(() => {
    const graph = getRunGraph(store, runId);
    const ids = new Set(graph.nodes.map((n) => n.id));
    if (Object.keys(data.positions).some((id) => !ids.has(id))) {
      throw new DomainError(
        "layout_node_missing",
        "布局包含当前计划不存在的节点",
        422,
      );
    }
    const before = readLayout(store, runId);
    if (before.revision !== data.expectedRevision) {
      const err = new DomainError(
        "layout_conflict",
        "布局已在其他页面更新，请重新载入后保存",
        409,
      ) as DomainError & { currentRevision?: number };
      err.currentRevision = before.revision;
      throw err;
    }
    const viewport = data.viewport ?? before.viewport;
    const collapsedGroups = data.collapsedGroups ?? before.collapsedGroups;
    const layout: CanvasLayout = {
      id: runId,
      revision: before.revision + 1,
      positions: data.positions,
      ...(before.graphId !== undefined ? { graphId: before.graphId } : {}),
      ...(before.viewerKey !== undefined ? { viewerKey: before.viewerKey } : {}),
      ...(viewport !== undefined ? { viewport } : {}),
      ...(collapsedGroups !== undefined ? { collapsedGroups } : {}),
    };
    store.put("canvas_layout", layout);
    return layout; // Deliberately no execution event or plan revision mutation.
  });
}

function validNodeIdsForGraph(store: Store, graphId: string): Set<string> | null {
  const run = store.get("adaptive_run", graphId);
  if (run) {
    const graph = getRunGraph(store, graphId);
    return new Set(graph.nodes.map((n) => n.id));
  }
  const draft = store.get<PlanDraft>("graph_draft", graphId);
  if (draft) {
    const ids = new Set<string>();
    for (const node of draft.nodes) {
      ids.add(node.id);
      ids.add(`cap:${node.id}`);
      ids.add(node.engineKey);
      ids.add(`cap:${node.engineKey}`);
    }
    for (const obs of draft.observations) {
      ids.add(obs.id);
      ids.add(`obs:${obs.id}`);
    }
    return ids;
  }
  return null;
}

export function patchLayout(store: Store, id: string, body: unknown): CanvasLayout {
  const data = patchInput.parse(body);
  return store.transaction(() => {
    const before =
      store.get<CanvasLayout>("canvas_layout", id) ??
      ({ id, revision: 0, positions: {} } satisfies CanvasLayout);
    const targetGraphId = data.graphId ?? before.graphId ?? id;
    const validIds = validNodeIdsForGraph(store, targetGraphId);
    if (!validIds) {
      throw new DomainError("layout_target_missing", "目标画布对应的运行或草稿不存在", 404);
    }
    if (data.positions && Object.keys(data.positions).some((k) => !validIds.has(k))) {
      throw new DomainError(
        "layout_node_missing",
        "布局包含当前计划不存在的节点",
        422,
      );
    }
    if (before.revision !== data.expectedRevision) {
      const err = new DomainError(
        "layout_conflict",
        "布局已在其他页面更新，请重新载入后保存",
        409,
      ) as DomainError & { currentRevision?: number };
      err.currentRevision = before.revision;
      throw err;
    }

    const mergedPositions = data.positions
      ? { ...before.positions, ...data.positions }
      : before.positions;
    if (Object.keys(mergedPositions).length > 50) {
      throw new DomainError("layout_limit_exceeded", "最多保存 50 个画布对象", 422);
    }

    const viewport = data.viewport ?? before.viewport;
    const collapsedGroups = data.collapsedGroups ?? before.collapsedGroups;
    const viewerKey = data.viewerKey ?? before.viewerKey;
    const layout: CanvasLayout = {
      id,
      graphId: targetGraphId,
      revision: before.revision + 1,
      positions: mergedPositions,
      ...(viewerKey !== undefined ? { viewerKey } : {}),
      ...(viewport !== undefined ? { viewport } : {}),
      ...(collapsedGroups !== undefined ? { collapsedGroups } : {}),
    };
    store.put("canvas_layout", layout);
    return layout;
  });
}
