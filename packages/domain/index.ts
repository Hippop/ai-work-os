import { createHash } from "node:crypto";
import { z } from "zod";

export const TaskInput = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(20000),
  type: z.enum(["development", "diagnosis", "manual"]).default("development"),
  projectId: z.string().uuid().nullable().default(null),
  acceptanceCriteria: z
    .array(z.string().trim().min(1).max(2000))
    .min(1)
    .max(50),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  maxMinutes: z.number().int().min(1).max(120).default(30),
  skillVersionIds: z.array(z.string().uuid()).max(20).default([]),
  knowledgeVersionIds: z.array(z.string().uuid()).max(30).default([]),
  workflowVersionId: z.string().uuid().nullable().default(null),
});
export type TaskData = z.infer<typeof TaskInput>;
export type Task = TaskData & {
  id: string;
  revision: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};
export const ProjectInput = z.object({
  name: z.string().trim().min(1).max(120),
  repositoryPath: z.string().trim().min(1).max(2000),
  description: z.string().max(10000).default(""),
  allowAgent: z.boolean().default(false),
  testCommand: z
    .object({
      executable: z.string().min(1).max(2000),
      args: z.array(z.string().max(4000)).max(100),
    })
    .optional(),
});
export type Project = z.infer<typeof ProjectInput> & {
  id: string;
  createdAt: string;
};
export const terminal = new Set(["succeeded", "failed", "cancelled"]);
export const runTransitions: Record<string, string[]> = {
  queued: ["preparing", "cancelling", "failed"],
  preparing: ["running", "failed", "cancelling", "reconciling"],
  running: [
    "pausing",
    "waiting_input",
    "waiting_approval",
    "reconciling",
    "succeeded",
    "failed",
    "cancelling",
  ],
  pausing: ["paused", "cancelling", "reconciling"],
  paused: ["preparing", "cancelling"],
  waiting_input: ["running", "paused", "failed", "cancelling"],
  waiting_approval: ["running", "paused", "failed", "cancelling"],
  reconciling: ["running", "paused", "failed", "cancelling"],
  cancelling: ["cancelled"],
};
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export function assertTransition(from: string, to: string) {
  if (!runTransitions[from]?.includes(to))
    throw new DomainError("invalid_transition", `不能从 ${from} 转为 ${to}`);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export const workflow = [
  ["analyze", "需求与影响分析"],
  ["design", "方案设计"],
  ["implement", "实现变更"],
  ["test", "测试验证"],
  ["review", "代码审查"],
  ["deliver", "成果交付"],
] as const;
export type Step = {
  operation?: string;
  dependsOn?: string[];
  id: string;
  key: string;
  title: string;
  status: string;
  attempts: number;
};
export type Run = {
  id: string;
  taskId: string;
  taskRevision: number;
  status: string;
  workflowVersion: string;
  steps: Step[];
  createdAt: string;
  updatedAt: string;
  runtime: string;
  manifest: Record<string, unknown>;
};
export type Event = {
  id: string;
  runId: string;
  seq: number;
  type: string;
  actor: string;
  at: string;
  payload: unknown;
};
