export type TestCommand = { executable: string; args: string[] };
export type Job = {
  runId: string;
  epoch: string;
  workspace: string;
  outputDir: string;
  command: string;
  commandPrefix: string[];
  objective: string;
  criteria: string[];
  testCommand: TestCommand;
  deadline: number;
  plan?: import("../resources/index.js").PlanNode[];
  context?: unknown;
  completed?: Record<string, unknown>;
};
export type WorkerMessage =
  | { type: "heartbeat"; epoch: string }
  | {
      type: "step";
      epoch: string;
      key: string;
      status: string;
      attemptId: string;
      detail?: unknown;
    }
  | {
      type: "result";
      epoch: string;
      summary: string;
      subjectDigest: string;
      artifacts: string[];
      artifactDigests: Record<string, string>;
    }
  | { type: "failure"; epoch: string; message: string };
