export type RunLink = {
  id: string;
  taskId: string;
  status: string;
  createdAt: string;
  engine?: "adaptive" | "legacy";
};
export function taskRunLink(
  taskId: string,
  legacy: RunLink[],
  adaptive: RunLink[],
) {
  const terminal = new Set(["done", "succeeded", "failed", "cancelled"]);
  return [
    ...legacy.map((r) => ({ ...r, engine: "legacy" as const })),
    ...adaptive.map((r) => ({ ...r, engine: "adaptive" as const })),
  ]
    .filter((r) => r.taskId === taskId)
    .sort(
      (a, b) =>
        Number(terminal.has(a.status)) - Number(terminal.has(b.status)) ||
        b.createdAt.localeCompare(a.createdAt),
    )[0];
}
