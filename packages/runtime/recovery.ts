import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, type Run, type Task } from "../domain/index.js";
import type { Store } from "../persistence/index.js";
import type { WorkService } from "../workflow/service.js";
import { workspaceDigest } from "../workspace/index.js";
import { loadReceipt, pidExists, type Lease } from "./receipt.js";

type Binding = {
  id: string;
  epoch?: string;
  workspace: string;
  locked: boolean;
  checkpointDigest?: string;
};
export const ReconciliationInput = z.object({
  expectedEpoch: z.string().uuid().nullable(),
  subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
  workerStopped: z.literal(true),
  externalActionsReconciled: z.literal(true),
  reason: z.string().trim().min(10).max(10000),
});
export function inspectRecovery(
  store: Store,
  service: WorkService,
  id: string,
) {
  const run = service.required<Run>("run", id),
    lease = store.get<Lease>("execution_lease", id),
    binding = store.get<Binding>("workspace", id),
    receipt = lease && loadReceipt(lease);
  const knownPids = [
    ...new Set(
      [lease?.workerPid, receipt?.childPid, receipt?.lastChildPid].filter(
        (p): p is number => !!p,
      ),
    ),
  ];
  let subjectDigest: string | null = null;
  try {
    if (binding) subjectDigest = workspaceDigest(binding.workspace);
  } catch {}
  return {
    runId: run.id,
    status: run.status,
    epoch: lease?.epoch ?? binding?.epoch ?? null,
    workspace: binding?.workspace ?? null,
    locked: binding?.locked ?? false,
    subjectDigest,
    knownProcesses: knownPids.map((pid) => ({ pid, alive: pidExists(pid) })),
    receipt: receipt
      ? {
          stopped: receipt.stopped,
          containment: receipt.containment,
          updatedAt: receipt.updatedAt,
        }
      : null,
  };
}
export function reconcileManually(
  store: Store,
  service: WorkService,
  id: string,
  input: unknown,
) {
  const parsed = ReconciliationInput.parse(input);
  return store.transaction(() => {
    const run = service.required<Run>("run", id),
      view = inspectRecovery(store, service, id);
    if (!["reconciling", "cancelling"].includes(run.status))
      throw new DomainError("not_reconciling", "该运行不在待核对状态");
    if (parsed.expectedEpoch !== view.epoch)
      throw new DomainError("stale_epoch", "执行批次已变化，请重新检查");
    if (view.knownProcesses.some((p) => p.alive))
      throw new DomainError(
        "writer_alive",
        "仍有已知进程存活或无法核实，不能解除写锁",
      );
    if (!view.subjectDigest || view.subjectDigest !== parsed.subjectDigest)
      throw new DomainError(
        "workspace_changed",
        "工作区已变化或不能读取，请重新检查",
      );
    const binding = service.required<Binding>("workspace", id),
      lease = store.get<Lease>("execution_lease", id);
    store.put("workspace", {
      ...binding,
      locked: false,
      checkpointDigest: view.subjectDigest,
    });
    if (lease) store.put("execution_lease", { ...lease, state: "stopped" });
    const decision = {
      id: randomUUID(),
      runId: id,
      epoch: view.epoch,
      actor: "owner",
      method: "manual-attestation",
      reason: parsed.reason,
      externalActionsReconciled: true,
      subjectDigest: view.subjectDigest,
      knownProcesses: view.knownProcesses,
      createdAt: new Date().toISOString(),
    };
    store.put("reconciliation", decision);
    store.event(id, "recovery.manually_reconciled", decision, "owner");
    for (const attempt of store.list<{
      id: string;
      runId: string;
      status: string;
    }>("attempt"))
      if (attempt.runId === id && attempt.status === "running")
        store.put("attempt", { ...attempt, status: "unknown" });
    const next = service.transition(
      id,
      run.status === "cancelling" ? "cancelled" : "paused",
    );
    // Owner review cannot resurrect old test evidence. Re-execute all stages on resume.
    store.put("run", {
      ...next,
      steps: next.steps.map((s) => ({ ...s, status: "pending" })),
    });
    const task = service.required<Task>("task", run.taskId);
    store.put("task", {
      ...task,
      status: next.status === "cancelled" ? "planned" : "in_progress",
    });
    store.db.prepare("UPDATE outbox SET state='done' WHERE run_id=?").run(id);
    return service.required<Run>("run", id);
  });
}

type Ownership = { id: string; owner: string; pid: number; released?: boolean };
export function acquireController(store: Store) {
  const owner = randomUUID();
  store.transaction(() => {
    const previous = store.get<Ownership>("runtime_ownership", "controller");
    if (previous && !previous.released && pidExists(previous.pid))
      throw new DomainError(
        "controller_active",
        "同一数据目录已有控制服务，不能同时启动",
      );
    store.put<Ownership>("runtime_ownership", {
      id: "controller",
      owner,
      pid: process.pid,
    });
  });
  return () =>
    store.transaction(() => {
      const record = store.get<Ownership>("runtime_ownership", "controller");
      if (record?.owner === owner)
        store.put("runtime_ownership", { ...record, released: true });
    });
}
