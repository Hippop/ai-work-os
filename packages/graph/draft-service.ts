import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AssetService, type Capability } from "../adaptive/assets.js";
import { DomainError, type Project, type Task } from "../domain/index.js";
import type { Store } from "../persistence/index.js";
import {
  FieldBindingSchema,
  KnowledgeRequirementSchema,
  NodeConditionSchema,
  NodeSpecSchema,
  ObservationSpecSchema,
  PlanDraftSchema,
  PlanGapSchema,
  VersionRefSchema,
  semanticDigest,
  type NodeSpec,
  type PlanDraft,
  type PlanGap,
} from "./types.js";

const CreateDraftInput = z
  .object({
    projectId: z.string().uuid().nullable().optional(),
    taskId: z.string().uuid().nullable().optional(),
    goal: z.string().trim().min(1).max(20000),
    nodes: z.array(NodeSpecSchema).max(30).default([]),
    gaps: z.array(PlanGapSchema).max(30).default([]),
    observations: z.array(ObservationSpecSchema).max(20).default([]),
    rationale: z.string().max(6000).default(""),
  })
  .strict();

export const DraftOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("addNode"),
      node: NodeSpecSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("updateNode"),
      nodeId: z.string().min(1).max(120),
      patch: z
        .object({
          title: z.string().trim().min(1).max(160).optional(),
          capabilityRef: VersionRefSchema.optional(),
          profileRef: VersionRefSchema.nullable().optional(),
          literals: z.record(z.string(), z.unknown()).optional(),
          dependsOn: z.array(z.string().min(1).max(120)).max(30).optional(),
          condition: NodeConditionSchema.nullable().optional(),
          actionKey: z.string().min(1).max(240).optional(),
          workspace: z
            .object({
              policy: z.literal("run-shared").default("run-shared"),
              subdir: z
                .string()
                .trim()
                .min(1)
                .max(240)
                .regex(/^\.$|^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)*$/),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("removeNode"),
      nodeId: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      op: z.literal("addBinding"),
      nodeId: z.string().min(1).max(120),
      binding: FieldBindingSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("updateBinding"),
      nodeId: z.string().min(1).max(120),
      bindingId: z.string().min(1).max(120),
      patch: z
        .object({
          target: z.string().min(1).max(240).optional(),
          source: z
            .object({
              nodeId: z.string().min(1).max(120),
              pointer: z.string().min(1).max(240),
            })
            .strict()
            .optional(),
          required: z.boolean().optional(),
          missing: z.enum(["block", "use-default", "omit"]).optional(),
          defaultValue: z.unknown().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("removeBinding"),
      nodeId: z.string().min(1).max(120),
      bindingId: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      op: z.literal("addDependency"),
      nodeId: z.string().min(1).max(120),
      dependsOnNodeId: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      op: z.literal("removeDependency"),
      nodeId: z.string().min(1).max(120),
      dependsOnNodeId: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      op: z.literal("addKnowledgeRequirement"),
      nodeId: z.string().min(1).max(120),
      requirement: KnowledgeRequirementSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("removeKnowledgeRequirement"),
      nodeId: z.string().min(1).max(120),
      requirementId: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      op: z.literal("addGap"),
      gap: PlanGapSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("resolveGap"),
      gapId: z.string().min(1).max(120),
      builderSessionId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("setObservations"),
      observations: z.array(ObservationSpecSchema).max(20),
    })
    .strict(),
  z
    .object({
      op: z.literal("replaceNodes"),
      nodes: z.array(NodeSpecSchema).max(30),
      gaps: z.array(PlanGapSchema).max(30).optional(),
      observations: z.array(ObservationSpecSchema).max(20).optional(),
      rationale: z.string().max(6000).optional(),
    })
    .strict(),
]);

export type DraftOperation = z.infer<typeof DraftOperationSchema>;

const PatchDraftInput = z
  .object({
    expectedRevision: z.number().int().positive(),
    goal: z.string().trim().min(1).max(20000).optional(),
    rationale: z.string().max(6000).optional(),
    operations: z.array(DraftOperationSchema).min(1).max(100),
  })
  .strict();

const ComposeDraftInput = z
  .object({
    expectedRevision: z.number().int().positive(),
    instruction: z.string().trim().min(1).max(10000),
    executionAgent: z.enum(["codex", "opencode"]).optional(),
  })
  .strict();

export type DraftComposeOperation = {
  id: string;
  draftId: string;
  baseRevision: number;
  status: "pending" | "succeeded" | "failed" | "conflict";
  instruction: string;
  executionAgent?: "codex" | "opencode";
  error?: string;
  createdAt: string;
  finishedAt?: string;
};

export type ComposeHook = (args: {
  draft: PlanDraft;
  instruction: string;
  executionAgent?: "codex" | "opencode";
}) => Promise<{
  nodes: NodeSpec[];
  gaps?: PlanGap[];
  observations?: PlanDraft["observations"];
  rationale?: string;
}>;

export function findNodeByAnyId(
  nodes: NodeSpec[],
  nodeId: string,
): { node: NodeSpec; index: number } | undefined {
  const idx = nodes.findIndex((n) => n.id === nodeId || n.engineKey === nodeId);
  return idx >= 0 ? { node: nodes[idx], index: idx } : undefined;
}

export function applyDraftOperationToGraph(
  draft: Pick<PlanDraft, "nodes" | "gaps" | "observations"> & { rationale?: string },
  op: DraftOperation,
): void {
  switch (op.op) {
    case "addNode": {
      if (
        draft.nodes.some(
          (n) => n.id === op.node.id || n.engineKey === op.node.engineKey,
        )
      ) {
        throw new DomainError(
          "duplicate_node",
          `节点标识或 engineKey 已存在: ${op.node.id} / ${op.node.engineKey}`,
          422,
        );
      }
      draft.nodes.push(structuredClone(op.node));
      break;
    }
    case "updateNode": {
      const hit = findNodeByAnyId(draft.nodes, op.nodeId);
      if (!hit) {
        throw new DomainError("node_missing", `节点不存在: ${op.nodeId}`, 404);
      }
      const n = hit.node;
      if (op.patch.title !== undefined) n.title = op.patch.title;
      if (op.patch.capabilityRef !== undefined) {
        n.capabilityRef = op.patch.capabilityRef;
      }
      if (op.patch.profileRef !== undefined) n.profileRef = op.patch.profileRef;
      if (op.patch.literals !== undefined) {
        n.literals = structuredClone(op.patch.literals);
      }
      if (op.patch.dependsOn !== undefined) n.dependsOn = [...op.patch.dependsOn];
      if (op.patch.condition !== undefined) {
        if (op.patch.condition === null) {
          delete n.condition;
        } else {
          n.condition = op.patch.condition;
        }
      }
      if (op.patch.actionKey !== undefined) n.actionKey = op.patch.actionKey;
      if (op.patch.workspace !== undefined) n.workspace = op.patch.workspace;
      break;
    }
    case "removeNode": {
      const hit = findNodeByAnyId(draft.nodes, op.nodeId);
      if (!hit) {
        throw new DomainError("node_missing", `节点不存在: ${op.nodeId}`, 404);
      }
      const removedId = hit.node.id;
      const removedEngineKey = hit.node.engineKey;
      const isRemoved = (ref: string) =>
        ref === removedId || ref === removedEngineKey;
      draft.nodes.splice(hit.index, 1);
      for (const node of draft.nodes) {
        node.dependsOn = node.dependsOn.filter((d) => !isRemoved(d));
        node.bindings = node.bindings.filter(
          (b) => !isRemoved(b.source.nodeId),
        );
        if (node.condition && isRemoved(node.condition.fromNode)) {
          delete node.condition;
        }
        node.knowledgeInputs = node.knowledgeInputs.filter(
          (req) =>
            req.source.kind !== "node-output" ||
            !isRemoved(req.source.nodeId),
        );
      }
      draft.observations = draft.observations.filter(
        (obs) => !isRemoved(obs.afterNode),
      );
      break;
    }
    case "addBinding": {
      const hit = findNodeByAnyId(draft.nodes, op.nodeId);
      if (!hit) {
        throw new DomainError("node_missing", `节点不存在: ${op.nodeId}`, 404);
      }
      if (hit.node.bindings.some((b) => b.id === op.binding.id)) {
        throw new DomainError(
          "duplicate_binding",
          `节点 ${op.nodeId} 已存在绑定 ${op.binding.id}`,
          422,
        );
      }
      hit.node.bindings.push(structuredClone(op.binding));
      break;
    }
    case "updateBinding": {
      const hit = findNodeByAnyId(draft.nodes, op.nodeId);
      if (!hit) {
        throw new DomainError("node_missing", `节点不存在: ${op.nodeId}`, 404);
      }
      const binding = hit.node.bindings.find((b) => b.id === op.bindingId);
      if (!binding) {
        throw new DomainError(
          "binding_missing",
          `绑定不存在: ${op.bindingId}`,
          404,
        );
      }
      if (op.patch.target !== undefined) binding.target = op.patch.target;
      if (op.patch.source !== undefined) binding.source = op.patch.source;
      if (op.patch.required !== undefined) binding.required = op.patch.required;
      if (op.patch.missing !== undefined) binding.missing = op.patch.missing;
      if (op.patch.defaultValue !== undefined) {
        binding.defaultValue = op.patch.defaultValue;
      }
      FieldBindingSchema.parse(binding);
      break;
    }
    case "removeBinding": {
      // Unbinding a data wire MUST preserve explicit dependsOn and sibling bindings (A03).
      const hit = findNodeByAnyId(draft.nodes, op.nodeId);
      if (!hit) {
        throw new DomainError("node_missing", `节点不存在: ${op.nodeId}`, 404);
      }
      const idx = hit.node.bindings.findIndex((b) => b.id === op.bindingId);
      if (idx < 0) {
        throw new DomainError(
          "binding_missing",
          `绑定不存在: ${op.bindingId}`,
          404,
        );
      }
      hit.node.bindings.splice(idx, 1);
      break;
    }
    case "addDependency": {
      const hit = findNodeByAnyId(draft.nodes, op.nodeId);
      if (!hit) {
        throw new DomainError("node_missing", `节点不存在: ${op.nodeId}`, 404);
      }
      if (!hit.node.dependsOn.includes(op.dependsOnNodeId)) {
        hit.node.dependsOn.push(op.dependsOnNodeId);
      }
      break;
    }
    case "removeDependency": {
      const hit = findNodeByAnyId(draft.nodes, op.nodeId);
      if (!hit) {
        throw new DomainError("node_missing", `节点不存在: ${op.nodeId}`, 404);
      }
      hit.node.dependsOn = hit.node.dependsOn.filter(
        (d) => d !== op.dependsOnNodeId,
      );
      break;
    }
    case "addKnowledgeRequirement": {
      const hit = findNodeByAnyId(draft.nodes, op.nodeId);
      if (!hit) {
        throw new DomainError("node_missing", `节点不存在: ${op.nodeId}`, 404);
      }
      if (
        hit.node.knowledgeInputs.some((k) => k.id === op.requirement.id)
      ) {
        throw new DomainError(
          "duplicate_knowledge_requirement",
          `知识需求已存在: ${op.requirement.id}`,
          422,
        );
      }
      hit.node.knowledgeInputs.push(structuredClone(op.requirement));
      break;
    }
    case "removeKnowledgeRequirement": {
      const hit = findNodeByAnyId(draft.nodes, op.nodeId);
      if (!hit) {
        throw new DomainError("node_missing", `节点不存在: ${op.nodeId}`, 404);
      }
      hit.node.knowledgeInputs = hit.node.knowledgeInputs.filter(
        (k) => k.id !== op.requirementId,
      );
      break;
    }
    case "addGap": {
      if (draft.gaps.some((g) => g.id === op.gap.id)) {
        throw new DomainError(
          "duplicate_gap",
          `缺口记录已存在: ${op.gap.id}`,
          422,
        );
      }
      draft.gaps.push(structuredClone(op.gap));
      break;
    }
    case "resolveGap": {
      const gap = draft.gaps.find((g) => g.id === op.gapId);
      if (!gap) {
        throw new DomainError("gap_missing", `缺口记录不存在: ${op.gapId}`, 404);
      }
      gap.status = "resolved";
      if (op.builderSessionId) {
        gap.builderSessionId = op.builderSessionId;
      }
      break;
    }
    case "setObservations": {
      draft.observations = structuredClone(op.observations);
      break;
    }
    case "replaceNodes": {
      draft.nodes = structuredClone(op.nodes);
      if (op.gaps !== undefined) draft.gaps = structuredClone(op.gaps);
      if (op.observations !== undefined) {
        draft.observations = structuredClone(op.observations);
      }
      if (op.rationale !== undefined && "rationale" in draft) {
        draft.rationale = op.rationale;
      }
      break;
    }
  }
}

export class GraphDraftService {
  private assets: AssetService;

  constructor(private store: Store) {
    this.assets = new AssetService(store);
  }

  createDraft(input: unknown): PlanDraft {
    const data = CreateDraftInput.parse(input);
    let projectId = data.projectId ?? null;
    if (projectId) {
      const project = this.store.get<Project>("project", projectId);
      if (!project) {
        throw new DomainError("project_missing", "项目不存在", 404);
      }
    }
    const taskId = data.taskId ?? null;
    if (taskId) {
      const task = this.store.get<Task>("task", taskId);
      if (!task) {
        throw new DomainError("task_missing", "任务不存在", 404);
      }
      if (projectId && task.projectId && task.projectId !== projectId) {
        throw new DomainError(
          "task_project_mismatch",
          "任务不属于指定的项目",
          422,
        );
      }
      projectId = projectId ?? task.projectId ?? null;
    }

    const now = new Date().toISOString();
    const draft = PlanDraftSchema.parse({
      id: randomUUID(),
      taskId,
      projectId,
      goal: data.goal,
      revision: 1,
      schemaVersion: 3,
      nodes: data.nodes,
      gaps: data.gaps,
      observations: data.observations,
      rationale: data.rationale,
      createdAt: now,
      updatedAt: now,
    });

    this.store.transaction(() => {
      this.store.put("graph_draft", draft);
      this.store.event(
        draft.id,
        "draft.created",
        { draftId: draft.id, revision: draft.revision, goal: draft.goal },
        "user",
        { planRevision: draft.revision },
      );
    });
    return draft;
  }

  getDraft(id: string): PlanDraft {
    const draft = this.store.get<PlanDraft>("graph_draft", id);
    if (!draft) {
      throw new DomainError("draft_missing", "方案草稿不存在", 404);
    }
    return draft;
  }

  listDrafts(filter?: { projectId?: string; taskId?: string }): PlanDraft[] {
    return this.store
      .list<PlanDraft>("graph_draft")
      .filter((d) => {
        if (filter?.projectId && d.projectId !== filter.projectId) return false;
        if (filter?.taskId && d.taskId !== filter.taskId) return false;
        return true;
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  patchDraft(id: string, input: unknown): PlanDraft {
    const data = PatchDraftInput.parse(input);
    return this.store.transaction(() => {
      const current = this.getDraft(id);
      if (current.revision !== data.expectedRevision) {
        const err = new DomainError(
          "revision_conflict",
          `草稿版本冲突，期望 revision=${data.expectedRevision}，当前为 ${current.revision}`,
          409,
        ) as DomainError & { currentRevision?: number };
        err.currentRevision = current.revision;
        throw err;
      }

      const next = structuredClone(current);
      if (data.goal !== undefined) next.goal = data.goal;
      if (data.rationale !== undefined) next.rationale = data.rationale;

      for (const op of data.operations) {
        applyDraftOperationToGraph(next, op);
      }

      next.revision += 1;
      next.updatedAt = new Date().toISOString();
      const validated = PlanDraftSchema.parse(next);
      this.store.put("graph_draft", validated);
      this.store.event(
        validated.id,
        "draft.patched",
        {
          draftId: validated.id,
          revision: validated.revision,
          operationCount: data.operations.length,
        },
        "user",
        { planRevision: validated.revision },
      );
      return validated;
    });
  }

  async composeDraft(
    id: string,
    input: unknown,
    composeHook?: ComposeHook,
  ): Promise<{ operationId: string; status: "succeeded"; draft: PlanDraft }> {
    const data = ComposeDraftInput.parse(input);
    const snapshot = this.getDraft(id);
    if (snapshot.revision !== data.expectedRevision) {
      const err = new DomainError(
        "revision_conflict",
        `草稿版本冲突，期望 revision=${data.expectedRevision}，当前为 ${snapshot.revision}`,
        409,
      ) as DomainError & { currentRevision?: number };
      err.currentRevision = snapshot.revision;
      throw err;
    }

    const opId = randomUUID();
    const opRecord: DraftComposeOperation = {
      id: opId,
      draftId: snapshot.id,
      baseRevision: snapshot.revision,
      status: "pending",
      instruction: data.instruction,
      ...(data.executionAgent ? { executionAgent: data.executionAgent } : {}),
      createdAt: new Date().toISOString(),
    };
    this.store.put("draft_compose_op", opRecord);

    let generated: {
      nodes: NodeSpec[];
      gaps?: PlanGap[];
      observations?: PlanDraft["observations"];
      rationale?: string;
    };

    try {
      if (composeHook) {
        generated = await composeHook({
          draft: snapshot,
          instruction: data.instruction,
          executionAgent: data.executionAgent,
        });
      } else {
        generated = this.deterministicCompose(
          snapshot,
          data.instruction,
          data.executionAgent,
        );
      }
    } catch (error) {
      this.store.put("draft_compose_op", {
        ...opRecord,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }

    return this.store.transaction(() => {
      const latest = this.getDraft(id);
      if (latest.revision !== data.expectedRevision) {
        this.store.put("draft_compose_op", {
          ...opRecord,
          status: "conflict",
          error: `草稿在编排期间已变更为 revision=${latest.revision}`,
          finishedAt: new Date().toISOString(),
        });
        const err = new DomainError(
          "revision_conflict",
          `草稿在编排期间已变更为 revision=${latest.revision}`,
          409,
        ) as DomainError & { currentRevision?: number };
        err.currentRevision = latest.revision;
        throw err;
      }

      const next = PlanDraftSchema.parse({
        ...latest,
        revision: latest.revision + 1,
        nodes: generated.nodes,
        gaps: generated.gaps ?? latest.gaps,
        observations: generated.observations ?? latest.observations,
        rationale:
          generated.rationale ??
          `基于编排指令生成方案: ${data.instruction.slice(0, 200)}`,
        updatedAt: new Date().toISOString(),
      });
      this.store.put("graph_draft", next);
      this.store.put("draft_compose_op", {
        ...opRecord,
        status: "succeeded",
        finishedAt: next.updatedAt,
      });
      this.store.event(
        next.id,
        "draft.composed",
        {
          draftId: next.id,
          operationId: opId,
          revision: next.revision,
          nodeCount: next.nodes.length,
          gapCount: next.gaps.filter((g) => g.status === "open").length,
        },
        "planner",
        { correlationId: opId, planRevision: next.revision },
      );
      return { operationId: opId, status: "succeeded", draft: next };
    });
  }

  getComposeOperation(opId: string): DraftComposeOperation {
    const op = this.store.get<DraftComposeOperation>("draft_compose_op", opId);
    if (!op) {
      throw new DomainError("operation_missing", "编排任务不存在", 404);
    }
    return op;
  }

  private deterministicCompose(
    draft: PlanDraft,
    instruction: string,
    executionAgent: "codex" | "opencode" = "codex",
  ): {
    nodes: NodeSpec[];
    gaps: PlanGap[];
    observations: PlanDraft["observations"];
    rationale: string;
  } {
    const caps = this.assets.listCapabilities();
    const published = caps.filter((c) => c.status === "published");
    const capDigest = (cap: Capability) =>
      semanticDigest({
        id: cap.id,
        version: cap.version,
        inputSchema: cap.inputSchema,
        outputSchema: cap.outputSchema,
        sideEffect: cap.sideEffect,
      });
    const pick = (name: string) =>
      published
        .filter((c) => c.name === name)
        .sort((a, b) => b.version.localeCompare(a.version))[0];

    const gaps: PlanGap[] = [...draft.gaps];
    const readCap =
      pick("core.analyze") ??
      pick(`core.${executionAgent}.read`) ??
      pick("core.codex.read");
    const analyzeOnly = /analyze\s*->\s*deliver|仅分析|只读/i.test(instruction);
    const writeCap = analyzeOnly
      ? undefined
      : (pick("core.implement") ??
        pick(`core.${executionAgent}.write`) ??
        pick("core.codex.write"));
    const testCap = analyzeOnly
      ? undefined
      : (pick("core.test") ?? pick("core.project.test"));
    const deliverCap =
      pick("core.deliver") ??
      pick("core.builtin.deliver") ??
      pick("core.conclude");

    if (
      draft.nodes.length > 0 &&
      /保留|增量|add|append/i.test(instruction)
    ) {
      return {
        nodes: draft.nodes,
        gaps,
        observations: draft.observations,
        rationale: `保留现有草稿节点并记录编排说明：${instruction}`,
      };
    }

    const customGapMatch = /cap:[a-z0-9._-]+|需要未发布能力|缺少能力|gap/i.exec(
      instruction,
    );
    if (customGapMatch) {
      const gapId = `gap-${gaps.length + 1}`;
      gaps.push({
        id: gapId,
        kind: "capability",
        reason: `当前目录缺少满足 "${customGapMatch[0]}" 的已发布能力，请先通过 Capability Builder 创建并发布。`,
        affectedNodeIds: [],
        status: "open",
      });
    }

    const nodes: NodeSpec[] = [];
    if (readCap) {
      nodes.push({
        id: "analyze",
        engineKey: "analyze",
        title: "仓库上下文勘查",
        capabilityRef: {
          id: readCap.id,
          version: readCap.version,
          digest: capDigest(readCap),
        },
        profileRef: null,
        literals: { objective: `${draft.goal}\n${instruction}` },
        bindings: [],
        dependsOn: [],
        knowledgeInputs: [],
        knowledgeOutputs: [],
        workspace: { policy: "run-shared", subdir: "." },
      });
    }
    if (writeCap) {
      nodes.push({
        id: "implement",
        engineKey: "implement",
        title: "变更实施",
        capabilityRef: {
          id: writeCap.id,
          version: writeCap.version,
          digest: capDigest(writeCap),
        },
        profileRef: null,
        literals: { objective: `${draft.goal}\n${instruction}` },
        bindings: [],
        dependsOn: readCap ? ["analyze"] : [],
        knowledgeInputs: [],
        knowledgeOutputs: [],
        workspace: { policy: "run-shared", subdir: "." },
      });
    }
    if (testCap && writeCap) {
      nodes.push({
        id: "verify",
        engineKey: "verify",
        title: "自动测试验证",
        capabilityRef: {
          id: testCap.id,
          version: testCap.version,
          digest: capDigest(testCap),
        },
        profileRef: null,
        literals: {},
        bindings: [
          {
            id: "b-impl-verify",
            target: "/objective",
            source: { nodeId: "implement", pointer: "/summary" },
            required: true,
            missing: "block",
          },
        ],
        dependsOn: ["implement"],
        knowledgeInputs: [],
        knowledgeOutputs: [],
        workspace: { policy: "run-shared", subdir: "." },
      });
    }
    if (deliverCap && nodes.length > 0) {
      const prev = nodes[nodes.length - 1];
      nodes.push({
        id: "deliver",
        engineKey: "deliver",
        title: "结果汇总交付",
        capabilityRef: {
          id: deliverCap.id,
          version: deliverCap.version,
          digest: capDigest(deliverCap),
        },
        profileRef: null,
        literals: {},
        bindings: [
          {
            id: "b-deliver-summary",
            target: "/objective",
            source: { nodeId: prev.id, pointer: "/summary" },
            required: true,
            missing: "use-default",
            defaultValue: draft.goal,
          },
        ],
        dependsOn: [prev.id],
        knowledgeInputs: [],
        knowledgeOutputs: [],
        workspace: { policy: "run-shared", subdir: "." },
      });
    }

    if (nodes.length === 0) {
      gaps.push({
        id: `gap-bootstrap-${gaps.length + 1}`,
        kind: "capability",
        reason: "未找到已发布的执行能力，无法编排可执行图。",
        affectedNodeIds: [],
        status: "open",
      });
    }

    return {
      nodes,
      gaps,
      observations: draft.observations,
      rationale: `默认编排生成 ${nodes.length} 个节点与 ${gaps.filter((g) => g.status === "open").length} 个待解缺口。`,
    };
  }
}
