import { useEffect, useState, type FormEvent } from "react";
import type { Task, Project } from "../../../packages/domain/index";
type API = (path: string, data?: unknown, headers?: Record<string, string>) => Promise<any>;
type Item = { id: string; name: string; version: string; title?: string; description?: string; status: string; profileRef?: string | null; sourceSkillId?: string | null };
type Knowledge = Item & { content: string; scope: string; source: string };
type Profile = Item & { executor: string };
type Source = { id: string; path: string; lastScannedAt: string | null };
type Skill = { id: string; name: string; relativePath: string; status: string; description: string; contentDigest: string };
type Flow = { nodes: { id: string; capabilityRef: string; profileRef?: string; dependsOn: string[]; inputs: Record<string,unknown>; bindings?: Record<string,unknown> }[]; observations: { id: string; afterNode: string; on: string[]; barrier: boolean; question: string }[]; rationale?: string };
type Run = { id: string; taskId: string; status: string; planRevision: number; plan: Flow; nodeStates: Record<string,string>; observationStates: Record<string,string>; failures: Record<string,string>; results: Record<string,unknown> };
const json = (x: unknown) => JSON.stringify(x, null, 2);
const defaultInput = {
  type: "object", properties: { objective: { type: "string" } }, required: ["objective"], additionalProperties: false,
};
const defaultOutput = {
  type: "object", properties: {
    summary: { type: "string" }, evidence: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  }, required: ["summary", "evidence", "risks"], additionalProperties: false,
};
const initialPlan: Flow = {
  nodes: [], observations: [], rationale: "Use published atomic capabilities",
};
export function AdaptiveBoard({ api, act, tasks, projects }: {
  api: API; act: (fn: () => Promise<void>) => Promise<void>;
  tasks: Task[]; projects: Project[];
}) {
  const [caps, setCaps] = useState<Item[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState("");
  const [taskId, setTaskId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [skillProjectId, setSkillProjectId] = useState("");
  const [plan, setPlan] = useState(json(initialPlan));
  const [events, setEvents] = useState<any[]>([]);
  const [notice, setNotice] = useState("");
  const [knowledgeScope, setKnowledgeScope] = useState("global");
  const [capProfile, setCapProfile] = useState("");
  const [profileExecutor, setProfileExecutor] = useState("agent");
  async function load() {
    const [c,p,k,s,sk,r] = await Promise.all([
      api("/v2/capabilities"), api("/v2/profiles"), api("/v2/knowledge"),
      api("/v2/skill-sources"), api("/v2/external-skills"), api("/v2/adaptive-runs"),
    ]);
    setCaps(c); setProfiles(p); setKnowledge(k); setSources(s); setSkills(sk); setRuns(r);
  }
  useEffect(() => { void act(load); }, []);
  useEffect(() => {
    if (!selectedRun) return;
    const get = () => Promise.all([
      api("/v2/adaptive-runs"), api("/v2/adaptive-runs/" + selectedRun + "/events"),
    ]).then(([r,e]) => { setRuns(r); setEvents(e); }).catch(() => {});
    void get();
    const timer = setInterval(() => { void get(); }, 3500);
    return () => clearInterval(timer);
  }, [selectedRun]);
  const current = runs.find((r) => r.id === selectedRun);
  function doForm(event: FormEvent<HTMLFormElement>, fn: (form: FormData) => Promise<unknown>) {
    event.preventDefault(); const form = event.currentTarget;
    void act(async () => { const outcome = await fn(new FormData(form)); setNotice(typeof outcome === "string" ? outcome : "操作已提交"); await load(); });
  }
  function makeSample() {
    const available = caps.filter((c) => c.status === "published" && c.profileRef);
    const nodes = available.slice(0, 2).map((c, i) => ({
      id: "stage_" + (i+1), capabilityRef: c.id,
      dependsOn: i ? ["stage_" + i] : [],
      inputs: { objective: "Execute task requirements" }, bindings: {},
    }));
    setPlan(json({ nodes, observations: [], rationale: "Edit as required; final capability must have the deliver tag" }));
  }
  return <div className="adaptive-board">
    <div className="panel">
      <h2>AI Work OS V2 · 自适应能力与知识工作台</h2>
      <p>Capability 定义输入输出，Profile 控制执行环境，Knowledge Hub 管理可引用知识。Agent 负责编排和评估；事件调度器控制运行状态。尚未配置可用 Codex 时可创建并验证手动 DAG。</p>
      {notice && <p role="status">{notice}</p>}
    </div>
    <div className="panel">
      <h2>Skill 导入与智能转化</h2>
      <form onSubmit={(e) => doForm(e, async (f) => {
        const result = await api("/v2/skill-sources", { path: String(f.get("path")) });
        return "扫描 " + result.found + " 个 Skill；" + result.warnings.join("；");
      })}>
        <label>本机 Linux Skill 根目录
          <input name="path" placeholder="/home/user/.agents/skills" required />
        </label>
        <button>注册并扫描</button>
      </form>
      {sources.map((source) => <article className="project" key={source.id}>
        <code>{source.path}</code> · {source.lastScannedAt ?? "尚未扫描"}
        <button className="quiet" onClick={() => void act(async () => { await api("/v2/skill-sources/" + source.id + "/scan", {}); await load(); })}>重新扫描</button>
      </article>)}
      <div className="form-row">
        <label>选择已扫描的 Skill
          <select value={skillId} onChange={(e) => setSkillId(e.target.value)}>
            <option value="">请选择</option>
            {skills.filter((x) => x.status === "available").map((x) =>
              <option value={x.id} key={x.id}>{x.name} — {x.relativePath}</option>)}
          </select>
        </label>
        <label>AI 分析使用的项目
          <select value={skillProjectId} onChange={(e) => setSkillProjectId(e.target.value)}>
            <option value="">无（仅生成结构化草案）</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <div className="actions">
        <button disabled={!skillId} onClick={() => void act(async () => {
          const candidate = await api("/v2/skill-candidates", { skillId, ai: false });
          setNotice("已生成待验证的 Skill 能力草案：" + candidate.id); await load();
        })}>生成确定性草案</button>
        <button disabled={!skillId || !skillProjectId} onClick={() => void act(async () => {
          const candidate = await api("/v2/skill-candidates", { skillId, projectId: skillProjectId, ai: true });
          setNotice("Agent 已生成待验证的能力草案：" + candidate.id); await load();
        })}>使用 Codex 智能分析生成</button>
      </div>
      <p>生成的能力默认为 candidate。AI 推断不是契约验证，发布前必须绑定授权配置、核查输入输出和运行验证。辅助脚本不会自动取得执行权限。</p>
    </div>
    <div className="panel">
      <h2>Execution Profile · 执行配置</h2>
      <form onSubmit={(e) => doForm(e, async (f) => api("/v2/profiles", {
        name: f.get("name"), version: f.get("version"), executor: f.get("executor"),
        agent: f.get("executor") === "agent" ? "codex" : undefined,
        model: f.get("model") || undefined,
        workspaceMode: f.get("workspaceMode"),
        skillIds: f.getAll("skillIds"),
        program: f.get("executor") === "program" ? {
          executable: f.get("executable"), args: JSON.parse(String(f.get("args") || "[]")),
        } : undefined,
      }))}>
        <div className="form-row">
          <label>配置名称<input name="name" placeholder="review.readonly" required /></label>
          <label>版本<input name="version" defaultValue="1.0.0" required /></label>
        </div>
        <div className="form-row">
          <label>执行器
            <select name="executor" value={profileExecutor} onChange={(e)=>setProfileExecutor(e.target.value)}>
              <option value="agent">Codex Agent</option><option value="program">项目授权程序</option>
              <option value="manual">人工输入</option><option value="builtin">平台内置</option>
            </select>
          </label>
          <label>工作区权限
            <select name="workspaceMode">
              <option value="none">无工作区</option><option value="read-only">只读</option><option value="worktree-write">独立 Worktree 写入</option>
            </select>
          </label>
        </div>
        {profileExecutor === "agent" && <label>模型（可留空使用默认）<input name="model" /></label>}
        {profileExecutor === "program" && <>
          <label>项目预授权命令路径<input name="executable" required /></label>
          <label>命令参数 JSON<input name="args" defaultValue="[]" required /></label>
        </>}
        <label>引用外部 Skill（多选）
          <select name="skillIds" multiple size={Math.max(2, Math.min(5, skills.length))}>
            {skills.filter((x)=>x.status==="available").map((x)=>
              <option value={x.id} key={x.id}>{x.name}</option>)}
          </select>
        </label>
        <button>创建执行配置草稿</button>
      </form>
      {profiles.map((p) => <div className="project" key={p.id}>
        <b>{p.id}</b> · {p.executor} · {p.status}
        {p.status === "draft" && <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/profiles/" + encodeURIComponent(p.id) + "/publish", {}); await load();
        })}>发布配置</button>}
      </div>)}
    </div>
    <div className="panel">
      <h2>Capability Registry · 原子能力</h2>
      <form onSubmit={(e) => doForm(e, async (f) => api("/v2/capabilities", {
        name: f.get("name"), version: f.get("version"), title: f.get("title"),
        description: f.get("description"), sideEffect: f.get("sideEffect"),
        profileRef: f.get("profileRef") || null,
        tags: String(f.get("tags") || "").split(",").map((x) => x.trim()).filter(Boolean),
        inputSchema: JSON.parse(String(f.get("inputSchema"))),
        outputSchema: JSON.parse(String(f.get("outputSchema"))),
      }))}>
        <div className="form-row">
          <label>ID<input name="name" placeholder="code.review" required /></label>
          <label>版本<input name="version" defaultValue="1.0.0" required /></label>
        </div>
        <label>名称<input name="title" placeholder="代码审查" required /></label>
        <label>描述<textarea name="description" required /></label>
        <div className="form-row">
          <label>执行配置
            <select name="profileRef" value={capProfile} onChange={(e)=>setCapProfile(e.target.value)}>
              <option value="">未绑定（待配置）</option>
              {profiles.filter((p)=>p.status==="published").map((p)=>
                <option key={p.id} value={p.id}>{p.id}</option>)}
            </select>
          </label>
          <label>副作用类型
            <select name="sideEffect">
              <option value="read">只读</option><option value="none">无</option>
              <option value="workspace-write">隔离 Worktree 写入</option>
              <option value="external-write">外部写入（需独立审批）</option>
            </select>
          </label>
        </div>
        <label>标签（逗号分隔；测试/审查/交付使用 test,review,deliver）<input name="tags" /></label>
        <details>
          <summary>输入输出 JSON Schema</summary>
          <label>输入 Schema<textarea name="inputSchema" defaultValue={json(defaultInput)} rows={7} required /></label>
          <label>输出 Schema<textarea name="outputSchema" defaultValue={json(defaultOutput)} rows={7} required /></label>
        </details>
        <button>创建候选能力</button>
      </form>
      {caps.map((c) => <article className="project" key={c.id}>
        <b>{c.id}</b> · {c.status} · {c.profileRef ?? "未绑定配置"}
        <p>{c.description}</p>
        {c.status === "candidate" && <button className="quiet" onClick={() => {
          const profileRef = window.prompt("绑定已发布的 Execution Profile ID（例如 review.readonly@1.0.0）", c.profileRef ?? "");
          if (profileRef === null || !profileRef.trim()) return;
          void act(async () => {
            await api("/v2/capabilities/" + encodeURIComponent(c.id) + "/candidate", { profileRef: profileRef.trim() });
            setNotice("已绑定执行配置；验证前仍可更新候选契约"); await load();
          });
        }}>绑定执行配置</button>}
        {c.status === "candidate" && <button className="quiet" onClick={() => {
          const evidence = window.prompt("请填写真实的契约验证结果及依据（不是模型推断）");
          if (!evidence) return;
          void act(async () => { await api("/v2/capabilities/" + encodeURIComponent(c.id) + "/validate", { evidence }); await load(); });
        }}>标记验证通过</button>}
        {c.status === "validated" && <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/capabilities/" + encodeURIComponent(c.id) + "/publish", {}); await load();
        })}>正式发布</button>}
        {c.status === "published" && <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/capabilities/" + encodeURIComponent(c.id) + "/revoke", {}); await load();
        })}>撤销</button>}
      </article>)}
    </div>
    <div className="panel">
      <h2>Knowledge Hub · 知识管理</h2>
      <form onSubmit={(e) => doForm(e, async (f) => api("/v2/knowledge", {
        name: f.get("name"), version: f.get("version"), title: f.get("title"),
        content: f.get("content"), source: f.get("source"), scope: f.get("scope"),
        projectId: f.get("projectId") || null,
        taskId: f.get("taskId") || null,
        capabilityNames: String(f.get("capabilityNames") || "").split(",").map((x) => x.trim()).filter(Boolean),
        tags: String(f.get("tags") || "").split(",").map((x) => x.trim()).filter(Boolean),
      }))}>
        <div className="form-row">
          <label>知识 ID<input name="name" placeholder="jvm.memory.guide" required /></label>
          <label>版本<input name="version" defaultValue="1.0.0" required /></label>
        </div>
        <label>标题<input name="title" required /></label>
        <label>作用域
          <select name="scope" value={knowledgeScope} onChange={(e)=>setKnowledgeScope(e.target.value)}>
            <option value="global">全局知识</option><option value="project">项目知识</option>
            <option value="capability">能力知识</option><option value="task">任务知识</option>
          </select>
        </label>
        {knowledgeScope === "project" && <label>项目
          <select name="projectId" required><option value="">请选择</option>
            {projects.map((p)=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>}
        {knowledgeScope === "task" && <label>任务
          <select name="taskId" required><option value="">请选择</option>
            {tasks.map((t)=><option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </label>}
        {knowledgeScope === "capability" && <label>适用能力名称（逗号分隔）
          <input name="capabilityNames" placeholder="code.review,code.analyze" required />
        </label>}
        <label>内容<textarea name="content" rows={7} required /></label>
        <label>证据或来源<input name="source" placeholder="用户编写 / 文档路径 / URL" required /></label>
        <label>标签<input name="tags" placeholder="java,oom,incident" /></label>
        <button>创建知识草稿</button>
      </form>
      {knowledge.map((k) => <article className="project" key={k.id}>
        <h3>{k.title} <small>{k.id}</small></h3>
        <p>{k.scope} · {k.status} · 来源：{k.source}</p>
        <details><summary>查看知识</summary><pre>{k.content}</pre></details>
        {k.status === "draft" && <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/knowledge/" + encodeURIComponent(k.id) + "/publish", {}); await load();
        })}>发布知识</button>}
        {k.status === "published" && <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/knowledge/" + encodeURIComponent(k.id) + "/revoke", {}); await load();
        })}>撤销知识</button>}
      </article>)}
      <form onSubmit={(e) => doForm(e, async (f) => api("/v2/knowledge-bindings", {
        capabilityName: f.get("capabilityName"), knowledgeRef: f.get("knowledgeRef"), mode: f.get("mode"),
      }))}>
        <h3>能力与知识绑定</h3>
        <label>能力名称
          <select name="capabilityName" required>
            {caps.filter((c)=>c.status==="published").map((c)=><option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label>知识
          <select name="knowledgeRef" required>
            {knowledge.filter((k)=>k.status==="published").map((k)=><option key={k.id} value={k.id}>{k.title} @ {k.version}</option>)}
          </select>
        </label>
        <label>加载方式
          <select name="mode"><option value="required">必需</option><option value="on-demand">按需检索</option><option value="optional">可选参考</option></select>
        </label>
        <button>添加知识绑定</button>
      </form>
    </div>
    <div className="panel">
      <h2>智能编排与动态工作流</h2>
      <label>选择任务
        <select value={taskId} onChange={(e)=>setTaskId(e.target.value)}>
          <option value="">请选择任务</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}（{t.type}）</option>)}
        </select>
      </label>
      <div className="actions">
        <button disabled={!taskId} onClick={() => void act(async () => {
          const result = await api("/v2/tasks/" + taskId + "/compose", {});
          setPlan(json(result.plan)); setNotice("Planner 已生成工作流，请检查 DAG 和观察策略后下发");
        })}>使用 Codex 智能编排</button>
        <button className="quiet" onClick={makeSample}>根据已发布能力生成编辑示例</button>
      </div>
      <label>工作流定义（DAG + 观察策略）
        <textarea rows={20} value={plan} onChange={(e)=>setPlan(e.target.value)} />
      </label>
      <div className="actions">
        <button disabled={!taskId} className="quiet" onClick={() => void act(async () => {
          const task = tasks.find((x) => x.id === taskId)!;
          const result = await api("/v2/workflows/validate", {
            taskId, projectId: task.projectId, plan: JSON.parse(plan),
          });
          setPlan(json(result.plan)); setNotice("工作流通过校验（尚未执行）");
        })}>验证 DAG / 依赖 / 授权</button>
        <button disabled={!taskId} onClick={() => void act(async () => {
          const result = await api("/v2/adaptive-runs", { taskId, plan: JSON.parse(plan) });
          setSelectedRun(result.id); setNotice("已创建自适应运行：" + result.id); await load();
        })}>确认并下发执行</button>
      </div>
      <p>观察点默认阻塞受影响后继节点；失败事件同样可触发评估。运行中的结果不能由编排 Agent 原地覆盖。当前按需调用仍以单机 Linux 为优先目标。</p>
    </div>
    <div className="panel">
      <h2>执行与观察记录</h2>
      <label>选择运行
        <select value={selectedRun} onChange={(e)=>setSelectedRun(e.target.value)}>
          <option value="">请选择</option>
          {runs.map((r)=><option key={r.id} value={r.id}>{tasks.find((t)=>t.id===r.taskId)?.title ?? r.taskId} · {r.status} · Revision {r.planRevision}</option>)}
        </select>
      </label>
      {current && <>
        <p>状态：<strong>{current.status}</strong> · 计划版本：{current.planRevision}</p>
        {current.plan.nodes.map((n)=><article className="project" key={n.id}>
          <b>{n.id}</b> · {n.capabilityRef} · {current.nodeStates[n.id] ?? "pending"}
          <small> · 依赖：{n.dependsOn.join(", ") || "无"}</small>
          {current.failures[n.id] && <p>{current.failures[n.id]}</p>}
          {current.nodeStates[n.id] === "waiting" &&
            <button onClick={() => {
              const v = window.prompt("填写符合该能力输出 Schema 的 JSON");
              if (!v) return;
              void act(async () => { await api("/v2/adaptive-runs/"+current.id+"/manual/"+n.id+"/complete", { output: JSON.parse(v) }); await load(); });
            }}>提交人工执行结果</button>}
        </article>)}
        <h3>观察点</h3>
        {current.plan.observations.map((o)=><article className="project" key={o.id}>
          <b>{o.id}</b> · {current.observationStates[o.id] ?? "未触发"}
          <p>{o.question}</p>
          {current.observationStates[o.id] === "waiting" && <button onClick={() => void act(async () => {
            await api("/v2/adaptive-runs/"+current.id+"/observations/"+o.id+"/decision",
              { decision: "CONTINUE", reason: "User manually reviewed the evidence", affectedNodeIds: [], evidenceRefs: [] });
            await load();
          })}>人工确认继续</button>}
        </article>)}
        {current.status === "awaiting_acceptance" && <div className="actions">
          <button onClick={() => void act(async () => {
            await api("/v2/adaptive-runs/"+current.id+"/accept", { accepted: true, reason: "Accepted by user" }); await load();
          })}>接受交付</button>
          <button className="quiet" onClick={() => {
            const reason = window.prompt("说明拒绝原因"); if (!reason) return;
            void act(async () => { await api("/v2/adaptive-runs/"+current.id+"/accept", { accepted: false, reason }); await load(); });
          }}>拒绝交付</button>
        </div>}
        <h3>事件时间线</h3>
        {events.map((event) => <details key={event.id}>
          <summary>{event.seq} · {event.type} · {event.at}</summary><pre>{json(event.payload)}</pre>
        </details>)}
      </>}
    </div>
  </div>;
}
