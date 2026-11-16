import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
export { canonicalJson } from "./canonical.js";
import { z } from "zod";
import { DomainError } from "../domain/index.js";

const draftNodeKey = z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/);
export const ObservationSpecSchema = z.object({
  id: draftNodeKey,
  afterNode: draftNodeKey,
  on: z.array(z.enum(["succeeded", "failed"])).min(1).max(2).default(["succeeded"]),
  barrier: z.boolean().default(true),
  question: z.string().trim().min(1).max(2000),
  maxInvocations: z.number().int().min(1).max(5).default(1),
});

export const VersionRefSchema = z
  .object({
    id: z.string().min(1).max(180),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    digest: z.string().min(8).max(128),
  })
  .strict();
export type VersionRef = z.infer<typeof VersionRefSchema>;

export const JsonPointerSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^\/(?:[^~/]|~[01])*(?:\/(?:[^~/]|~[01])*)*$/, "必须是合法的 JSON Pointer（例如 /field 或 /a/b）");

export const FieldBindingSchema = z
  .object({
    id: z.string().min(1).max(120),
    target: JsonPointerSchema,
    source: z
      .object({
        nodeId: z.string().min(1).max(120),
        pointer: JsonPointerSchema,
      })
      .strict(),
    required: z.boolean().default(true),
    missing: z.enum(["block", "use-default", "omit"]).default("block"),
    defaultValue: z.unknown().optional(),
  })
  .strict();
export type FieldBinding = z.infer<typeof FieldBindingSchema>;

export const KnowledgeKindSchema = z.enum([
  "fact",
  "hypothesis",
  "decision",
  "pattern",
]);
export type KnowledgeKind = z.infer<typeof KnowledgeKindSchema>;

export const KnowledgeRequirementSchema = z
  .object({
    id: z.string().min(1).max(120),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("pinned"), ref: VersionRefSchema }).strict(),
      z
        .object({
          kind: z.literal("query"),
          query: z.string().trim().min(1).max(1000),
          scopeRefs: z.array(z.string().min(1).max(180)).max(20).default([]),
        })
        .strict(),
      z
        .object({
          kind: z.literal("node-output"),
          nodeId: z.string().min(1).max(120),
          outputId: z.string().min(1).max(120),
        })
        .strict(),
    ]),
    required: z.boolean().default(true),
    acceptedKinds: z.array(KnowledgeKindSchema).min(1).max(4).default(["fact", "pattern", "decision"]),
    purpose: z.string().trim().min(1).max(500),
    resolution: z.enum(["run-start", "producer-completion"]).default("run-start"),
  })
  .strict();
export type KnowledgeRequirement = z.infer<typeof KnowledgeRequirementSchema>;

export const KnowledgeOutputSpecSchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: KnowledgeKindSchema,
    destination: z.enum(["task", "candidate"]),
    evidenceRequired: z.boolean().default(true),
  })
  .strict();
export type KnowledgeOutputSpec = z.infer<typeof KnowledgeOutputSpecSchema>;

export const NodeConditionSchema = z
  .object({
    fromNode: z.string().min(1).max(120),
    pointer: JsonPointerSchema,
    equals: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  })
  .strict();
export type NodeCondition = z.infer<typeof NodeConditionSchema>;

export const EngineKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/);

export const NodeSpecSchema = z
  .object({
    id: z.string().min(1).max(120),
    engineKey: EngineKeySchema,
    title: z.string().trim().min(1).max(160).optional(),
    capabilityRef: VersionRefSchema,
    profileRef: VersionRefSchema.nullable().optional(),
    literals: z.record(z.string(), z.unknown()).default({}),
    bindings: z.array(FieldBindingSchema).max(60).default([]),
    dependsOn: z.array(z.string().min(1).max(120)).max(30).default([]),
    condition: NodeConditionSchema.optional(),
    knowledgeInputs: z.array(KnowledgeRequirementSchema).max(30).default([]),
    knowledgeOutputs: z.array(KnowledgeOutputSpecSchema).max(20).default([]),
    workspace: z
      .object({
        policy: z.literal("run-shared").default("run-shared"),
        subdir: z
          .string()
          .trim()
          .min(1)
          .max(240)
          .regex(/^\.$|^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)*$/)
          .default("."),
      })
      .strict()
      .default({ policy: "run-shared", subdir: "." }),
    actionKey: z.string().min(1).max(240).optional(),
  })
  .strict();
export type NodeSpec = z.infer<typeof NodeSpecSchema>;

export const PlanGapSchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: z.enum(["capability", "knowledge", "configuration"]),
    reason: z.string().trim().min(1).max(2000),
    affectedNodeIds: z.array(z.string().min(1).max(120)).max(30).default([]),
    builderSessionId: z.string().uuid().optional(),
    status: z.enum(["open", "resolved"]).default("open"),
  })
  .strict();
export type PlanGap = z.infer<typeof PlanGapSchema>;

export const PlanDraftSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().default(null),
    goal: z.string().trim().min(1).max(20000),
    revision: z.number().int().positive(),
    schemaVersion: z.literal(3),
    nodes: z.array(NodeSpecSchema).max(30).default([]),
    gaps: z.array(PlanGapSchema).max(30).default([]),
    observations: z.array(ObservationSpecSchema).max(20).default([]),
    rationale: z.string().max(6000).default(""),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

export const CompilerDiagnosticSchema = z
  .object({
    code: z.string(),
    severity: z.enum(["error", "warning"]),
    nodeId: z.string().optional(),
    bindingId: z.string().optional(),
    fieldPointer: z.string().optional(),
    message: z.string(),
    suggestedActions: z.array(z.string()).default([]),
  })
  .strict();
export type CompilerDiagnostic = z.infer<typeof CompilerDiagnosticSchema>;

export type ResourceManifest = {
  capabilities: Record<string, VersionRef>;
  profiles: Record<string, VersionRef>;
  skills: Record<string, { id: string; name: string; digest: string }>;
  knowledge: Record<string, VersionRef>;
};

export type CompiledPlan = {
  id: string;
  draftId: string;
  draftRevision: number;
  taskId: string | null;
  projectId: string | null;
  semanticDigest: string;
  compilerVersion: string;
  executablePlan: unknown;
  nodeSpecs: NodeSpec[];
  resourceManifestRef: string;
  resourceManifest: ResourceManifest;
  pendingProducerBindings: string[];
  preflightDigest: string;
  diagnostics: CompilerDiagnostic[];
  createdAt: string;
};

export type ResultValidity = {
  id: string;
  runId: string;
  nodeId: string;
  invocationId: string;
  state: "valid" | "stale" | "invalid" | "unknown";
  reasons: string[];
  assessedAtRevision: number;
  updatedAt: string;
};

export type EffectRecord = {
  id: string;
  runId: string;
  nodeId: string;
  invocationId: string;
  actionKey: string;
  capabilityRef: string;
  sideEffect: "none" | "read" | "workspace-write" | "external-write";
  targetDigest: string;
  argsDigest: string;
  idempotencyKey?: string;
  receiptRef?: string;
  state: "planned" | "started" | "confirmed" | "uncertain" | "reconciled";
  reason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ResolvedContextManifest = {
  id: string;
  runId: string;
  nodeId: string;
  invocationId: string;
  planRevision: number;
  contextMode: "contract-v3" | "legacy-ancestors";
  capabilityRef: VersionRef;
  profileRef: VersionRef;
  skillRefs: Array<{ id: string; name: string; digest: string }>;
  resolvedInputs: Record<string, unknown>;
  inputDigest: string;
  bindingSources: Array<{
    target: string;
    fromNode: string;
    pointer: string;
    digest: string;
  }>;
  artifactInputs: Array<{ ref: string; digest: string }>;
  knowledgeHits: Array<{
    id: string;
    version: string;
    digest: string;
    requirementId?: string;
    reason: string;
  }>;
  taskObjectiveDigest: string;
  acceptanceCriteriaDigest: string;
  cwdRef: string;
  workspaceDigest: string;
  effectiveConfigDigest: string;
  omissions: Array<{ kind: string; id: string; reason: string }>;
  totalChars: number;
  budgetChars: number;
  assemblerVersion: string;
  assembledPromptDigest: string;
  createdAt: string;
};

export type NodeImpact = {
  nodeId: string;
  engineKey: string;
  action: "keep" | "invalidate" | "add" | "remove" | "modify";
  validityAfter: "valid" | "stale" | "invalid";
  reasons: string[];
  preservedEffect?: boolean;
};

export type ChangeProposal = {
  id: string;
  runId: string;
  baseRevision: number;
  baseStateDigest: string;
  instruction?: string;
  nextPlan: unknown;
  nextNodeSpecs: NodeSpec[];
  diff: {
    addedNodes: string[];
    removedNodes: string[];
    modifiedNodes: string[];
    bindingChanges: string[];
    knowledgeChanges: string[];
  };
  impact: NodeImpact[];
  requiredActions: string[];
  budgetDeltaUsd: number;
  approvalDigest: string;
  status: "pending" | "committed" | "rejected" | "superseded";
  createdAt: string;
  committedAt?: string;
};

export type InterventionRecord = {
  id: string;
  runId: string;
  nodeId?: string;
  mode: "inspect" | "interactive-read" | "interactive-write";
  basePlanRevision: number;
  beforeDigest: string | null;
  afterDigest?: string | null;
  diffArtifactRef?: string;
  sessionRefs: string[];
  externalReconciled: boolean;
  reviewState: "pending" | "adopted" | "discarded";
  note?: string;
  outputMapping?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceHolder = {
  owner: string;
  mode: "read-only" | "write" | "setup" | "intervention";
  epoch: number;
  acquiredAt: string;
};

export type WorkspaceAccess = {
  id: string;
  workspaceId: string;
  owner: string;
  mode: "read-only" | "write" | "setup" | "intervention";
  epoch: number;
  status: "active" | "released" | "needs-reconciliation";
  holders: WorkspaceHolder[];
  processIdentity?: {
    pid: number | null;
    startedAt: string;
    controllerId: string;
    cgroup?: string | null;
  };
  acquiredAt: string;
  updatedAt: string;
  note?: string;
};

export type KnowledgeClaim = {
  id: string;
  knowledgeId: string;
  name: string;
  version: string;
  kind: KnowledgeKind;
  lifecycle: "draft" | "reviewed" | "published" | "revoked";
  verification: "evidence-backed" | "experiment-verified" | "unverified";
  scope: "global" | "project" | "capability" | "task";
  projectId: string | null;
  taskId: string | null;
  capabilityNames: string[];
  content: string;
  contentDigest: string;
  sourceRunId?: string;
  sourceInvocationId?: string;
  evidenceRefs: string[];
  applicableConditions: string[];
  counterEvidence: string[];
  createdAt: string;
};

export type KnowledgeRelation = {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: "conflict" | "supersedes" | "supports" | "derived_from";
  reason: string;
  createdAt: string;
};

export type AgentSession = {
  id: string;
  interventionId: string;
  runId: string;
  nodeId?: string;
  adapter: "codex" | "opencode";
  mode: "interactive-read" | "interactive-write";
  cwdRef: string;
  contextManifestRef?: string;
  processState:
    | "creating"
    | "running"
    | "exited"
    | "stop-unconfirmed"
    | "failed";
  connectionState: "attached" | "detached";
  reviewState: "not-needed" | "pending" | "adopted" | "discarded";
  revision: number;
  rows: number;
  cols: number;
  processIdentity?: {
    pid: number | null;
    startedAt: string;
    controllerId: string;
  };
  createdAt: string;
  updatedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  stopProof?: string;
};

export function semanticDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new DomainError(
      "invalid_json_pointer",
      `JSON Pointer 必须以 / 开头: ${pointer}`,
      422,
    );
  }
  if (pointer === "/") return [""];
  const segments = pointer
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.some((s) => s.length === 0)) {
    throw new DomainError(
      "invalid_json_pointer",
      `不支持空的 JSON Pointer 段: ${pointer}`,
      422,
    );
  }
  return segments;
}

export function pointerToDottedField(pointer: string): string {
  const segments = parseJsonPointer(pointer);
  if (
    !segments.length ||
    segments.some((s) => !/^[a-zA-Z_]\w*$/.test(s))
  ) {
    throw new DomainError(
      "pointer_not_expressible",
      `JSON Pointer 无法无损映射为受控字段路径: ${pointer}`,
      422,
    );
  }
  return segments.join(".");
}

export function resolveSchemaAtPointer(
  schema: Record<string, unknown>,
  pointer: string,
): Record<string, unknown> | null {
  const segments = parseJsonPointer(pointer);
  let current: Record<string, unknown> = schema;
  for (const seg of segments) {
    if (current.type !== "object" || !current.properties || typeof current.properties !== "object") {
      return null;
    }
    const props = current.properties as Record<string, unknown>;
    if (!Object.hasOwn(props, seg)) return null;
    const next = props[seg];
    if (!next || typeof next !== "object" || Array.isArray(next)) return null;
    current = next as Record<string, unknown>;
  }
  return current;
}

export function getValueAtPointer(
  root: unknown,
  pointer: string,
): { found: boolean; value: unknown } {
  const segments = parseJsonPointer(pointer);
  let current: unknown = root;
  for (const seg of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return { found: false, value: undefined };
    }
    if (!Object.hasOwn(current, seg)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return { found: true, value: current };
}

export function setValueAtPointer(
  target: Record<string, unknown>,
  pointer: string,
  value: unknown,
): void {
  const segments = parseJsonPointer(pointer);
  if (!segments.length) {
    throw new DomainError("invalid_json_pointer", "目标路径不能为空", 422);
  }
  let current: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const existing = current[seg];
    if (existing === undefined) {
      current[seg] = {};
    } else if (
      typeof existing !== "object" ||
      existing === null ||
      Array.isArray(existing)
    ) {
      throw new DomainError(
        "binding_target_conflict",
        `字段写入路径冲突: ${pointer}`,
        422,
      );
    }
    current = current[seg] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}
