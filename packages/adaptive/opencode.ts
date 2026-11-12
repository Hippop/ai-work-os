import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ChildProcess } from "node:child_process";
import { DomainError, digest } from "../domain/index.js";
import { execute, executablePath } from "../runtime/adapter.js";
import { checkSchema } from "./assets.js";
import type { McpRegistry } from "./mcp.js";
import type { CgroupLimits } from "../runtime/linux-cgroup.js";

export type OpenCodeMcp = ReturnType<McpRegistry["resolve"]>;
type Mode = "read-only" | "worktree-write";
export type OpenCodeResult = {
  output: unknown;
  modelUsage?: { inputTokens:number; outputTokens:number };
  tools: { kind:string;name:string;inputDigest?:string;outputDigest?:string }[];
  eventLog:string;
};
const safeName=(name:string)=>name.replace(/[^a-zA-Z0-9_-]/g,"_");

export function assertOpenCodeWorkspaceSafe(directory:string) {
  // OpenCode can load plugins/agents/MCP from a repository's config. Fail closed
  // rather than merge project-controlled permissions into the platform allowlist.
  let cursor=resolve(directory);
  const root=resolve(cursor,sep);
  while(true) {
    for(const filename of ["opencode.json","opencode.jsonc",".opencode"]) {
      if(existsSync(join(cursor,filename)))
        throw new DomainError("opencode_project_config",
          "工作区包含 OpenCode 配置或插件目录，无法保证逐 Profile 授权隔离；请先使用无配置的隔离工作区",422);
    }
    if(existsSync(join(cursor,".git"))||cursor===root)break;
    const parent=resolve(cursor,"..");
    if(parent===cursor)break;
    cursor=parent;
  }
}
export function renderOpenCodeConfig(mode:Mode,mcp:OpenCodeMcp) {
  const permissions:{action:string;resource:string;effect:"deny"|"allow"}[]=[
    {action:"*",resource:"*",effect:"deny"},
    {action:"read",resource:"*",effect:"allow"},
    {action:"glob",resource:"*",effect:"allow"},
    {action:"grep",resource:"*",effect:"allow"},
    {action:"shell",resource:"git status *",effect:"allow"},
    {action:"shell",resource:"git diff *",effect:"allow"},
  ];
  if(mode==="worktree-write")permissions.push({action:"edit",resource:"*",effect:"allow"});
  const servers:Record<string,unknown>={};
  for(const {server,enabledTools} of mcp) {
    const name=safeName(server.name);
    if(name!==server.name)
      throw new DomainError("opencode_server_name","MCP Server 名称在 OpenCode 中不能重命名",422);
    servers[name]=server.transport.type==="stdio"
      ? {type:"local",command:[server.transport.executable,...server.transport.args],codemode:false}
      : {type:"remote",url:server.transport.url,codemode:false};
    permissions.push({action:name+"_*",resource:"*",effect:"deny"});
    for(const tool of enabledTools)permissions.push({
      action:name+"_"+safeName(tool),resource:"*",effect:"allow",
    });
  }
  const agentName=mode==="worktree-write"?"aiwork_write":"aiwork_read";
  return {$schema:"https://opencode.ai/config.json",update:"disable",
    default_agent:agentName,
    agents:{[agentName]:{description:"AI Work OS controlled single-invocation agent",
      mode:"primary",permissions}},
    permissions,mcp:{servers}};
}

/**
 * OpenCode global config and provider auth live under XDG resources.
 * Isolate global config/plugins/state; copy only the provider auth file.
 * Not an OS sandbox. Project config is explicitly refused.
 */
export function isolatedOpenCodeHome(config:unknown,opts?:{
  authFile?:string;tempRoot?:string;
}) {
  const dir=mkdtempSync(join(opts?.tempRoot??tmpdir(),"aiwork-opencode-"));
  chmodSync(dir,0o700);
  const xdgConfig=join(dir,"config"),xdgData=join(dir,"data"),
    xdgState=join(dir,"state"),xdgCache=join(dir,"cache");
  const configDir=join(xdgConfig,"opencode"),dataDir=join(xdgData,"opencode");
  try {
    for(const folder of [xdgConfig,xdgData,xdgState,xdgCache,configDir,dataDir])
      mkdirSync(folder,{recursive:true,mode:0o700});
    const value=JSON.stringify(config);
    const configFile=join(configDir,"opencode.json");
    writeFileSync(configFile,value,{flag:"wx",mode:0o600});
    const source=opts?.authFile ??
      join(process.env.XDG_DATA_HOME??join(homedir(),".local","share"),"opencode","auth.json");
    if(existsSync(source)) {
      const stat=lstatSync(source);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
        throw new DomainError("opencode_auth_invalid","OpenCode Provider 凭据必须是非符号链接的普通文件",422);
      copyFileSync(source,join(dataDir,"auth.json"),constants.COPYFILE_EXCL);
      chmodSync(join(dataDir,"auth.json"),0o600);
    }
    return {
      dir,configFile,
      env:{
        ...process.env,
        XDG_CONFIG_HOME:xdgConfig,XDG_DATA_HOME:xdgData,
        XDG_STATE_HOME:xdgState,XDG_CACHE_HOME:xdgCache,
        OPENCODE_CONFIG:configFile,OPENCODE_CONFIG_DIR:configDir,
        OPENCODE_CONFIG_CONTENT:value,OPENCODE_DISABLE_AUTOUPDATE:"1",
      } as NodeJS.ProcessEnv,
      dispose(){rmSync(dir,{recursive:true,force:true});},
    };
  }catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
}

export function parseOpenCodeEvents(stdout:string,schema:Record<string,unknown>):OpenCodeResult {
  let answer="",input=0,output=0,hasUsage=false,events=0;
  const tools:OpenCodeResult["tools"]=[];
  for(const line of stdout.split(/\r?\n/)) {
    if(!line.trim())continue;
    let event:any;
    try{event=JSON.parse(line);}catch{
      throw new DomainError("opencode_protocol","OpenCode 输出了非 JSONL 事件",502);
    }
    events++;
    if(event?.type==="error"||event?.type==="session.error")
      throw new DomainError("opencode_error","OpenCode 返回执行错误",502);
    if(event?.type==="text"&&typeof event.part?.text==="string")answer+=event.part.text;
    if(event?.type==="step_finish"||event?.type==="step-finish") {
      const tokens=event.part?.tokens??event.tokens;
      if(typeof tokens?.input==="number"&&typeof tokens?.output==="number") {
        input+=tokens.input;output+=tokens.output;hasUsage=true;
      }
    }
    if(event?.type==="tool_use"||event?.type==="tool") {
      const p=event.part??{};
      tools.push({kind:"opencode",name:String(p.tool??event.tool??"unknown").slice(0,100),
        inputDigest:p.state?.input===undefined?undefined:digest(p.state.input),
        outputDigest:p.state?.output===undefined?undefined:digest(p.state.output)});
    }
  }
  if(!events||!answer.trim())
    throw new DomainError("opencode_missing_answer","OpenCode 未提供可验证的文本结果，拒绝视为成功",502);
  let raw=answer.trim();
  const fence=String.fromCharCode(96).repeat(3);
  if(raw.startsWith(fence)) {
    const lines=raw.split(/\r?\n/);
    if(lines.length<3||!lines.at(-1)?.startsWith(fence))
      throw new DomainError("opencode_invalid_json","OpenCode 返回的 fenced JSON 不完整",502);
    raw=lines.slice(1,-1).join("\n").trim();
  }
  let value:unknown;
  try{value=JSON.parse(raw);}catch{
    throw new DomainError("opencode_invalid_json","OpenCode 未按契约返回 JSON 对象",502);
  }
  checkSchema(schema,value);
  return {output:value,modelUsage:hasUsage?{inputTokens:input,outputTokens:output}:undefined,
    tools,eventLog:stdout};
}

export async function runOpenCode(options:{
  command?:string;cwd:string;mode:Mode;
  model?:string;prompt:string;schema:Record<string,unknown>;
  mcp:OpenCodeMcp;deadline:number;cgroup?:CgroupLimits;
  onChild:(child:ChildProcess|null)=>void;authFile?:string;
}):Promise<OpenCodeResult> {
  assertOpenCodeWorkspaceSafe(options.cwd);
  const isolated=isolatedOpenCodeHome(renderOpenCodeConfig(options.mode,options.mcp),
    {authFile:options.authFile});
  try {
    const args=["run","--format","json","--dir",options.cwd,
      ...(options.model?["--model",options.model]:[]),
      "--agent",options.mode==="worktree-write"?"aiwork_write":"aiwork_read",
      options.prompt+
      "\nReturn ONLY a single valid JSON object matching this schema, without Markdown:\n"+
      JSON.stringify(options.schema).slice(0,20000)];
    const result=await execute(executablePath(options.command??process.env.AI_WORK_OS_OPENCODE??"opencode"),
      args,options.cwd,options.deadline,options.onChild,
      {env:isolated.env,cgroup:options.cgroup});
    if(result.code!==0)
      throw new DomainError("opencode_failed",
        "OpenCode 执行失败（隐藏可能包含敏感信息的 stderr），退出码："+result.code,502);
    return parseOpenCodeEvents(result.stdout,options.schema);
  }finally{isolated.dispose();}
}
