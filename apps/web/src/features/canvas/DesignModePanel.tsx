import { useEffect, useState } from "react";
import type { Task } from "../../../../../packages/domain/index";
import {
  capabilityDigestPayload,
  profileDigestPayload,
  sha256HexBrowser,
} from "../../../../../packages/graph/canonical";
import type {
  ChangeProposal,
  CompilerDiagnostic,
  PlanDraft,
} from "../../../../../packages/graph/types";

type API = (
  path: string,
  data?: unknown,
  headers?: Record<string, string>,
  method?: string,
) => Promise<any>;

export function DesignModePanel({
  api,
  tasks,
  capabilities,
  profiles,
  onRunStarted,
  onResolveGap,
}: {
  api: API;
  tasks: Task[];
  capabilities: {
    id: string;
    name: string;
    version: string;
    status: string;
    sideEffect?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }[];
  profiles: {
    id: string;
    name: string;
    version: string;
    status: string;
    executor?: string;
    workspaceMode?: string;
    workspaceSubdir?: string;
    skillIds?: string[];
  }[];
  onRunStarted: (runId: string) => void;
  onResolveGap?: (gapTitle: string) => void;
}) {
  const [drafts, setDrafts] = useState<PlanDraft[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [goal, setGoal] = useState("");
  const [taskId, setTaskId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [nodeCapId, setNodeCapId] = useState("");
  const [nodeProfileId, setNodeProfileId] = useState("");
  const [nodesJson, setNodesJson] = useState("[]");
  const [compileState, setCompileState] = useState<{
    ok: boolean;
    compiledDigest: string | null;
    diagnostics: CompilerDiagnostic[];
  } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function refreshDrafts(focusId?: string) {
    const list: PlanDraft[] = await api("/v3/plan-drafts");
    setDrafts(list);
    const id = focusId ?? selectedId ?? list[0]?.id ?? "";
    if (id) {
      const target = list.find((d) => d.id === id);
      if (target) {
        setSelectedId(target.id);
        setNodesJson(JSON.stringify(target.nodes, null, 2));
      }
    }
  }

  useEffect(() => {
    void refreshDrafts();
  }, []);

  const current = drafts.find((d) => d.id === selectedId) ?? null;

  async function runAct(fn: () => Promise<void>) {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="draft-workbench">
      <div className="draft-header">
        <strong>方案设计工作台 (PlanDraft)</strong>
        <select
          aria-label="选择方案草稿"
          value={selectedId}
          onChange={(e) => {
            const next = drafts.find((d) => d.id === e.target.value);
            setSelectedId(e.target.value);
            setCompileState(null);
            if (next) setNodesJson(JSON.stringify(next.nodes, null, 2));
          }}
        >
          <option value="">新建或选择方案草稿…</option>
          {drafts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.goal.slice(0, 40)} · rev {d.revision} · 节点 {d.nodes.length} · 缺口{" "}
              {d.gaps.filter((g) => g.status === "open").length}
            </option>
          ))}
        </select>
        <button className="quiet" disabled={busy} onClick={() => void runAct(refreshDrafts)}>
          刷新草稿
        </button>
      </div>

      <div className="draft-create-row">
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
          <option value="">关联任务（启动执行前必选）</option>
          {tasks
            .filter((t) => !["done", "cancelled"].includes(t.status))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
        </select>
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="输入方案目标以创建新 PlanDraft…"
        />
        <button
          disabled={busy || !goal.trim()}
          onClick={() =>
            void runAct(async () => {
              const selectedTask = tasks.find((t) => t.id === taskId);
              const created: PlanDraft = await api("/v3/plan-drafts", {
                goal: goal.trim(),
                ...(taskId ? { taskId } : {}),
                ...(selectedTask?.projectId ? { projectId: selectedTask.projectId } : {}),
              });
              setGoal("");
              await refreshDrafts(created.id);
              setMsg(`已创建方案草稿 ${created.id.slice(0, 8)}`);
            })
          }
        >
          创建草稿
        </button>
      </div>

      {current && (
        <div className="draft-body">
          <div className="draft-actions">
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="编排指令（例如：添加需求分析、实现和测试交付节点）"
            />
            <button
              disabled={busy}
              onClick={() =>
                void runAct(async () => {
                  const res = await api(`/v3/plan-drafts/${current.id}/compose`, {
                    expectedRevision: current.revision,
                    instruction: instruction || current.goal,
                  });
                  setCompileState(null);
                  await refreshDrafts(res.draft.id);
                  setMsg("已完成草稿编排（含可执行节点与未满足能力缺口识别）。");
                })
              }
            >
              智能编排草稿
            </button>

            <button
              className="quiet"
              disabled={busy}
              onClick={() =>
                void runAct(async () => {
                  const cap = capabilities.find((c) => c.id === nodeCapId);
                  if (!cap) throw new Error("请先选择一个已发布能力");
                  const prof = profiles.find((p) => p.id === nodeProfileId);
                  const capDigest = await sha256HexBrowser(
                    capabilityDigestPayload({
                      id: cap.id,
                      version: cap.version,
                      inputSchema: cap.inputSchema ?? {},
                      outputSchema: cap.outputSchema ?? {},
                      sideEffect: cap.sideEffect ?? "none",
                    }),
                  );
                  const profDigest = prof
                    ? await sha256HexBrowser(
                        profileDigestPayload({
                          id: prof.id,
                          version: prof.version,
                          executor: prof.executor ?? "agent",
                          workspaceMode: prof.workspaceMode ?? "none",
                          workspaceSubdir: prof.workspaceSubdir ?? ".",
                          skillIds: prof.skillIds ?? [],
                        }),
                      )
                    : null;
                  const id = `${cap.name.split(".").pop() ?? "node"}_${current.nodes.length + 1}`;
                  const patched: PlanDraft = await api(
                    `/v3/plan-drafts/${current.id}`,
                    {
                      expectedRevision: current.revision,
                      operations: [
                        {
                          op: "addNode",
                          node: {
                            id,
                            engineKey: id.replace(/[^a-z0-9_-]/gi, "_").toLowerCase(),
                            capabilityRef: {
                              id: cap.id,
                              version: cap.version,
                              digest: capDigest,
                            },
                            ...(prof && profDigest
                              ? {
                                  profileRef: {
                                    id: prof.id,
                                    version: prof.version,
                                    digest: profDigest,
                                  },
                                }
                              : {}),
                            literals: { objective: current.goal },
                            bindings: [],
                            dependsOn: [],
                            knowledgeInputs: [],
                            knowledgeOutputs: [],
                          },
                        },
                      ],
                    },
                    {},
                    "PATCH",
                  );
                  setCompileState(null);
                  await refreshDrafts(patched.id);
                })
              }
            >
              追加能力节点
            </button>
          </div>

          <div className="draft-selectors">
            <select value={nodeCapId} onChange={(e) => setNodeCapId(e.target.value)}>
              <option value="">选择能力以追加节点…</option>
              {capabilities
                .filter((c) => c.status === "published")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}@{c.version}
                  </option>
                ))}
            </select>
            <select value={nodeProfileId} onChange={(e) => setNodeProfileId(e.target.value)}>
              <option value="">默认执行配置 Profile…</option>
              {profiles
                .filter((p) => p.status === "published")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}@{p.version}
                  </option>
                ))}
            </select>
            <button
              disabled={busy}
              onClick={() =>
                void runAct(async () => {
                  try {
                    const result = await api(`/v3/plan-drafts/${current.id}/compile`, {
                      expectedRevision: current.revision,
                    });
                    setCompileState(result);
                    setMsg(`编译通过 · digest=${result.compiledDigest?.slice(0, 12)}`);
                  } catch (e) {
                    const diag = (e as { details?: { diagnostics?: CompilerDiagnostic[] } })
                      ?.details?.diagnostics;
                    if (Array.isArray(diag)) {
                      setCompileState({ ok: false, compiledDigest: null, diagnostics: diag });
                    }
                    throw e;
                  }
                })
              }
            >
              Compile 校验
            </button>
            <button
              disabled={busy || !compileState?.ok || !compileState.compiledDigest}
              onClick={() =>
                void runAct(async () => {
                  const started = await api(
                    `/v3/plan-drafts/${current.id}/start`,
                    {
                      expectedRevision: current.revision,
                      compiledDigest: compileState!.compiledDigest,
                    },
                    { "Idempotency-Key": `ui-${current.id}-${current.revision}` },
                  );
                  setMsg(`已启动运行 ${started.runId}`);
                  onRunStarted(started.runId);
                })
              }
            >
              Start 启动运行
            </button>
          </div>

          {current.gaps.length > 0 && (
            <div className="draft-gaps">
              <strong>能力缺口 ({current.gaps.length})</strong>
              {current.gaps.map((g) => (
                <article key={g.id} className="project">
                  <b>{g.kind}</b> · {g.status} · {g.reason}
                  {g.affectedNodeIds.length > 0 && (
                    <small> · 影响节点：{g.affectedNodeIds.join(", ")}</small>
                  )}
                  {g.status === "open" && (
                    <>
                      {onResolveGap && (
                        <button
                          className="quiet"
                          onClick={() => onResolveGap(g.reason)}
                        >
                          去 Capability Builder 补齐
                        </button>
                      )}
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() =>
                          void runAct(async () => {
                            const patched: PlanDraft = await api(
                              `/v3/plan-drafts/${current.id}`,
                              {
                                expectedRevision: current.revision,
                                operations: [{ op: "resolveGap", gapId: g.id }],
                              },
                              {},
                              "PATCH",
                            );
                            setCompileState(null);
                            await refreshDrafts(patched.id);
                            setMsg(`已标记能力缺口 ${g.id} 为已解决。`);
                          })
                        }
                      >
                        标记已解决
                      </button>
                    </>
                  )}
                </article>
              ))}
            </div>
          )}

          {compileState && !compileState.ok && (
            <div className="draft-diagnostics" role="alert">
              <strong>编译诊断 ({compileState.diagnostics.length})</strong>
              <ul>
                {compileState.diagnostics.map((d, idx) => (
                  <li key={idx}>
                    <code>{d.code}</code> {d.nodeId ? `[${d.nodeId}]` : ""}{" "}
                    {d.fieldPointer ?? ""}: {d.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details>
            <summary>
              草案节点定义 ({current.nodes.length} 节点 · revision {current.revision})
            </summary>
            <pre>{nodesJson}</pre>
          </details>
        </div>
      )}

      {msg && (
        <p role="status" className="canvas-help">
          {msg}
        </p>
      )}
    </div>
  );
}

export function ChangeProposalPanel({
  runId,
  revision,
  api,
  onCommitted,
}: {
  runId: string;
  revision: number;
  api: API;
  onCommitted: () => Promise<void>;
}) {
  const [proposals, setProposals] = useState<ChangeProposal[]>([]);
  const [instruction, setInstruction] = useState("");
  const [patchText, setPatchText] = useState("{}");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function refreshProposals() {
    const list: ChangeProposal[] = await api(`/v3/runs/${runId}/change-proposals`);
    setProposals(list);
  }

  useEffect(() => {
    void refreshProposals();
  }, [runId, revision]);

  async function runAct(fn: () => Promise<void>) {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="change-proposal-panel">
      <h4>运行时图变更提案 (ChangeProposal · baseRev {revision})</h4>
      <div className="cli-controls">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="变更说明（例：重配置分析参数或追加验证节点）"
        />
        <textarea
          rows={2}
          value={patchText}
          onChange={(e) => setPatchText(e.target.value)}
          placeholder='可选 JSON Patch，如 {"operations":[...]} 或 {}'
        />
        <button
          disabled={busy || !instruction.trim()}
          onClick={() =>
            void runAct(async () => {
              const parsed = JSON.parse(patchText || "{}");
              const res = await api(`/v3/runs/${runId}/change-proposals`, {
                expectedRevision: revision,
                instruction: instruction.trim(),
                ...(Object.keys(parsed).length ? { patch: parsed } : {}),
              });
              await refreshProposals();
              setMsg(`已生成影响分析提案 ${res.proposal.id.slice(0, 8)}`);
            })
          }
        >
          生成变更影响预览
        </button>
      </div>

      {proposals.map((p) => (
        <article key={p.id} className="project">
          <b>{p.id.slice(0, 8)}</b> · baseRev {p.baseRevision} · 状态 {p.status} ·{" "}
          {p.instruction}
          <ul>
            {p.impact.map((item) => (
              <li key={item.nodeId}>
                <code>{item.engineKey}</code> → <strong>{item.action}</strong> (
                {item.validityAfter}) {item.preservedEffect ? "[保留已确认写效果]" : ""} ·{" "}
                {item.reasons.join("; ")}
              </li>
            ))}
          </ul>
          {p.status === "pending" && (
            <button
              disabled={busy}
              onClick={() =>
                void runAct(async () => {
                  await api(`/v3/change-proposals/${p.id}/commit`, {
                    expectedRunRevision: revision,
                    proposalDigest: p.approvalDigest,
                  });
                  await refreshProposals();
                  await onCommitted();
                  setMsg("已提交图变更并更新受影响节点有效性。");
                })
              }
            >
              提交变更提案 (CAS)
            </button>
          )}
        </article>
      ))}
      {msg && <p role="status" className="canvas-help">{msg}</p>}
    </div>
  );
}
