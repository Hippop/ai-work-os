import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { checkSchema } from "../../adaptive/assets.js";
import type { AdaptiveRun } from "../../adaptive/engine.js";
import { isolatedCodexHome, renderMcpConfig } from "../../adaptive/mcp.js";
import { isolatedOpenCodeHome } from "../../adaptive/opencode.js";
import { resolveRunNodeKey } from "../../graph/compiler.js";
import {
  ImpactAnalyzer,
  persistValidityRecords,
} from "../../graph/impact.js";
import type {
  AgentSession,
  InterventionRecord,
  NodeSpec,
  ResolvedContextManifest,
  ResultValidity,
} from "../../graph/types.js";
import { DomainError, digest, type Project, type Task } from "../../domain/index.js";
import type { Store } from "../../persistence/index.js";
import { workspaceDigest } from "../../workspace/index.js";
import {
  WorkspaceAccessCoordinator,
  resolveAuthorizedSubdir,
} from "../../workspace/access.js";
import { executablePath, stopTree } from "../adapter.js";

export type SessionAdapterDescriptor = {
  adapter: "codex" | "opencode";
  interactiveSupported: boolean;
  effectivePermissionSupport: "enforced" | "best-effort" | "unverified";
  stopProofSupport: "process-tree" | "pid-only";
  contextInjectionSupport: "args-and-file" | "file-only";
};

export const ADAPTER_CAPABILITIES: Record<
  "codex" | "opencode",
  SessionAdapterDescriptor
> = {
  codex: {
    adapter: "codex",
    interactiveSupported: true,
    effectivePermissionSupport: "enforced",
    stopProofSupport: "process-tree",
    contextInjectionSupport: "args-and-file",
  },
  opencode: {
    adapter: "opencode",
    interactiveSupported: true,
    effectivePermissionSupport: "enforced",
    stopProofSupport: "process-tree",
    contextInjectionSupport: "args-and-file",
  },
};

const RequestInterventionInput = z
  .object({
    nodeId: z.string().min(1).max(120).optional(),
    expectedRevision: z.number().int().positive(),
    mode: z.enum(["inspect", "interactive-read", "interactive-write"]),
  })
  .strict();

const AdoptInterventionInput = z
  .object({
    expectedDigest: z.string().min(1).max(128).nullable(),
    note: z.string().trim().min(1).max(4000),
    outputMapping: z.unknown().optional(),
  })
  .strict();

const StartSessionInput = z
  .object({
    adapter: z.enum(["codex", "opencode"]),
    rows: z.number().int().min(10).max(200).default(40),
    cols: z.number().int().min(40).max(400).default(120),
  })
  .strict();

const StopSessionInput = z
  .object({
    expectedSessionRevision: z.number().int().positive(),
  })
  .strict();

const ResizeSessionInput = z
  .object({
    rows: z.number().int().min(10).max(200),
    cols: z.number().int().min(40).max(400),
  })
  .strict();

type RunV3Extended = AdaptiveRun & {
  schemaVersion?: number;
  nodeSpecs?: NodeSpec[];
  dispatchGate?:
    | "open"
    | "paused"
    | "intervention"
    | "change_pending"
    | "reconciling";
  resultValidity?: Record<string, ResultValidity["state"]>;
};

export type OutputChunk = {
  seq: number;
  stream: "stdout" | "stderr" | "system";
  data: string;
  at: string;
};

export type SessionProcessHandle = {
  pid: number | null;
  write: (data: string) => void;
  resize?: (rows: number, cols: number) => void;
  stop: () => Promise<boolean>;
  onData: (cb: (stream: "stdout" | "stderr", chunk: string) => void) => void;
  onExit: (cb: (code: number | null, signal: string | null) => void) => void;
};

export type SpawnSessionHook = (params: {
  session: AgentSession;
  cwd: string;
  env: Record<string, string>;
  contextFile: string;
  readOnly: boolean;
}) => SessionProcessHandle;

type ConnectTicketRecord = {
  ticket: string;
  sessionId: string;
  expiresAt: number;
  used: boolean;
};

type ActiveConnection = {
  connectionId: string;
  isWriter: boolean;
  onChunk?: (chunk: OutputChunk) => void;
  onClose?: () => void;
};

type LiveSessionState = {
  handle: SessionProcessHandle;
  chunks: OutputChunk[];
  bytes: number;
  lastSeq: number;
  truncatedBeforeSeq: number;
  connections: Map<string, ActiveConnection>;
  cleanupTemp?: () => void;
};

const MAX_BUFFER_CHUNKS = 200;
const MAX_BUFFER_BYTES = 512 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const TICKET_TTL_MS = 55_000;

function resolveRunWorkspace(
  store: Store,
  run: AdaptiveRun,
): { workspacePath: string | null; authorizedRoot: string | null } {
  const ws =
    store.get<{ path: string }>("adaptive_workspace", run.id) ??
    store.get<{ path: string }>("adaptive_worktree", run.id);
  const runWorkspacePath =
    (run as AdaptiveRun & { workspacePath?: string }).workspacePath ?? null;
  const task = store.get<Task>("task", run.taskId);
  const project = task?.projectId
    ? store.get<Project>("project", task.projectId)
    : undefined;
  const workspacePath =
    ws?.path ?? runWorkspacePath ?? project?.repositoryPath ?? null;
  const authorizedRoot =
    ws?.path ?? runWorkspacePath ?? project?.repositoryPath ?? null;
  return { workspacePath, authorizedRoot };
}

function buildSanitizedEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  const secretPattern =
    /(token|secret|key|password|credential|auth|cookie)/i;
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith("AI_WORK_OS_SESSION_") || !secretPattern.test(k)) {
      clean[k] = v;
    }
  }
  return clean;
}

function defaultSpawnSession(params: {
  session: AgentSession;
  cwd: string;
  env: Record<string, string>;
  contextFile: string;
  readOnly: boolean;
}): SessionProcessHandle {
  const runnerOverride = process.env.AI_WORK_OS_SESSION_RUNNER;
  let cmd: string;
  let args: string[];
  if (runnerOverride) {
    cmd = executablePath(runnerOverride);
    args = [
      "--adapter",
      params.session.adapter,
      "--mode",
      params.session.mode,
      "--context-file",
      params.contextFile,
    ];
  } else if (params.session.adapter === "opencode") {
    cmd = executablePath(process.env.AI_WORK_OS_OPENCODE ?? "opencode");
    args = ["--cwd", params.cwd];
  } else {
    cmd = executablePath(process.env.AI_WORK_OS_CODEX ?? "codex");
    args = [
      "--sandbox",
      params.readOnly ? "read-only" : "workspace-write",
      "-C",
      params.cwd,
    ];
  }

  const child: ChildProcess = spawn(cmd, args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const dataCbs: Array<(stream: "stdout" | "stderr", chunk: string) => void> =
    [];
  const exitCbs: Array<(code: number | null, signal: string | null) => void> =
    [];

  child.stdout?.on("data", (buf: Buffer | string) => {
    const str = typeof buf === "string" ? buf : buf.toString("utf8");
    for (const cb of dataCbs) cb("stdout", str);
  });
  child.stderr?.on("data", (buf: Buffer | string) => {
    const str = typeof buf === "string" ? buf : buf.toString("utf8");
    for (const cb of dataCbs) cb("stderr", str);
  });
  child.on("error", (err) => {
    const msg = `[process error] ${err.message}\n`;
    for (const cb of dataCbs) cb("stderr", msg);
  });
  child.on("exit", (code, signal) => {
    for (const cb of exitCbs) cb(code, signal);
  });

  return {
    pid: child.pid ?? null,
    write: (data: string) => {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(data);
      }
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      await stopTree(child);
      if (child.exitCode !== null || child.signalCode !== null) return true;
      // Verify whether pid is still alive
      if (!child.pid) return true;
      try {
        process.kill(child.pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
  };
}

export class InterventionService {
  private access: WorkspaceAccessCoordinator;
  private impact: ImpactAnalyzer;

  constructor(private store: Store) {
    this.access = new WorkspaceAccessCoordinator(store);
    this.impact = new ImpactAnalyzer(store);
  }

  requestIntervention(runId: string, input: unknown): InterventionRecord {
    const data = RequestInterventionInput.parse(input);
    return this.store.transaction(() => {
      const run = this.store.get<RunV3Extended>("adaptive_run", runId);
      if (!run) {
        throw new DomainError("run_missing", "运行不存在", 404);
      }
      if (["done", "cancelled"].includes(run.status)) {
        throw new DomainError(
          "run_terminal",
          `终态运行 (${run.status}) 不能启动人工介入`,
          409,
        );
      }
      if (run.planRevision !== data.expectedRevision) {
        const err = new DomainError(
          "revision_conflict",
          `运行版本冲突，期望 revision=${data.expectedRevision}，当前为 ${run.planRevision}`,
          409,
        ) as DomainError & { currentRevision?: number };
        err.currentRevision = run.planRevision;
        throw err;
      }

      if (data.nodeId && !resolveRunNodeKey(run, data.nodeId)) {
        throw new DomainError(
          "node_missing",
          `节点 ${data.nodeId} 不存在`,
          404,
        );
      }

      const activePending = this.store
        .list<InterventionRecord>("intervention")
        .find((iv) => iv.runId === run.id && iv.reviewState === "pending");
      if (activePending) {
        throw new DomainError(
          "intervention_already_active",
          `运行 ${run.id} 已有进行中的人工介入 (${activePending.id})`,
          409,
        );
      }

      const interventionId = randomUUID();
      const { workspacePath, authorizedRoot } = resolveRunWorkspace(
        this.store,
        run,
      );
      let beforeDigest: string | null = null;
      if (workspacePath && existsSync(workspacePath)) {
        const lockMode =
          data.mode === "interactive-write" ? "intervention" : "read-only";
        this.access.acquire({
          workspacePath,
          authorizedRoot: authorizedRoot ?? workspacePath,
          owner: `intervention:${interventionId}`,
          mode: lockMode,
        });
        beforeDigest = workspaceDigest(workspacePath);
      }

      const now = new Date().toISOString();
      const record: InterventionRecord = {
        id: interventionId,
        runId: run.id,
        ...(data.nodeId ? { nodeId: data.nodeId } : {}),
        mode: data.mode,
        basePlanRevision: run.planRevision,
        beforeDigest,
        sessionRefs: [],
        externalReconciled: false,
        reviewState: "pending",
        createdAt: now,
        updatedAt: now,
      };

      run.dispatchGate = "intervention";
      if (run.status === "queued" || run.status === "running") {
        run.status = "paused";
      }
      run.updatedAt = now;
      this.store.put("adaptive_run", run);
      this.store.put("intervention", record);
      this.store.event(
        run.id,
        "intervention.started",
        {
          interventionId: record.id,
          mode: record.mode,
          nodeId: record.nodeId ?? null,
          beforeDigest,
        },
        "user",
        { correlationId: record.id, planRevision: run.planRevision },
      );
      return record;
    });
  }

  getIntervention(id: string): InterventionRecord {
    const iv = this.store.get<InterventionRecord>("intervention", id);
    if (!iv) {
      throw new DomainError("intervention_missing", "人工介入记录不存在", 404);
    }
    return iv;
  }

  listInterventions(runId: string): InterventionRecord[] {
    return this.store
      .list<InterventionRecord>("intervention")
      .filter((iv) => iv.runId === runId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  adoptIntervention(
    interventionId: string,
    input: unknown,
    options: { wake?: () => void } = {},
  ): {
    intervention: InterventionRecord;
    run: RunV3Extended;
    invalidatedNodes: string[];
  } {
    const data = AdoptInterventionInput.parse(input);
    const result = this.store.transaction(() => {
      const iv = this.getIntervention(interventionId);
      if (iv.reviewState !== "pending") {
        throw new DomainError(
          "intervention_not_pending",
          `人工介入状态为 ${iv.reviewState}，无法重复采纳`,
          409,
        );
      }
      const run = this.store.get<RunV3Extended>("adaptive_run", iv.runId);
      if (!run) {
        throw new DomainError("run_missing", "关联运行不存在", 404);
      }

      // Check every attached session has cleanly exited before adopting (A18)
      const sessions = this.store
        .list<AgentSession>("agent_session")
        .filter((s) => s.interventionId === iv.id);
      const blockingSession = sessions.find((s) =>
        ["creating", "running", "stop-unconfirmed"].includes(s.processState),
      );
      if (blockingSession) {
        throw new DomainError(
          "session_not_stopped",
          `交互会话 ${blockingSession.id} 状态为 ${blockingSession.processState}，必须先确认停止后方可采纳并恢复调度`,
          409,
        );
      }

      const { workspacePath } = resolveRunWorkspace(this.store, run);
      let afterDigest: string | null = null;
      if (workspacePath && existsSync(workspacePath)) {
        const wsAccess = this.access.get(workspacePath);
        if (wsAccess?.status === "needs-reconciliation") {
          throw new DomainError(
            "workspace_reconciliation_required",
            "工作区锁尚待人工核对，不能采纳结果或恢复调度",
            409,
          );
        }
        afterDigest = workspaceDigest(workspacePath);
      }

      if (afterDigest !== data.expectedDigest) {
        throw new DomainError(
          "workspace_digest_mismatch",
          `工作区最新摘要 (${afterDigest}) 与期望摘要 (${data.expectedDigest}) 不一致，请刷新现场摘要后确认采纳`,
          409,
        );
      }

      // Validate explicit outputMapping strictly against frozen capability outputSchema (A19)
      let mappedEngineKey: string | null = null;
      if (data.outputMapping !== undefined) {
        if (!iv.nodeId) {
          throw new DomainError(
            "output_mapping_requires_node",
            "提供 outputMapping 时必须关联具体节点",
            422,
          );
        }
        const resolved = resolveRunNodeKey(run, iv.nodeId);
        if (!resolved) {
          throw new DomainError("node_missing", "关联节点不存在", 404);
        }
        mappedEngineKey = resolved.engineKey;
        const cap = run.snapshots[mappedEngineKey]?.capability;
        if (!cap) {
          throw new DomainError(
            "capability_snapshot_missing",
            "节点缺少能力契约快照",
            422,
          );
        }
        checkSchema(cap.outputSchema, data.outputMapping);
        run.results[mappedEngineKey] = {
          output: data.outputMapping,
          artifactRefs: [],
          invocationId: iv.id,
          digest: digest(data.outputMapping),
        };
        run.nodeStates[mappedEngineKey] = "succeeded";
        run.resultValidity = {
          ...(run.resultValidity ?? {}),
          [mappedEngineKey]: "valid",
        };
      }

      const workspaceChanged =
        afterDigest !== null && afterDigest !== iv.beforeDigest;
      let invalidatedNodes: string[] = [];
      if (workspaceChanged || iv.mode === "interactive-write" || mappedEngineKey) {
        const impact = this.impact.computeWorkspaceInterventionImpact(
          run,
          iv.nodeId,
        );
        const toInvalidate = impact.invalidatedEngineKeys.filter(
          (k) => k !== mappedEngineKey,
        );
        invalidatedNodes = toInvalidate;
        const nextValidity: Record<string, ResultValidity["state"]> = {};
        for (const key of toInvalidate) {
          if (
            ["succeeded", "failed", "skipped"].includes(run.nodeStates[key])
          ) {
            run.nodeStates[key] = "pending";
            delete run.results[key];
            delete run.failures[key];
          }
          run.resultValidity = { ...(run.resultValidity ?? {}), [key]: "stale" };
          nextValidity[key] = "stale";
        }
        persistValidityRecords(
          this.store,
          run,
          {
            ...nextValidity,
            ...(mappedEngineKey ? { [mappedEngineKey]: "valid" } : {}),
          },
          impact.reasons,
        );
      }

      // Release intervention workspace lock if held
      if (workspacePath && existsSync(workspacePath)) {
        const currentAccess = this.access.get(workspacePath);
        const holder = currentAccess?.holders.find(
          (h) => h.owner === `intervention:${iv.id}`,
        );
        if (holder) {
          this.access.release(workspacePath, holder.owner, holder.epoch, true);
        }
      }

      const now = new Date().toISOString();
      const updatedIv: InterventionRecord = {
        ...iv,
        afterDigest,
        externalReconciled: true,
        reviewState: "adopted",
        note: data.note,
        ...(data.outputMapping !== undefined
          ? { outputMapping: data.outputMapping }
          : {}),
        updatedAt: now,
      };
      this.store.put("intervention", updatedIv);

      for (const s of sessions) {
        this.store.put("agent_session", {
          ...s,
          reviewState: "adopted",
          updatedAt: now,
        });
      }

      run.dispatchGate = "open";
      const hasPendingWork = Object.values(run.nodeStates).some(
        (s) => s === "pending",
      );
      if (hasPendingWork && (run.status === "paused" || run.status === "awaiting_acceptance")) {
        run.status = "running";
      }
      run.updatedAt = now;
      this.store.put("adaptive_run", run);

      this.store.event(
        run.id,
        "intervention.adopted",
        {
          interventionId: updatedIv.id,
          afterDigest,
          invalidatedNodes,
          outputMappedNode: mappedEngineKey,
        },
        "user",
        { correlationId: updatedIv.id, planRevision: run.planRevision },
      );

      return { intervention: updatedIv, run, invalidatedNodes };
    });

    if (result.run.status === "running") {
      options.wake?.();
    }
    return result;
  }

  discardIntervention(interventionId: string, note: string): InterventionRecord {
    return this.store.transaction(() => {
      const iv = this.getIntervention(interventionId);
      if (iv.reviewState !== "pending") {
        throw new DomainError(
          "intervention_not_pending",
          `人工介入状态为 ${iv.reviewState}，不能重复放弃`,
          409,
        );
      }
      const sessions = this.store
        .list<AgentSession>("agent_session")
        .filter((s) => s.interventionId === iv.id);
      if (
        sessions.some((s) =>
          ["creating", "running", "stop-unconfirmed"].includes(s.processState),
        )
      ) {
        throw new DomainError(
          "session_not_stopped",
          "请先确认停止交互会话，再关闭介入记录",
          409,
        );
      }

      const run = this.store.get<RunV3Extended>("adaptive_run", iv.runId);
      if (!run) throw new DomainError("run_missing", "关联运行不存在", 404);
      const { workspacePath } = resolveRunWorkspace(this.store, run);
      if (workspacePath && existsSync(workspacePath)) {
        const wsAccess = this.access.get(workspacePath);
        if (wsAccess?.status === "needs-reconciliation") {
          throw new DomainError(
            "workspace_reconciliation_required",
            "工作区锁尚待人工核对，不能关闭介入",
            409,
          );
        }
        if (
          iv.beforeDigest &&
          workspaceDigest(workspacePath) !== iv.beforeDigest
        ) {
          throw new DomainError(
            "workspace_modified_must_adopt",
            "工作区已在介入期间发生变更，不能直接放弃，请走采纳与影响重算流程",
            409,
          );
        }
        const holder = wsAccess?.holders.find(
          (h) => h.owner === `intervention:${iv.id}`,
        );
        if (holder) {
          this.access.release(workspacePath, holder.owner, holder.epoch, true);
        }
      }

      const now = new Date().toISOString();
      const discarded: InterventionRecord = {
        ...iv,
        reviewState: "discarded",
        note,
        updatedAt: now,
      };
      this.store.put("intervention", discarded);
      for (const s of sessions) {
        this.store.put("agent_session", {
          ...s,
          reviewState: "discarded",
          updatedAt: now,
        });
      }
      run.dispatchGate = "open";
      run.updatedAt = now;
      this.store.put("adaptive_run", run);
      return discarded;
    });
  }
}

export class AgentSessionManager {
  private live = new Map<string, LiveSessionState>();
  private tickets = new Map<string, ConnectTicketRecord>();
  private access: WorkspaceAccessCoordinator;

  constructor(
    private store: Store,
    private controllerId = "server",
    private spawnHook: SpawnSessionHook = defaultSpawnSession,
  ) {
    this.access = new WorkspaceAccessCoordinator(store);
  }

  listAdapters(): SessionAdapterDescriptor[] {
    return Object.values(ADAPTER_CAPABILITIES);
  }

  getSession(id: string): AgentSession {
    const session = this.store.get<AgentSession>("agent_session", id);
    if (!session) {
      throw new DomainError("session_missing", "交互会话不存在", 404);
    }
    return session;
  }

  listSessions(runId?: string): AgentSession[] {
    return this.store
      .list<AgentSession>("agent_session")
      .filter((s) => !runId || s.runId === runId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  startSession(interventionId: string, input: unknown): AgentSession {
    const data = StartSessionInput.parse(input);
    const iv = this.store.get<InterventionRecord>(
      "intervention",
      interventionId,
    );
    if (!iv) {
      throw new DomainError("intervention_missing", "人工介入记录不存在", 404);
    }
    if (iv.reviewState !== "pending") {
      throw new DomainError(
        "intervention_not_pending",
        "人工介入已结束，不能再新建终端会话",
        409,
      );
    }
    if (iv.mode === "inspect") {
      throw new DomainError(
        "inspect_mode_no_session",
        "inspect 只读检查模式不允许启动交互终端",
        422,
      );
    }

    const run = this.store.get<RunV3Extended>("adaptive_run", iv.runId);
    if (!run) throw new DomainError("run_missing", "运行不存在", 404);

    const { workspacePath, authorizedRoot } = resolveRunWorkspace(
      this.store,
      run,
    );
    if (!workspacePath || !existsSync(workspacePath)) {
      throw new DomainError(
        "workspace_missing",
        "当前运行尚无授权本地工作目录",
        422,
      );
    }

    let subdir = ".";
    if (iv.nodeId) {
      const resolved = resolveRunNodeKey(run, iv.nodeId);
      subdir = resolved?.nodeSpec?.workspace.subdir ?? ".";
    }
    const { cwd } = resolveAuthorizedSubdir(
      workspacePath,
      subdir,
      authorizedRoot ?? workspacePath,
    );

    const wsAccess = this.access.get(workspacePath);
    if (wsAccess?.status === "needs-reconciliation") {
      throw new DomainError(
        "workspace_reconciliation_required",
        "工作区锁尚待人工核对，不能启动交互终端",
        409,
      );
    }

    const manifests = this.store
      .list<ResolvedContextManifest>("context_manifest")
      .filter((m) => m.runId === run.id && (!iv.nodeId || m.nodeId === iv.nodeId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const latestManifest = manifests[0];

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const readOnly = iv.mode === "interactive-read";

    // Build isolated adapter home + context file without leaking host credentials
    const contextDir = join(tmpdir(), `aiwork-session-${sessionId}`);
    mkdirSync(contextDir, { recursive: true, mode: 0o700 });
    const contextFile = join(contextDir, "context-manifest.json");
    writeFileSync(
      contextFile,
      JSON.stringify(
        latestManifest ?? {
          runId: run.id,
          nodeId: iv.nodeId ?? null,
          mode: iv.mode,
          planRevision: run.planRevision,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const isolatedHome =
      data.adapter === "opencode"
        ? isolatedOpenCodeHome({})
        : isolatedCodexHome(renderMcpConfig([]));
    const env: Record<string, string> = {
      ...buildSanitizedEnv(process.env),
      ...isolatedHome.env,
      TERM: "xterm-256color",
      LINES: String(data.rows),
      COLUMNS: String(data.cols),
      AI_WORK_OS_SESSION_ID: sessionId,
      AI_WORK_OS_CONTEXT_FILE: contextFile,
      AI_WORK_OS_INTERVENTION_MODE: iv.mode,
    };

    const initialSession: AgentSession = {
      id: sessionId,
      interventionId: iv.id,
      runId: run.id,
      ...(iv.nodeId ? { nodeId: iv.nodeId } : {}),
      adapter: data.adapter,
      mode: iv.mode,
      cwdRef: cwd,
      ...(latestManifest ? { contextManifestRef: latestManifest.id } : {}),
      processState: "creating",
      connectionState: "detached",
      reviewState: iv.mode === "interactive-write" ? "pending" : "not-needed",
      revision: 1,
      rows: data.rows,
      cols: data.cols,
      createdAt: now,
      updatedAt: now,
    };

    const handle = this.spawnHook({
      session: initialSession,
      cwd,
      env,
      contextFile,
      readOnly,
    });

    const liveState: LiveSessionState = {
      handle,
      chunks: [],
      bytes: 0,
      lastSeq: 0,
      truncatedBeforeSeq: 1,
      connections: new Map(),
      cleanupTemp: () => {
        try {
          isolatedHome.dispose();
        } catch {}
        try {
          rmSync(contextDir, { recursive: true, force: true });
        } catch {}
      },
    };
    this.live.set(sessionId, liveState);

    const runningSession: AgentSession = {
      ...initialSession,
      processState: "running",
      processIdentity: {
        pid: handle.pid,
        startedAt: now,
        controllerId: this.controllerId,
      },
    };

    this.store.transaction(() => {
      this.store.put("agent_session", runningSession);
      const nextRefs = [...new Set([...iv.sessionRefs, sessionId])];
      this.store.put("intervention", {
        ...iv,
        sessionRefs: nextRefs,
        updatedAt: now,
      });
      this.store.event(
        run.id,
        "session.started",
        {
          sessionId,
          interventionId: iv.id,
          adapter: data.adapter,
          mode: iv.mode,
          pid: handle.pid,
        },
        "user",
        { correlationId: iv.id, planRevision: run.planRevision },
      );
    });

    handle.onData((stream, chunk) => {
      this.appendOutput(sessionId, stream, chunk);
    });
    handle.onExit((code) => {
      try {
        if (!this.store.db.isOpen) return;
        const current = this.store.get<AgentSession>(
          "agent_session",
          sessionId,
        );
        if (current && current.processState !== "stop-unconfirmed") {
          const exitedAt = new Date().toISOString();
          const updated: AgentSession = {
            ...current,
            processState: "exited",
            exitCode: code,
            exitedAt,
            revision: current.revision + 1,
            updatedAt: exitedAt,
            stopProof: `exited:${code ?? "signal"}:${exitedAt}`,
          };
          this.store.put("agent_session", updated);
          this.store.event(
            current.runId,
            "session.exited",
            { sessionId, exitCode: code },
            "platform",
          );
        }
      } catch {
        /* ignore late exit after store.close() */
      } finally {
        liveState.cleanupTemp?.();
      }
    });

    return runningSession;
  }

  private appendOutput(
    sessionId: string,
    stream: OutputChunk["stream"],
    data: string,
  ): void {
    const state = this.live.get(sessionId);
    if (!state || !data) return;
    const seq = state.lastSeq + 1;
    state.lastSeq = seq;
    const chunk: OutputChunk = {
      seq,
      stream,
      data,
      at: new Date().toISOString(),
    };
    state.chunks.push(chunk);
    state.bytes += Buffer.byteLength(data, "utf8");
    while (
      state.chunks.length > MAX_BUFFER_CHUNKS ||
      (state.bytes > MAX_BUFFER_BYTES && state.chunks.length > 1)
    ) {
      const dropped = state.chunks.shift()!;
      state.bytes -= Buffer.byteLength(dropped.data, "utf8");
      state.truncatedBeforeSeq = state.chunks[0]?.seq ?? seq + 1;
    }
    for (const conn of state.connections.values()) {
      conn.onChunk?.(chunk);
    }
  }

  issueConnectTicket(sessionId: string): {
    ticket: string;
    expiresAt: string;
    sessionId: string;
  } {
    this.getSession(sessionId);
    const ticket = randomBytes(24).toString("hex");
    const expiresAtMs = Date.now() + TICKET_TTL_MS;
    this.tickets.set(ticket, {
      ticket,
      sessionId,
      expiresAt: expiresAtMs,
      used: false,
    });
    return {
      ticket,
      expiresAt: new Date(expiresAtMs).toISOString(),
      sessionId,
    };
  }

  attachConnection(
    sessionId: string,
    ticket: string,
    callbacks: {
      onChunk?: (chunk: OutputChunk) => void;
      onClose?: () => void;
    } = {},
  ): { connectionId: string; isWriter: boolean } {
    const rec = this.tickets.get(ticket);
    if (
      !rec ||
      rec.sessionId !== sessionId ||
      rec.used ||
      Date.now() > rec.expiresAt
    ) {
      throw new DomainError(
        "invalid_connect_ticket",
        "连接凭证无效、已过期或已使用",
        401,
      );
    }
    rec.used = true;
    this.tickets.delete(ticket);

    const session = this.getSession(sessionId);
    const live = this.live.get(sessionId);
    const existingWriter = live
      ? [...live.connections.values()].some((c) => c.isWriter)
      : false;
    const isWriter = !existingWriter && session.mode === "interactive-write";
    const connectionId = randomUUID();

    if (live) {
      live.connections.set(connectionId, {
        connectionId,
        isWriter,
        ...callbacks,
      });
    }

    if (session.connectionState !== "attached") {
      this.store.put("agent_session", {
        ...session,
        connectionState: "attached",
        revision: session.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      this.store.event(
        session.runId,
        "session.connected",
        { sessionId, connectionId, isWriter },
        "user",
      );
    }

    return { connectionId, isWriter };
  }

  readOutput(sessionId: string, afterSeq = 0): {
    sessionId: string;
    lastSeq: number;
    truncated: boolean;
    truncatedBeforeSeq: number;
    chunks: OutputChunk[];
    processState: AgentSession["processState"];
    connectionState: AgentSession["connectionState"];
    revision: number;
  } {
    const session = this.getSession(sessionId);
    const live = this.live.get(sessionId);
    if (!live) {
      return {
        sessionId,
        lastSeq: 0,
        truncated: false,
        truncatedBeforeSeq: 1,
        chunks: [],
        processState: session.processState,
        connectionState: session.connectionState,
        revision: session.revision,
      };
    }
    const truncated = afterSeq > 0 && afterSeq + 1 < live.truncatedBeforeSeq;
    const chunks = live.chunks.filter((c) => c.seq > afterSeq);
    return {
      sessionId,
      lastSeq: live.lastSeq,
      truncated,
      truncatedBeforeSeq: live.truncatedBeforeSeq,
      chunks,
      processState: session.processState,
      connectionState: session.connectionState,
      revision: session.revision,
    };
  }

  sendInput(
    sessionId: string,
    connectionId: string | undefined,
    data: string,
  ): void {
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
      throw new DomainError(
        "input_too_large",
        "单次终端输入超过 16KB 上限",
        413,
      );
    }
    const session = this.getSession(sessionId);
    if (session.processState !== "running") {
      throw new DomainError(
        "session_not_running",
        `终端会话当前状态为 ${session.processState}，不能写入输入`,
        409,
      );
    }
    const live = this.live.get(sessionId);
    if (!live) {
      throw new DomainError("session_unavailable", "终端进程已不可用", 409);
    }
    if (session.mode === "interactive-read") {
      throw new DomainError(
        "read_only_session",
        "只读交互会话禁止写入输入",
        403,
      );
    }
    if (connectionId) {
      const conn = live.connections.get(connectionId);
      if (!conn || !conn.isWriter) {
        throw new DomainError(
          "read_only_connection",
          "当前连接为只读视图，只有活跃主写连接可发送输入",
          403,
        );
      }
    } else if ([...live.connections.values()].some((c) => !c.isWriter) && live.connections.size > 0 && ![...live.connections.values()].some((c) => c.isWriter)) {
      throw new DomainError(
        "read_only_connection",
        "当前无主写控制连接",
        403,
      );
    }
    live.handle.write(data);
  }

  resize(sessionId: string, input: unknown): AgentSession {
    const data = ResizeSessionInput.parse(input);
    const session = this.getSession(sessionId);
    const live = this.live.get(sessionId);
    live?.handle.resize?.(data.rows, data.cols);
    const updated: AgentSession = {
      ...session,
      rows: data.rows,
      cols: data.cols,
      revision: session.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.store.put("agent_session", updated);
    return updated;
  }

  /**
   * Disconnect detaches UI / WebSocket cleanly WITHOUT killing the subprocess
   * and WITHOUT releasing workspace locks or adopting results (A16).
   */
  disconnect(sessionId: string, connectionId?: string): AgentSession {
    const session = this.getSession(sessionId);
    const live = this.live.get(sessionId);
    if (live) {
      if (connectionId) {
        live.connections.delete(connectionId);
      } else {
        live.connections.clear();
      }
    }
    const stillAttached = (live?.connections.size ?? 0) > 0;
    const nextState: AgentSession["connectionState"] = stillAttached
      ? "attached"
      : "detached";
    if (nextState !== session.connectionState) {
      const updated: AgentSession = {
        ...session,
        connectionState: nextState,
        revision: session.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.store.put("agent_session", updated);
      this.store.event(
        session.runId,
        "session.disconnected",
        { sessionId, connectionId: connectionId ?? null },
        "user",
      );
      return updated;
    }
    return session;
  }

  async stopSession(sessionId: string, input: unknown): Promise<AgentSession> {
    const data = StopSessionInput.parse(input);
    const session = this.getSession(sessionId);
    if (session.revision !== data.expectedSessionRevision) {
      const err = new DomainError(
        "revision_conflict",
        `终端会话版本冲突，期望 revision=${data.expectedSessionRevision}，当前为 ${session.revision}`,
        409,
      ) as DomainError & { currentRevision?: number };
      err.currentRevision = session.revision;
      throw err;
    }
    if (session.processState === "exited") return session;

    const live = this.live.get(sessionId);
    let stoppedConfirmed = true;
    if (live) {
      stoppedConfirmed = await live.handle.stop();
    } else if (session.processIdentity?.pid) {
      try {
        process.kill(session.processIdentity.pid, 0);
        stoppedConfirmed = false;
      } catch {
        stoppedConfirmed = true;
      }
    }

    const now = new Date().toISOString();
    const run = this.store.get<RunV3Extended>("adaptive_run", session.runId);
    const { workspacePath } = run
      ? resolveRunWorkspace(this.store, run)
      : { workspacePath: null };

    if (!stoppedConfirmed) {
      // A18: stop-unconfirmed MUST retain workspace lock under needs-reconciliation
      const updated: AgentSession = {
        ...session,
        processState: "stop-unconfirmed",
        connectionState: "detached",
        revision: session.revision + 1,
        updatedAt: now,
      };
      this.store.transaction(() => {
        this.store.put("agent_session", updated);
        if (workspacePath && existsSync(workspacePath)) {
          const access = this.access.get(workspacePath);
          const holder = access?.holders.find(
            (h) => h.owner === `intervention:${session.interventionId}`,
          );
          if (holder) {
            this.access.release(
              workspacePath,
              holder.owner,
              holder.epoch,
              false,
            );
          } else if (access && access.status === "active") {
            this.store.put("workspace_access", {
              ...access,
              status: "needs-reconciliation",
              updatedAt: now,
              note: "session_stop_unconfirmed",
            });
          }
        }
        this.store.event(
          session.runId,
          "session.stop_unconfirmed",
          { sessionId, pid: session.processIdentity?.pid ?? null },
          "platform",
        );
      });
      return updated;
    }

    const updated: AgentSession = {
      ...session,
      processState: "exited",
      connectionState: "detached",
      exitedAt: session.exitedAt ?? now,
      stopProof: `stopped-by-operator:${now}`,
      revision: session.revision + 1,
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.store.put("agent_session", updated);
      this.store.event(
        session.runId,
        "session.stopped",
        { sessionId, stopProof: updated.stopProof },
        "user",
      );
    });
    if (live) {
      for (const conn of live.connections.values()) {
        conn.onClose?.();
      }
      live.connections.clear();
      live.cleanupTemp?.();
    }
    return updated;
  }

  recoverOnRestart(): AgentSession[] {
    return this.store.transaction(() => {
      const recovered: AgentSession[] = [];
      const now = new Date().toISOString();
      for (const s of this.store.list<AgentSession>("agent_session")) {
        if (["creating", "running"].includes(s.processState)) {
          const updated: AgentSession = {
            ...s,
            processState: "stop-unconfirmed",
            connectionState: "detached",
            revision: s.revision + 1,
            updatedAt: now,
          };
          this.store.put("agent_session", updated);
          recovered.push(updated);
        }
      }
      return recovered;
    });
  }
}

function sendWsText(socket: Duplex, text: string): void {
  if (socket.destroyed || !socket.writable) return;
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

export function attachTerminalWebSocket(
  server: Server,
  sessions: AgentSessionManager,
  isAllowedOrigin: (origin: string | undefined) => boolean,
): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const rawUrl = req.url ?? "";
    const url = new URL(rawUrl, "http://127.0.0.1");
    const match = /^\/api\/v3\/agent-sessions\/([^/]+)\/stream$/.exec(
      url.pathname,
    );
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = decodeURIComponent(match[1]);
    const ticket = url.searchParams.get("ticket") ?? "";
    const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0") || 0;
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || !key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    let attached: { connectionId: string; isWriter: boolean };
    try {
      attached = sessions.attachConnection(sessionId, ticket, {
        onChunk: (chunk) => {
          sendWsText(socket, JSON.stringify({ type: "output", ...chunk }));
        },
        onClose: () => {
          try {
            socket.end();
          } catch {}
        },
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );

    const replay = sessions.readOutput(sessionId, afterSeq);
    sendWsText(
      socket,
      JSON.stringify({
        type: "hello",
        connectionId: attached.connectionId,
        writer: attached.isWriter,
        isWriter: attached.isWriter,
        truncated: replay.truncated,
        truncatedBeforeSeq: replay.truncatedBeforeSeq,
        lastSeq: replay.lastSeq,
      }),
    );
    for (const chunk of replay.chunks) {
      sendWsText(socket, JSON.stringify({ type: "output", ...chunk }));
    }

    let buffer = Buffer.alloc(0);
    socket.on("data", (raw: Buffer) => {
      buffer = Buffer.concat([buffer, raw]);
      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buffer.length < 4) return;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) return;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buffer.length < offset + maskLen + payloadLen) return;
        const maskKey = masked
          ? buffer.subarray(offset, offset + 4)
          : Buffer.alloc(0);
        offset += maskLen;
        const payload = Buffer.from(
          buffer.subarray(offset, offset + payloadLen),
        );
        buffer = buffer.subarray(offset + payloadLen);
        if (masked) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i % 4];
          }
        }
        if (opcode === 0x8) {
          try {
            socket.write(Buffer.from([0x88, 0x00]));
          } catch {}
          socket.destroy();
          return;
        }
        if (opcode === 0x9) {
          // Pong frame
          socket.write(Buffer.from([0x8a, 0x00]));
          continue;
        }
        if (opcode === 0x1) {
          try {
            const msg = JSON.parse(payload.toString("utf8")) as {
              type?: string;
              data?: string;
              rows?: number;
              cols?: number;
            };
            if (msg.type === "input" && typeof msg.data === "string") {
              sessions.sendInput(sessionId, attached.connectionId, msg.data);
            } else if (
              msg.type === "resize" &&
              typeof msg.rows === "number" &&
              typeof msg.cols === "number"
            ) {
              sessions.resize(sessionId, { rows: msg.rows, cols: msg.cols });
            }
          } catch (err) {
            sendWsText(
              socket,
              JSON.stringify({
                type: "error",
                code: err instanceof DomainError ? err.code : "ws_message_error",
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
      }
    });

    socket.on("close", () => {
      try {
        sessions.disconnect(sessionId, attached.connectionId);
      } catch {}
    });
    socket.on("error", () => {
      try {
        sessions.disconnect(sessionId, attached.connectionId);
      } catch {}
    });
  });
}
