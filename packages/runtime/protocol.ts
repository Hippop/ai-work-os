export type TestCommand = { executable: string; args: string[] };
export type Job = {
  runId: string;
  epoch: string;
  recovery?: { receiptPath: string; inputDigest: string };
  workspace: string;
  outputDir: string;
  command: string;
  commandPrefix: string[];
  objective: string;
  criteria: string[];
  flowInstructions?: string;
  testCommand: TestCommand;
  deadline: number;
  model?: string | null;
  modelReasoning?: string | null;
  runtimeConfigurationDigest?: string | null;
  plan?: import("../resources/index.js").PlanNode[];
  context?: unknown;
  completed?: Record<string, unknown>;
  taskType?: string;
  diagnosis?: {
    evidence: import("../diagnosis/index.js").Evidence[];
    hypotheses: unknown[];
    digest: string;
  };
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
      diagnosisReport?: import("../diagnosis/index.js").DiagnosisReport;
    }
  | { type: "failure"; epoch: string; message: string };
