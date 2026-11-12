import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { DomainError, digest } from "../domain/index.js";
import { Store } from "../persistence/index.js";
import { McpRegistry, type McpServer } from "./mcp.js";

const IntentInput = z.object({
  server: z.string().min(1).max(64),
  tool: z.string().regex(/^[a-zA-Z][\w.-]{0,119}$/),
  projectId: z.string().uuid().nullable().default(null),
  runId: z.string().uuid().nullable().default(null),
  arguments: z.record(z.string(), z.unknown()),
  purpose: z.string().trim().min(10).max(2000),
}).strict();
type Status = "requested" | "approved" | "rejected" | "executing" | "succeeded" | "uncertain" | "reconciled";
export type WriteIntent = z.infer<typeof IntentInput> & {
  id: string; status: Status; argsDigest: string; serverDigest: string;
  createdAt: string; expiresAt: string; approvedAt?: string;
  approvalReason?: string; completedAt?: string; resultDigest?: string;
  error?: string; reconciliation?: string;
};
export type WriteTransport = (server: McpServer, tool: string, args: Record<string, unknown>, intentId: string) => Promise<unknown>;
function jsonResponse(text: string, contentType: string): any {
  if (text.length > 2_000_000) throw Error("MCP response too large");
  if (contentType.includes("text/event-stream")) {
    const entries = text.split(/\r?\n\r?\n/);
    const data = entries.flatMap((entry) => entry.split(/\r?\n/)
      .filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()))
      .filter((line) => line && line !== "[DONE]").at(-1);
    if (!data) throw Error("MCP SSE response missing JSON");
    return JSON.parse(data);
  }
  if (!contentType.includes("application/json")) throw Error("MCP response must be JSON or SSE");
  return JSON.parse(text);
}
async function send(url: string, payload: unknown, session: string | null, version: string) {
  const response = await fetch(url, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw Error("MCP HTTP status " + response.status);
  const id = response.headers.get("mcp-session-id") ?? session;
  const text = await response.text();
  return { id, value: text ? jsonResponse(text, response.headers.get("content-type") ?? "") : null };
}
/**
 * A deliberately narrow, remote HTTPS Streamable HTTP MCP adapter.
 * No OAuth, redirects, stdio execution, automatic retries or provider-specific compensation.
 * Production operators must explicitly allowlist remote hosts and verify network egress rules.
 */
export const callMcpWrite: WriteTransport = async (server, tool, args, intentId) => {
  if (server.transport.type !== "http")
    throw new DomainError("mcp_transport_unsupported", "写操作只支持经审批的 HTTPS Streamable HTTP MCP", 422);
  const parsed = new URL(server.transport.url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname ||
      isIP(parsed.hostname) || parsed.hostname === "localhost" || parsed.hostname.endsWith(".local"))
    throw new DomainError("mcp_endpoint_unsafe", "MCP 写入目标地址不符合安全限制", 403);
  const allowed = (process.env.AI_WORK_OS_MCP_WRITE_ALLOW_HOSTS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(parsed.hostname.toLowerCase()))
    throw new DomainError("mcp_host_not_allowed", "MCP 写入域名不在运维白名单中", 403);
  const version = "2025-06-18", id = randomUUID();
  const initialized = await send(parsed.toString(), {
    jsonrpc: "2.0", id, method: "initialize",
    params: { protocolVersion: version, capabilities: {},
      clientInfo: { name: "ai-work-os", version: "2.1.0" } },
  }, null, version);
  if (initialized.value?.error || initialized.value?.id !== id)
    throw Error("MCP initialize rejected or returned an invalid id");
  await send(parsed.toString(), { jsonrpc: "2.0", method: "notifications/initialized" },
    initialized.id, version);
  const callId = intentId;
  const result = await send(parsed.toString(), {
    jsonrpc: "2.0", id: callId, method: "tools/call",
    params: { name: tool, arguments: args },
  }, initialized.id, version);
  if (result.value?.id !== callId || result.value?.error || result.value?.result?.isError)
    throw Error("MCP tool returned a failure or mismatched request id");
  return result.value.result;
};
/**
 * Explicit human approval for an exact MCP tool call, separate from Agent execution.
 * The local bearer-token owner is the approver, not a distinct human identity.
 * Once execution starts, a lost acknowledgement always becomes uncertain; never replay.
 */
export class McpWriteService {
  private registry: McpRegistry;
  constructor(private store: Store, private transport: WriteTransport = callMcpWrite) {
    this.registry = new McpRegistry(store);
  }
  get(id: string) {
    const value = this.store.get<WriteIntent>("adaptive_mcp_write", id);
    if (!value) throw new DomainError("mcp_intent_missing", "写操作请求不存在", 404);
    return value;
  }
  list() { return this.store.list<WriteIntent>("adaptive_mcp_write"); }
  private requireLinkedRunWaiting(item:WriteIntent) {
    if(!item.runId)return;
    const run=this.store.get<{status:string;nodeStates:Record<string,string>}>(
      "adaptive_run",item.runId);
    const linked=this.store.list<{runId:string;nodeId:string;mcpIntentId?:string;status:string}>(
      "adaptive_invocation").filter((inv)=>inv.mcpIntentId===item.id &&
        inv.runId===item.runId && inv.status==="waiting");
    if(!run||run.status!=="waiting"||linked.length!==1||
       run.nodeStates[linked[0].nodeId]!=="waiting")
      throw new DomainError("mcp_run_inactive","关联工作流并非等待此项写入审批，禁止继续外部副作用",409);
  }
  request(input: unknown) {
    const data = IntentInput.parse(input);
    const canonical = JSON.stringify(data.arguments);
    if (canonical.length > 12_000)
      throw new DomainError("mcp_args_too_large", "写操作参数超过安全上限", 422);
    const server = this.registry.get(data.server);
    if (server.projectId && server.projectId !== data.projectId)
      throw new DomainError("mcp_project_scope", "服务器不属于该项目", 403);
    if (data.projectId && !this.store.get("project", data.projectId))
      throw new DomainError("project_missing", "项目不存在", 404);
    if (!server.exposedTools.includes(data.tool) || server.readOnlyTools.includes(data.tool))
      throw new DomainError("write_tool_invalid", "只能申请已登记的写入工具", 422);
    if (data.runId) {
      const run = this.store.get<{ taskId:string }>("adaptive_run", data.runId);
      const task = run ? this.store.get<{projectId:string|null}>("task", run.taskId) : null;
      if (!task || task.projectId !== data.projectId)
        throw new DomainError("run_scope", "关联运行与项目不一致", 403);
    }
    const now = Date.now();
    const result: WriteIntent = {
      ...data, id: randomUUID(), status:"requested",
      argsDigest:digest(data.arguments), serverDigest:digest(server),
      createdAt:new Date(now).toISOString(), expiresAt:new Date(now + 15*60_000).toISOString(),
    };
    this.store.transaction(() => {
      this.store.put("adaptive_mcp_write", result);
      this.store.event("mcp-write:"+result.id, "mcp.write.requested",
        {server:server.id,tool:data.tool,projectId:data.projectId,runId:data.runId,argsDigest:result.argsDigest},"user");
    });
    return result;
  }
  decide(id:string, approve:boolean, reason:string, expectedArgsDigest:string) {
    if (reason.trim().length < 10) throw new DomainError("approval_reason", "审批依据至少十个字符", 422);
    return this.store.transaction(() => {
      const item = this.get(id);
      if (item.status !== "requested") throw new DomainError("approval_state", "请求不再等待审批", 409);
      this.requireLinkedRunWaiting(item);
      if (Date.now() > Date.parse(item.expiresAt)) throw new DomainError("approval_expired", "审批请求已过期", 409);
      if (item.argsDigest !== expectedArgsDigest ||
          digest(item.arguments) !== expectedArgsDigest)
        throw new DomainError("args_changed", "审批参数摘要发生变化", 409);
      const server = this.registry.get(item.server);
      if (digest(server) !== item.serverDigest) throw new DomainError("server_changed", "服务器配置已变化", 409);
      const updated:WriteIntent = {
        ...item,status:approve?"approved":"rejected",
        approvedAt:new Date().toISOString(),approvalReason:reason,
      };
      this.store.put("adaptive_mcp_write",updated);
      this.store.event("mcp-write:"+id,approve?"mcp.write.approved":"mcp.write.rejected",
        {server:item.server,tool:item.tool,argsDigest:item.argsDigest,reason},"user");
      return updated;
    });
  }
  async execute(id:string) {
    const item = this.store.transaction(() => {
      const current = this.get(id);
      if (current.status !== "approved") throw new DomainError("execution_state", "写操作未获得有效一次性授权", 409);
      this.requireLinkedRunWaiting(current);
      if (Date.now() > Date.parse(current.expiresAt)) throw new DomainError("approval_expired", "授权已过期", 409);
      const server = this.registry.get(current.server);
      if (digest(server) !== current.serverDigest || digest(current.arguments) !== current.argsDigest)
        throw new DomainError("approval_changed", "工具或参数与审批内容不一致", 409);
      const executing:WriteIntent = { ...current,status:"executing" };
      this.store.put("adaptive_mcp_write",executing);
      this.store.put("adaptive_side_effect", {
        id: current.id, runId: current.runId, nodeId: null,
        capabilityRef: "mcp:"+current.server+"/"+current.tool,
        inputDigest:current.argsDigest,state:"started",createdAt:new Date().toISOString(),
      });
      this.store.event("mcp-write:"+id,"mcp.write.dispatch_started",
        {server:current.server,tool:current.tool,argsDigest:current.argsDigest});
      return executing;
    });
    try {
      const server = this.registry.get(item.server);
      const result = await this.transport(server,item.tool,item.arguments,item.id);
      return this.store.transaction(() => {
        const current = this.get(id);
        if (current.status !== "executing") throw new DomainError("execution_state","执行状态已变动",409);
        const completed:WriteIntent = { ...current,status:"succeeded",
          completedAt:new Date().toISOString(),resultDigest:digest(result) };
        this.store.put("adaptive_mcp_write",completed);
        const effect = this.store.get<any>("adaptive_side_effect",id);
        this.store.put("adaptive_side_effect",{...effect,state:"confirmed",outputDigest:completed.resultDigest});
        this.store.event("mcp-write:"+id,"mcp.write.confirmed",
          {resultDigest:completed.resultDigest});
        return { ...completed,result };
      });
    } catch(error) {
      this.store.transaction(() => {
        const current = this.get(id);
        if (current.status !== "executing") return;
        const message = String((error as Error).message).slice(0,1000);
        this.store.put("adaptive_mcp_write",{...current,status:"uncertain",error:message,
          completedAt:new Date().toISOString()});
        const effect = this.store.get<any>("adaptive_side_effect",id);
        this.store.put("adaptive_side_effect",{...effect,state:"uncertain",reason:message});
        this.store.event("mcp-write:"+id,"mcp.write.uncertain",
          {server:current.server,tool:current.tool,reason:message});
      });
      throw error;
    }
  }
  /** Human verification is only an audit resolution; it never repeats the remote call. */
  reconcile(id:string, note:string) {
    if (note.trim().length < 20) throw new DomainError("reconcile_note", "必须提供外部状态核验依据", 422);
    return this.store.transaction(() => {
      const item = this.get(id);
      if (item.status !== "uncertain")
        throw new DomainError("not_uncertain", "该请求不需要核对", 422);
      const updated:WriteIntent = { ...item,status:"reconciled",reconciliation:note };
      this.store.put("adaptive_mcp_write",updated);
      const effect = this.store.get<any>("adaptive_side_effect",id);
      if (effect) this.store.put("adaptive_side_effect",{...effect,state:"reconciled",note});
      this.store.event("mcp-write:"+id,"mcp.write.reconciled",
        {argsDigest:item.argsDigest,note},"user");
      return updated;
    });
  }
  recover() {
    this.store.transaction(() => {
      for (const item of this.list().filter((i) => i.status === "executing")) {
        this.store.put("adaptive_mcp_write",{...item,status:"uncertain",error:"controller_restart"});
        const effect = this.store.get<any>("adaptive_side_effect",item.id);
        if (effect) this.store.put("adaptive_side_effect",
          {...effect,state:"uncertain",reason:"controller_restart"});
        this.store.event("mcp-write:"+item.id,"mcp.write.uncertain",{reason:"controller_restart"});
      }
    });
  }
}
