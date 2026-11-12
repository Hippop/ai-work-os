import { useEffect, useState, type FormEvent } from "react";
import type { Task, Project } from "../../../packages/domain/index";
import { McpWriteBoard } from "./McpWriteBoard";
import { CapabilityBuilderBoard } from "./CapabilityBuilderBoard";
type API = (path: string, data?: unknown, headers?: Record<string, string>) => Promise<any>;
type Item = { id: string; name: string; version: string; title?: string; description?: string; status: string; profileRef?: string | null; sourceSkillId?: string | null };
type Knowledge = Item & { content: string; scope: string; source: string };
type Binding = {id:string;capabilityName:string;knowledgeRef:string;mode:string;status?:string};
type Profile = Item & { executor: string; agent?: string; model?:string; projectId?: string | null; mcpGrants?: {server:string;actions:string[]}[] };
type McpServer = { id: string; name: string; description: string; status: string; exposedTools: string[]; readOnlyTools: string[] };
type Source = { id: string; path: string; lastScannedAt: string | null };
type Skill = { id: string; name: string; relativePath: string; status: string; description: string; contentDigest: string };
type Flow = { nodes: { id: string; capabilityRef: string; profileRef?: string; dependsOn: string[]; inputs: Record<string,unknown>; bindings?: Record<string,unknown> }[]; observations: { id: string; afterNode: string; on: string[]; barrier: boolean; question: string }[]; rationale?: string };
type Run = { id: string; taskId: string; status: string; planRevision: number; plan: Flow; nodeStates: Record<string,string>; observationStates: Record<string,string>; decisions: Record<string,{decision:string;reason:string}>; failures: Record<string,string>; results: Record<string,unknown> };
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
export function AdaptiveBoard({ api, act, token, tasks, projects, initialRunId = "", onChanged }: {
  api: API; act: (fn: () => Promise<void>) => Promise<void>; token: string;
  tasks: Task[]; projects: Project[]; initialRunId?: string; onChanged?:()=>Promise<void>;
}) {
  const [caps, setCaps] = useState<Item[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState(initialRunId);
  useEffect(()=>{if(initialRunId)setSelectedRun(initialRunId);},[initialRunId]);
  const [workspace,setWorkspace] = useState<{available:boolean;digest:string|null}|null>(null);
  const [taskId, setTaskId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [skillProjectId, setSkillProjectId] = useState("");
  const [plan, setPlan] = useState(json(initialPlan));
  const [budgetUsd, setBudgetUsd] = useState("");
  const [costInfo, setCostInfo] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [notice, setNotice] = useState("");
  const [preflight,setPreflight]=useState<{ready:boolean;checks:{label:string;passed:boolean;detail:string}[]}|null>(null);
  useEffect(()=>setPreflight(null),[taskId,plan]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [evalDatasets, setEvalDatasets] = useState<any[]>([]);
  const [evalResults, setEvalResults] = useState<any[]>([]);
  const [knowledgeScope, setKnowledgeScope] = useState("global");
  const [capProfile, setCapProfile] = useState("");
  const [profileExecutor, setProfileExecutor] = useState("agent");
  const [profileAgent, setProfileAgent] = useState("codex");
  const [executionAgent, setExecutionAgent] = useState("codex");
  async function load() {
    const [c,p,k,s,sk,r,mcp,stats,bind,datasets,evaluations] = await Promise.all([
      api("/v2/capabilities"), api("/v2/profiles"), api("/v2/knowledge"),
      api("/v2/skill-sources"), api("/v2/external-skills"), api("/v2/adaptive-runs"), api("/v2/mcp-servers"), api("/v2/analytics"), api("/v2/knowledge-bindings"),
      api("/v2/evaluations/datasets"),api("/v2/evaluations"),
    ]);
    await onChanged?.();
    setCaps(c); setProfiles(p); setKnowledge(k); setSources(s); setSkills(sk); setRuns(r); setMcpServers(mcp); setAnalytics(stats); setBindings(bind); setEvalDatasets(datasets); setEvalResults(evaluations);
  }
  useEffect(() => { void act(load); }, []);
  useEffect(() => {
    if (!selectedRun) return;
    const get = () => Promise.all([
      api("/v2/adaptive-runs"), api("/v2/adaptive-runs/" + selectedRun + "/events"),
      api("/v2/adaptive-runs/" + selectedRun + "/costs"),
      api("/v2/adaptive-runs/" + selectedRun + "/workspace"),
    ]).then(([r,e,c,w]) => { setRuns(r); setEvents(e); setCostInfo(c); setWorkspace(w); }).catch(() => {});
    void get();
    const timer = setInterval(() => { void get(); }, 3500);
    return () => clearInterval(timer);
  }, [selectedRun]);
  async function downloadArtifact(runId:string,nodeId:string,artifactRef:string) {
    const name=artifactRef.split("/").pop() ?? "";
    const path="/api/v2/adaptive-runs/"+encodeURIComponent(runId)+
      "/artifacts/"+encodeURIComponent(nodeId)+"/"+encodeURIComponent(name);
    const result=await fetch(path,{headers:{Authorization:"Bearer "+token}});
    if(!result.ok)throw Error("工件下载失败："+result.status);
    const url=URL.createObjectURL(await result.blob());
    const link=document.createElement("a");
    link.href=url;link.download=name;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function downloadRunAudit(runId:string) {
    const audit=await api("/v2/adaptive-runs/"+runId+"/audit");
    const blob=new Blob([JSON.stringify(audit,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");
    link.href=url;link.download="adaptive-audit-"+runId+".json";link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
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
    <CapabilityBuilderBoard api={api} act={act} projects={projects}
      skills={skills} knowledge={knowledge} profiles={profiles} onChanged={load}/>
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
      <h2>MCP Server · 受控服务器目录</h2>
      <p>注册本机可信 MCP 服务或 HTTPS MCP 端点，只发布经人工确认的只读工具。Profile 可逐项选择服务器与工具；单次运行使用独立 Codex 配置，不继承用户全局 MCP。</p>
      <form onSubmit={(e) => doForm(e, async (f) => {
        const transport = String(f.get("transport"));
        return api("/v2/mcp-servers", {
          name: f.get("name"), description: f.get("description"),
          projectId: f.get("projectId") || null,
          transport: transport === "stdio"
            ? { type: "stdio", executable: f.get("executable"), args: JSON.parse(String(f.get("args") || "[]")) }
            : { type: "http", url: f.get("url") },
          exposedTools: String(f.get("exposedTools")).split(",").map((t) => t.trim()).filter(Boolean),
          readOnlyTools: String(f.get("readOnlyTools")).split(",").map((t) => t.trim()).filter(Boolean),
        });
      })}>
        <div className="form-row">
          <label>Server ID<input name="name" placeholder="code-search" required /></label>
          <label>描述<input name="description" required /></label>
        </div>
        <label>项目范围
          <select name="projectId"><option value="">全局可引用</option>
            {projects.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>传输方式
          <select name="transport" defaultValue="stdio">
            <option value="stdio">stdio（填写可执行路径）</option>
            <option value="http">HTTPS（填写服务 URL）</option>
          </select>
        </label>
        <label>stdio 可执行程序绝对路径<input name="executable" placeholder="/usr/local/bin/mcp-server" /></label>
        <label>stdio 参数 JSON<input name="args" defaultValue="[]" /></label>
        <label>HTTPS MCP URL<input name="url" placeholder="https://example.com/mcp" /></label>
        <label>Server 暴露工具（逗号分隔）<input name="exposedTools" placeholder="search,read" required /></label>
        <label>经确认的只读工具（逗号分隔）<input name="readOnlyTools" placeholder="search,read" required /></label>
        <button>注册 MCP Server 草稿</button>
      </form>
      {mcpServers.map((m) => <div className="project" key={m.id}>
        <b>{m.name}</b> · {m.status} · 工具 {m.exposedTools.join(", ")}
        <p>{m.description}</p>
        {m.status === "draft" && <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/mcp-servers/" + m.id + "/publish", {}); await load();
        })}>发布只读工具授权</button>}
        {m.status === "published" && <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/mcp-servers/" + m.id + "/revoke", {}); await load();
        })}>撤销 MCP</button>}
      </div>)}
    </div>
    <McpWriteBoard api={api} act={act} projects={projects} servers={mcpServers}/>
    <div className="panel">
      <h2>Execution Profile · 执行配置</h2>
      <button className="quiet" onClick={()=>void act(async()=>{
        const agents=await api("/v2/agents/probe");
        setNotice((agents as {id:string;available:boolean;version?:string|null}[])
          .map((a)=>a.id+": "+(a.available?"已安装 "+(a.version??""):"未检测到 CLI")).join(" · "));
      })}>检测 Codex / OpenCode CLI</button>
      <p>规划与进度评估后端可以通过服务启动变量 AI_WORK_OS_PLANNER_AGENT=opencode 选择 OpenCode。</p>
      <form onSubmit={(e) => doForm(e, async (f) => api("/v2/profiles", {
        name: f.get("name"), version: f.get("version"), executor: f.get("executor"),
        agent: f.get("executor") === "agent" ? f.get("agent") : undefined,
        mcpWrite: f.get("executor") === "mcp-write" ? {
          server:f.get("writeServer"),tool:f.get("writeTool"),purpose:f.get("writePurpose"),
        } : undefined,
        model: f.get("model") || undefined,
        projectId: f.get("projectId") || null,
        mcpGrants: JSON.parse(String(f.get("mcpGrants") || "[]")),
        workspaceMode: f.get("executor") === "mcp-write" ? "none" : f.get("workspaceMode"),
        workspaceSubdir: f.get("workspaceSubdir") || ".",
        memoryLimitMb: Number(f.get("memoryLimitMb") || 2048),
        maxProcesses: Number(f.get("maxProcesses") || 128),
        maxCostUsd: Number(f.get("maxCostUsd") || 2),
        billing: String(f.get("billing") || "").trim()
          ? JSON.parse(String(f.get("billing"))) : undefined,
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
              <option value="agent">AI Agent（Codex / OpenCode）</option><option value="program">项目授权程序</option>
              <option value="manual">人工输入</option><option value="builtin">平台内置</option>
              <option value="mcp-write">MCP 写操作（逐节点审批）</option>
            </select>
          </label>
          <label>工作区权限
            <select name="workspaceMode">
              <option value="none">无工作区</option><option value="read-only">只读</option><option value="worktree-write">独立 Worktree 写入</option>
            </select>
          </label>
        </div>
        {profileExecutor === "agent" && <>
          <label>Agent 适配器
            <select name="agent" value={profileAgent} onChange={(e)=>setProfileAgent(e.target.value)}>
              <option value="codex">Codex CLI</option>
              <option value="opencode">OpenCode CLI</option>
            </select>
          </label>
          <label>模型（可留空使用适配器默认值；OpenCode 请使用 provider/model）
            <input name="model" placeholder={profileAgent==="opencode"?"anthropic/claude-sonnet-5-5":""}/>
          </label>
          {profileAgent==="opencode" && <p>OpenCode 使用 JSONL CLI 和独立 XDG 配置；工作区存在 opencode.json、opencode.jsonc 或 .opencode 插件目录时拒绝执行，以防继承非授权工具。</p>}
        </>}
        {profileExecutor === "mcp-write" && <>
          <label>已发布 MCP Server（仅显示有写工具的服务器）
            <select name="writeServer" required>
              <option value="">请选择</option>
              {mcpServers.filter((m)=>m.status==="published" &&
                m.exposedTools.some((t)=>!m.readOnlyTools.includes(t))).map((m)=>
                <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>MCP 写工具名称（必须与服务器发布目录一致）
            <input name="writeTool" required placeholder="update"/>
          </label>
          <label>每次调用所需的业务审批目的
            <textarea name="writePurpose" required minLength={10} rows={3}
              placeholder="Explain the exact external change that this workflow may request" />
          </label>
          <p>此类型不会赋予 Agent 写权限；节点执行时生成审批请求，并等待用户确认参数后单次执行。</p>
        </>}
        <label>工作目录（相对项目/隔离 Worktree 的目录，不允许跨出根目录）
          <input name="workspaceSubdir" defaultValue="." placeholder="src/backend" required />
        </label>
        <div className="form-row">
          <label>Linux 内存上限（MB）
            <input name="memoryLimitMb" type="number" min="64" max="32768" defaultValue="2048" />
          </label>
          <label>Linux 最大进程数
            <input name="maxProcesses" type="number" min="2" max="4096" defaultValue="128" />
          </label>
        </div>
        <p>仅在部署者设置 AI_WORK_OS_CGROUP_PARENT 指向可写的 cgroup v2 子树时生效；严格要求可设置 AI_WORK_OS_REQUIRE_CGROUP=1。</p>
        <label>单次能力调用预留费用上限（美元）
          <input name="maxCostUsd" type="number" min="0" max="100" step="0.01" defaultValue="2" />
        </label>
        <label>模型费用预留配置（可选 JSON；仅预留+事后计费，不保证单次硬上限）
          <textarea rows={4} name="billing" placeholder='{"inputUsdPerMillion":2,"outputUsdPerMillion":8,"reservedInputTokens":100000,"reservedOutputTokens":10000}' />
        </label>
        <label>配置所属项目
          <select name="projectId"><option value="">全局</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>MCP 工具授权 JSON（只允许以下已发布工具）
          <textarea name="mcpGrants" rows={3} defaultValue="[]" placeholder='[{"server":"code-search","actions":["search"]}]' />
        </label>
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
        <b>{p.id}</b> · {p.executor} {p.agent ? "/ "+p.agent : ""} · {p.status}
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
          const projectId = window.prompt("使用哪个已授权项目 ID 执行只读契约样例验证？", skillProjectId);
          if (!projectId) return;
          const value = window.prompt("输入待测试的 JSON 样例", '{"objective":"Inspect code"}');
          if (!value) return;
          let sampleInput: unknown;
          try { sampleInput = JSON.parse(value); }
          catch { window.alert("样例输入不是有效 JSON"); return; }
          void act(async () => {
            const result = await api("/v2/capabilities/" + encodeURIComponent(c.id) + "/sample-run",
              { projectId, sampleInput });
            setNotice("真实 Codex 只读样例运行成功（仍需人工审核）："
              + JSON.stringify(result.output).slice(0, 700)); await load();
          });
        }}>Codex 只读样例验证</button>}
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
          let sample: {input: unknown; output: unknown} | undefined;
          if (c.sourceSkillId) {
            const i = window.prompt("Skill 能力必须提供测试输入 JSON", '{"objective":"Review code"}');
            if (!i) return;
            const o = window.prompt("Skill 能力必须提供实际输出 JSON", '{"summary":"Reviewed","evidence":[],"risks":[]}');
            if (!o) return;
            try { sample = { input: JSON.parse(i), output: JSON.parse(o) }; }
            catch { window.alert("输入和输出必须是有效 JSON"); return; }
          }
          void act(async () => {
            await api("/v2/capabilities/" + encodeURIComponent(c.id) + "/validate", { evidence, sample });
            await load();
          });
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
        {k.status === "draft" && <button className="quiet" onClick={() => {
          const revised = window.prompt("修改知识草稿（Markdown 正文）", k.content);
          if (revised === null || !revised.trim()) return;
          void act(async () => {
            await api("/v2/knowledge/" + encodeURIComponent(k.id) + "/draft", { content: revised });
            await load();
          });
        }}>编辑草稿</button>}
        {k.status === "published" && <button className="quiet" onClick={() => {
          const version = window.prompt("新版本号（例如 1.0.1）");
          if (!version) return;
          void act(async () => {
            await api("/v2/knowledge/" + encodeURIComponent(k.id) + "/revise", { version });
            setNotice("已建立新版本草稿，旧发布版本保持不变"); await load();
          });
        }}>创建新版本草稿</button>}
        {k.status === "draft" && <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/knowledge/" + encodeURIComponent(k.id) + "/publish", {}); await load();
        })}>发布知识</button>}
        {k.status === "published" && <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/knowledge/" + encodeURIComponent(k.id) + "/revoke", {}); await load();
        })}>撤销知识</button>}
      </article>)}
      <h3>现有知识绑定</h3>
      {bindings.filter((b)=>b.status!=="revoked").map((b)=><article className="project" key={b.id}>
        <b>{b.capabilityName}</b> → {b.knowledgeRef} · {b.mode}
        <button className="quiet" onClick={() => void act(async () => {
          await api("/v2/knowledge-bindings/"+encodeURIComponent(b.id)+"/revoke",{}); await load();
        })}>解除绑定</button>
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
      <label>本次执行的模型费用总预算（USD，可选；设置后要求使用的 Agent 配置含定价信息）
        <input type="number" step="0.01" min="0.01" max="1000" value={budgetUsd}
          placeholder="不限制（费用未知时请慎用）" onChange={(e)=>setBudgetUsd(e.target.value)} />
      </label>
      <label>选择任务
        <select value={taskId} onChange={(e)=>setTaskId(e.target.value)}>
          <option value="">请选择任务</option>
          {tasks.filter((t)=>!["done","cancelled","awaiting_acceptance","in_progress"].includes(t.status)).map((t) => <option key={t.id} value={t.id}>{t.title}（{t.type}）</option>)}
        </select>
      </label>
      <label>核心原子能力的 Agent 执行后端
        <select value={executionAgent} onChange={(e)=>setExecutionAgent(e.target.value)}>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
      </label>
      <div className="actions">
        <button disabled={!taskId} onClick={() => void act(async () => {
          const result = await api("/v2/tasks/" + taskId + "/compose", {executionAgent});
          setPlan(json(result.plan)); setNotice("Planner 已生成工作流，核心节点将使用 "+executionAgent+"；请检查 DAG 和观察策略后下发");
        })}>使用 AI 智能编排（规划模型由服务端配置）</button>
        <button disabled={!taskId} className="quiet" onClick={() => void act(async () => {
          const result = await api("/v2/tasks/" + taskId + "/standard-plan", {executionAgent});
          setPlan(json(result.plan)); setNotice("已生成 "+executionAgent+" 平台标准工作流（非 AI 编排），请确认后执行");
        })}>使用标准流程</button>
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
        <button disabled={!taskId} className="quiet" onClick={()=>void act(async()=>{
          setPreflight(await api("/v2/tasks/"+taskId+"/preflight",{plan:JSON.parse(plan)}));
        })}>检查项目环境与执行器</button>
        <button disabled={!taskId} onClick={() => void act(async () => {
          const result = await api("/v2/adaptive-runs", { taskId, plan: JSON.parse(plan),
            budgetUsd: budgetUsd.trim() ? Number(budgetUsd) : null });
          setSelectedRun(result.id); setNotice("已创建自适应运行：" + result.id); await load();
        })}>确认并下发执行</button>
      </div>
      {preflight&&<div role="status"><b>{preflight.ready?"环境检查通过（认证和模型仍需实际验证）":"环境检查未通过"}</b>
        {preflight.checks.map((c)=><p key={c.label}>{c.passed?"✓":"待处理"} {c.label}：{c.detail}</p>)}
      </div>}
      <p>观察点默认阻塞受影响后继节点；失败事件同样可触发评估。运行中的结果不能由编排 Agent 原地覆盖。当前按需调用仍以单机 Linux 为优先目标。</p>
    </div>
    <div className="panel">
      <h2>能力版本离线对照评估</h2>
      <p>以真实已交付 Run 的输入/输出摘要为证据，对照冻结样例比较两个已发布的只读能力版本。不触发 Agent 执行，不会自动发布或切换能力版本。</p>
      <form onSubmit={(event)=>doForm(event,async (f)=>api("/v2/evaluations/datasets",{
        title:String(f.get("title")),
        capabilityName:String(f.get("capabilityName")),
        projectId:f.get("projectId")||null,
        cases:JSON.parse(String(f.get("cases"))),
      }))}>
        <h3>创建不可变验收样例集</h3>
        <div className="form-row">
          <label>数据集标题<input name="title" required placeholder="Search skill regression v1"/></label>
          <label>能力名称<select name="capabilityName" required>
            <option value="">选择已发布能力名称</option>
            {[...new Set(caps.filter((c)=>c.status==="published").map((c)=>c.name))].map((name)=>
              <option key={name} value={name}>{name}</option>)}
          </select></label>
        </div>
        <label>所属项目<select name="projectId"><option value="">全局任务</option>
          {projects.map((p)=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <label>冻结样例 JSON（每项包含 id、input、assertions）
          <textarea name="cases" rows={6} required
            defaultValue={JSON.stringify([{id:"case1",input:{objective:"Inspect a service"},
              assertions:[{field:"summary",equals:"No unresolved issues"}]}],null,2)}/>
        </label>
        <button>创建评估数据集</button>
      </form>
      <h3>执行历史的成对回放评估</h3>
      <form onSubmit={(event)=>doForm(event,async (f)=>api("/v2/evaluations",{
        datasetId:f.get("datasetId"),
        baselineRef:f.get("baselineRef"),
        candidateRef:f.get("candidateRef"),
        pairs:JSON.parse(String(f.get("pairs"))),
      }))}>
        <label>冻结数据集<select name="datasetId" required>
          <option value="">请选择</option>
          {evalDatasets.map((d)=><option key={d.id} value={d.id}>{d.title} · {d.capabilityName}</option>)}
        </select></label>
        <div className="form-row">
          <label>旧版引用<select name="baselineRef" required>
            <option value="">请选择</option>
            {caps.filter((c)=>c.status==="published").map((c)=><option key={c.id} value={c.id}>{c.id}</option>)}
          </select></label>
          <label>候选新版引用<select name="candidateRef" required>
            <option value="">请选择</option>
            {caps.filter((c)=>c.status==="published").map((c)=><option key={c.id} value={c.id}>{c.id}</option>)}
          </select></label>
        </div>
        <label>每项样例的两次已交付运行证据 JSON
          <textarea name="pairs" rows={6} required
            placeholder='[{"caseId":"case1","baselineRunId":"uuid","baselineNodeId":"analyze","candidateRunId":"uuid","candidateNodeId":"analyze"}]'/>
        </label>
        <p>输入摘要必须与样例完全匹配。评估只读取历史运行记录，不会生成新运行或批准生产发布。</p>
        <button>核对输入/输出并生成回归报告</button>
      </form>
      <h3>已保存的评估结论</h3>
      {evalResults.map((result)=><article className="project" key={result.id}>
        <b>{result.baselineRef}</b> → <b>{result.candidateRef}</b> · {result.verdict}
        <p>回归案例：{result.regressions.length} · 改善案例：{result.improvements.length} ·
          数据集摘要：<code>{result.datasetDigest.slice(0,16)}</code></p>
        <details><summary>逐案例对照与引用摘要</summary><pre>{json(result.cases)}</pre></details>
      </article>)}
    </div>
    <div className="panel">
      <h2>运行监控与优化候选</h2>
      <p>基于已持久化执行事件生成统计，只读展示，不自动修改能力或模型配置。</p>
      {analytics && <>
        <div className="form-row">
          <p>最近 {analytics.range.days} 天任务：<b>{analytics.range.runCount}</b></p>
          <p>样本调用：<b>{analytics.range.sampledInvocations}</b></p>
          <p>观察评估：<b>{analytics.checkpoints.decided}</b></p>
          <p>重规划：<b>{analytics.replans}</b></p>
        </div>
        <details><summary>运行状态与事件统计</summary><pre>{json({runs:analytics.runStatuses,events:analytics.events})}</pre></details>
        {analytics.modelCosts && <p>已估算模型费用：
          {Number(analytics.modelCosts.settledUsd).toFixed(6)} USD ·
          进行中预留 {Number(analytics.modelCosts.pendingReserveUsd).toFixed(6)} USD ·
          未核对 {analytics.modelCosts.unverified} 次 ·
          超预留 {analytics.modelCosts.overruns} 次
        </p>}
        <h3>能力执行指标</h3>
        {analytics.invocations.map((c: any) => (
          <article className="project" key={c.capabilityRef}>
            <b>{c.capabilityRef}</b> · {c.invoked} 次
            <p>成功 {c.succeeded} · 失败 {c.failed} · 不确定 {c.uncertain} · 均耗时 {c.averageDurationMs ?? "未知"} ms</p>
            <small>已观测 tokens：输入 {c.inputTokens} / 输出 {c.outputTokens}</small>
          </article>
        ))}
        <h3>待评审的优化候选</h3>
        {analytics.recommendations.length===0 ? <p>暂无达到分析阈值的高失败率能力。</p> :
          analytics.recommendations.map((c:any,i:number)=><article className="project" key={i}>
            <b>{c.capabilityRef}</b> · {c.reason}
            <pre>{json(c.evidence)}</pre>
          </article>)}
      </>}
      <button className="quiet" onClick={() => void act(load)}>刷新运行指标</button>
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
        <div className="actions">
          {["queued","running","waiting","awaiting_acceptance"].includes(current.status) && <>
            <button onClick={()=>void act(async()=>{
              await api("/v2/adaptive-runs/"+current.id+"/stop",{mode:"pause"});await load();
            })}>停止当前执行并保留现场</button>
            <button className="quiet" onClick={()=>void act(async()=>{
              await api("/v2/adaptive-runs/"+current.id+"/stop",{mode:"cancel"});await load();
            })}>停止并取消运行</button>
          </>}
          {current.status==="paused" && <button onClick={()=>void act(async()=>{
            await api("/v2/adaptive-runs/"+current.id+"/resume",{});await load();
          })}>继续已暂停运行</button>}
          {["failed","paused"].includes(current.status) && workspace?.available && <button className="quiet" onClick={()=>{
            const note=window.prompt("请先确认进程已停止，并检查工作区、初始化依赖与已有代码修改。填写至少20字的核对依据。接纳后将重新执行分析、测试和审查，已核对写入不会重放。");
            if(!note||note.trim().length<20)return;
            void act(async()=>{
              await api("/v2/adaptive-runs/"+current.id+"/adopt-workspace",{expectedDigest:workspace.digest,note});await load();
            });
          }}>核对并接纳现有工作区，重新验证</button>}
          {["failed","paused","waiting"].includes(current.status) && <button className="quiet" onClick={()=>void act(async()=>{
            await api("/v2/adaptive-runs/"+current.id+"/cancel",{});await load();
          })}>结束本次运行</button>}
        </div>
        {["pausing","cancelling"].includes(current.status)&&<p>正在停止本次运行的进程并核对结果，请等待。</p>}
        {current.status==="reconciling"&&<p>执行结果尚不确定。请逐项核对下方调用、遗留进程及外部影响，完成后再决定结束或接纳工作区。</p>}
        <button className="quiet" onClick={()=>void act(async()=>downloadRunAudit(current.id))}>
          下载本次运行审计摘要（SHA-256 链，原始参数与模型输出已省略）
        </button>
        {costInfo && <details>
          <summary>模型费用账本（已知用量与预算预留）</summary>
          <p>运行预算：{costInfo.runBudgetUsd ?? "未配置"} USD · 已记录费用：
            {(costInfo.spentMicroUsd/1e6).toFixed(6)} USD · 预留：
            {(costInfo.reservedMicroUsd/1e6).toFixed(6)} USD · 待核对：{costInfo.unverifiedCount}</p>
          <p>这不是供应商账单；超额/缺失用量可能在调用完成后才发现。</p>
          {(costInfo.costs as any[]).map((record:any)=><article key={record.id} className="project">
            <b>{record.profileRef}</b> · {record.state} ·
            已知 {(record.actualMicroUsd??0)/1e6} USD · 预留 {record.reservedMicroUsd/1e6} USD
            {record.state==="unverified"&&<button className="quiet" onClick={()=>{
              const input=window.prompt("请填写经过供应商数据核对的 input tokens");
              const output=window.prompt("请填写经过供应商数据核对的 output tokens");
              if(input===null||output===null||!/^\d+$/.test(input)||!/^\d+$/.test(output))return;
              const note=window.prompt("请填写供应商用量核对依据（至少 20 字）");
              if(!note||note.trim().length<20)return;
              void act(async()=>{
                await api("/v2/adaptive-runs/"+current.id+"/costs/"+record.id+"/reconcile",
                  {inputTokens:Number(input),outputTokens:Number(output),note});
                setCostInfo(await api("/v2/adaptive-runs/"+current.id+"/costs"));
              });
            }}>人工核对真实 token 用量</button>}
          </article>)}
        </details>}
        {current.plan.nodes.map((n)=><article className="project" key={n.id}>
          <b>{n.id}</b> · {n.capabilityRef} · {current.nodeStates[n.id] ?? "pending"}
          <small> · 依赖：{n.dependsOn.join(", ") || "无"}</small>
          {current.failures[n.id] && <p>{current.failures[n.id]}</p>}
          {((current.results[n.id] as {artifactRefs?:string[]}|undefined)?.artifactRefs ?? []).map((artifact)=>(
            <button key={artifact} className="quiet" onClick={() => void act(async () => {
              await downloadArtifact(current.id,n.id,artifact);
            })}>下载 {artifact.split("/").pop()}</button>
          ))}
          {current.nodeStates[n.id] === "uncertain" &&
            <button onClick={() => {
              const note = window.prompt("确认相关进程已终止、Worktree 和外部副作用已逐项核对。输入至少 10 字的依据（无法确认请取消）");
              if (!note || note.trim().length < 10) return;
              void act(async () => {
                await api("/v2/adaptive-runs/"+current.id+"/reconcile/"+n.id,
                  {stoppedConfirmed:true,note}); await load();
              });
            }}>人工核对该未确认调用</button>}
          {current.nodeStates[n.id] === "failed" &&
            ["waiting","failed"].includes(current.status) &&
            <button className="quiet" onClick={() => void act(async () => {
              await api("/v2/adaptive-runs/"+current.id+"/retry",{nodeId:n.id}); await load();
            })}>请求安全重试（写入能力将被拒绝）</button>}
          {current.status === "waiting" && current.nodeStates[n.id] === "waiting" &&
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
          {current.status === "waiting" &&
            current.decisions[o.id]?.decision === "REPLAN" &&
            <button onClick={() => void act(async () => {
              await api("/v2/adaptive-runs/"+current.id+"/observations/"+o.id+"/replan",{});
              await load();
            })}>重试经校验的重规划</button>}
          {current.status === "waiting" && (current.observationStates[o.id] === "waiting" ||
            (current.status==="waiting" &&
              ["WAIT_INPUT","WAIT_APPROVAL"].includes(current.decisions[o.id]?.decision))) &&
            <button onClick={() => void act(async () => {
            await api("/v2/adaptive-runs/"+current.id+"/observations/"+o.id+"/decision",
              { decision: "CONTINUE", reason: "User manually reviewed the evidence", affectedNodeIds: [], evidenceRefs: [] });
            await load();
          })}>人工确认继续</button>}
        </article>)}
        {["done","awaiting_acceptance"].includes(current.status) && (
          <button className="quiet" onClick={() => {
            const name = window.prompt("提取成项目知识候选，填写新知识 ID", "experience." + current.id.slice(0,8));
            if (!name) return;
            const version = window.prompt("版本号", "1.0.0");
            if (!version) return;
            void act(async () => {
              const candidate = await api("/v2/adaptive-runs/"+current.id+"/extract-knowledge",
                { name, version });
              setNotice("已生成待人工审阅的项目知识草稿：" + candidate.id);
              await load();
            });
          }}>从本次执行提取知识候选</button>
        )}
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
