import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { digest } from "../domain/index.js";
import type { Job, WorkerMessage } from "./protocol.js";

const Message = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("step"),
    epoch: z.string().uuid(),
    key: z.string().min(1),
    status: z.enum(["running", "succeeded"]),
    attemptId: z.string().uuid(),
    detail: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("failure"),
    epoch: z.string().uuid(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("result"),
    epoch: z.string().uuid(),
    summary: z.string(),
    subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
    artifacts: z.array(z.string()).max(100),
    artifactDigests: z.record(z.string(), z.string()),
    diagnosisReport: z.unknown().optional(),
  }),
]);
const ReceiptSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  epoch: z.string().uuid(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  workerPid: z.number().int().positive(),
  containment: z.enum(["windows-job-v1", "posix-process-group"]),
  updatedAt: z.string(),
  stopped: z.boolean(),
  stopError: z.string().optional(),
  childPid: z.number().int().positive().nullable(),
  lastChildPid: z.number().int().positive().nullable(),
  messages: z.array(Message).max(1000),
});
export type Receipt = {
  version: 1;
  runId: string;
  epoch: string;
  inputDigest: string;
  workerPid: number;
  containment: "windows-job-v1" | "posix-process-group";
  updatedAt: string;
  stopped: boolean;
  stopError?: string;
  childPid: number | null;
  lastChildPid: number | null;
  messages: Exclude<WorkerMessage, { type: "heartbeat" }>[];
};
export type Lease = {
  id: string;
  epoch: string;
  workerPid: number;
  inputDigest: string;
  receiptPath: string;
  outputDir: string;
  artifactSubdir?: string;
  state: "dispatched" | "stopped";
  createdAt: string;
};
export function jobDigest(job: Job) {
  const { recovery: _, ...input } = job;
  return digest(input);
}
export function saveReceipt(path: string, receipt: Receipt) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`,
    fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
export function loadReceipt(lease: Lease): Receipt | undefined {
  try {
    if (statSync(lease.receiptPath).size > 16_000_000) return;
    const r = ReceiptSchema.parse(
      JSON.parse(readFileSync(lease.receiptPath, "utf8")),
    );
    if (
      r.runId !== lease.id ||
      r.epoch !== lease.epoch ||
      r.workerPid !== lease.workerPid ||
      r.inputDigest !== lease.inputDigest ||
      r.messages.some((m) => m.epoch !== r.epoch)
    )
      return;
    return r as Receipt;
  } catch {
    return;
  }
}
// An alive or inaccessible PID is never evidence that the old writer stopped.
export function pidExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
