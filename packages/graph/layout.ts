export type Point = { x: number; y: number };
export type CanvasLayout = { id: string; revision: number; positions: Record<string, Point> };
/** Stable layered layout; independent of execution state. Observations are ordinary presentation vertices. */
export function defaultPositions(nodes: {id: string}[], edges: {source: string; target: string}[]): Record<string, Point> {
  const ids = new Set(nodes.map(n => n.id));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0; // tolerate malformed legacy projection without hanging the UI
    visiting.add(id);
    const parents = edges.filter(e => e.target === id && ids.has(e.source));
    const value = parents.length ? Math.max(...parents.map(e => visit(e.source))) + 1 : 0;
    visiting.delete(id); depth.set(id, value); return value;
  };
  const rows = new Map<number, number>();
  return Object.fromEntries(nodes.map(n => {
    const column = visit(n.id), row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return [n.id, {x: 40 + column * 300, y: 40 + row * 160}];
  }));
}
