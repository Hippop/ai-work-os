import { useEffect, useState, type FormEvent } from "react";
import type { Project } from "../../../packages/domain/index";

type Api = (path: string, data?: unknown) => Promise<any>;
type Intent = {
  id:string; server:string; tool:string; projectId:string|null;
  arguments:Record<string,unknown>; purpose:string; argsDigest:string;
  status:string; createdAt:string; expiresAt:string; error?:string;
  reconciliation?:string;
};
type Mcp = {id:string;name:string;status:string;exposedTools:string[];readOnlyTools:string[]};
export function McpWriteBoard({api,act,projects,servers}:{
  api:Api;act:(fn:()=>Promise<void>)=>Promise<void>;
  projects:Project[];servers:Mcp[];
}) {
  const [intents,setIntents]=useState<Intent[]>([]);
  const [selectedServer,setSelectedServer]=useState("");
  const [selectedTool,setSelectedTool]=useState("");
  const [argumentsText,setArgumentsText]=useState("{}");
  const [message,setMessage]=useState("");
  async function refresh(){ setIntents(await api("/v2/mcp-write-intents")); }
  useEffect(()=>{void refresh().catch(()=>{});},[]);
  const source=servers.find((m)=>m.id===selectedServer);
  const writable=source?.exposedTools.filter((tool)=>!source.readOnlyTools.includes(tool)) ?? [];
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const values=new FormData(event.currentTarget);
    let args:unknown;
    try {args=JSON.parse(argumentsText);}catch{setMessage("参数必须是有效 JSON");return;}
    if (!args || Array.isArray(args) || typeof args!=="object") {
      setMessage("工具参数必须是 JSON 对象");return;
    }
    await act(async()=>{
      await api("/v2/mcp-write-intents",{
        server:selectedServer,tool:selectedTool,projectId:values.get("projectId")||null,
        arguments:args,purpose:values.get("purpose"),runId:null,
      });
      setMessage("已创建审批请求；批准前不会向外部 MCP 发送写操作");
      await refresh();
    });
  }
  return <div className="panel">
    <h2>MCP 写操作 · 精确参数人工审批</h2>
    <p>仅支持经运维白名单允许的 HTTPS MCP 域名。Agent 无权替你审批，也不会自动重放写操作。审批后，必须再明确点击执行；失败或回执丢失需人工核对外部状态。</p>
    <form onSubmit={(e)=>{void submit(e);}}>
      <div className="form-row">
        <label>已发布 MCP Server
          <select value={selectedServer} onChange={(e)=>{setSelectedServer(e.target.value);setSelectedTool("");}} required>
            <option value="">请选择</option>
            {servers.filter((m)=>m.status==="published"&&m.exposedTools.some((t)=>!m.readOnlyTools.includes(t)))
              .map((m)=><option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>写入工具
          <select value={selectedTool} onChange={(e)=>setSelectedTool(e.target.value)} required>
            <option value="">请选择</option>
            {writable.map((t)=><option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>
      <label>授权项目
        <select name="projectId"><option value="">全局（只适用于全局 MCP）</option>
          {projects.map((p)=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label>工具参数 JSON（将在本机数据库保存供逐字审查）
        <textarea rows={6} value={argumentsText} onChange={(e)=>setArgumentsText(e.target.value)}/>
      </label>
      <label>业务目的与预期外部变化
        <textarea name="purpose" rows={3} minLength={10} required />
      </label>
      <button disabled={!selectedServer||!selectedTool}>创建待审批请求</button>
    </form>
    {message && <p role="status">{message}</p>}
    <h3>审批与执行账本</h3>
    {intents.map((intent)=><article key={intent.id} className="project">
      <b>{intent.server} / {intent.tool}</b> · {intent.status}
      <p>{intent.purpose}</p>
      <small>参数 SHA-256：<code>{intent.argsDigest}</code></small>
      <details>
        <summary>审阅冻结参数和截止时间</summary>
        <pre>{JSON.stringify(intent.arguments,null,2)}</pre>
        <p>审批截止：{intent.expiresAt}</p>
      </details>
      {intent.status==="requested"&&<div className="actions">
        <button onClick={()=>{ 
          const digest=window.prompt("请输入上方完整的参数 SHA-256，确认审批的是准确内容");
          if(digest!==intent.argsDigest){setMessage("摘要不匹配，未执行任何操作");return;}
          const reason=window.prompt("审批理由（至少 10 字）");
          if(!reason||reason.trim().length<10)return;
          void act(async()=>{await api("/v2/mcp-write-intents/"+intent.id+"/decision",{
            approve:true,reason,expectedArgsDigest:intent.argsDigest,
          });await refresh();});
        }}>审批精确参数</button>
        <button className="quiet" onClick={()=>{
          const reason=window.prompt("拒绝原因（至少 10 字）");
          if(!reason||reason.trim().length<10)return;
          void act(async()=>{await api("/v2/mcp-write-intents/"+intent.id+"/decision",{
            approve:false,reason,expectedArgsDigest:intent.argsDigest,
          });await refresh();});
        }}>拒绝</button>
      </div>}
      {intent.status==="approved"&&<button onClick={()=>{
        if(!window.confirm("将向外部 MCP 发送一次已批准的写操作。是否执行？"))return;
        void act(async()=>{await api("/v2/mcp-write-intents/"+intent.id+"/execute",{});await refresh();});
      }}>执行已批准的写操作（仅一次）</button>}
      {intent.status==="uncertain"&&<>
        {intent.error&&<p>异常：{intent.error}</p>}
        <button className="quiet" onClick={()=>{
          const note=window.prompt("请先在外部系统核实写入是否实际生效，并填写至少 20 字的证据。此操作不会重新调用远程工具。");
          if(!note||note.trim().length<20)return;
          void act(async()=>{await api("/v2/mcp-write-intents/"+intent.id+"/reconcile",{note});await refresh();});
        }}>核对外部状态</button>
      </>}
    </article>)}
    <button className="quiet" onClick={()=>void act(refresh)}>刷新审批账本</button>
  </div>;
}
