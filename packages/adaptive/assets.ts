import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, digest } from "../domain/index.js";
import { Store } from "../persistence/index.js";
import { ExternalSkillService } from "../external-skills/index.js";
import { McpRegistry } from "./mcp.js";

const key = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(120);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const shape = z.record(z.string(), z.unknown());
export const ExecutionProfileInput = z.object({
  name: key, version,
  projectId: z.string().uuid().nullable().default(null),
  executor: z.enum(["agent", "program", "project-test", "manual", "builtin"]),
  agent: z.string().max(80).optional(),
  model: z.string().max(150).optional(),
  skillIds: z.array(z.string().uuid()).max(20).default([]),
  mcpGrants: z.array(z.object({
    server: z.string().min(1).max(120),
    actions: z.array(z.string().min(1).max(120)).max(30),
  })).max(20).default([]),
  workspaceMode: z.enum(["none", "read-only", "worktree-write"]).default("none"),
  workspaceSubdir: z.string().trim().min(1).max(240).regex(/^\.$|^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)*$/).default("."),
  memoryLimitMb: z.number().int().min(64).max(32768).default(2048),
  maxProcesses: z.number().int().min(2).max(4096).default(128),
  program: z.object({
    executable: z.string().min(1).max(1024),
    args: z.array(z.string().max(1000)).max(50).default([]),
  }).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  maxCostUsd: z.number().min(0).max(100).default(2),
  billing: z.object({
    inputUsdPerMillion: z.number().finite().min(0).max(1000),
    outputUsdPerMillion: z.number().finite().min(0).max(1000),
    reservedInputTokens: z.number().int().min(1).max(10_000_000),
    reservedOutputTokens: z.number().int().min(1).max(10_000_000),
  }).strict().optional(),
});
export const CapabilityInput = z.object({
  name: key, version, title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(4000),
  inputSchema: shape, outputSchema: shape,
  sideEffect: z.enum(["none", "read", "workspace-write", "external-write"]).default("read"),
  profileRef: z.string().max(180).nullable().default(null),
  projectId: z.string().uuid().nullable().default(null),
  tags: z.array(z.string().max(60)).max(30).default([]),
  sourceSkillId: z.string().uuid().nullable().default(null),
  sourceDigest: z.string().max(128).nullable().default(null),
});
export const KnowledgeInput = z.object({
  name: key, version, title: z.string().trim().min(1).max(160),
  content: z.string().min(1).max(200000),
  scope: z.enum(["global", "project", "capability", "task"]),
  projectId: z.string().uuid().nullable().default(null),
  taskId: z.string().uuid().nullable().default(null),
  capabilityNames: z.array(key).max(40).default([]),
  source: z.string().trim().min(1).max(2000),
  evidenceRefs: z.array(z.string().max(500)).max(50).default([]),
  tags: z.array(z.string().max(60)).max(30).default([]),
});
export const KnowledgeBindingInput = z.object({
  capabilityName: key,
  knowledgeRef: z.string().min(1).max(180),
  mode: z.enum(["required", "on-demand", "optional"]),
});

export type Profile = z.infer<typeof ExecutionProfileInput> & { id: string; status: "draft" | "published" | "revoked"; createdAt: string };
export type Capability = z.infer<typeof CapabilityInput> & {
  id: string; status: "candidate" | "validated" | "published" | "revoked";
  createdAt: string; validation?: {
    at: string; evidence: string; inputDigest: string;
    sampleInputDigest?: string; sampleOutputDigest?: string;
  };
};
export type Knowledge = z.infer<typeof KnowledgeInput> & { id: string; status: "draft" | "published" | "revoked"; createdAt: string };
export type KnowledgeBinding = z.infer<typeof KnowledgeBindingInput> & { id: string; status?: "active" | "revoked" };

/** Deliberately limited, auditable JSON Schema subset. Reject unsupported keywords rather than silently accepting them. */
const supported = new Set(["type", "properties", "required", "items", "enum", "additionalProperties", "minLength", "maxLength", "minimum", "maximum", "description"]);
export function checkSchema(schema: Record<string, unknown>, value?: unknown): void {
  function validate(node: Record<string, unknown>, data: unknown, path: string, definitionOnly: boolean) {
    if (Object.keys(node).some((k) => !supported.has(k))) throw new DomainError("schema_unsupported", "不支持的 JSON Schema 关键字", 422);
    const type = node.type;
    if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type)))
      throw new DomainError("schema_unsupported", "Schema 必须显式声明受支持的 type", 422);
    const properties = node.properties as Record<string, unknown> | undefined;
    const required = node.required as unknown;
    if (properties && (type !== "object" || Array.isArray(properties) || typeof properties !== "object"))
      throw new DomainError("schema_invalid", "properties 必须是对象字段表", 422);
    if (Array.isArray(required) && required.some((x) => typeof x === "string" && !Object.hasOwn(properties ?? {}, x)))
      throw new DomainError("schema_invalid", "required 引用了未声明字段", 422);
    if (required !== undefined && (!Array.isArray(required) || required.some((x) => typeof x !== "string")))
      throw new DomainError("schema_invalid", "required 应是字符串数组", 422);
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length))
      throw new DomainError("schema_invalid", "enum 不能为空", 422);
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean")
      throw new DomainError("schema_invalid", "additionalProperties 只接受布尔值", 422);
    if (properties) for (const [name, sub] of Object.entries(properties)) {
      if (!sub || typeof sub !== "object" || Array.isArray(sub)) throw new DomainError("schema_invalid", "属性 Schema 无效", 422);
      validate(sub as Record<string, unknown>, (data as Record<string, unknown> | null)?.[name], path + "." + name, true);
    }
    if (node.items !== undefined) {
      if (type !== "array" || !node.items || typeof node.items !== "object" || Array.isArray(node.items))
        throw new DomainError("schema_invalid", "items 只能是单个 Schema", 422);
      validate(node.items as Record<string, unknown>, undefined, path + "[]", true);
    }
    if (definitionOnly) return;
    const validType = type === "null" ? data === null :
      type === "array" ? Array.isArray(data) :
      type === "object" ? !!data && typeof data === "object" && !Array.isArray(data) :
      type === "integer" ? typeof data === "number" && Number.isInteger(data) :
      type === "number" ? typeof data === "number" && Number.isFinite(data) :
      typeof data === type;
    if (!validType) throw new DomainError("schema_mismatch", path + " 类型不匹配", 422);
    if (node.enum && !(node.enum as unknown[]).some((x) => JSON.stringify(x) === JSON.stringify(data)))
      throw new DomainError("schema_mismatch", path + " 不在 enum 范围", 422);
    if (type === "string") {
      if (typeof node.minLength === "number" && (data as string).length < node.minLength) throw new DomainError("schema_mismatch", path + " 长度不足", 422);
      if (typeof node.maxLength === "number" && (data as string).length > node.maxLength) throw new DomainError("schema_mismatch", path + " 长度超限", 422);
    }
    if (type === "number" || type === "integer") {
      if (typeof node.minimum === "number" && (data as number) < node.minimum) throw new DomainError("schema_mismatch", path + " 小于下限", 422);
      if (typeof node.maximum === "number" && (data as number) > node.maximum) throw new DomainError("schema_mismatch", path + " 大于上限", 422);
    }
    if (type === "object") {
      const obj = data as Record<string, unknown>;
      for (const req of (required ?? []) as string[]) if (!Object.hasOwn(obj, req))
        throw new DomainError("schema_mismatch", path + "." + req + " 必填", 422);
      if (node.additionalProperties === false && Object.keys(obj).some((k) => !Object.hasOwn(properties ?? {}, k)))
        throw new DomainError("schema_mismatch", path + " 存在未声明字段", 422);
      for (const [k, v] of Object.entries(obj)) if (properties?.[k])
        validate(properties[k] as Record<string, unknown>, v, path + "." + k, false);
    }
    if (type === "array" && node.items) for (const [i, item] of (data as unknown[]).entries())
      validate(node.items as Record<string, unknown>, item, path + "[" + i + "]", false);
  }
  if (JSON.stringify(schema).length > 20000) throw new DomainError("schema_too_large", "Schema 过大", 422);
  validate(schema, value, "$", value === undefined);
}
function ref(name: string, ver: string) { return name + "@" + ver; }

export class AssetService {
  constructor(public store: Store) {}
  private record(type: string, id: string, event: string, payload: unknown) {
    this.store.event("asset:" + type + ":" + id, event, payload, "user");
  }
  createProfile(input: unknown): Profile {
    const data = ExecutionProfileInput.parse(input), id = ref(data.name, data.version);
    if (this.store.get("adaptive_profile", id)) throw new DomainError("version_exists", "配置版本已存在");
    if (data.projectId && !this.store.get("project", data.projectId))
      throw new DomainError("project_not_found", "执行配置绑定的项目不存在", 422);
    if (data.executor === "program" && !data.program) throw new DomainError("program_required", "程序执行器需要显式程序及参数", 422);
    if (data.executor === "agent" && !data.agent) throw new DomainError("agent_required", "Agent执行器需要指定适配器", 422);
    const profile: Profile = { ...data, id, status: "draft", createdAt: new Date().toISOString() };
    this.store.transaction(() => { this.store.put("adaptive_profile", profile); this.record("profile", id, "profile.created", { profile }); });
    return profile;
  }
  publishProfile(id: string): Profile {
    return this.store.transaction(() => {
      const p = this.getProfile(id, false);
      for (const skill of p.skillIds) new ExternalSkillService(this.store).snapshot([skill]);
      if (p.mcpGrants.length) new McpRegistry(this.store).resolve(p.mcpGrants, p.projectId);
      const v = { ...p, status: "published" as const };
      this.store.put("adaptive_profile", v); this.record("profile", id, "profile.published", { id });
      return v;
    });
  }
  getProfile(id: string, published = true): Profile {
    const p = this.store.get<Profile>("adaptive_profile", id);
    if (!p || (published && p.status !== "published")) throw new DomainError("profile_unavailable", "执行配置不存在或未发布", 422);
    return p;
  }
  createCapability(input: unknown): Capability {
    const data = CapabilityInput.parse(input), id = ref(data.name, data.version);
    checkSchema(data.inputSchema); checkSchema(data.outputSchema);
    if (this.store.get("adaptive_capability", id)) throw new DomainError("version_exists", "能力版本已存在");
    if (data.projectId && !this.store.get("project", data.projectId)) throw new DomainError("project_not_found", "项目不存在", 422);
    const cap: Capability = { ...data, id, status: "candidate", createdAt: new Date().toISOString() };
    this.store.transaction(() => { this.store.put("adaptive_capability", cap); this.record("capability", id, "capability.created", { id, sourceSkillId: data.sourceSkillId }); });
    return cap;
  }
  updateCandidate(id: string, input: unknown): Capability {
    const patch = z.object({
      title: z.string().trim().min(1).max(160).optional(),
      description: z.string().trim().min(1).max(4000).optional(),
      inputSchema: shape.optional(), outputSchema: shape.optional(),
      tags: z.array(z.string().max(60)).max(30).optional(),
      profileRef: z.string().max(180).nullable().optional(),
      sideEffect: z.enum(["none", "read", "workspace-write", "external-write"]).optional(),
    }).strict().parse(input);
    return this.store.transaction(() => {
      const old = this.getCapability(id, false);
      if (old.status !== "candidate") throw new DomainError("candidate_only", "已验证或已发布版本不可覆盖", 422);
      const data = CapabilityInput.parse({ ...old, ...patch });
      checkSchema(data.inputSchema); checkSchema(data.outputSchema);
      if (data.profileRef) this.getProfile(data.profileRef);
      const next: Capability = { ...old, ...data };
      this.store.put("adaptive_capability", next);
      this.record("capability", id, "capability.candidate_updated", {
        id, previousDigest: digest(old), nextDigest: digest(next),
      });
      return next;
    });
  }
  validateCapability(id: string, evidence: string, sample?: { input: unknown; output: unknown }): Capability {
    if (!evidence.trim() || evidence.length > 4000) throw new DomainError("validation_evidence_required", "请提供契约验证依据", 422);
    return this.store.transaction(() => {
      const cap = this.getCapability(id, false);
      if (cap.status !== "candidate") throw new DomainError("invalid_state", "只有候选能力可进入验证", 422);
      if (cap.sourceSkillId && !sample)
        throw new DomainError("skill_contract_sample_required", "从 Skill 导入的能力必须提供实际输入和输出样例", 422);
      if (sample) {
        checkSchema(cap.inputSchema, sample.input);
        checkSchema(cap.outputSchema, sample.output);
      }
      if (cap.profileRef) {
        const profile = this.getProfile(cap.profileRef);
        if (cap.sideEffect === "read" && profile.workspaceMode === "worktree-write")
          throw new DomainError("permission_mismatch", "只读能力不可绑定写入配置", 422);
        if (cap.sourceSkillId && !profile.skillIds.includes(cap.sourceSkillId))
          throw new DomainError("skill_binding_missing", "生成能力必须在配置中引用原始 Skill", 422);
      }
      if (cap.sourceSkillId) {
        const [skill] = new ExternalSkillService(this.store).snapshot([cap.sourceSkillId]);
        if (cap.sourceDigest !== skill.contentDigest) throw new DomainError("skill_changed", "源 Skill 内容已变化，需要重新生成候选", 422);
      }
      const updated: Capability = { ...cap, status: "validated", validation: {
        at: new Date().toISOString(), evidence, inputDigest: digest(cap),
        ...(sample ? { sampleInputDigest: digest(sample.input), sampleOutputDigest: digest(sample.output) } : {}),
      } };
      this.store.put("adaptive_capability", updated); this.record("capability", id, "capability.validated", updated.validation);
      return updated;
    });
  }
  publishCapability(id: string): Capability {
    return this.store.transaction(() => {
      const cap = this.getCapability(id, false);
      if (cap.status !== "validated" || !cap.validation) throw new DomainError("validation_required", "能力必须先验证", 422);
      if (cap.profileRef) this.getProfile(cap.profileRef);
      const v: Capability = { ...cap, status: "published" };
      this.store.put("adaptive_capability", v); this.record("capability", id, "capability.published", { id });
      return v;
    });
  }
  getCapability(id: string, published = true): Capability {
    const cap = this.store.get<Capability>("adaptive_capability", id);
    if (!cap || (published && cap.status !== "published")) throw new DomainError("capability_unavailable", "能力不存在或未发布", 422);
    return cap;
  }
  listCapabilities() { return this.store.list<Capability>("adaptive_capability"); }
  revokeCapability(id: string) {
    const cap = this.getCapability(id, false);
    this.store.transaction(() => { this.store.put("adaptive_capability", { ...cap, status: "revoked" }); this.record("capability", id, "capability.revoked", { id }); });
  }
  createKnowledge(input: unknown): Knowledge {
    const data = KnowledgeInput.parse(input), id = ref(data.name, data.version);
    if (this.store.get("adaptive_knowledge", id)) throw new DomainError("version_exists", "知识版本已存在");
    if (data.scope === "project" && (!data.projectId || !this.store.get("project", data.projectId)))
      throw new DomainError("scope_required", "项目知识必须关联已有项目", 422);
    if (data.scope === "task") {
      const task = data.taskId
        ? this.store.get<{projectId:string|null}>("task",data.taskId) : null;
      if (!task)
        throw new DomainError("scope_required", "任务知识必须关联已有任务", 422);
      if (data.projectId !== task.projectId)
        throw new DomainError("knowledge_task_project_mismatch",
          "任务知识项目范围必须与任务所属项目一致", 422);
    }
    if (data.taskId && data.scope !== "task")
      throw new DomainError("knowledge_scope_mismatch", "只有任务作用域知识可以指定任务 ID", 422);
    if (data.projectId && !this.store.get("project",data.projectId))
      throw new DomainError("knowledge_project_missing", "知识引用的项目不存在", 422);
    if (data.scope === "capability" && !data.capabilityNames.length)
      throw new DomainError("scope_required", "能力知识必须指定适用能力", 422);
    const k: Knowledge = { ...data, id, status: "draft", createdAt: new Date().toISOString() };
    this.store.transaction(() => { this.store.put("adaptive_knowledge", k); this.record("knowledge", id, "knowledge.created", { id }); });
    return k;
  }
  getKnowledge(id: string): Knowledge {
    const k = this.store.get<Knowledge>("adaptive_knowledge", id);
    if (!k) throw new DomainError("knowledge_missing", "知识不存在", 404);
    return k;
  }
  updateKnowledgeDraft(id: string, input: unknown): Knowledge {
    const patch = z.object({
      title: z.string().trim().min(1).max(160).optional(),
      content: z.string().min(1).max(200000).optional(),
      source: z.string().trim().min(1).max(2000).optional(),
      tags: z.array(z.string().max(60)).max(30).optional(),
      evidenceRefs: z.array(z.string().max(500)).max(50).optional(),
      capabilityNames: z.array(key).max(40).optional(),
    }).strict().parse(input);
    return this.store.transaction(() => {
      const old = this.getKnowledge(id);
      if (old.status !== "draft")
        throw new DomainError("knowledge_published", "只可修改草稿；已发布知识应创建新版本", 422);
      const data = KnowledgeInput.parse({ ...old, ...patch });
      if (data.scope === "capability" && !data.capabilityNames.length)
        throw new DomainError("scope_required", "能力知识必须指定适用能力", 422);
      const updated: Knowledge = { ...old, ...data };
      this.store.put("adaptive_knowledge", updated);
      this.record("knowledge", id, "knowledge.draft_updated", {
        id, beforeDigest: digest(old.content), afterDigest: digest(updated.content),
      });
      return updated;
    });
  }
  reviseKnowledge(id: string, input: unknown): Knowledge {
    const data = z.object({
      version: version, title: z.string().trim().min(1).max(160).optional(),
      content: z.string().min(1).max(200000).optional(),
      source: z.string().trim().min(1).max(2000).optional(),
      tags: z.array(z.string().max(60)).max(30).optional(),
      evidenceRefs: z.array(z.string().max(500)).max(50).optional(),
      capabilityNames: z.array(key).max(40).optional(),
    }).strict().parse(input);
    const previous = this.getKnowledge(id);
    if (previous.version === data.version)
      throw new DomainError("revision_same_version", "新知识版本号必须改变", 422);
    const result = this.createKnowledge({ ...previous, ...data });
    this.store.transaction(() => {
      this.record("knowledge", result.id, "knowledge.revised_from", {
        sourceId: previous.id, sourceContentDigest: digest(previous.content),
      });
    });
    return result;
  }
  publishKnowledge(id: string): Knowledge {
    return this.store.transaction(() => {
      const k = this.getKnowledge(id);
      if (k.status !== "draft") throw new DomainError("invalid_state", "只有草稿知识可以发布", 422);
      const v: Knowledge = { ...k, status: "published" };
      this.store.put("adaptive_knowledge", v); this.record("knowledge", id, "knowledge.published", { id });
      return v;
    });
  }
  revokeKnowledge(id: string) {
    this.store.transaction(() => { const k = this.getKnowledge(id); this.store.put("adaptive_knowledge", { ...k, status: "revoked" }); this.record("knowledge", id, "knowledge.revoked", { id }); });
  }
  listKnowledge() { return this.store.list<Knowledge>("adaptive_knowledge"); }
  bindKnowledge(input: unknown): KnowledgeBinding {
    const data = KnowledgeBindingInput.parse(input);
    const k = this.getKnowledge(data.knowledgeRef);
    if (k.status !== "published") throw new DomainError("knowledge_unpublished", "只能绑定已发布知识", 422);
    if (k.scope === "capability" && !k.capabilityNames.includes(data.capabilityName))
      throw new DomainError("knowledge_forbidden", "能力不可绑定其他能力的专属知识", 403);
    const id = digest(data), binding: KnowledgeBinding = { ...data, id, status: "active" };
    this.store.transaction(() => { this.store.put("adaptive_knowledge_binding", binding); this.record("knowledge-binding", id, "binding.created", { ...data }); });
    return binding;
  }
  bindings(capabilityName: string) {
    return this.store.list<KnowledgeBinding>("adaptive_knowledge_binding").filter((b) => b.capabilityName === capabilityName && b.status !== "revoked");
  }
  revokeKnowledgeBinding(id: string) {
    return this.store.transaction(() => {
      const binding = this.store.get<KnowledgeBinding>("adaptive_knowledge_binding", id);
      if (!binding) throw new DomainError("binding_missing", "知识绑定不存在", 404);
      const revoked: KnowledgeBinding = { ...binding, status: "revoked" };
      this.store.put("adaptive_knowledge_binding", revoked);
      this.record("knowledge-binding", id, "binding.revoked", { id });
      return revoked;
    });
  }
  accessible(k: Knowledge, projectId: string | null, taskId: string | null, capabilityName: string): boolean {
    return k.status === "published" &&
      (k.projectId === null || k.projectId === projectId) &&
      (k.taskId === null || k.taskId === taskId) &&
      (!k.capabilityNames.length || k.capabilityNames.includes(capabilityName));
  }
  retrieveKnowledge(query: string, projectId: string | null, taskId: string | null, capabilityName: string, max = 8) {
    if (taskId) {
      const task = this.store.get<{projectId:string|null}>("task",taskId);
      if (!task || task.projectId !== projectId)
        throw new DomainError("knowledge_context_scope", "任务与查询项目范围不一致", 403);
    }
    if (projectId && !this.store.get("project",projectId))
      throw new DomainError("knowledge_context_scope", "查询项目不存在", 403);
    const search = query.toLowerCase().trim();
    const bindings = this.bindings(capabilityName);
    const required = bindings.filter((b) => b.mode === "required");
    if (required.length > 20)
      throw new DomainError("required_knowledge_over_budget",
        "必需知识超过运行上下文上限，不允许静默丢弃",422);
    for (const b of required) {
      const k = this.getKnowledge(b.knowledgeRef);
      if (!this.accessible(k, projectId, taskId, capabilityName)) throw new DomainError("required_knowledge_missing", "必需知识不可访问或已撤销", 422);
    }
    // Version conflict prevention: one active version per knowledge identity/scope.
    // Explicit bindings pin their referenced versions; required bindings take priority.
    const identity = (k: Knowledge) => [k.name,k.scope,k.projectId??"",k.taskId??"",
      [...k.capabilityNames].sort().join(",")].join("|");
    const requiredIdentity = new Map<string,string>();
    for(const binding of required) {
      const k = this.getKnowledge(binding.knowledgeRef);
      const key = identity(k);
      if(requiredIdentity.has(key) && requiredIdentity.get(key)!==k.id)
        throw new DomainError("knowledge_version_conflict",
          "同一知识身份同时绑定多个必需版本，需要先解除冲突",422);
      requiredIdentity.set(key,k.id);
    }
    const candidates = this.listKnowledge().filter((k) =>
      this.accessible(k, projectId, taskId, capabilityName));
    const byIdentity = new Map<string,Knowledge[]>();
    for(const k of candidates) {
      const name=identity(k);
      byIdentity.set(name,[...(byIdentity.get(name)??[]),k]);
    }
    const allowed:Knowledge[]=[];
    const compareVersion=(a:Knowledge,b:Knowledge)=>{
      const av=a.version.split(".").map(Number),bv=b.version.split(".").map(Number);
      for(let i=0;i<3;i++)if(av[i]!==bv[i])return bv[i]-av[i];
      return a.id.localeCompare(b.id);
    };
    for(const group of byIdentity.values()) {
      const pinned=group.filter((k)=>bindings.some((b)=>b.knowledgeRef===k.id));
      const requiredPinned=pinned.filter((k)=>required.some((b)=>b.knowledgeRef===k.id));
      allowed.push([...(requiredPinned.length?requiredPinned:pinned.length?pinned:group)]
        .sort(compareVersion)[0]);
    }
    const scored = allowed.map((k) => {
      const binding = bindings.find((b) => b.knowledgeRef === k.id);
      const hay = (k.title + " " + k.name + " " + k.tags.join(" ") + " " + k.content).toLowerCase();
      const terms = search.split(/\s+/).filter(Boolean);
      const score = (binding?.mode === "required" ? 100 : 0) + (terms.length && terms.every((t) => hay.includes(t)) ? 10 : 0) +
        (binding ? 2 : 0);
      return { k, score };
    }).filter(({ k, score }) => score > 0 || required.some((r) => r.knowledgeRef === k.id))
      .sort((a,b) => b.score - a.score || a.k.id.localeCompare(b.k.id)).slice(0, Math.min(20, Math.max(required.length, max)));
    const results = scored.map(({ k }) => ({
      id: k.id, title: k.title, version: k.version, name: k.name,
      content: k.content, digest: digest(k.content),
      scope: k.scope, source: k.source, evidenceRefs: k.evidenceRefs,
    }));
    this.store.event(taskId ? "task:" + taskId : "knowledge:search", "knowledge.retrieved", {
      queryDigest: digest(query), projectId, capabilityName,
      returned: results.map((item) => ({ id: item.id, digest: item.digest })),
    });
    return results;
  }
  /** Source-preserving deterministic draft; not represented as model-verified AI output. */
  draftFromSkill(skillId: string): Capability {
    const [skill] = new ExternalSkillService(this.store).snapshot([skillId]);
    const name = "skill." + skill.name.replace(/-/g, ".");
    const base = { type: "object", properties: {
      objective: { type: "string" }, context: { type: "string" },
    }, required: ["objective"], additionalProperties: false };
    const output = { type: "object", properties: {
      summary: { type: "string" }, evidence: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
    }, required: ["summary", "evidence", "risks"], additionalProperties: false };
    const versions = this.listCapabilities().filter((c) => c.name === name).length;
    return this.createCapability({
      name, version: "0.1." + versions, title: skill.name, description: skill.description,
      inputSchema: base, outputSchema: output, sourceSkillId: skill.id,
      sourceDigest: skill.contentDigest, sideEffect: "read", tags: ["skill-import"],
    });
  }
}
