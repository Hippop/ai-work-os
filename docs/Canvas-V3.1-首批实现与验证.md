# Canvas V3.1 实现与验证

日期：2026-11-16。设计基线：[完整开发架构](AI-Work-OS-Canvas-V3.1-开发架构设计.md)、[完整设计方案](AI-Work-OS-Canvas-V3-完整方案.md)。

## 已实现范围（P0 – P4）

### 1. 存储迁移与领域模型（P0）

- SQLite `user_version` 原子迁移 `v0 -> v1 -> v2`（失败自动回滚），新增 11 张专用 V3 关系表（`graph_drafts`、`compiled_plans`、`canvas_layouts`、`plan_changes`、`result_validity`、`context_manifests`、`workspace_access`、`agent_sessions`、`interventions`、`effect_records`、`knowledge_relations`）与双写镜像，并向后兼容全部 V1/V2 实体与事件流。
- 统一运行/草案事件 信封（`schemaVersion`、`seq`、`correlationId`、`planRevision`、`idempotencyGet/Put`、`eventsPage` 增量分页）。

### 2. 图草案、编译器与变更提案（P1 / P2）

- `GraphDraftService`：支持草稿创建、CAS `patchDraft`（节点/字段绑定/依赖/知识需求/缺口管理/手工标注 `resolveGap`）、基于已发布能力的确定性编排 `composeDraft` 与幂等记录。
- `GraphCompiler`：统一执行 `PlanGap` 阻断、能力与 Profile 发布态与 SHA-256 摘要校验、JSON Pointer 与 Schema 类型检查、条件分支门控（`skipped` 与 `block` / `use-default` / `omit`）、三色 DFS 环检测、测试/审查/交付质量门，以及冻结 `ResourceManifest` 启动（`startCompiledPlan` 支持 `Idempotency-Key`）。
- `ImpactAnalyzer` & `PlanChangeService`：运行态 `ChangeProposal`、影响范围重算（`valid` / `stale` / `invalid` / `unknown`）、已确认外部写入保护（`write_replan_unsafe`）、同 revision 运行状态漂移保护，以及 `?revision=` 历史视图回溯。

### 3. 上下文契约与知识治理（P3）

- `ContextAssembler`：为节点按契约组装冻结资源与依赖输入；强制执行作用域检查、冲突对阻断、撤销即时失效、上游工件 SHA-256 篡改检测（fail-closed）与上下文预算裁剪/超限阻断；对旧 V2 运行诚实返回 `available: false`、`contextMode: "legacy-ancestors"`。
- `KnowledgeCurationService`：支持 `node-output` 证据校验、`proposeCandidate` 审核边界（禁止跳过审核直晋 global）、冲突关系登记及 `revokeAndPropagate` 失效传播。

### 4. 工作区协调、副作用台账与交互式 CLI（P0 / P4）

- `WorkspaceAccessCoordinator`：读写锁互斥、epoch 校验、控制器重启恢复（标记为 `needs-reconciliation`）及显式人工核对（`reconcile`）。
- `AdaptiveEngine` & `EffectRecord`：外部写入与不确定失败自动转入 `reconciling`、阻断自动重放，并在 `adoptWorkspace` / `resume` 恢复执行时正确重置 `dispatchGate`。
- `InterventionService` & `AgentSessionManager`：支持 `interactive-write` / `inspect` 人工介入、一次性质询凭证、`disconnect` 不断开后台进程、RFC 6455 WebSocket 终端流（`/api/v3/agent-sessions/:id/stream`）、输出环形缓冲区与 `adoptIntervention`（按冻结 `outputSchema` 校验后重算下游）。

### 5. V3 REST / WebSocket 接口与统一工作台前端

- `apps/server/routes/v3.ts` & `apps/server/app.ts`：完整挂载 `/api/v3/*` 与终端 WebSocket，沿用本机 Bearer 鉴权与 `Origin` 校验，统一返回 `{ code, message, details, retryable, currentRevision }`。
- `apps/web/src/features/canvas/*`：`RunCanvas`（运行/设计/历史多模式切换、事件流增量同步与 seq 缺口快照兜底、图层过滤与 5 栏节点检查器）、`DesignModePanel`（草稿编排、手工节点浏览器端真实 SHA-256 摘要计算、缺口跳转 Builder 或标记解决、编译诊断与变更提案）、`CliSessionDock`（工作区摘要、交互式 CLI 会话控制与 `adopt`/`discard`）。

## 自动化验证结果（Windows 本机环境实测）

- `npm.cmd run typecheck`（`tsc --noEmit`）：退出码 `0`。
- `npm.cmd run build`（`vite build`）：退出码 `0`（47 个前端模块编译通过）。
- `node --import tsx --test tests/canvas-v3-*.test.ts tests/graph-projection.test.ts`：**24/24 通过**（覆盖 `A01–A26` 编译器、知识上下文、工作区锁、副作用台账、CLI 进程与 WebSocket 终端流、V1->V2 迁移与 V3 投影/路由）。
- `node --import tsx --test-name-pattern="workspace recovery checks digest" --test tests/adaptive-release-regressions.test.ts`：**1/1 通过**。
- `npm.cmd run check` 全量测试（`node --import tsx --test tests/*.test.ts`）：**163/177 通过，3 跳过（Linux POSIX 专属），11 失败**；11 项失败均为既有测试在非提权 Windows 环境运行 `.sh` mock 脚本（退出码 125 / 非 Win32 应用）或 `symlinkSync`（`EPERM`）导致的平台差异。

## 仍需目标环境验收项（本环境未覆盖）

1. **真实 Chromium 浏览器交互验收**：真实页面渲染、画布拖拽/键盘微调/缩放、断网重连事件流同步、WebSocket 终端按键与窄屏响应式布局。
2. **真实认证 Codex / OpenCode CLI 联调**：使用目标机实际认证凭证与真实外部工具执行端到端介入、工作区修改及 `adopt` 恢复。
3. **Linux cgroup v2 资源隔离验收**：在开启 cgroup v2 委托的目标 Linux 主机上验证子进程资源限制与清理测试。
