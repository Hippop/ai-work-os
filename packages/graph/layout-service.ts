import { z } from "zod";
import { DomainError } from "../domain/index.js";
import type { Store } from "../persistence/index.js";
import { getRunGraph } from "./projection.js";
import type { CanvasLayout } from "./layout.js";
const input = z.object({
  expectedRevision: z.number().int().nonnegative(),
  positions: z.record(z.string().max(80), z.object({
    x: z.number().finite().min(0).max(20000), y: z.number().finite().min(0).max(20000),
  }).strict()).refine(p => Object.keys(p).length <= 50, "最多保存 50 个画布对象"),
}).strict();
export function readLayout(store: Store, runId: string): CanvasLayout {
  getRunGraph(store, runId);
  return store.get<CanvasLayout>("canvas_layout", runId) ?? {id: runId, revision: 0, positions: {}};
}
export function saveLayout(store: Store, runId: string, body: unknown): CanvasLayout {
  const data = input.parse(body);
  return store.transaction(() => {
    const graph = getRunGraph(store, runId);
    const ids = new Set(graph.nodes.map(n => n.id));
    if (Object.keys(data.positions).some(id => !ids.has(id)))
      throw new DomainError("layout_node_missing", "布局包含当前计划不存在的节点", 422);
    const before = readLayout(store, runId);
    if (before.revision !== data.expectedRevision)
      throw new DomainError("layout_conflict", "布局已在其他页面更新，请重新载入后保存", 409);
    const layout = {id: runId, revision: before.revision + 1, positions: data.positions};
    store.put("canvas_layout", layout);
    return layout; // Deliberately no execution event or plan revision mutation.
  });
}
