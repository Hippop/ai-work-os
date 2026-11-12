import { useState, useEffect } from "react";
import type { Task, Project } from "../../../packages/domain/index";
type Props = {
  tasks: Task[];
  projects: Project[];
  api: (path: string, data?: unknown) => Promise<any>;
  act: (fn: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
};
export function PlanningBoard({ tasks, projects, api, act, refresh }: Props) {
  const [goals, setGoals] = useState<any[]>([]),
    [selected, setSelected] = useState(""),
    [query, setQuery] = useState(""),
    [from, setFrom] = useState(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    ),
    [to, setTo] = useState(from),
    [summary, setSummary] = useState<any>();
  const task = tasks.find((t) => t.id === selected);
  const load = async () => {
    setGoals(await api("/goals"));
    setSummary(await api(`/planning/summary?from=${from}&to=${to}`));
  };
  useEffect(() => {
    void act(load);
  }, [from, to, tasks]);
  return (
    <>
      <div className="panel">
        <h2>目标与工作计划</h2>
        <div className="form-row">
          <label>
            开始日期
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        {summary && (
          <>
            <p>{summary.note}</p>
            <div className="stats">
              {[
                ["计划任务", summary.planned.length],
                ["已验收", summary.accepted.length],
                ["进行中", summary.active.length],
                ["逾期", summary.overdue.length],
              ].map(([label, n]) => (
                <article key={label}>
                  <span>{label}</span>
                  <strong>{n}</strong>
                </article>
              ))}
            </div>
            <h3>本期已验收</h3>
            {summary.accepted.map((t: Task) => (
              <p key={t.id}>{t.title}</p>
            ))}
            {summary.accepted.length === 0 && <p>本期尚无验收完成记录。</p>}
          </>
        )}
      </div>
      <div className="panel">
        <h2>建立目标</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              fd = new FormData(form);
            void act(async () => {
              await api("/goals", {
                name: fd.get("name"),
                objective: fd.get("objective"),
                successCriteria: String(fd.get("criteria"))
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
                projectIds: fd.getAll("projectIds"),
              });
              form.reset();
              await load();
            });
          }}
        >
          <label>
            目标名称
            <input name="name" required />
          </label>
          <label>
            目标说明
            <textarea name="objective" required />
          </label>
          <label>
            成功标准（每行一项）
            <textarea name="criteria" required />
          </label>
          <label>
            关联项目
            <select name="projectIds" multiple>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button>保存目标</button>
        </form>
        {goals.map((g) => (
          <article className="project" key={g.id}>
            <h3>{g.name}</h3>
            <p>{g.objective}</p>
            <small>
              关联任务验收 {g.acceptedTasks}/{g.taskCount}
              ；目标是否达成仍需按成功标准判断。
            </small>
          </article>
        ))}
      </div>
      <div className="panel">
        <h2>整理与编辑任务</h2>
        <label>
          筛选任务
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入标题关键词"
          />
        </label>
        <label>
          选择任务
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">请选择</option>
            {tasks
              .filter((t) =>
                t.title.toLowerCase().includes(query.toLowerCase()),
              )
              .map((t) => (
                <option value={t.id} key={t.id}>
                  {t.title} · {t.status}
                </option>
              ))}
          </select>
        </label>
        {task && (
          <form
            key={task.id + ":" + task.revision}
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              void act(async () => {
                await api(`/tasks/${task.id}/plan`, {
                  revision: task.revision,
                  changes: {
                    title: fd.get("title"),
                    objective: fd.get("objective"),
                    maxMinutes:Number(fd.get("maxMinutes")||30),
                    acceptanceCriteria: String(fd.get("criteria"))
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    goalId: fd.get("goalId") || null,
                    parentId: fd.get("parentId") || null,
                    dependsOn: fd.getAll("dependsOn"),
                    plannedFor: fd.get("plannedFor") || null,
                    dueAt: fd.get("dueAt") || null,
                    priority: fd.get("priority"),
                  },
                });
                await refresh();
              });
            }}
          >
            <p>
              保存会增加任务版本并回到计划状态。执行中的任务需要先结束当前运行。
            </p>
            <label>
              标题
              <input name="title" defaultValue={task.title} required />
            </label>
            <label>
              工作目标
              <textarea
                name="objective"
                defaultValue={task.objective}
                required
              />
            </label>
            <label>
              任务时间预算（分钟，1～120）
              <input name="maxMinutes" type="number" min="1" max="120" defaultValue={task.maxMinutes} required/>
            </label>
            <label>
              验收标准
              <textarea
                name="criteria"
                defaultValue={task.acceptanceCriteria.join("\n")}
                required
              />
            </label>
            <div className="form-row">
              <label>
                计划日期
                <input
                  type="date"
                  name="plannedFor"
                  defaultValue={task.plannedFor ?? ""}
                />
              </label>
              <label>
                截止日期
                <input
                  type="date"
                  name="dueAt"
                  defaultValue={task.dueAt ?? ""}
                />
              </label>
            </div>
            <label>
              优先级
              <select name="priority" defaultValue={task.priority}>
                <option value="normal">普通</option>
                <option value="high">高</option>
                <option value="low">低</option>
              </select>
            </label>
            <label>
              关联目标
              <select name="goalId" defaultValue={task.goalId ?? ""}>
                <option value="">无</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              父任务
              <select name="parentId" defaultValue={task.parentId ?? ""}>
                <option value="">无</option>
                {tasks
                  .filter((t) => t.id !== task.id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              依赖已验收任务（可多选）
              <select
                name="dependsOn"
                multiple
                defaultValue={task.dependsOn ?? []}
              >
                {tasks
                  .filter((t) => t.id !== task.id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} · {t.status}
                    </option>
                  ))}
              </select>
            </label>
            <button>保存任务版本</button>
          </form>
        )}
      </div>
    </>
  );
}
