import {ProjectRuntimeSettings} from "./ProjectRuntimeSettings";
import { taskRunLink, type RunLink } from "./run-navigation";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task, Project, Run, Event } from "../../../packages/domain/index";
import "./style.css";
import { ResourceManager } from "./ResourceManager";
import { AdaptiveBoard } from "./AdaptiveBoard";
import { PlanEditor } from "./PlanEditor";
import { PlanningBoard } from "./PlanningBoard";
import { DiagnosisBoard } from "./DiagnosisBoard";
import { OptimizationBoard } from "./OptimizationBoard";
import { RuntimeStatus } from "./RuntimeStatus";
import { RecoveryPanel } from "./RecoveryPanel";

const labels: Record<string, string> = {
  inbox: "收件箱",
  planned: "已规划",
  ready: "就绪",
  in_progress: "执行中",
  awaiting_acceptance: "待验收",
  done: "已完成",
  running: "执行中",
  queued: "排队中",
  paused: "已暂停",
  succeeded: "交付就绪",
  cancelled: "已取消",
  failed: "失败",
  pending: "待执行",
  blocked: "受阻",
  reconciling: "待核对",
  preparing: "准备中",
  pausing: "正在暂停",
  cancelling: "正在取消",
};
type Delivery = {
  artifacts?: string[];
  id: string;
  runId: string;
  summary: string;
  createdAt: string;
};
const developmentStages = [
  { operation: "analyze", title: "需求分析", instruction: "明确需求范围和验收要点" },
  { operation: "design", title: "方案设计" },
  { operation: "implement", title: "代码实现" },
  { operation: "test", title: "运行测试" },
  { operation: "review", title: "代码审查" },
  { operation: "deliver", title: "成果交付" },
];
const diagnosisStages = [
  { operation: "collect", title: "收集证据" },
  { operation: "hypothesize", title: "形成假设" },
  { operation: "verify", title: "验证与反证" },
  { operation: "conclude", title: "形成结论" },
  { operation: "deliver", title: "交付诊断报告" },
];
function buildFlowRequest(form: FormData) {
  const mode = String(form.get("flowMode") || "standard");
  const instructions = String(form.get("flowInstructions") || "").trim();
  if (form.get("type") === "manual") return null;
  if (mode === "standard") return instructions ? { mode, instructions } : null;
  const source = String(form.get("flowDefinition") || "").trim();
  if (!source) throw new Error("请填写流程步骤 JSON");
  const stages = JSON.parse(source);
  return mode === "compose"
    ? { mode, instructions, stages }
    : { mode: "graph", instructions, nodes: stages };
}
function sampleFlow(mode: "standard" | "compose" | "graph", taskType: string) {
  const stages: { operation: string; title: string; instruction?: string }[] =
    taskType === "diagnosis" ? diagnosisStages : developmentStages;
  if (mode !== "graph") return JSON.stringify(stages, null, 2);
  return JSON.stringify(stages.map(({ operation, title, instruction }, i) => ({
    key: operation + "_1",
    operation,
    title,
    ...(instruction ? { instruction } : {}),
    dependsOn: i ? [stages[i - 1].operation + "_1"] : [],
  })), null, 2);
}
function App() {
  const [token, setToken] = useState(
    sessionStorage.getItem("ai-work-os-token") ?? "",
  );
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState("工作台");
  const [tasks, setTasks] = useState<Task[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [deliveries, setDeliveries] = useState<Delivery[]>([]),
    [resources, setResources] = useState<
      {
        id: string;
        name: string;
        version: string;
        kind: string;
        status: string;
        familyId: string;
        current: boolean;
      }[]
    >([]);
  const [adaptiveRuns,setAdaptiveRuns] = useState<RunLink[]>([]);
  const [selectedAdaptive,setSelectedAdaptive] = useState("");
  const [externalSkills, setExternalSkills] = useState<{ id: string; name: string; status: string }[]>([]);
  const [flowMode, setFlowMode] = useState<"standard" | "compose" | "graph">("standard");
  const [flowTaskType, setFlowTaskType] = useState("manual");
  const [flowPreview, setFlowPreview] = useState<
    { key: string; operation: string; title: string; dependsOn: string[] }[]
  >([]);
  const [selected, setSelected] = useState<string>(),
    [events, setEvents] = useState<Event[]>([]),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState(false);
  const [prepared, setPrepared] = useState<{
    taskId: string;
    preparationDigest: string;
    ready: boolean;
    checks: { label: string; passed: boolean; detail: string }[];
    plan: { key: string; operation: string; title: string; dependsOn: string[] }[];
  }>();
  async function api<T = any>(
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(path.startsWith("/v2/") ? `/api${path}` : `/api/v1${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "请求失败");
    return result;
  }
  async function refresh() {
    const [t, p, r, d, versions, importedSkills, adaptiveIndex] = await Promise.all([
      api<Task[]>("/tasks"),
      api<Project[]>("/projects"),
      api<Run[]>("/runs"),
      api<Delivery[]>("/deliveries"),
      api<typeof resources>("/resources"),
      api<typeof externalSkills>("/v2/external-skills"),
      api<RunLink[]>("/v2/run-index"),
    ]);
    setTasks(t);
    setProjects(p);
    setRuns(r);
    setDeliveries(d);
    setResources(versions);
    setExternalSkills(importedSkills);
    setAdaptiveRuns(adaptiveIndex);
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!token) return;
    void act(async () => {
      await refresh();
      setConnected(true);
    });
  }, []);
  const currentRun = runs.find((r) => r.id === selected),
    currentTask = tasks.find((t) => t.id === currentRun?.taskId);
  useEffect(() => {
    if (!connected || !selected) return;
    const load = () =>
      api<Event[]>(`/runs/${selected}/events`)
        .then(setEvents)
        .catch((e) => setError(e.message));
    void load();
    const timer = setInterval(() => {
      void load();
      void refresh().catch((e) => setError(e.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [selected, connected]);
  useEffect(()=>{
    if(!connected)return;
    const timer=setInterval(()=>{void refresh().catch((e)=>setError(e.message));},5000);
    return ()=>clearInterval(timer);
  },[connected,token]);
  const active = tasks.filter((t) => t.status === "in_progress").length,
    pending = tasks.filter((t) => t.status === "awaiting_acceptance").length;
  async function prepare(task: Task) {
    await act(async () => {
      const result = await api<{
        preparationDigest: string;
        ready: boolean;
        checks: { label: string; passed: boolean; detail: string }[];
        manifest: { context: { plan: { key: string; operation: string; title: string; dependsOn: string[] }[] } };
      }>(`/tasks/${task.id}/prepare`, {});
      setPrepared({
        ...result,
        taskId: task.id,
        plan: task.type === "manual"
          ? [{ key: "manual", operation: "manual", title: "人工执行与成果提交", dependsOn: [] }]
          : result.manifest.context.plan,
      });
    });
  }
  function taskForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void act(async () => {
      await api("/tasks", {
        title: form.get("title"),
        objective: form.get("objective"),
        type: form.get("type"),
        priority: form.get("priority"),
        maxMinutes:Number(form.get("maxMinutes")||30),
        flowRequirements: buildFlowRequest(form),
        projectId: form.get("projectId") || null,
        externalSkillIds: form.getAll("externalSkillIds").map(String),
        skillVersionIds: form
          .getAll("skillVersionIds")
          .filter((v) => !String(v).startsWith("active:")),
        knowledgeVersionIds: form
          .getAll("knowledgeVersionIds")
          .filter((v) => !String(v).startsWith("active:")),
        workflowVersionId: String(form.get("workflowVersionId")).startsWith(
          "active:",
        )
          ? null
          : form.get("workflowVersionId") || null,
        resourceFamilyIds: [
          ...form.getAll("skillVersionIds"),
          ...form.getAll("knowledgeVersionIds"),
          form.get("workflowVersionId"),
        ]
          .filter((v) => String(v).startsWith("active:"))
          .map((v) => String(v).slice(7)),
        acceptanceCriteria: String(form.get("criteria"))
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setModal(false);
      await refresh();
    });
  }
  if (!connected)
    return (
      <div className="login">
        <div className="brand">◈ AI WORK OS</div>
        <h1>连接你的工作空间</h1>
        <p>访问令牌保存在服务启动时显示的本机文件中。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await refresh();
              sessionStorage.setItem("ai-work-os-token", token);
              setConnected(true);
            });
          }}
        >
          <label>
            本机访问令牌
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </label>
          <button disabled={busy}>连接工作空间 →</button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          ◈{" "}
          <span>
            AI WORK OS<small>个人智能工作空间</small>
          </span>
        </div>
        <div className="nav-title">WORKSPACE</div>
        {[
          "工作台",
          "执行台",
          "优化中心",
          "项目与仓库",
          "能力与知识",
          "自适应工作流",
          "目标与计划",
          "故障诊断",
        ].map((item, index) => (
          <button
            className={`nav ${page === item ? "active" : ""}`}
            key={item}
            onClick={() => {
              setPage(item);
              setPrepared(undefined);
            }}
          >
            <span>{["▦", "▷", "↗", "▱", "◈", "☷", "⌕"][index]}</span>
            {item}
            {item === "执行台" && active > 0 && <b>{active}</b>}
          </button>
        ))}
        <div className="sidebar-bottom">
          <i /> 本机服务已连接<small>LOCAL FIRST · v0.1 开发中</small>
        </div>
      </aside>
      <main>
        <header>
          <div>
            工作空间 <span>/</span> {page}
          </div>
          <button className="quiet" onClick={() => void act(refresh)}>
            ↻ 刷新
          </button>
        </header>
        <section className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(
                  new Date(),
                )}
              </div>
              <h1>{page === "工作台" ? "把目标，变成进展。" : page}</h1>
              <p>
                {page === "工作台"
                  ? "收集想法，规划工作，追踪每一次交付。"
                  : page === "执行台"
                    ? "查看运行过程、成果与需要你处理的事项。"
                    : page === "优化中心"
                      ? "让改进建立在真实的任务记录上。"
                      : page === "目标与计划"
                        ? "组织目标、子任务与依赖，回顾实际验收进展。"
                        : page === "故障诊断"
                          ? "围绕可追溯证据建立假设、验证和结论。"
                          : page === "能力与知识"
                            ? "管理版本、来源与运行方法。"
                            : "连接代码仓库，建立项目上下文。"}
              </p>
            </div>
            {page === "工作台" && (
              <button onClick={() => setModal(true)}>＋ 创建任务</button>
            )}
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
              <button className="quiet" onClick={() => setError("")}>
                关闭
              </button>
            </div>
          )}
          {page === "工作台" && (
            <>
              <div className="stats">
                {[
                  ["全部任务", tasks.length, "从想法到交付"],
                  ["执行中", active, "专注当前进展"],
                  ["待验收", pending, "查看成果与反馈"],
                  [
                    "已完成",
                    tasks.filter((t) => t.status === "done").length,
                    "让工作持续积累",
                  ],
                ].map(([label, value, note]) => (
                  <article key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                    <small>{note}</small>
                  </article>
                ))}
              </div>
              <div className="panel">
                <div className="panel-heading">
                  <h2>
                    任务清单 <em>{tasks.length}</em>
                  </h2>
                  <span>按创建时间排序</span>
                </div>
                {!tasks.length ? (
                  <div className="empty">
                    <span>＋</span>
                    <h3>从一个清晰的目标开始</h3>
                    <p>创建任务，写下目标与验收条件，再选择执行方式。</p>
                    <button onClick={() => setModal(true)}>
                      创建第一个任务
                    </button>
                  </div>
                ) : (
                  tasks.map((task) => (
                    <div className="task-row" key={task.id}>
                      <div className={`priority ${task.priority}`} />
                      <div className="task-info">
                        <h3>{task.title}</h3>
                        <p>
                          {projects.find((p) => p.id === task.projectId)
                            ?.name ?? "个人任务"}{" "}
                          ·{" "}
                          {task.type === "manual"
                            ? "人工执行"
                            : task.type === "diagnosis"
                              ? "故障诊断"
                              : "需求开发"}{" "}
                          · {task.acceptanceCriteria.length} 项验收
                        </p>
                      </div>
                      <span className={`badge ${task.status}`}>
                        {labels[task.status] ?? task.status}
                      </span>
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() => {
                          const run = taskRunLink(task.id,runs,adaptiveRuns);
                          if (run?.engine === "adaptive") {
                            setSelectedAdaptive(run.id);setPage("自适应工作流");
                          } else if (
                            run &&
                            [
                              "in_progress",
                              "awaiting_acceptance",
                              "done",
                            ].includes(task.status)
                          ) {
                            setSelected(run.id);
                            setPage("执行台");
                          } else void prepare(task);
                        }}
                      >
                        {[
                          "in_progress",
                          "awaiting_acceptance",
                          "done",
                        ].includes(task.status)
                          ? "查看运行 →"
                          : "执行准备 →"}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
          {prepared && (
            <div className="panel preparation">
              <h2>执行准备</h2>
              <details>
                <summary>本次任务组装流程（{prepared.plan.length} 步）</summary>
                <ol>{prepared.plan.map((node) => (
                  <li key={node.key}>{node.title}（{node.operation}） · 依赖：{node.dependsOn.join(", ") || "无"}</li>
                ))}</ol>
              </details>
              {prepared.checks.map((c) => (
                <p key={c.label}>
                  <span className={c.passed ? "pass" : "warn"}>
                    {c.passed ? "✓" : "○"}
                  </span>{" "}
                  <b>{c.label}</b> — {c.detail}
                </p>
              ))}
              <button
                disabled={!prepared.ready || busy}
                onClick={() =>
                  void act(async () => {
                    const run = await api<Run>(
                      `/tasks/${prepared.taskId}/runs`,
                      { preparationDigest: prepared.preparationDigest },
                      { "Idempotency-Key": crypto.randomUUID() },
                    );
                    setPrepared(undefined);
                    await refresh();
                    setSelected(run.id);
                    setPage("执行台");
                  })
                }
              >
                启动执行
              </button>
              <button className="quiet" onClick={() => setPrepared(undefined)}>
                关闭
              </button>
            </div>
          )}
          {page === "执行台" && (
            <div className="execution">
              <div className="panel run-list">
                <h2>运行记录</h2>
                {runs.length === 0 && adaptiveRuns.length === 0 && (
                  <p className="muted">
                    暂无运行，请先创建任务并检查执行准备。
                  </p>
                )}
                {adaptiveRuns.map((run)=><button key={run.id} className="run-link" onClick={()=>{
                  setSelectedAdaptive(run.id);setPage("自适应工作流");
                }}><b>{tasks.find((t)=>t.id===run.taskId)?.title}</b>
                  <span>{labels[run.status]??run.status} · 自适应工作流</span>
                  <small>{new Date(run.createdAt).toLocaleString("zh-CN")}</small>
                </button>)}
                {runs.map((run) => (
                  <button
                    key={run.id}
                    className={`run-link ${selected === run.id ? "chosen" : ""}`}
                    onClick={() => setSelected(run.id)}
                  >
                    <b>{tasks.find((t) => t.id === run.taskId)?.title}</b>
                    <span className={`badge ${run.status}`}>
                      {labels[run.status] ?? run.status}
                    </span>
                    <small>
                      {new Date(run.createdAt).toLocaleString("zh-CN")}
                    </small>
                  </button>
                ))}
              </div>
              <div className="panel run-detail">
                {currentRun && currentTask ? (
                  <>
                    <div className="panel-heading">
                      <h2>{currentTask.title}</h2>
                      <span className={`badge ${currentRun.status}`}>
                        {labels[currentRun.status] ?? currentRun.status}
                      </span>
                    </div>
                    <p className="muted">{currentTask.objective}</p>
                    <h3>验收条件</h3>
                    <ul>
                      {currentTask.acceptanceCriteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                    <div className="steps">
                      {currentRun.steps.map((s) => (
                        <div key={s.id}>
                          <i
                            className={
                              s.status === "succeeded" ? "complete" : ""
                            }
                          />
                          {s.title}
                          <small>{labels[s.status] ?? s.status}</small>
                        </div>
                      ))}
                    </div>
                    <div className="actions">
                      {currentRun.status === "running" && (
                        <button
                          className="quiet"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await api(`/runs/${currentRun.id}/pause`, {});
                              await refresh();
                            })
                          }
                        >
                          暂停
                        </button>
                      )}
                      {currentRun.status === "paused" && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await api(`/runs/${currentRun.id}/resume`, {});
                              await refresh();
                            })
                          }
                        >
                          恢复
                        </button>
                      )}
                      {!["succeeded", "failed", "cancelled"].includes(
                        currentRun.status,
                      ) && (
                        <button
                          className="quiet danger"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await api(`/runs/${currentRun.id}/cancel`, {});
                              await refresh();
                            })
                          }
                        >
                          取消运行
                        </button>
                      )}
                    </div>
                    {currentRun.status === "running" &&
                      currentRun.runtime === "manual" && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const summary = new FormData(e.currentTarget).get(
                              "summary",
                            );
                            void act(async () => {
                              await api(`/runs/${currentRun.id}/deliveries`, {
                                summary,
                              });
                              await refresh();
                            });
                          }}
                        >
                          <label>
                            成果说明
                            <textarea
                              name="summary"
                              required
                              placeholder="描述完成的内容、验证方式、交付位置和遗留事项…"
                            />
                          </label>
                          <button disabled={busy}>提交成果，进入验收</button>
                        </form>
                      )}
                    {["reconciling", "cancelling"].includes(
                      currentRun.status,
                    ) &&
                      currentRun.runtime !== "manual" && (
                        <RecoveryPanel
                          key={currentRun.id}
                          runId={currentRun.id}
                          busy={busy}
                          api={api}
                          act={act}
                          refresh={refresh}
                        />
                      )}
                    {deliveries
                      .filter((d) => d.runId === currentRun.id)
                      .map((d) => (
                        <div className="delivery" key={d.id}>
                          <h3>交付成果</h3>
                          <pre>{d.summary}</pre>
                          {d.artifacts?.map((name) => (
                            <button
                              className="quiet"
                              key={name}
                              onClick={() =>
                                void act(async () => {
                                  const response = await fetch(
                                    `/api/v1/runs/${d.runId}/artifacts/${name}`,
                                    {
                                      headers: {
                                        Authorization: `Bearer ${token}`,
                                      },
                                    },
                                  );
                                  if (!response.ok)
                                    throw new Error(
                                      (await response.json()).message,
                                    );
                                  const url = URL.createObjectURL(
                                      await response.blob(),
                                    ),
                                    link = document.createElement("a");
                                  link.href = url;
                                  link.download = name;
                                  link.click();
                                  setTimeout(
                                    () => URL.revokeObjectURL(url),
                                    1000,
                                  );
                                })
                              }
                            >
                              下载 {name}
                            </button>
                          ))}
                          {currentTask.status === "awaiting_acceptance" && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                const fd = new FormData(e.currentTarget);
                                const accepted =
                                  fd.get("decision") === "accept";
                                void act(async () => {
                                  await api(
                                    `/tasks/${currentTask.id}/acceptances`,
                                    {
                                      deliveryId: d.id,
                                      accepted,
                                      reason: fd.get("reason"),
                                    },
                                  );
                                  await refresh();
                                });
                              }}
                            >
                              <label>
                                验收结论
                                <select name="decision">
                                  <option value="accept">接受交付</option>
                                  <option value="reject">退回修改</option>
                                </select>
                              </label>
                              <label>
                                反馈
                                <input
                                  name="reason"
                                  placeholder="退回时请填写原因"
                                />
                              </label>
                              <button disabled={busy}>确认验收结论</button>
                            </form>
                          )}
                        </div>
                      ))}
                    <h3>事实时间线</h3>
                    <div className="timeline">
                      {events.map((ev) => (
                        <div key={ev.id}>
                          <time>
                            {new Date(ev.at).toLocaleTimeString("zh-CN")}
                          </time>
                          <b>{ev.type}</b>
                          <details>
                            <summary>查看详情</summary>
                            <pre>{JSON.stringify(ev.payload, null, 2)}</pre>
                          </details>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="empty">
                    <h3>选择一次运行</h3>
                    <p>查看步骤、成果和执行记录。</p>
                  </div>
                )}
              </div>
            </div>
          )}
          {page === "优化中心" && (
            <OptimizationBoard
              api={api}
              act={act}
              runs={runs}
              refresh={refresh}
            />
          )}
          {page === "能力与知识" && <ResourceManager api={api} act={act} refresh={refresh} />}
          {page === "自适应工作流" && <AdaptiveBoard api={api} act={act} token={token} tasks={tasks} projects={projects} initialRunId={selectedAdaptive} onChanged={refresh} />}
          {page === "目标与计划" && (
            <PlanningBoard
              tasks={tasks}
              projects={projects}
              api={api}
              act={act}
              refresh={refresh}
            />
          )}
          {page === "故障诊断" && (
            <DiagnosisBoard tasks={tasks} api={api} act={act} />
          )}
          {currentRun?.status === "paused" &&
            currentRun.runtime !== "manual" &&
            page === "执行台" && (
              <div className="panel">
                <PlanEditor
                  key={currentRun.id + ":" + currentRun.manifest.planRevision}
                  run={currentRun}
                  submit={(nodes, reason) =>
                    act(async () => {
                      await api(`/runs/${currentRun.id}/plan-proposals`, {
                        expectedRevision:
                          Number(currentRun.manifest.planRevision) || 1,
                        nodes: JSON.parse(String(nodes)),
                        reason,
                      });
                      await refresh();
                    })
                  }
                />
              </div>
            )}
          {page === "项目与仓库" && <RuntimeStatus api={api} act={act} />}
          {page === "项目与仓库" && (
            <div className="panel">
              <h2>添加项目</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = e.currentTarget,
                    fd = new FormData(f);
                  void act(async () => {
                    const executable = String(
                      fd.get("testExecutable") ?? "",
                    ).trim();
                    await api("/projects", {
                      name: fd.get("name"),
                      repositoryPath: fd.get("repositoryPath"),
                      description: fd.get("description"),
                      allowAgent: fd.get("allowAgent") === "on",
                      ...(String(fd.get("setupExecutable")||"").trim() ? {setupCommand:{
                        executable:String(fd.get("setupExecutable")).trim(),
                        args:JSON.parse(String(fd.get("setupArgs")||"[]")),
                      }} : {}),
                      authorizedCommands: JSON.parse(String(fd.get("authorizedCommands") || "[]")),
                      ...(executable
                        ? {
                            testCommand: {
                              executable,
                              args: JSON.parse(
                                String(fd.get("testArgs") || "[]"),
                              ),
                            },
                          }
                        : {}),
                    });
                    f.reset();
                    await refresh();
                  });
                }}
              >
                <label>
                  项目名称
                  <input name="name" required />
                </label>
                <label>
                  Git 仓库绝对路径
                  <input
                    name="repositoryPath"
                    required
                    placeholder="C:\Projects\my-project"
                  />
                </label>
                <label>
                  项目说明
                  <textarea name="description" />
                </label>
                <label>
                  测试程序
                  <input
                    name="testExecutable"
                    placeholder="可执行文件绝对路径，例如 node.exe"
                  />
                </label>
                <label>
                  测试参数（JSON数组）
                  <input
                    name="testArgs"
                    defaultValue="[]"
                    placeholder='["--test"]'
                  />
                </label>
                <label>隔离工作区初始化程序（可选，仅 V2；会使用本机权限执行）
                  <input name="setupExecutable" placeholder="例如 /usr/bin/npm"/>
                </label>
                <label>初始化参数 JSON
                  <input name="setupArgs" defaultValue="[]" placeholder='["ci"]'/>
                </label>
                <p>新 Worktree 不继承 node_modules、虚拟环境或未跟踪配置。初始化命令在每次运行的新工作区执行一次；仅配置受信任命令。</p>
                <label>额外授权的程序命令 JSON（可选；独立于测试命令）
                  <textarea name="authorizedCommands" rows={4} defaultValue="[]"
                    placeholder='[{"name":"static-check","executable":"/usr/bin/node","args":["scripts/check.cjs"],"allowWorkspaceWrite":false}]'/>
                </label>
                <p>额外程序默认只读；只有明确设置 allowWorkspaceWrite=true 并配置隔离 Worktree 才允许修改代码。</p>
                <label className="checkbox">
                  <input type="checkbox" name="allowAgent" />
                  授权 Agent 在隔离工作区修改代码，并运行上述测试程序
                </label>
                <p>
                  测试程序按项目配置直接运行，使用当前用户权限。仅配置受信任的程序和参数。
                </p>
                <button disabled={busy}>连接仓库</button>
              </form>
              {projects.map((p) => (
                <article className="project" key={p.id}>
                  <h3>{p.name}</h3>
                  <code>{p.repositoryPath}</code>
                  <p>{p.description}</p>
                  <ProjectRuntimeSettings key={JSON.stringify(p)} project={p} api={api} act={act} onChanged={refresh}/>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
      {modal && (
        <div className="overlay">
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-title"
          >
            <div className="panel-heading">
              <h2 id="task-title">创建任务</h2>
              <button className="quiet" onClick={() => setModal(false)}>
                关闭 ✕
              </button>
            </div>
            <form onSubmit={taskForm}>
              <label>
                任务标题
                <input
                  name="title"
                  required
                  autoFocus
                  maxLength={200}
                  placeholder="例如：完成订单查询接口"
                />
              </label>
              <label>
                工作目标
                <textarea
                  name="objective"
                  required
                  placeholder="为什么做，期望得到什么结果？"
                />
              </label>
              <div className="form-row">
                <label>
                  执行方式
                  <select name="type" value={flowTaskType} onChange={(event) => { setFlowTaskType(event.target.value); setFlowPreview([]); }}>
                    <option value="manual">人工执行</option>
                    <option value="development">Codex 需求开发</option>
                    <option value="diagnosis">Codex 只读故障诊断</option>
                  </select>
                </label>
                <label>
                  优先级
                  <select name="priority" defaultValue="normal">
                    <option value="normal">普通</option>
                    <option value="high">高</option>
                    <option value="low">低</option>
                  </select>
                </label>
              </div>
              <label>
                所属项目
                <select name="projectId">
                  <option value="">个人任务</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                工作流版本
                <select name="workflowVersionId">
                  <option value="">按任务类型选择标准流程</option>
                  {resources
                    .filter(
                      (r) =>
                        r.kind === "workflow" &&
                        r.current &&
                        r.status === "published",
                    )
                    .map((r) => (
                      <option
                        key={"active:" + r.familyId}
                        value={"active:" + r.familyId}
                      >
                        跟随发布模板：{r.name}（当前 {r.version}）
                      </option>
                    ))}
                  {resources
                    .filter(
                      (r) => r.kind === "workflow" && r.status === "published",
                    )
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} @{r.version}
                      </option>
                    ))}
                </select>
              </label>
              {flowTaskType !== "manual" && (
                <div className="panel">
                  <h3>本任务的流程组装需求</h3>
                  <p>可沿用标准/已发布模板、按步骤顺序组装，或提交完整 DAG。指定的流程只影响本任务，不会覆盖公共模板。</p>
                  <label>组装方式
                    <select name="flowMode" value={flowMode} onChange={(event) => {
                      setFlowMode(event.target.value as typeof flowMode);
                      setFlowPreview([]);
                    }}>
                      <option value="standard">沿用选定模板</option>
                      <option value="compose">按步骤需求顺序组装</option>
                      <option value="graph">自定义依赖图（高级）</option>
                    </select>
                  </label>
                  <label>流程整体要求（会传递给执行 Agent）
                    <textarea name="flowInstructions"
                      placeholder="例如：重点关注向后兼容性；每步保留决策依据"
                      maxLength={4000} rows={3} />
                  </label>
                  {flowMode !== "standard" && (
                    <label>步骤清单（JSON 数组）
                      <textarea
                        key={flowTaskType + ":" + flowMode}
                        name="flowDefinition"
                        defaultValue={sampleFlow(flowMode, flowTaskType)}
                        rows={12}
                      />
                    </label>
                  )}
                  {flowMode === "compose" && <p>每个步骤包含 operation、title 和可选 instruction。系统按填写顺序串接，并自动生成依赖。多个 test 步骤目前仍执行同一项目测试命令。</p>}
                  {flowMode === "graph" && <p>每个节点包含 key、operation、title、dependsOn 和可选 instruction。系统执行环依赖校验并采用拓扑顺序串行执行。</p>}
                  <button type="button" className="quiet" onClick={(event) => {
                    const form = event.currentTarget.form;
                    if (!form) return;
                    const data = new FormData(form);
                    void act(async () => {
                      const version = String(data.get("workflowVersionId") ?? "");
                      const result = await api<{ plan: typeof flowPreview }>("/flows/preview", {
                        type: data.get("type"),
                        projectId: data.get("projectId") || null,
                        workflowVersionId: version.startsWith("active:") ? null : version || null,
                        resourceFamilyIds: version.startsWith("active:") ? [version.slice(7)] : [],
                        flowRequirements: buildFlowRequest(data),
                      });
                      setFlowPreview(result.plan);
                    });
                  }}>预览并校验流程</button>
                  {flowPreview.length > 0 && (
                    <div><p>预计执行 {flowPreview.length} 个步骤（当前 Worker 为顺序执行）：</p>
                      <ol>{flowPreview.map((node) => (
                        <li key={node.key}>{node.title}（{node.operation}） · 依赖 {node.dependsOn.join(", ") || "无"}</li>
                      ))}</ol>
                    </div>
                  )}
                </div>
              )}
              <label>任务时间预算（分钟，包含等待与暂停）<input name="maxMinutes" type="number" min="1" max="120" defaultValue="30" required/></label>
              <label>外部 Skill（引用目录中的 SKILL.md，不复制）
                <select name="externalSkillIds" multiple>
                  {externalSkills.filter((skill) => skill.status === "available").map((skill) => (
                    <option key={skill.id} value={skill.id}>{skill.name}</option>
                  ))}
                </select>
              </label>
              {(["skill", "knowledge"] as const).map((kind) => (
                <label key={kind}>
                  {kind === "skill" ? "Skill版本" : "知识版本"}（可多选）
                  <select
                    name={
                      kind === "skill"
                        ? "skillVersionIds"
                        : "knowledgeVersionIds"
                    }
                    multiple
                  >
                    {resources
                      .filter(
                        (r) =>
                          r.kind === kind &&
                          r.current &&
                          r.status === "published",
                      )
                      .map((r) => (
                        <option
                          key={"active:" + r.familyId}
                          value={"active:" + r.familyId}
                        >
                          跟随发布版本：{r.name}（当前 {r.version}）
                        </option>
                      ))}
                    {resources
                      .filter(
                        (r) => r.kind === kind && r.status === "published",
                      )
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} @{r.version}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <label>
                验收条件（每行一项）
                <textarea
                  name="criteria"
                  required
                  placeholder="用可以检查的结果定义完成"
                />
              </label>
              <button disabled={busy}>创建任务</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
