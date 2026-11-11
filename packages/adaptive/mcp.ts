import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { lstatSync, statSync, copyFileSync, chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, constants } from "node:fs";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { Store } from "../persistence/index.js";
import { DomainError } from "../domain/index.js";

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const action = z.string().regex(/^[a-zA-Z][\w.-]{0,119}$/);
export const McpServerInput = z.object({
  name,
  description: z.string().trim().min(1).max(2000),
  transport: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("stdio"),
      executable: z.string().min(1).max(1024),
      args: z.array(z.string().max(2000)).max(40).default([]),
    }),
    z.object({
      type: z.literal("http"),
      url: z.url().max(2048).refine((u) => u.startsWith("https://"), "MCP HTTP 端点必须使用 HTTPS"),
    }),
  ]),
  exposedTools: z.array(action).min(1).max(100),
  readOnlyTools: z.array(action).max(100).default([]),
  projectId: z.string().uuid().nullable().default(null),
}).strict();
export type McpServer = z.infer<typeof McpServerInput> & {
  id: string;
  status: "draft" | "published" | "revoked";
  createdAt: string;
};
export type McpGrant = { server: string; actions: string[] };

/** Explicit server registry. It never resolves or reuses Codex's user-level MCP catalog. */
export class McpRegistry {
  constructor(private store: Store) {}
  register(input: unknown): McpServer {
    const data = McpServerInput.parse(input);
    if (this.store.get("adaptive_mcp_server", data.name))
      throw new DomainError("mcp_name_exists", "MCP Server 名称已注册；请使用新名称创建新版本", 422);
    if (new Set(data.exposedTools).size !== data.exposedTools.length ||
      new Set(data.readOnlyTools).size !== data.readOnlyTools.length ||
      data.readOnlyTools.some((tool) => !data.exposedTools.includes(tool)))
      throw new DomainError("mcp_tools_invalid", "工具清单重复或只读工具未被声明", 422);
    if (data.projectId && !this.store.get("project", data.projectId))
      throw new DomainError("mcp_project_missing", "项目不存在", 422);
    if (data.transport.type === "stdio" && !isAbsolute(data.transport.executable))
      throw new DomainError("mcp_executable_path", "MCP 启动器必须是绝对路径", 422);
    const server: McpServer = { ...data, id: data.name, status: "draft", createdAt: new Date().toISOString() };
    this.store.transaction(() => {
      this.store.put("adaptive_mcp_server", server);
      this.store.event("asset:mcp:" + server.id, "mcp.registered", { id: server.id });
    });
    return server;
  }
  get(id: string, published = true): McpServer {
    const s = this.store.get<McpServer>("adaptive_mcp_server", id);
    if (!s || (published && s.status !== "published"))
      throw new DomainError("mcp_unavailable", "MCP Server 不存在或未发布", 422);
    return s;
  }
  publish(id: string) {
    return this.store.transaction(() => {
      const s = this.get(id, false);
      if (s.status !== "draft") throw new DomainError("mcp_not_draft", "只能发布草稿 MCP Server", 422);
      if (s.transport.type === "stdio") {
        let stat;
        try { stat = lstatSync(s.transport.executable); } catch {
          throw new DomainError("mcp_executable_missing", "MCP 可执行文件不存在", 422);
        }
        if (stat.isSymbolicLink() || !stat.isFile() || !(stat.mode & 0o111))
          throw new DomainError("mcp_executable_invalid", "MCP 可执行文件不可用或是符号链接", 422);
      }
      const next: McpServer = { ...s, status: "published" };
      this.store.put("adaptive_mcp_server", next);
      this.store.event("asset:mcp:" + id, "mcp.published", { id });
      return next;
    });
  }
  revoke(id: string) {
    return this.store.transaction(() => {
      const s = this.get(id, false);
      const next: McpServer = { ...s, status: "revoked" };
      this.store.put("adaptive_mcp_server", next);
      this.store.event("asset:mcp:" + id, "mcp.revoked", { id });
      return next;
    });
  }
  list() { return this.store.list<McpServer>("adaptive_mcp_server"); }
  resolve(grants: McpGrant[], projectId: string | null) {
    const seen = new Set<string>();
    return grants.map((grant) => {
      if (seen.has(grant.server)) throw new DomainError("mcp_grant_duplicate", "MCP Server 授权重复", 422);
      seen.add(grant.server);
      const s = this.get(grant.server);
      if (s.projectId && s.projectId !== projectId)
        throw new DomainError("mcp_scope_denied", "MCP Server 不属于当前项目", 403);
      if (!grant.actions.length || new Set(grant.actions).size !== grant.actions.length ||
        grant.actions.some((a) => !s.exposedTools.includes(a)))
        throw new DomainError("mcp_grant_invalid", "MCP 工具授权不在已发布目录内", 422);
      if (grant.actions.some((a) => !s.readOnlyTools.includes(a)))
        throw new DomainError("mcp_write_requires_approval", "MCP 写入工具必须使用独立审批通道", 422);
      return { server: s, enabledTools: grant.actions };
    });
  }
}
function toml(value: string) { return JSON.stringify(value); }
export function renderMcpConfig(resolved: ReturnType<McpRegistry["resolve"]>): string {
  // Prevent trusted project-local .codex/config.toml from injecting extra servers.
  // The sandbox/approval CLI flags still govern the invocation itself.
  let content = "# AI Work OS per-invocation MCP allowlist. Do not load project-local config.\n" +
    "project_root_markers = []\n" +
    "allow_login_shell = false\n";
  for (const { server, enabledTools } of resolved) {
    content += "\n[mcp_servers." + server.name + "]\n";
    if (server.transport.type === "http") content += "url = " + toml(server.transport.url) + "\n";
    else {
      content += "command = " + toml(server.transport.executable) + "\n";
      content += "args = [" + server.transport.args.map(toml).join(", ") + "]\n";
    }
    content += "enabled = true\nrequired = true\n";
    content += "enabled_tools = [" + enabledTools.map(toml).join(", ") + "]\n";
    content += "default_tools_approval_mode = \"auto\"\n";
  }
  return content;
}

/**
 * Per-invocation CODEX_HOME: isolates the user's config, plugins and MCP catalog.
 * Only auth.json is copied, using private 0700/0600 paths; never place secrets in run manifests.
 * Do not use this as an OS sandbox against malicious local commands or system policies.
 */
export function isolatedCodexHome(config: string, opts?: { authHome?: string; tempRoot?: string }) {
  const dir = mkdtempSync(join(opts?.tempRoot ?? tmpdir(), "aiwork-codex-"));
  chmodSync(dir, 0o700);
  try {
    writeFileSync(join(dir, "config.toml"), config, { mode: 0o600, flag: "wx" });
    const original = opts?.authHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const source = join(original, "auth.json");
    let exists = false;
    try {
      const st = lstatSync(source);
      if (!st.isFile() || st.isSymbolicLink())
        throw new DomainError("codex_auth_invalid", "Codex 凭据文件不能是符号链接", 422);
      exists = true;
    } catch (error) {
      if (error instanceof DomainError) throw error;
    }
    if (exists) {
      copyFileSync(source, join(dir, "auth.json"), constants.COPYFILE_EXCL);
      chmodSync(join(dir, "auth.json"), 0o600);
    }
    return {
      dir,
      env: { ...process.env, CODEX_HOME: dir } as NodeJS.ProcessEnv,
      dispose() { rmSync(dir, { recursive: true, force: true }); },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
