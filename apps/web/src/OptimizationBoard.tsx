import { useEffect, useState } from "react";
import type { Run } from "../../../packages/domain/index";
type Props = {
  api: (path: string, data?: unknown) => Promise<any>;
  act: (fn: () => Promise<void>) => Promise<void>;
  runs: Run[];
  refresh: () => Promise<void>;
};
export function OptimizationBoard({ api, act, runs, refresh }: Props) {
  const [state, setState] = useState<any>(),
    [resources, setResources] = useState<any[]>([]),
    [proposalId, setProposalId] = useState("");
  const load = async () => {
    const [s, r] = await Promise.all([api("/optimization"), api("/resources")]);
    setState(s);
    setResources(r);
  };
  useEffect(() => {
    void act(load);
  }, []);
  const submit = (fn: () => Promise<void>) =>
    void act(async () => {
      await fn();
      await load();
      await refresh();
    });
  if (!state)
    return (
      <div className="panel">
        <p>正在读取优化记录…</p>
      </div>
    );
  const resourceName = (id: string) => {
    const r = resources.find((r) => r.id === id);
    return r ? `${r.name} @${r.version}` : id;
  };
  const runLabel = (run: Run) =>
    `${(run.manifest.task as any)?.title ?? run.id} · ${run.status} · ${run.id.slice(0, 8)}`;
  const proposal = state.proposals.find((p: any) => p.id === proposalId);
  return (
    <>
      <div className="stats">
        {[
          ["改进提案", state.proposals.length],
          ["评估记录", state.evaluations.length],
          ["发布记录", state.releases.length],
          ["回滚记录", state.rollbacks.length],
        ].map(([label, n]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{n}</strong>
          </article>
        ))}
      </div>
      <div className="panel">
        <h2>1 · 从执行轨迹发现问题</h2>
        <button
          onClick={() =>
            submit(async () => {
              await api("/optimization/analyze", {
                from: new Date(Date.now() - 7 * 86400000).toISOString(),
                to: new Date().toISOString(),
              });
            })
          }
        >
          分析最近七天
        </button>
        {state.analyses.slice(0, 3).map((batch: any) => (
          <article className="project" key={batch.id}>
            <small>
              {batch.from} — {batch.to} · {batch.runIds.length} 个运行
            </small>
            {batch.groups.length === 0 ? (
              <p>该窗口没有已记录的失败模式。</p>
            ) : (
              batch.groups.map((g: any, i: number) => (
                <div key={i}>
                  <h3>{g.signature}</h3>
                  <p>
                    {g.runIds.length} 个失败运行 · {g.recommendation}
                  </p>
                </div>
              ))
            )}
          </article>
        ))}
      </div>
      <div className="panel">
        <h2>2 · 生成Skill改进候选</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            submit(async () => {
              const p = await api("/optimization/candidates", {
                baselineId: fd.get("baselineId"),
                evidenceRunIds: fd.getAll("evidenceRunIds"),
              });
              setProposalId(p.id);
            });
          }}
        >
          <label>
            已发布基线Skill
            <select name="baselineId" required>
              <option value="">选择</option>
              {resources
                .filter((r) => r.kind === "skill" && r.status === "published")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} @{r.version}
                  </option>
                ))}
            </select>
          </label>
          <label>
            优化依据（必须是使用该基线的失败运行）
            <select name="evidenceRunIds" multiple required>
              {runs
                .filter((r) => r.status === "failed")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {runLabel(r)}
                  </option>
                ))}
            </select>
          </label>
          <p>
            候选会追加失败处理方法，创建后仍需通过实际成对执行和评估，不能直接发布。选择的优化依据不能计入留出集。
          </p>
          <button>生成候选和提案</button>
        </form>
        <details>
          <summary>关联已有的知识、Skill或工作流候选</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              submit(async () => {
                const p = await api("/optimization/proposals", {
                  title: fd.get("title"),
                  reason: fd.get("reason"),
                  baselineId: fd.get("baselineId"),
                  candidateId: fd.get("candidateId"),
                  evidenceRunIds: fd.getAll("evidenceRunIds"),
                  minVerifiedDeliveryGain: Number(
                    fd.get("minVerifiedDeliveryGain"),
                  ),
                });
                setProposalId(p.id);
              });
            }}
          >
            <label>
              提案标题
              <input name="title" required />
            </label>
            <label>
              修改理由
              <textarea name="reason" required />
            </label>
            <label>
              预设留出集最少增加通过案例数
              <input
                name="minVerifiedDeliveryGain"
                type="number"
                min={0}
                max={100}
                defaultValue={1}
              />
            </label>
            {["baselineId", "candidateId"].map((key) => (
              <label key={key}>
                {key === "baselineId" ? "基线版本" : "候选版本"}
                <select name={key} required>
                  <option value="">选择</option>
                  {resources
                    .filter((r) => r.status !== "revoked")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {resourceName(r.id)}
                      </option>
                    ))}
                </select>
              </label>
            ))}
            <label>
              依据运行
              <select name="evidenceRunIds" multiple required>
                {runs
                  .filter((r) => ["failed", "succeeded"].includes(r.status))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {runLabel(r)}
                    </option>
                  ))}
              </select>
            </label>
            <button>记录提案</button>
          </form>
        </details>
      </div>
      <div className="panel">
        <h2>3 · 固定独立评估案例</h2>
        <label>
          当前提案
          <select
            value={proposalId}
            onChange={(e) => setProposalId(e.target.value)}
          >
            <option value="">选择提案</option>
            {state.proposals.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        {proposal && (
          <>
            <p>
              基线：{resourceName(proposal.baselineId)} → 候选：
              {resourceName(proposal.candidateId)} ·{" "}
              {proposal.risk === "low" ? "行为等价低风险" : "需要人工审核"}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                submit(async () => {
                  const cases = ["development", "holdout"].flatMap((split) =>
                    fd.getAll(split).map((sourceRunId) => ({
                      sourceRunId,
                      split,
                      label: runLabel(runs.find((r) => r.id === sourceRunId)!),
                    })),
                  );
                  await api("/optimization/datasets", {
                    name: fd.get("name"),
                    version: fd.get("version"),
                    baselineId: proposal.baselineId,
                    cases,
                  });
                });
              }}
            >
              <label>
                数据集名称
                <input name="name" required />
              </label>
              <label>
                版本
                <input name="version" defaultValue="1.0.0" required />
              </label>
              {["development", "holdout"].map((split) => (
                <label key={split}>
                  {split === "holdout"
                    ? "独立留出案例（不使用优化依据中的输入）"
                    : "开发案例"}
                  <select name={split} multiple>
                    {runs
                      .filter(
                        (r) =>
                          r.runtime !== "manual" &&
                          ["succeeded", "failed", "cancelled"].includes(
                            r.status,
                          ),
                      )
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {runLabel(r)}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <p>
                每个案例固定输入、仓库基线、测试配置、执行器版本与非目标资源；重复输入不能增加独立样本量。
              </p>
              <button>保存不可变数据集</button>
            </form>
          </>
        )}
      </div>
      <div className="panel">
        <h2>4 · 成对试跑与证据评估</h2>
        {proposal && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              submit(async () => {
                await api(`/optimization/proposals/${proposal.id}/trials`, {
                  datasetId: fd.get("datasetId"),
                  consentToLocalExecution: fd.get("consent") === "on",
                });
              });
            }}
          >
            <label>
              固定数据集
              <select name="datasetId" required>
                <option value="">选择</option>
                {state.datasets
                  .filter((d: any) => d.baselineId === proposal.baselineId)
                  .map((d: any) => (
                    <option key={d.id} value={d.id}>
                      {d.name} @{d.version} · {d.cases.length} 个案例 × 2组
                    </option>
                  ))}
              </select>
            </label>
            <p>
              会调用模型，并在独立Worktree运行案例记录的测试命令。Worktree隔离代码目录；测试程序使用本机用户权限，不等同于网络或进程沙箱。
            </p>
            <details>
              <summary>查看该提案数据集的仓库与测试命令</summary>
              {state.datasets
                .filter((d: any) => d.baselineId === proposal.baselineId)
                .flatMap((d: any) =>
                  d.cases.map((c: any) => {
                    const source = runs.find((r) => r.id === c.sourceRunId);
                    return (
                      <pre key={d.id + c.id}>
                        {JSON.stringify(
                          {
                            case: c.label,
                            project: source?.manifest.project,
                            baseCommit: source?.manifest.baseCommit,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    );
                  }),
                )}
            </details>
            <label className="checkbox">
              <input type="checkbox" name="consent" required />
              我确认这些案例及测试程序可信，并授权本次模型调用与本机成对执行
            </label>
            <button>启动成对试跑</button>
          </form>
        )}
        {state.trials.map((trial: any) => (
          <article key={trial.id} className="project">
            <h3>试跑 {trial.id.slice(0, 8)}</h3>
            <p>
              {
                trial.pairs.filter(
                  (p: any) =>
                    ["succeeded", "failed", "cancelled"].includes(
                      runs.find((r) => r.id === p.baselineRunId)?.status ?? "",
                    ) &&
                    ["succeeded", "failed", "cancelled"].includes(
                      runs.find((r) => r.id === p.candidateRunId)?.status ?? "",
                    ),
                ).length
              }
              /{trial.pairs.length} 对执行已结束
            </p>
            <button className="quiet" onClick={() => submit(async () => {})}>
              刷新执行进度
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                submit(async () => {
                  await api(
                    `/optimization/proposals/${trial.proposalId}/evaluations`,
                    {
                      datasetId: trial.datasetId,
                      pairs: trial.pairs,
                      minHoldoutCases: Number(fd.get("minHoldoutCases")),
                    },
                  );
                });
              }}
            >
              <label>
                本次人工评估最小留出案例数
                <input
                  name="minHoldoutCases"
                  type="number"
                  min={3}
                  max={100}
                  defaultValue={20}
                />
              </label>
              <button>校验真实证据并生成评估</button>
            </form>
          </article>
        ))}
      </div>
      <div className="panel">
        <h2>5 · 审核发布与回滚</h2>
        <p>
          指标是验证交付通过数，不等同于最终业务验收。费用缺失时显示未知；小样本不能证明通用收益。
        </p>
        {state.evaluations.map((evaluation: any) => (
          <article className="project" key={evaluation.id}>
            <h3>
              评估 {evaluation.id.slice(0, 8)} ·{" "}
              {
                (
                  {
                    passed: "门槛通过",
                    regression: "发现失败或回归",
                    insufficient_samples: "独立样本不足",
                    no_measured_gain: "未达到预设收益",
                  } as Record<string, string>
                )[evaluation.result.gate]
              }
            </h3>
            <p>
              基线通过 {evaluation.result.baselinePass} /{" "}
              {evaluation.pairs.length}；候选通过{" "}
              {evaluation.result.candidatePass} / {evaluation.pairs.length}
              ；留出案例 {evaluation.result.holdoutCases}；费用：未知
            </p>
            <details>
              <summary>逐案例证据与结果</summary>
              <pre>{JSON.stringify(evaluation.result.cases, null, 2)}</pre>
            </details>
            {evaluation.result.gate === "passed" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  submit(async () => {
                    if (fd.get("releaseMode") === "canary") {
                      await api(
                        `/optimization/proposals/${evaluation.proposalId}/canaries`,
                        {
                          evaluationId: evaluation.id,
                          approvalReason: fd.get("reason"),
                          projectIds: fd.getAll("projectIds"),
                          maxTasks: Number(fd.get("maxTasks")),
                        },
                      );
                      return;
                    }
                    await api(
                      `/optimization/proposals/${evaluation.proposalId}/releases`,
                      {
                        evaluationId: evaluation.id,
                        mode: "manual",
                        approvalReason: fd.get("reason"),
                      },
                    );
                  });
                }}
              >
                <label>
                  人工审核理由
                  <textarea name="reason" required />
                </label>
                <label>
                  发布方式
                  <select name="releaseMode" defaultValue="canary">
                    <option value="canary">先在选定项目灰度</option>
                    <option value="manual">审核后直接发布</option>
                  </select>
                </label>
                <label>
                  灰度项目
                  <select name="projectIds" multiple>
                    {state.projects.map((project: any) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  灰度任务上限
                  <input
                    name="maxTasks"
                    type="number"
                    defaultValue={5}
                    min={1}
                    max={20}
                  />
                </label>
                <button>提交审核决定</button>
              </form>
            )}
          </article>
        ))}
        {state.canaries.map((canary: any) => (
          <article className="project" key={canary.rolloutId}>
            <h3>
              灰度 {resourceName(canary.candidateId)} · {canary.status}
            </h3>
            <p>
              已选择 {canary.selectedTaskIds.length}/{canary.maxTasks}{" "}
              个任务，已验收 {canary.acceptedTaskIds.length} 个。
            </p>
            {canary.status === "active" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const fd = new FormData(event.currentTarget);
                  submit(async () => {
                    await api(
                      `/optimization/canaries/${canary.id}/${fd.get("action")}`,
                      {
                        rolloutId: canary.rolloutId,
                        approvalReason: fd.get("reason"),
                        reason: fd.get("reason"),
                      },
                    );
                  });
                }}
              >
                <label>
                  操作
                  <select name="action">
                    <option value="promote">验收达标后全量发布</option>
                    <option value="stop">停止灰度，后续任务使用基线</option>
                  </select>
                </label>
                <label>
                  理由
                  <input name="reason" required />
                </label>
                <button className="quiet">执行灰度决定</button>
              </form>
            )}
          </article>
        ))}
        {state.releases.map((release: any) => (
          <article className="project" key={release.id}>
            <h3>已发布 {resourceName(release.resourceId)}</h3>
            <p>{release.approvalReason || "已授权低风险自动发布"}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                submit(async () => {
                  await api(`/optimization/releases/${release.id}/rollback`, {
                    reason: fd.get("reason"),
                  });
                });
              }}
            >
              <label>
                回滚理由
                <input name="reason" required />
              </label>
              <button className="quiet danger">回滚到前一版本</button>
            </form>
          </article>
        ))}
      </div>
      <div className="panel">
        <h2>周期分析与自动发布策略</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            submit(async () => {
              await api("/optimization/schedule", {
                enabled: fd.get("enabled") === "on",
                intervalDays: Number(fd.get("intervalDays")),
              });
            });
          }}
        >
          <label className="checkbox">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={state.schedule?.enabled}
            />
            启用本机服务运行期间的周期分析
          </label>
          <label>
            间隔天数
            <input
              type="number"
              name="intervalDays"
              min={1}
              max={90}
              defaultValue={state.schedule?.intervalDays ?? 7}
            />
          </label>
          <button>保存分析周期</button>
        </form>
        <p>
          默认关闭；离线漏触发合并为一次分析。只分析记录，不自动生成或执行试跑。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            submit(async () => {
              await api("/optimization/policy", {
                enabled: fd.get("enabled") === "on",
                approvalReason: fd.get("reason"),
                projectIds: fd.getAll("projectIds"),
              });
            });
          }}
        >
          <label className="checkbox">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={state.policy?.enabled}
            />
            允许行为等价资源的低风险自动发布
          </label>
          <label>
            自动灰度项目
            <select
              name="projectIds"
              multiple
              defaultValue={state.policy?.projectIds ?? []}
            >
              {state.projects.map((project: any) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            策略授权理由
            <input name="reason" required />
          </label>
          <p>
            语义内容、流程和来源集合必须不变，至少20个独立留出案例通过。任何行为改动仍需人工审核。
          </p>
          <button>保存发布策略</button>
        </form>
      </div>
    </>
  );
}
