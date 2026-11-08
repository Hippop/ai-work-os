import { fork, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../persistence/index.js";
import { WorkService } from "../workflow/service.js";
import { type Run, type Task, type Project } from "../domain/index.js";
import { createWorkspace, workspaceDigest } from "../workspace/index.js";
import type { Job, WorkerMessage } from "./protocol.js";

type Active = {
  outputDir: string;
  artifactSubdir?: string;
  child: ChildProcess;
  epoch: string;
  lastHeartbeat: number;
  result?: Extract<WorkerMessage, { type: "result" }>;
  failure?: string;
};
export class Supervisor {
  active = new Map<string, Active>();
  timer?: NodeJS.Timeout;
  constructor(
    public store: Store,
    public service: WorkService,
    public dataDir: string,
    public command: string,
    public commandPrefix: string[] = [],
  ) {}
  start() {
    // A previous controller's worker is not proven stopped. Preserve its lock until explicit reconciliation.
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
    for (const [id, active] of this.active) {
      const run = this.service.required<Run>("run", id);
      if (
        ["pausing", "cancelling"].includes(run.status) ||
        Date.now() - active.lastHeartbeat > 45000
      ) {
        if (!["pausing", "cancelling"].includes(run.status))
          this.store.transaction(() =>
            this.service.transition(id, "reconciling"),
          );
        if (active.child.connected) active.child.send({ type: "stop" });
      }
    }
    if (this.active.size >= 2) return;
    const row = this.store.db
      .prepare(
        "SELECT id,run_id FROM outbox WHERE state='pending' ORDER BY created_at LIMIT 1",
      )
      .get() as { id: string; run_id: string } | undefined;
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
        criteria: task.acceptanceCriteria,
        testCommand: project.testCommand!,
        deadline,
        completed,
        context: run.manifest.context,
        plan:
          (run.manifest.activePlan as Job["plan"]) ??
          (run.manifest.context as { plan: Job["plan"] })?.plan,
      };
      const child = fork(
        new URL("../../apps/worker/index.ts", import.meta.url),
        [],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          windowsHide: true,
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
      child.send({ type: "execute", job });
    } catch (error) {
      this.store.transaction(() => {
        this.store.event(run.id, "run.error", {
          message: (error as Error).message,
        });
        const current = this.service.required<Run>("run", run.id);
        if (["preparing", "running"].includes(current.status))
          this.service.transition(run.id, "failed");
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
    this.store.transaction(() => {
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
    });
  }
  closed(id: string, code: number | null) {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    this.store.transaction(() => {
      const run = this.service.required<Run>("run", id);
      this.store.event(id, "worker.stopped", { code, epoch: active.epoch });
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
            status: code === 0 ? "interrupted" : "unknown",
          });
      }
      const binding = this.store.get<{ id: string; locked: boolean }>(
        "workspace",
        id,
      );
      let checkpointDigest: string | undefined;
      if (binding && code === 0) {
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
      if (run.status === "cancelling" && code === 0) {
        this.service.transition(id, "cancelled");
        const task = this.service.required<Task>("task", run.taskId);
        this.store.put("task", { ...task, status: "planned" });
      } else if (run.status === "pausing" && code === 0 && checkpointDigest) {
        const paused = this.service.transition(id, "paused");
        this.store.put("run", {
          ...paused,
          steps: paused.steps.map((s) =>
            s.status === "running" ? { ...s, status: "paused" } : s,
          ),
        });
      } else if (run.status === "running" && code === 0 && active.result) {
        let evidenceValid = false;
        try {
          const workspace = this.store.get<{ workspace: string }>(
            "workspace",
            id,
          )!;
          evidenceValid =
            workspaceDigest(workspace.workspace) ===
              active.result.subjectDigest &&
            active.result.artifacts.every(
              (name) =>
                /^[a-zA-Z0-9.-]+$/.test(name) &&
                createHash("sha256")
                  .update(readFileSync(join(active.outputDir, name)))
                  .digest("hex") === active.result!.artifactDigests[name],
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
          this.store.event(id, "delivery.submitted", delivery);
          this.service.transition(id, "succeeded");
          const task = this.service.required<Task>("task", run.taskId);
          this.store.put("task", { ...task, status: "awaiting_acceptance" });
        }
      } else if (run.status === "running" && code === 0 && active.failure) {
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
  async close() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(
      [...this.active.values()].map(
        (active) =>
          new Promise<void>((resolve) => {
            active.child.once("close", () => resolve());
            active.child.send({ type: "stop" });
          }),
      ),
    );
  }
}
