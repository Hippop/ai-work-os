import { useEffect, useState } from "react";
import type { Task } from "../../../packages/domain/index";
type Props = {
  tasks: Task[];
  api: (path: string, data?: unknown) => Promise<any>;
  act: (fn: () => Promise<void>) => Promise<void>;
};
export function DiagnosisBoard({ tasks, api, act }: Props) {
  const [id, setId] = useState(""),
    [snapshot, setSnapshot] = useState<any>();
  const load = async () => {
    if (id) setSnapshot(await api(`/tasks/${id}/diagnosis`));
  };
  useEffect(() => {
    setSnapshot(undefined);
    if (id) void act(load);
  }, [id]);
  return (
    <>
      <div className="panel">
        <h2>假设—证据工作区</h2>
        <p>
          诊断任务使用独立只读流程。证据不足时保留未知项；确认根因必须有用户验证的因果实验。
        </p>
        <label>
          诊断任务
          <select value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">选择故障诊断任务</option>
            {tasks
              .filter((t) => t.type === "diagnosis")
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        </label>
      </div>
      {id && snapshot && (
        <>
          <div className="panel">
            <h2>添加证据</h2>
            <p>
              证据按版本保留。新增证据供之后创建的运行使用，已有运行的输入快照保持固定。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  fd = new FormData(form);
                void act(async () => {
                  await api(`/tasks/${id}/diagnosis/evidence`, {
                    title: fd.get("title"),
                    source: fd.get("source"),
                    kind: fd.get("kind"),
                    observedAt: new Date(
                      String(fd.get("observedAt")),
                    ).toISOString(),
                    content: fd.get("content"),
                    verified: fd.get("verified") === "on",
                    causal: fd.get("causal") === "on",
                  });
                  form.reset();
                  await load();
                });
              }}
            >
              <label>
                证据标题
                <input name="title" required />
              </label>
              <label>
                原始来源
                <input
                  name="source"
                  placeholder="日志查询、实验记录或原始文件位置"
                  required
                />
              </label>
              <label>
                观测时间
                <input type="datetime-local" name="observedAt" required />
              </label>
              <label>
                类型
                <select name="kind">
                  <option value="observation">观测记录</option>
                  <option value="experiment">隔离验证实验</option>
                </select>
              </label>
              <label>
                证据内容
                <textarea name="content" required />
              </label>
              <label className="checkbox">
                <input type="checkbox" name="verified" />
                我已核实实验记录和结果
              </label>
              <label className="checkbox">
                <input type="checkbox" name="causal" />
                这是能支持因果关系的控制实验（需同时选择实验及已核实）
              </label>
              <button>保存证据</button>
            </form>
            {snapshot.evidence.map((e: any) => (
              <article className="project" key={e.id}>
                <h3>
                  {e.title}{" "}
                  <span className="badge">
                    {e.kind}
                    {e.causal ? " · 因果实验" : ""}
                  </span>
                </h3>
                <small>
                  {e.observedAt} · {e.source}
                </small>
                <pre>{e.content}</pre>
                <small>证据ID：{e.id}</small>
              </article>
            ))}
          </div>
          <div className="panel">
            <h2>建立候选假设</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  fd = new FormData(form);
                void act(async () => {
                  await api(`/tasks/${id}/diagnosis/hypotheses`, {
                    claim: fd.get("claim"),
                    supportingEvidence: fd.getAll("supportingEvidence"),
                    contradictingEvidence: fd.getAll("contradictingEvidence"),
                    nextExperiment: fd.get("nextExperiment"),
                  });
                  form.reset();
                  await load();
                });
              }}
            >
              <label>
                假设说明
                <textarea name="claim" required />
              </label>
              {(["supportingEvidence", "contradictingEvidence"] as const).map(
                (kind) => (
                  <label key={kind}>
                    {kind === "supportingEvidence" ? "支持证据" : "反证"}
                    <select multiple name={kind}>
                      {snapshot.evidence.map((e: any) => (
                        <option key={e.id} value={e.id}>
                          {e.title}
                        </option>
                      ))}
                    </select>
                  </label>
                ),
              )}
              <label>
                下一项待执行实验
                <textarea name="nextExperiment" />
              </label>
              <button>保存假设</button>
            </form>
            {snapshot.hypotheses.map((h: any) => (
              <article className="project" key={h.id}>
                <h3>{h.claim}</h3>
                <p>
                  支持 {h.supportingEvidence.length} 项 · 反证{" "}
                  {h.contradictingEvidence.length} 项
                </p>
                <p>下一步：{h.nextExperiment || "待补充"}</p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void act(async () => {
                      await api(`/tasks/${id}/diagnosis/hypotheses/${h.id}`, {
                        revision: h.revision,
                        changes: {
                          status: data.get("status"),
                          nextExperiment: data.get("nextExperiment"),
                        },
                      });
                      await load();
                    });
                  }}
                >
                  <label>
                    假设判断
                    <select name="status" defaultValue={h.status}>
                      <option value="open">尚待验证</option>
                      <option value="supported">有证据支持</option>
                      <option value="rejected">已排除</option>
                    </select>
                  </label>
                  <label>
                    下一步实验
                    <textarea
                      name="nextExperiment"
                      defaultValue={h.nextExperiment}
                    />
                  </label>
                  <button className="quiet">保存假设新版本</button>
                </form>
              </article>
            ))}
          </div>
          <div className="panel">
            <h2>诊断报告</h2>
            <button className="quiet" onClick={() => void act(load)}>
              刷新报告
            </button>
            {snapshot.reports.length === 0 && (
              <p>
                可从工作台或 V2 自适应工作流启动诊断，结构化报告通过证据校验后会出现在这里。
              </p>
            )}
            {snapshot.reports.map((r: any) => (
              <article className="project" key={r.id}>
                <h3>{r.summary}</h3>
                {r.runId&&<small>V2 运行：{r.runId} · 证据摘要：{r.inputDigest}</small>}
                {tasks.find((t)=>t.id===id)?.status==="done" && ["confirmed","likely"].includes(r.conclusion.status)&&<button className="quiet" onClick={()=>{
                  const objective=window.prompt("填写修复目标。可能根因仍需修复测试验证，不视为已确认事实。");if(!objective?.trim())return;
                  const criteria=window.prompt("填写修复验收标准，每行一项");if(!criteria?.trim())return;
                  void act(async()=>{const repair=await api(`/tasks/${id}/diagnosis/reports/${r.id}/repair-task`,{
                    title:("修复："+r.summary).slice(0,200),objective,acceptanceCriteria:criteria.split("\n").map((s)=>s.trim()).filter(Boolean),
                  });window.alert("修复任务已创建（尚未执行）："+repair.title+" · "+repair.id);await load();});
                }}>创建关联修复任务</button>}
                <span className="badge">
                  {
                    (
                      {
                        confirmed: "确认根因",
                        likely: "可能根因",
                        unresolved: "证据不足",
                      } as Record<string, string>
                    )[r.conclusion.status]
                  }
                </span>
                <p>{r.conclusion.reason}</p>
                <ul>
                  {r.conclusion.unknowns.map((v: string, i: number) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
                <details>
                  <summary>假设与证据引用</summary>
                  <pre>{JSON.stringify(r.hypotheses, null, 2)}</pre>
                </details>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
