import { fork, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../persistence/index.js";
import { WorkService } from "../workflow/service.js";
import { type Run, type Task, type Project } from "../domain/index.js";
import { createWorkspace, workspaceDigest } from "../workspace/index.js";
import type { Job, WorkerMessage } from "./protocol.js";
import { validateDiagnosis } from "../diagnosis/index.js";
import { jobDigest, loadReceipt, pidExists, type Lease } from "./receipt.js";
import { executablePath } from "./adapter.js";

type Active = {
  outputDir: string;
  artifactSubdir?: string;
  child: ChildProcess;
  epoch: string;
  lastHeartbeat: number;
  result?: Extract<WorkerMessage, { type: "result" }>;
  failure?: string;
};
type Outcome = Pick<
  Active,
  "epoch" | "outputDir" | "artifactSubdir" | "result" | "failure"
>;
export class Supervisor {
  active = new Map<string, Active>();
  timer?: NodeJS.Timeout;
  private closing = false;
  constructor(
    public store: Store,
    public service: WorkService,
    public dataDir: string,
    public command: string,
    public commandPrefix: string[] = [],
  ) {
    // Manual work remains available when the optional local executor is absent.
    try {
      this.command = executablePath(command);
    } catch {}
  }
  private signal(active: Active, message: { type: string; job?: Job }) {
    if (!active.child.connected) return;
    active.child.send(message, (error) => {
      if (error) {
        active.failure = "Worker IPC disconnected";
        if (active.child.connected) active.child.disconnect();
      }
    });
  }
  start() {
    // Do not infer writer termination from a controller restart.
    this.store.transaction(() => {
      for (const run of this.store.list<Run>("run"))
        if (
          run.runtime !== "manual" &&
          ["preparing", "running", "pausing", "cancelling"].includes(run.status)
        ) {
          if (run.status !== "cancelling")
            this.service.transition(run.id, "reconciling");
          this.store.event(run.id, "recovery.required", {
            reason:
              "Controller restarted; worker stop and side effects require verification",
          });
        }
    });
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        console.error("Scheduler error", error);
      }
    }, 500);
  }
  tick() {
    if (this.closing) return;
    this.recover();
    for (const [id, active] of this.active) {
      const run = this.service.required<Run>("run", id);
      if (
        ["pausing", "cancelling", "reconciling"].includes(run.status) ||
        Date.now() - active.lastHeartbeat > 45000
      ) {
        if (!["pausing", "cancelling", "reconciling"].includes(run.status))
          this.store.transaction(() =>
            this.service.transition(id, "reconciling"),
          );
        this.signal(active, { type: "stop" });
      }
    }
    if (this.active.size >= 2) return;
    const pending = this.store.db
      .prepare(
        "SELECT id,run_id FROM outbox WHERE state='pending' ORDER BY created_at",
      )
      .all() as { id: string; run_id: string }[];
    const eligible = pending.filter((row) => {
      const run = this.service.required<Run>("run", row.run_id);
      if (!["queued", "preparing"].includes(run.status)) return true;
      return ((run.manifest.task as Task).dependsOn ?? []).every(
        (id) => this.store.get<Task>("task", id)?.status === "done",
      );
    });
    const rank = (row: { run_id: string }) => {
      const task = this.service.required<Run>("run", row.run_id).manifest
        .task as Task;
      return task.priority === "high" ? 0 : task.priority === "low" ? 2 : 1;
    };
    const row = eligible.sort((a, b) => rank(a) - rank(b))[0];
    if (!row) return;
    const run = this.service.required<Run>("run", row.run_id);
    if (run.status !== "queued" && run.status !== "preparing") {
      this.store.db
        .prepare("UPDATE outbox SET state='done' WHERE id=?")
        .run(row.id);
      return;
    }
    const epoch = randomUUID();
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE outbox SET state='claimed' WHERE id=? AND state='pending'",
        )
        .run(row.id);
      if (run.status === "queued") this.service.transition(run.id, "preparing");
      this.store.put("dispatch_intent", {
        id: run.id,
        epoch,
        protocol: 1,
        resolved: false,
      });
    });
    try {
      const project = run.manifest.project as Project;
      const existing = this.store.get<{ workspace: string; locked: boolean }>(
        "workspace",
        run.id,
      );
      if (existing?.locked) throw new Error("Existing workspace still locked");
      const workspace =
        existing?.workspace ??
        createWorkspace(
          join(this.dataDir, "workspaces"),
          project.repositoryPath,
          run.id,
          String(run.manifest.baseCommit),
        );
      const task = run.manifest.task as Task;
      const deadline =
        Number(run.manifest.deadline) || Date.now() + task.maxMinutes * 60000;
      const outputDir = existing
        ? join(this.dataDir, "artifacts", run.id, epoch)
        : join(this.dataDir, "artifacts", run.id);
      const attempts = this.store.list<{
        runId: string;
        stepKey: string;
        status: string;
        detail: unknown;
      }>("attempt");
      const completed = Object.fromEntries(
        run.steps
          .filter((s) => s.status === "succeeded")
          .map((s) => [
            s.key,
            attempts.find(
              (a) =>
                a.runId === run.id &&
                a.stepKey === s.key &&
                a.status === "succeeded",
            )?.detail,
          ]),
      );
      const binding = {
        id: run.id,
        workspace,
        repo: project.repositoryPath,
        baseCommit: run.manifest.baseCommit,
        epoch,
        locked: true,
      };
      this.store.transaction(() => {
        const latest = this.service.required<Run>("run", run.id);
        this.store.put("run", {
          ...latest,
          manifest: { ...latest.manifest, deadline },
        });
        this.store.put("workspace", binding);
        this.service.transition(run.id, "running");
        this.store.event(run.id, "workspace.created", binding);
      });
      const job: Job = {
        runId: run.id,
        epoch,
        workspace,
        outputDir,
        command: this.command,
        commandPrefix: this.commandPrefix,
        objective: task.objective,
        taskType: task.type,
        diagnosis: run.manifest.diagnosis as Job["diagnosis"],
        criteria: task.acceptanceCriteria,
        flowInstructions: task.flowRequirements?.instructions ?? "",
        testCommand: project.testCommand!,
        deadline,
        model: run.manifest.model as Job["model"],
        modelReasoning: run.manifest.modelReasoning as Job["modelReasoning"],
        runtimeConfigurationDigest: run.manifest
          .runtimeConfigurationDigest as Job["runtimeConfigurationDigest"],
        completed,
        context: run.manifest.context,
        plan:
          (run.manifest.activePlan as Job["plan"]) ??
          (run.manifest.context as { plan: Job["plan"] })?.plan,
      };
      job.recovery = {
        receiptPath: join(this.dataDir, "receipts", run.id, `${epoch}.json`),
        inputDigest: jobDigest(job),
      };
      const child = fork(
        new URL("../../apps/worker/index.ts", import.meta.url),
        [],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          windowsHide: true,
          // Keep the worker alive long enough to acknowledge controller IPC loss.
          // libuv's implicit Windows parent job otherwise kills non-detached children first.
          detached: process.platform === "win32",
        },
      );
      const active: Active = {
        child,
        epoch,
        outputDir,
        artifactSubdir: existing ? epoch : undefined,
        lastHeartbeat: Date.now(),
      };
      this.active.set(run.id, active);
      child.stderr?.on("data", () => {}); // Worker error content is not exposed as an unaudited successful result.
      child.on("message", (message) =>
        this.message(run.id, message as WorkerMessage),
      );
      child.once("error", (error) => {
        active.failure = error.message;
      });
      child.once("close", (code) => this.closed(run.id, code));
      if (!child.pid) throw new Error("Worker process was not created");
      this.store.put<Lease>("execution_lease", {
        id: run.id,
        epoch,
        workerPid: child.pid,
        inputDigest: job.recovery.inputDigest,
        receiptPath: job.recovery.receiptPath,
        outputDir,
        artifactSubdir: active.artifactSubdir,
        state: "dispatched",
        createdAt: new Date().toISOString(),
      });
      this.signal(active, { type: "execute", job });
    } catch (error) {
      this.store.transaction(() => {
        this.store.event(run.id, "run.error", {
          message: (error as Error).message,
        });
        const current = this.service.required<Run>("run", run.id);
        if (["preparing", "running"].includes(current.status))
          this.service.transition(
            run.id,
            this.active.has(run.id) ? "reconciling" : "failed",
          );
        const active = this.active.get(run.id);
        if (active) this.signal(active, { type: "stop" });
        this.store.db
          .prepare("UPDATE outbox SET state='done' WHERE id=?")
          .run(row.id);
      });
    }
  }
  message(id: string, message: WorkerMessage) {
    const active = this.active.get(id);
    if (!active || active.epoch !== message.epoch) return;
    active.lastHeartbeat = Date.now();
    if (message.type === "heartbeat") return;
    const run = this.service.required<Run>("run", id);
    if (run.status !== "running") return;
    if (message.type === "result") {
      active.result = message;
      return;
    }
    if (message.type === "failure") {
      active.failure = message.message;
      return;
    }
    this.recordStep(id, message);
  }
  private recordStep(
    id: string,
    message: Extract<WorkerMessage, { type: "step" }>,
  ) {
    const run = this.service.required<Run>("run", id);
    if (
      !run.steps.some((s) => s.key === message.key) ||
      !["running", "succeeded"].includes(message.status)
    )
      return;
    this.store.transaction(() => {
      const marker = `${id}:${message.epoch}:${message.attemptId}:${message.status}`;
      if (this.store.get("worker_message", marker)) return;
      const updated = {
        ...run,
        steps: run.steps.map((s) =>
          s.key === message.key
            ? {
                ...s,
                status: message.status,
                attempts: s.attempts + (message.status === "running" ? 1 : 0),
              }
            : s,
        ),
      };
      this.store.put("run", updated);
      this.store.put("attempt", {
        id: message.attemptId,
        runId: id,
        stepKey: message.key,
        epoch: message.epoch,
        status: message.status,
        detail: message.detail,
        updatedAt: new Date().toISOString(),
      });
      this.store.event(id, "step.updated", message, "worker");
      this.store.put("worker_message", { id: marker });
    });
  }
  closed(id: string, code: number | null) {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    const lease = this.store.get<Lease>("execution_lease", id),
      receipt = lease && loadReceipt(lease);
    const confirmed =
      code === 0 &&
      lease?.epoch === active.epoch &&
      receipt?.stopped === true &&
      receipt.childPid === null;
    if (confirmed && receipt) {
      for (const message of receipt.messages) {
        if (message.type === "step") this.recordStep(id, message);
        else if (message.type === "result") active.result = message;
        else active.failure = message.message;
      }
    }
    this.settle(id, active, confirmed);
  }
  private settle(id: string, active: Outcome, confirmed: boolean) {
    this.store.transaction(() => {
      let run = this.service.required<Run>("run", id);
      this.store.event(id, "worker.stopped", {
        confirmed,
        epoch: active.epoch,
      });
      if (confirmed) {
        const lease = this.store.get<Lease>("execution_lease", id);
        if (lease?.epoch === active.epoch)
          this.store.put("execution_lease", { ...lease, state: "stopped" });
      }
      for (const attempt of this.store.list<{
        id: string;
        runId: string;
        epoch: string;
        status: string;
      }>("attempt")) {
        if (
          attempt.runId === id &&
          attempt.epoch === active.epoch &&
          attempt.status === "running"
        )
          this.store.put("attempt", {
            ...attempt,
            status: confirmed ? "interrupted" : "unknown",
          });
      }
      const binding = this.store.get<{ id: string; locked: boolean }>(
        "workspace",
        id,
      );
      let checkpointDigest: string | undefined;
      if (binding && confirmed) {
        try {
          checkpointDigest = workspaceDigest(
            (binding as unknown as { workspace: string }).workspace,
          );
        } catch (error) {
          this.store.event(id, "checkpoint.failed", {
            message: (error as Error).message,
          });
        }
        this.store.put("workspace", {
          ...binding,
          locked: false,
          checkpointDigest,
        });
      }
      if (run.status === "reconciling" && confirmed && active.result)
        run = this.service.transition(id, "running");
      if (run.status === "cancelling" && confirmed) {
        this.service.transition(id, "cancelled");
        const task = this.service.required<Task>("task", run.taskId);
        this.store.put("task", { ...task, status: "planned" });
      } else if (
        ["pausing", "reconciling"].includes(run.status) &&
        confirmed &&
        checkpointDigest &&
        (run.status === "pausing" || (!active.result && !active.failure))
      ) {
        const paused = this.service.transition(id, "paused");
        this.store.put("run", {
          ...paused,
          steps: paused.steps.map((s) =>
            s.status === "running" ? { ...s, status: "paused" } : s,
          ),
        });
      } else if (run.status === "running" && confirmed && active.result) {
        let evidenceValid = false;
        try {
          const workspace = this.store.get<{ workspace: string }>(
            "workspace",
            id,
          )!;
          const requiredArtifacts =
            (run.manifest.task as Task).type === "diagnosis"
              ? ["diagnosis.json", "context.json", "delivery.json"]
              : [
                  "changes.patch",
                  "untracked.json",
                  "files.json",
                  "test.json",
                  "delivery.json",
                ];
          evidenceValid =
            requiredArtifacts.every((name) =>
              active.result!.artifacts.includes(name),
            ) &&
            workspaceDigest(workspace.workspace) ===
              active.result.subjectDigest &&
            active.result.artifacts.every(
              (name) =>
                /^[a-zA-Z0-9.-]+$/.test(name) &&
                createHash("sha256")
                  .update(readFileSync(join(active.outputDir, name)))
                  .digest("hex") === active.result!.artifactDigests[name],
            );
          if ((run.manifest.task as Task).type === "diagnosis")
            validateDiagnosis(
              active.result.diagnosisReport,
              (run.manifest.diagnosis as NonNullable<Job["diagnosis"]>)
                .evidence,
            );
        } catch {
          evidenceValid = false;
        }
        if (!evidenceValid || run.steps.some((s) => s.status !== "succeeded")) {
          this.service.transition(id, "failed");
          this.store.event(id, "run.error", {
            message:
              "Missing required step results or invalid delivery evidence",
          });
        } else {
          const delivery = {
            id: randomUUID(),
            runId: id,
            taskRevision: run.taskRevision,
            ...active.result,
            artifactSubdir: active.artifactSubdir,
            createdAt: new Date().toISOString(),
          };
          this.store.put("delivery", delivery);
          if (active.result.diagnosisReport)
            this.store.put("diagnosis_report", {
              ...active.result.diagnosisReport,
              id: randomUUID(),
              taskId: run.taskId,
              runId: id,
              inputDigest: (
                run.manifest.diagnosis as NonNullable<Job["diagnosis"]>
              ).digest,
              evidenceSnapshot: (
                run.manifest.diagnosis as NonNullable<Job["diagnosis"]>
              ).evidence,
              createdAt: new Date().toISOString(),
            });
          this.store.event(id, "delivery.submitted", delivery);
          this.service.transition(id, "succeeded");
          const task = this.service.required<Task>("task", run.taskId);
          this.store.put("task", { ...task, status: "awaiting_acceptance" });
        }
      } else if (
        ["running", "reconciling"].includes(run.status) &&
        confirmed &&
        active.failure
      ) {
        this.service.transition(id, "failed");
        this.store.event(id, "run.error", { message: active.failure });
      } else if (run.status === "running" || run.status === "pausing") {
        this.service.transition(id, "reconciling");
        this.store.event(id, "recovery.required", {
          reason: active.failure ?? "Worker exit outcome unknown",
        });
      }
      this.store.db
        .prepare("UPDATE outbox SET state='done' WHERE run_id=?")
        .run(id);
    });
  }
  recover() {
    for (const run of this.store.list<Run>("run")) {
      if (
        this.active.has(run.id) ||
        !["reconciling", "cancelling"].includes(run.status)
      )
        continue;
      const lease = this.store.get<Lease>("execution_lease", run.id);
      const intent = this.store.get<{
        id: string;
        epoch: string;
        protocol: number;
        resolved: boolean;
      }>("dispatch_intent", run.id);
      if (
        intent?.protocol === 1 &&
        !intent.resolved &&
        lease?.epoch !== intent.epoch
      ) {
        this.store.transaction(() => {
          const binding = this.store.get<{
            id: string;
            epoch: string;
            workspace: string;
            locked: boolean;
          }>("workspace", run.id);
          let checkpointDigest: string | undefined;
          if (binding?.epoch === intent.epoch) {
            try {
              checkpointDigest = workspaceDigest(binding.workspace);
            } catch {}
            this.store.put("workspace", {
              ...binding,
              locked: false,
              checkpointDigest,
            });
          }
          this.store.event(run.id, "recovery.not_dispatched", {
            epoch: intent.epoch,
          });
          this.store.put("dispatch_intent", { ...intent, resolved: true });
          if (run.status === "cancelling") {
            this.service.transition(run.id, "cancelled");
            const task = this.service.required<Task>("task", run.taskId);
            this.store.put("task", { ...task, status: "planned" });
          } else
            this.service.transition(
              run.id,
              checkpointDigest ? "paused" : "failed",
            );
          this.store.db
            .prepare("UPDATE outbox SET state='done' WHERE run_id=?")
            .run(run.id);
        });
        continue;
      }
      if (!lease || lease.state === "stopped" || pidExists(lease.workerPid))
        continue;
      if (
        this.store.get<{ epoch: string }>("workspace", run.id)?.epoch !==
        lease.epoch
      )
        continue;
      const receipt = loadReceipt(lease);
      // POSIX process groups allow detached descendants; they cannot prove full containment.
      if (
        !receipt?.stopped ||
        receipt.childPid !== null ||
        receipt.containment !== "windows-job-v1" ||
        (receipt.lastChildPid && pidExists(receipt.lastChildPid))
      )
        continue;
      this.store.transaction(() => {
        for (const message of receipt.messages)
          if (message.type === "step") this.recordStep(run.id, message);
        this.store.event(run.id, "recovery.verified", {
          epoch: lease.epoch,
          inputDigest: lease.inputDigest,
          method: "durable-worker-receipt",
        });
        this.settle(
          run.id,
          {
            ...lease,
            result: receipt.messages.find((m) => m.type === "result"),
            failure: receipt.messages.find((m) => m.type === "failure")
              ?.message,
          },
          true,
        );
      });
    }
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(
      [...this.active.values()].map(
        (active) =>
          new Promise<void>((resolve, reject) => {
            const id = [...this.active].find(([, a]) => a === active)?.[0];
            const timer = setTimeout(() => {
              if (id) {
                const run = this.service.required<Run>("run", id);
                if (["running", "pausing"].includes(run.status))
                  this.service.transition(id, "reconciling");
                this.store.event(id, "recovery.required", {
                  reason: "Shutdown timed out; workspace lock retained",
                });
              }
              reject(
                new Error("Worker shutdown timed out; workspace lock retained"),
              );
            }, 30000);
            active.child.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            if (
              id &&
              this.service.required<Run>("run", id).status === "running"
            )
              this.service.control(id, "pause");
            this.signal(active, { type: "stop" });
          }),
      ),
    );
  }
}
