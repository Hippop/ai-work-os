import { useEffect, useState, type FormEvent } from "react";
import type { Project } from "../../../packages/domain/index";

type API=(path:string,data?:unknown)=>Promise<any>;
type Skill={id:string;name:string;status:string};
type Knowledge={id:string;title?:string;status:string;scope:string;projectId?:string|null};
type Profile={id:string;status:string;executor:string;agent?:string;workspaceMode?:string;mcpGrants?:unknown[];projectId?:string|null};
type Proposal={
  name:string;title:string;description:string;operatingInstructions:string;
  inputSchema:Record<string,unknown>;outputSchema:Record<string,unknown>;
  sampleInput:Record<string,unknown>;sampleOutput:Record<string,unknown>;
  suggestedSideEffect:string;suggestedExecutor:string;
  tags:string[];questions:string[];rationale:string;
};
type Snapshot={kind:string;label:string;digest:string;source:string};
type Session={
  id:string;projectId:string;profileRef:string;backend:string;goal:string;
  capabilityId:string;materials:Snapshot[];proposal:Proposal;
  revisions:{number:number;instruction:string;at:string;proposalDigest:string}[];
};
const asJson=(value:unknown)=>JSON.stringify(value,null,2);
const textExtensions=/\.(md|txt|json|jsonc|yaml|yml|ts|tsx|js|jsx|java|go|rs|py|xml|proto|sql|properties|log|csv|http)$/i;
export function CapabilityBuilderBoard({api,act,projects,skills,knowledge,profiles,onChanged}:{
  api:API;act:(fn:()=>Promise<void>)=>Promise<void>;projects:Project[];
  skills:Skill[];knowledge:Knowledge[];profiles:Profile[];onChanged:()=>Promise<void>;
}){
  const [projectId,setProjectId]=useState("");
  const [backend,setBackend]=useState("codex");
  const [profileRef,setProfileRef]=useState("");
  const [goal,setGoal]=useState("");
  const [paths,setPaths]=useState("");
  const [notes,setNotes]=useState("");
  const [skillIds,setSkillIds]=useState<string[]>([]);
  const [knowledgeIds,setKnowledgeIds]=useState<string[]>([]);
  const [uploaded,setUploaded]=useState<{name:string;text:string}[]>([]);
  const [sessions,setSessions]=useState<Session[]>([]);
  const [selected,setSelected]=useState<Session|null>(null);
  const [instruction,setInstruction]=useState("");
  const [verifiedSample,setVerifiedSample]=useState<{input:unknown;output:unknown}|null>(null);
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const [installed,setInstalled]=useState<{skill:{id:string;digest:string};profiles:string[]}|null>(null);
  useEffect(()=>{
    void Promise.all([api("/v2/capability-builder"),api("/v2/capability-builder/sessions")])
      .then(([info,list])=>{setInstalled(info);setSessions(list);})
      .catch(()=>setMessage("尚未检测到 Builder 服务，请确认后端已启动"));
  },[]);
  async function reload(){
    setSessions(await api("/v2/capability-builder/sessions"));
    await onChanged();
  }
  async function uploadFiles(files:FileList|null){
    if(!files)return;
    const next:{name:string;text:string}[]=[];
    for(const file of Array.from(files)){
      if(!textExtensions.test(file.name)||file.size>50000)
        throw Error("仅允许单个 50KB 以内的文本/代码文件："+file.name);
      const value=await file.text();
      if(value.includes("\0"))throw Error("不能导入二进制文件："+file.name);
      next.push({name:file.name,text:value});
    }
    if(next.length+uploaded.length>8)throw Error("最多选择 8 个本地文本文件");
    setUploaded([...uploaded,...next]);
  }
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!projectId||goal.trim().length<10)return;
    setBusy(true);
    try{
      const materials:unknown[]=[];
      if(notes.trim())materials.push({kind:"inline",name:"背景说明",text:notes.trim()});
      for(const file of uploaded)materials.push({kind:"inline",name:file.name,text:file.text});
      for(const path of paths.split("\n").map((v)=>v.trim()).filter(Boolean))
        materials.push({kind:"project-file",path});
      for(const id of skillIds)materials.push({kind:"skill",id});
      for(const id of knowledgeIds)materials.push({kind:"knowledge",id});
      if(materials.length>12)throw Error("最多允许 12 份参考材料");
      const result=await api("/v2/capability-builder/sessions",{
        projectId,backend,profileRef:profileRef||undefined,goal:goal.trim(),materials,
      });
      setVerifiedSample(null);
      setSelected({
        id:result.sessionId,projectId,backend,profileRef:profileRef||"",
        goal,capabilityId:result.capability.id,materials:result.materials,
        proposal:result.proposal,revisions:result.revisions,
      });
      setMessage("已生成待审核 Candidate："+result.capability.id+"。建议权限不会自动授予。");
      await reload();
    }catch(error){setMessage(String(error));}
    finally{setBusy(false);}
  }
  async function revise(){
    if(!selected||instruction.trim().length<5)return;
    setBusy(true);
    try{
      const result=await api("/v2/capability-builder/sessions/"+selected.id+"/revise",
        {instruction:instruction.trim()});
      setSelected({...selected,proposal:result.proposal,
        revisions:[...selected.revisions,result.revision]});
      setVerifiedSample(null);
      setInstruction("");
      setMessage("已按要求修改候选契约；仍需审核和验证");
      await reload();
    }catch(error){setMessage(String(error));}
    finally{setBusy(false);}
  }
  const eligible=profiles.filter((p)=>p.status==="published"&&p.executor==="agent"&&
    p.agent===backend&&p.workspaceMode==="read-only"&&!(p.mcpGrants?.length)&&
    (!p.projectId||p.projectId===projectId));
  const candidateReadProfile="core."+((selected?.backend==="opencode")?"opencode":"codex")+".read@1.0.0";
  return <section className="panel">
    <h2>AI 原子能力构建助手（平台预制）</h2>
    <p>只需描述能力目标，可组合导入文本/代码、项目内文件、已登记 Skill 与知识条目。平台 Builder Skill 指导 Codex/OpenCode 生成可编辑的候选契约和样例；发布前仍须人工确认。</p>
    <p><small>预制能力：{installed?.skill.id??"core.capability.builder@1.0.0"} · 构建过程无外部写权限</small></p>
    {message&&<p role="status">{message}</p>}
    <form onSubmit={(event)=>void create(event)}>
      <label>能力需要完成什么
        <textarea value={goal} onChange={(e)=>setGoal(e.target.value)} required minLength={10} rows={4}
          placeholder="例如：解析 Java GC 日志，识别频繁的大对象分配、老年代增长和 Full GC 风险，输出带证据的诊断结论"/>
      </label>
      <div className="form-row">
        <label>授权项目
          <select value={projectId} onChange={(e)=>{setProjectId(e.target.value);setKnowledgeIds([]);}} required>
            <option value="">选择项目（必须授权 Agent）</option>
            {projects.filter((p)=>p.allowAgent).map((p)=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>构建 Agent
          <select value={backend} onChange={(e)=>{setBackend(e.target.value);setProfileRef("");}}>
            <option value="codex">Codex</option><option value="opencode">OpenCode</option>
          </select>
        </label>
      </div>
      <label>Builder 执行配置（可选，默认使用平台预制只读 Profile）
        <select value={profileRef} onChange={(e)=>setProfileRef(e.target.value)}>
          <option value="">平台预制 {backend} Builder</option>
          {eligible.map((p)=><option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
      </label>
      <details>
        <summary>添加参考资料（可选）</summary>
        <label>背景说明 / 可粘贴的已有材料
          <textarea rows={4} value={notes} onChange={(e)=>setNotes(e.target.value)}
            placeholder="已有执行步骤、输入输出示例、约束条件或接口说明"/>
        </label>
        <label>导入本地文本与源代码
          <input type="file" multiple accept=".md,.txt,.json,.jsonc,.yaml,.yml,.ts,.tsx,.js,.jsx,.java,.go,.rs,.py,.xml,.proto,.sql,.properties,.log,.csv,.http"
            onChange={(e)=>void uploadFiles(e.target.files).catch((err)=>setMessage(String(err)))}/>
        </label>
        {uploaded.length>0&&<p>已选择：{uploaded.map((x)=>x.name).join("、")}
          <button type="button" className="quiet" onClick={()=>setUploaded([])}>清空</button>
        </p>}
        <label>项目代码或文档的相对路径（每行一个，不能包含 .. 或符号链接）
          <textarea rows={3} value={paths} onChange={(e)=>setPaths(e.target.value)}
            placeholder={"docs/api.md\nsrc/main/java/Example.java"}/>
        </label>
        <label>导入已扫描 Skill（多选）
          <select multiple size={Math.max(2,Math.min(6,skills.length))}
            value={skillIds} onChange={(e)=>setSkillIds(Array.from(e.target.selectedOptions,(o)=>o.value))}>
            {skills.filter((s)=>s.status==="available").map((s)=>
              <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>引用 Knowledge Hub（限全局或所选项目的已发布知识）
          <select multiple size={Math.max(2,Math.min(6,knowledge.length))}
            value={knowledgeIds} onChange={(e)=>setKnowledgeIds(Array.from(e.target.selectedOptions,(o)=>o.value))}>
            {knowledge.filter((k)=>k.status==="published" &&
              (k.scope==="global"&&!k.projectId || k.scope==="project"&&k.projectId===projectId))
              .map((k)=><option key={k.id} value={k.id}>{k.title??k.id}</option>)}
          </select>
        </label>
        <small>当前支持纯文本/源码；PDF、DOCX 需先提取为文本。文件仅作为参考，不会执行脚本；项目文件限制在授权仓库内部。</small>
      </details>
      <button disabled={busy||!projectId||goal.trim().length<10}>
        {busy?"正在生成":"AI 生成候选原子能力"}
      </button>
    </form>
    <h3>已创建的 Builder 会话</h3>
    <select value={selected?.id??""} onChange={(e)=>{
      const s=sessions.find((v)=>v.id===e.target.value);setSelected(s??null);setVerifiedSample(null);
    }}>
      <option value="">选择现有会话继续修改</option>
      {sessions.map((s)=><option key={s.id} value={s.id}>
        {s.capabilityId} · 第 {s.revisions.length} 版
      </option>)}
    </select>
    {selected&&<div>
      <h3>{selected.proposal.title} <small>Candidate · {selected.capabilityId}</small></h3>
      <p>{selected.proposal.description}</p>
      <p><strong>建议执行器：</strong>{selected.proposal.suggestedExecutor}；
        <strong> 建议副作用：</strong>{selected.proposal.suggestedSideEffect}（尚未授权）</p>
      <p><strong>推理依据：</strong>{selected.proposal.rationale}</p>
      <details open>
        <summary>生成的运行说明与输入输出契约</summary>
        <pre>{selected.proposal.operatingInstructions}</pre>
        <b>输入 Schema</b><pre>{asJson(selected.proposal.inputSchema)}</pre>
        <b>输出 Schema</b><pre>{asJson(selected.proposal.outputSchema)}</pre>
        <b>建议输入样例</b><pre>{asJson(selected.proposal.sampleInput)}</pre>
        <b>建议输出样例（并非真实执行结果）</b><pre>{asJson(selected.proposal.sampleOutput)}</pre>
      </details>
      {selected.proposal.questions.length>0&&<p>待确认事项：{selected.proposal.questions.join("；")}</p>}
      <details><summary>引用的材料与版本依据</summary>
        {selected.materials.map((m,i)=><p key={i}>
          {m.kind}: {m.label} · SHA: {m.digest.slice(0,16)}</p>)}
      </details>
      <label>继续对话式修改候选能力
        <textarea value={instruction} onChange={(e)=>setInstruction(e.target.value)} rows={3}
          placeholder="例如：把输入改成 GC 日志路径，并在输出中增加可复核的时间戳字段"/>
      </label>
      <div className="actions">
        <button disabled={busy||instruction.trim().length<5}
          onClick={()=>void revise()}>AI 修改当前候选</button>
        <button className="quiet" onClick={()=>void act(async()=>{
          const value=await api("/v2/capability-builder/sessions/"+selected.id+"/check-sample",{});
          setMessage(value.passed?"样例 Schema 检查通过（不代表模型实际运行）":"样例检查失败");
        })}>检查生成样例的 Schema</button>
        <button className="quiet" onClick={()=>void act(async()=>{
          const result=await api("/v2/capabilities/"+encodeURIComponent(selected.capabilityId)+"/sample-run",{
            projectId:selected.projectId,sampleInput:selected.proposal.sampleInput,
          });
          setVerifiedSample({input:selected.proposal.sampleInput,output:result.output});
          setMessage("已通过真实只读 Agent 样例检查；请人工审核输出证据并决定是否验证");
        })}>运行真实只读 Agent 样例</button>
        {verifiedSample&&<button className="quiet" onClick={()=>{
          const evidence=window.prompt("填写你审核真实样例输入/输出之后的验证依据（不允许使用 AI 的自我声明）");
          if(!evidence?.trim())return;
          void act(async()=>{
            await api("/v2/capabilities/"+encodeURIComponent(selected.capabilityId)+"/validate",{
              evidence,sample:verifiedSample,
            });
            await onChanged();
            setMessage("人工验收成功，Candidate 已进入 validated；请在下方能力目录明确发布");
          });
        }}>人工审核样例并标记验证通过</button>}
        <button className="quiet" onClick={()=>void act(async()=>{
          await api("/v2/capabilities/"+encodeURIComponent(selected.capabilityId)+"/candidate",
            {profileRef:candidateReadProfile,sideEffect:"read"});
          await onChanged();
          setMessage("已按你的明确操作绑定只读运行 Profile；下一步请真实测试并人工验证发布");
        })}>确认绑定预制只读执行配置</button>
      </div>
      {verifiedSample&&<details open><summary>真实 Agent 样例输出（请人工审核）</summary><pre>{asJson(verifiedSample.output)}</pre></details>}
      <p><small>Schema、权限、副作用和材料均需人工审核；上方样例为 AI 推断，不能据此直接认定真实执行成功。需要进一步编辑可使用下方 Capability Registry。</small></p>
      <details><summary>修改历史</summary>
        {selected.revisions.map((r)=><p key={r.number}>
          第 {r.number} 版 · {r.instruction} · {r.at}</p>)}
      </details>
    </div>}
  </section>;
}
