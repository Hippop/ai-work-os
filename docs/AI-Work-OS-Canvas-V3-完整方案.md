# AI Work OS Canvas V3｜统一画布、Agent Workspace 与知识感知工作流完整方案

> 状态：**设计提案，尚未实现**  
> 日期：2026-11-15  
> 环境：Linux 单机优先；React/TypeScript + Node.js 22  
> 基线：[V2.1 架构](./AI-Work-OS-自适应原子能力架构方案-v2.1.md) · [V2 实现说明](./自适应工作流V2实现说明.md)  
> 目的：统一前述讨论的交互、领域模型、执行语义、安全边界、实施路线与验收标准，不修改已有 V2 的事实描述。

## 0. 方案摘要与设计决策

AI Work OS 的主要入口升级为**一张统一画布**。用户在画布上创建可复用原子能力，AI 负责动态编排；知识、数据、工件在节点间流转；运行中通过 Observation 评估并受控重规划；用户随时点击 Agent 节点进入对应工作目录与 CLI 深入协作，再将修改安全交回工作流。

核心闭环：

`任务目标 → AI 生成 GraphPlan → 能力/知识缺口补齐 → 编译校验 → 执行 → 观察/重规划 → 人工 CLI 干预 → 交付 → 知识与能力沉淀 → 下次复用`

**明确的架构决策：**

1. **同一张画布，不拆成执行和知识两张图。** 设计、运行、回溯共用 GraphPlan；执行、数据、知识是可切换的显示层。
2. **原子能力实例是主方框。** 知识卡片、工件卡片、观察点按需展开，不把每个数据字段变成方框。
3. **每个 Agent-backed 节点都有确定的有效 Agent/Profile/cwd 和可选 Skill**；多个节点可引用同一能力定义，但执行实例独立。
4. **Node → Agent Workspace → CLI** 是关键交互：终端在受控工作目录中启动，CLI 的人工修改须审核/接纳/重新验证，不能绕过自动流程。
5. **能力契约与运行配置分离**；已发布 Capability/Profile/Skill 版本及运行快照不可静默修改。
6. **任务级共享 Git Worktree + 节点 cwd/上下文隔离**为默认开发模式；独立写入分支选用单独 Worktree 并显式合并。
7. **计划不止任务类型**，还必须规划执行依赖、精确数据绑定、知识来源和沉淀策略、工作目录与观察点。
8. **AI 给提案，后端做决定**：确定性编译器校验权限/数据/知识/副作用/质量门，保存不可变历史。
9. **重规划必须考虑知识与副作用**：不能删除已经发生的写入事实；不能把 CLI 关闭理解为节点成功。

## 1. 产品目标与非目标

### 1.1 主要目标

- 可理解：看懂任务如何规划、各能力用什么 Agent/Skill/知识、执行到哪里、为什么调整。
- 可操作：用户拖拽/连线、自然语言修改计划、下钻节点，直接在 Agent CLI 中工作。
- 可追溯：输入/输出、知识版本、工件摘要、CLI 人工修改、PlanRevision、审批与副作用均留证。
- 可复用：能力从候选到发布；知识从假设、证据到项目/能力/全局知识，后续任务按权限复用。
- 可恢复：运行暂停与失联可安全核对，不重放未知副作用。

### 1.2 初期非目标

不做无限循环、无限自动重规划、分布式调度、完全自治的高风险执行、多人同时写同一工作区，也不默认承诺恢复供应商 CLI 的原始内部会话。Worktree/cgroup/cwd 限制不等于完整安全沙箱。当前 V2 计划的节点、观察点和版本上限应在 UI 显式呈现，扩展前不能假设无限规模。

## 2. 主画布的交互布局

| 区域 | 内容 | 操作 |
| --- | --- | --- |
| 左侧资源库 | 原子能力、知识、Skill、工件、流程模板 | 搜索、拖入、创建、查看版本 |
| 中间画布 | Capability 节点、依赖关系、Observation、知识/工件卡片 | 拖拽、连线、缩放、局部展开、定位 |
| 右侧节点检查器 | 概览、输入/知识、Agent/CLI、输出/证据、历史/版本 | 配置、调试、进入 CLI、接纳变更 |
| 底部 AI 协作栏 | 自然语言指令、规划解释、差异与风险确认 | “新增验证节点”“引用这条知识”“重规划下游” |

三种模式共用一个计划模型：**设计**（编辑草案、连线、校验与预检）、**运行**（实时状态、日志、观察点、CLI 介入）、**回溯**（查看 PlanRevision 和差异）。提供 `全部`、`执行依赖`、`数据流`、`知识流`、`只看受影响范围` 的显示过滤。

信息密度采用三级：默认节点只显示标题/Agent/cwd 简写/状态/数量；聚焦节点时显示输入输出端口和相关边；右侧检查器查看完整 Schema、实际上下文、证据、日志和调用历史。大型工作流按阶段折叠；重规划只重新布局受影响区域，保持其他节点位置稳定。

## 3. 画布的对象与连线

| 对象 | 是否直接调度 | 含义 |
| --- | --- | --- |
| CapabilityInvocationNode | 是 | 已发布能力在当前任务中的一次调用实例 |
| ObservationNode | 由控制层触发评估 | 阶段检查、异常观察、REPLAN/RETRY/WAIT 等决策 |
| KnowledgeRefCard | 否 | 已发布知识/候选知识的引用，展开后查看版本、证据、使用者 |
| ArtifactRefCard | 否 | 代码、Diff、日志、报告等原始工件的可核验引用 |
| MissingCapability / MissingKnowledge | 否 | 规划阶段的缺口占位，未解决时禁止正式派发 |

关系线分为：`dependency`（执行先后）、`data-binding`（字段映射）、`knowledge-read`（知识引用）、`knowledge-produce`（候选知识产出）、`observation-control`（检查点影响的后继）。同一对节点存在多种关系时使用一条可展开的复合边，避免平行线过多。

拖动输出端口到输入端口时弹出映射：源 Schema 字段、目标 Schema 字段、类型兼容、是否必需、缺失策略、条件与转换需求。连接知识卡片时改为配置知识版本策略、作用域、required/optional 和查询条件。所有映射由后端编译器校验；不支持类型时提示插入显式转换能力，不让 Agent 猜测。

## 4. 原子能力：一个方框，三层身份

### 4.1 CapabilityDefinition

定义业务边界、`inputSchema`、`outputSchema`、`operatingInstructions`、验收标准、`sideEffect`、版本/发布状态。可从自然语言、已有 Skill、源代码或资料生成 candidate。能力定义本身不等于一个永远在线的 Agent 进程。

### 4.2 ExecutionProfile

定义使用 Codex/OpenCode 或 Program/Manual/MCP 等 Runner、模型、零到多个 Skill、MCP grants、`workspaceMode`、`workspaceSubdir`、资源/时间/费用限制。一次 Agent-backed 调用解析为**一种有效 Agent 后端、一份 Profile、一份 cwd**。手动、程序、MCP 节点显示相应 Runner，不人为绑定一个假的 Agent。

### 4.3 NodeBinding / Invocation

当前图中的节点实例绑定能力版本、有效 Profile、输入、知识需求、cwd 与上下文。`CapabilityInvocation` 表示一次真正的执行，保存调用/结果/副作用。多个节点可复用相同 `CapabilityDefinition`，但实例 ID、输入、会话、执行证据彼此独立。

默认节点卡片显示：标题、状态、Agent 或 Runner、cwd 相对路径、Skill 数量、知识输入数量、工件数量、副作用标记。点击后右侧 Tab：`概览`、`输入与知识`、`执行与 CLI`、`输出与证据`、`变更历史`。

### 4.4 创建与修改能力

- 空白画布双击/拖入“新建原子能力” → 输入目标、可选资料、代码路径、Skill、知识。
- 复用现有 Capability Builder 生成 candidate、输入输出、建议 Profile、样例与测试。
- 经人工审查、有效样例/测试、权限确认后 `candidate → validated → published`，再成为可执行节点。
- AI 规划遇到缺口可显示候选占位并自动提出构建草案，但未发布能力不能直接执行。
- 用户希望**修改能力本身**时，在 `Capability Development Session` 中创建新候选版本；原有运行引用旧的冻结版本，不静默升级。

## 5. Agent Workspace：点击节点进入 CLI

### 5.1 三种操作入口

1. **查看执行回放**：只读看日志、工具事件、输入输出、执行证据，无 CLI 写入。
2. **继续协作**：在节点有效 cwd、授权 Profile、Skill 与上下文快照下启动**新的受控交互式** Codex/OpenCode CLI，可在终端中调查或修改。
3. **开发原子能力**：在独立能力候选环境里修改契约/Skill/Profile/样例，经验证再发布新版本。

首版**不能宣称附着到已结束的非交互式 CLI 内部会话**；现有自动 Codex/OpenCode 调用运行后退出。新的交互式终端需要独立的会话管理，使用冻结的节点上下文重建协作环境；若将来供应商 CLI 有可靠恢复协议，再增加适配。

### 5.2 UI 行为

点击方框 → 展开右侧 Agent Workspace（Agent/模型/Profile/cwd/Skill/上下文版本）→ 点击 `进入 CLI` → 在右侧停靠、底部停靠或全屏终端中操作。支持切回画布、查看当前节点位置、断线重连、停止会话、查看修改文件和 Diff。

CLI 会话结束后先进入**变更核对**：工作区摘要、Git Diff、执行过的授权验证、工件、外部副作用、人工说明。可选 `接纳并重新验证`；不能仅凭退出码或“Agent 已完成”宣布节点业务成功。接纳后计算下游影响，必要时生成新 PlanRevision。

### 5.3 CLI 会话状态

`created → ready → attached ↔ detached → closed/failed/needs-reconciliation`。

WebSocket 断开不等于终端进程停止；需管理 Session TTL、心跳、输出游标、重连、最大进程数、显式停止及进程树结束证明。若控制器崩溃或副作用不确定，保留锁并进入核对状态，不能自动开放新写入者。

### 5.4 技术路径

前端可使用 xterm.js；后端 `AgentSessionManager` 通过受控 PTY 启动预定义 Codex/OpenCode CLI，使用独立鉴权/会话令牌的 WebSocket 传输终端输入输出。必须独立于自动调用通道：自动调用负责结构化结果，交互式 CLI 负责人的进一步协作。禁止暴露任意操作系统 Shell 或任意可执行文件启动接口。

## 6. 工作目录、Worktree 与 Skill

默认一个 Run 对应一个共享 Git Worktree；每个节点有**确定的 cwd**，可指向该 Worktree 内子目录，多个节点也可在相同目录执行。只读并行可以共享；写入必须持有工作区锁，不能让两个自动/人工 Agent 同时写同一工作区。明确独立的并行写分支可分配独立 Worktree，但合并应有显式节点与审查步骤。

节点运行记录、上下文清单、CLI 元数据、事件保存在平台受控数据目录，不能默认写进用户仓库。`cwd` 由项目授权根、Run Worktree、Profile 子路径确定性解析，检查路径越界、符号链接与实际目录。Skill 以引用而非复制为主，运行冻结其已授权的版本/摘要；CLI 不得继承未授权的全局插件、MCP 或执行权限。

## 7. 规划包含能力流、数据流、知识流与环境计划

Planner 必须同时给出：

1. **Execution Plan**：节点、依赖、分支、Agent/Profile、质量门、观察点。
2. **Information Plan**：精确字段绑定、工件引用、类型与缺失策略。
3. **Knowledge Plan**：节点需要什么知识、来源、版本、是否必需、何时提炼/验证/沉淀。
4. **Environment Plan**：工作目录、Skill、MCP、只读/写入策略与预算。

知识应分三层：`Run Context`（临时执行信息）、`Task Knowledge`（当前任务证据/决定/假设）、`Reusable Knowledge`（经审核发布的项目/能力/全局资产）。不要混淆原始 `Artifact`、结构化 `DataOutput` 与带证据的 `KnowledgeClaim`。

每个节点声明 `knowledgeInputs`（固定引用/检索/上游产出、required、版本策略和范围）与 `knowledgeOutputs`（事实/假设/技术决策/经验模式、去向、验证条件）。运行时由 `ContextAssembler` 检查权限、实际解析版本、检索最相关的知识并保存 `ResolvedContextManifest`，包含真实的 knowledge ID、版本、内容摘要、查询、工件引用与省略原因。必需知识缺失或超预算必须明确阻断，不静默截断。

知识生命周期建议：`observed → candidate → verified → published → superseded/revoked`。KnowledgeCurator 可以在阶段中提炼候选，按证据、适用条件、冲突和重复情况审核；不能将 AI 推测自动发布为已证实的全局事实。新任务仅复用可授权访问且适用条件匹配的知识，保留来源和反证。

## 8. 动态观察与重规划

触发可以来自 Observation/Evaluator 的 `REPLAN`、用户主动修改、知识失效、环境变化、失败、数据不匹配。不是简单重画整张图，而是：

1. 保存触发原因、证据、旧 PlanRevision 和候选受影响节点。
2. 确保处于安全切换点；运行中的调用与待审批/不确定副作用不能直接热替换。
3. Planner 生成 `PlanDraft vN+1`（能力/数据/知识/环境四类变化）。
4. `ImpactAnalyzer` 根据节点定义、Profile/Skill、上游字段/工件摘要、实际使用知识/工作区状态计算影响闭包。
5. `PlanDiffService` 输出新增、删除、修改、失效、保留的节点/边/知识引用及理由，画布提供“旧版/新版/只看差异/受影响下游”。
6. GraphCompiler 校验 DAG、知识、授权、测试审查与副作用；必要时人工审批。
7. 以预期 revision 的 CAS/数据库事务**原子提交新版本**，保留旧执行、工件和证据；未变节点位置不跳动。
8. 只对真正满足依赖未变条件的已成功节点复用结果，受影响下游重新执行。

已经发生的 `workspace-write` **或 `external-write`** 不可因图重规划被删除或重放；必须保留执行事实，后续需要修复时新增补偿/修复节点。CLI 修改后的接纳同样走影响分析与重新验证。未确定的外部写入先人工核对，不能重复执行。知识版本变化可能影响结果复用，但不能仅凭 AI 判断旧证据“没有变化”。

## 9. 完整用户场景与验收动作

| 场景 | 用户交互 | 预期行为 |
| --- | --- | --- |
| 创建单个能力 | 画布新建方框 → 自然语言目标 → 选择 Agent/cwd/可选 Skill | 生成候选、审核 Schema/权限、测试、发布后复用 |
| AI 自动规划 | 输入目标、项目、约束、验收 → 点击规划 | 绘制 DAG，明确 Agent、知识/数据/环境契约和观察点 |
| 能力缺口 | AI 标注“缺少 OpenJ9 分析能力” | 生成受控 Builder 候选；验证前不得派发 |
| 知识缺口 | 节点显示缺少项目 GC 参数 | 读取授权文件或新增取证步骤，不伪造信息 |
| 连线映射 | 从 A 输出拖到 B 输入 | 弹出字段/类型/依赖/知识规则，后端校验 |
| 检查节点知识 | 点击节点 `知识` | 对照计划知识与实际命中、版本、来源及下游消费者 |
| CLI 人工介入 | 点击失败节点 → 安全暂停 → 进入 CLI | 正确 Agent/cwd/Skill/上下文，写锁与审计；结束后 Diff/核对/接纳 |
| CLI 优化能力 | 点击 `开发能力新版本` | 克隆 candidate、验证、发布，不修改当前已运行版本 |
| 观察重规划 | 测试失败触发 REPLAN | 显示旧/新版本、知识变化及下游受影响范围，安全提交 |
| 任务中途知识沉淀 | 选中诊断节点输出 → 提炼 | 候选知识带证据、来源与适用条件，审核后发布 |
| 跨任务复用 | 新建相似任务 | Planner 说明过去哪些经验被引用、为什么适用 |
| 冲突知识 | 并行节点给出相反结论 | 标记冲突、增加证据核验，不以“最新”覆盖 |
| 失联/崩溃 | CLI 断连或工作进程意外结束 | 保存工作区与锁、核对副作用后恢复，不盲重试 |

### 9.1 示例：K8s Java OOM

用户下发“分析 OpenJ9 服务 OOMKilled，验证可能原因、提供修复与测试，并沉淀可复用排障知识”。AI 画布规划：`GC 日志收集` 与 `cgroup/POD 证据收集` 并行 → `联合诊断` → `假设验证` → `修复` → `测试` → `审查` → `交付`。引用 JVM 资料、项目部署约束和已发布历史经验。若缺少专用 GC 解析能力则产生候选占位。

用户可点击 `联合诊断` 进入 Codex/OpenCode CLI，在其受控 cwd 检查证据或补充判断；退出后核对修改。发现新证据，观察点重规划后续验证/修复，不重复已发生的写入。交付阶段将“诊断假设/证据/适用条件/反证”提炼为项目知识候选，后续任务按权限复用。

## 10. 建议领域模型（目标设计，非当前代码）

~~~ts
type GraphPlan = {
  id: string; taskId: string; revision: number;
  nodes: GraphNode[]; edges: GraphEdge[];
  rationale: string; expectedBaseRevision?: number;
};
type GraphNode = {
  id: string;
  kind: "capability" | "observation" | "knowledge-ref" | "artifact-ref" |
        "missing-capability" | "missing-knowledge";
  capabilityRef?: string; profileRef?: string;
  dataInputs?: DataBinding[];
  knowledgeInputs?: KnowledgeRequirement[];
  knowledgeOutputs?: KnowledgeOutputPolicy[];
  workspace?: { policy: "run-shared" | "isolated"; subdir: string };
};
type GraphEdge = {
  id: string;
  kind: "dependency" | "data-binding" | "knowledge-read" |
        "knowledge-produce" | "observation-control";
  fromNode: string; fromPort?: string;
  toNode: string; toPort?: string;
};
type DataBinding = {
  inputField: string; fromNode: string; outputField: string; required: boolean;
};
type KnowledgeRequirement = {
  source: "pinned" | "query" | "node-output";
  ref?: string; query?: string; required: boolean;
  versionPolicy: "pinned" | "resolve-at-start";
};
type KnowledgeOutputPolicy = {
  kind: "fact" | "hypothesis" | "decision" | "pattern";
  destination: "run-context" | "task-knowledge" | "knowledge-candidate";
  evidenceRequired: boolean;
};
type ResolvedContextManifest = {
  runId: string; nodeId: string; invocationId: string;
  capabilityDigest: string; profileDigest: string; skillDigests: string[];
  cwdRef: string; inputDigest: string;
  artifactInputs: Array<{ref: string; digest: string}>;
  knowledgeHits: Array<{id: string; version: string; digest: string}>;
};
type AgentWorkspaceSession = {
  id: string; runId?: string; nodeId?: string;
  capabilityRef: string; profileRef: string;
  agent: "codex" | "opencode"; cwdRef: string; contextManifestRef: string;
  mode: "inspect" | "interactive-read" | "interactive-write" | "capability-development";
  status: "created" | "ready" | "attached" | "detached" | "closed" |
          "failed" | "needs-reconciliation";
  workspaceDigestBefore?: string; workspaceDigestAfter?: string;
};
~~~

注意：`GraphPlan` 是规划权威，画布坐标/缩放/展开存 `CanvasLayout`，不决定执行语义；`KnowledgeRefCard` 与 `ArtifactRefCard` 并非自动执行节点；运行中的 `ResolvedContextManifest` 才是复用与审计的事实依据。节点级工作区策略需后端授权解析，与现有 Profile 规则兼容。

## 11. 组件与接口规划

新增/扩展组件：

- `GraphCompiler`：画布编译为现有 DAG；字段、知识、能力/Profile、权限、质量门和预算校验。
- `ContextAssembler`：按节点知识契约准备最小且可追溯的上下文。
- `AgentSessionManager`：受控 PTY/CLI 进程、连接、超时、锁、退出核对和恢复。
- `KnowledgeCurator`：从证据中提出知识候选、去重、冲突和版本演化。
- `ImpactAnalyzer` 与 `PlanDiffService`：重规划影响计算、差异预览和安全提交。
- `CanvasProjection`：事件/Invocation/知识/工件映射为 UI 状态，断线按事件序号补齐。

| 现有位置 | 改造 |
| --- | --- |
| `apps/web/src/AdaptiveBoard.tsx` | 拆分画布、资源库、节点检查器、Agent Workspace、历史视图 |
| `packages/adaptive/engine.ts` | 扩展知识契约、GraphPlan 编译、重规划保护与人工接纳 |
| `packages/adaptive/assets.ts` | 知识来源/契约、能力版本与生命周期扩展 |
| `packages/adaptive/runtime.ts` | 生成上下文 Manifest，解析有效 Agent/cwd/Skill 快照 |
| `packages/runtime/` | 新增会话 PTY、锁和进程生命周期管理 |
| `apps/server/app.ts` | GraphPlan、PlanDiff、CLI Session、Context、知识候选 API |
| `packages/persistence/` | 图草案/布局、CLI 会话、上下文清单、知识关系及审计 |
| `tests/` | UI E2E、权限拒绝、CLI 崩溃/恢复、重规划不变式 |

前端初选 `@xyflow/react` + ELK.js 自动布局、xterm.js 终端。实际实施时检查库版本/许可/体积/浏览器兼容性；不能因为有 React Flow 就把 GraphCompiler 放到前端。

建议新增 `/api/v3/graph-plans`（草案/编排/校验）、`/api/v3/runs/:id/graph`（运行投影）、`/api/v3/runs/:id/replan-preview` 和 `commit-replan`、`/api/v3/agent-sessions`（会话建立/状态/停止/核对/接纳）、`/api/v3/runs/:id/nodes/:nodeId/context`（脱敏上下文清单）、`/api/v3/knowledge-candidates`。**这些均是拟议接口，目前不可调用。**优先复用已有 `/api/v2` 的能力、知识、执行、审批与预算 API。

## 12. 安全与一致性原则

1. Agent/Skill/外部文档都是不可信内容；不能将文件文字当作平台授权。
2. CLI 只允许可信 CLI 适配器，不允许任意 shell；服务端会话要强认证、授权范围、连接重试与超时。
3. CLI 的权限不应大于当前节点 Profile；项目外文件、未经授权 MCP、网络、命令及工作区写入必须阻断。
4. 同一工作区写入互斥；进程失联不能自动解除写锁，必须证明停止并核对副作用。
5. 退出 CLI 不等于节点成功；人工接纳后仍需按照 DAG 重新验证测试/审查。
6. 已成功的 `workspace-write` 和 `external-write` 不因 PlanRevision 删除历史事实；不确定结果不得自动重试。
7. 运行中冻结能力、Profile、Skill、知识版本与输入摘要；知识更新不静默污染旧证据。
8. 知识的事实/假设/推断与验证状态明确区分，项目范围、权限和冲突不能忽略。
9. 画布 UI 不作为权威；后端状态机、事件顺序、事务与 CAS 才决定执行。
10. Token/成本、PTY 输出、日志和工件可能包含敏感信息；需要最小展示、脱敏、审计保留策略。
11. 工作区、cgroup 和临时 CLI 配置不是强隔离证明；真实 Linux 目标机需做外部工具和崩溃场景验收。

## 13. 分阶段开发与验收

| 阶段 | 交付 | 最小验收 |
| --- | --- | --- |
| P0 画布基础 | V2 DAG 只读渲染、节点状态、观察点、日志/工件、布局 | 同一 Plan 的结构语义无损；状态来自后端 |
| P1 可编辑图与知识 | 拖拽/连线、知识端口、Schema 与知识校验、ContextManifest | 无环/类型/必需知识/授权/交付门槛均可验证 |
| P2 Agent CLI | 节点 Agent/cwd/Skill 下钻、受控 CLI、暂停/锁/核对/接纳 | Linux 上真实“暂停→CLI 修改→接纳→测试/审查→恢复”闭环 |
| P3 动态规划与重规划 | AI 缺口占位、Builder 集成、PlanDiff、影响闭包、CAS | 已完成写入不能被删除/重放；知识变化正确影响下游 |
| P4 知识演化 | 中途候选、证据/冲突、审核发布、跨任务复用 | 未验证事实不发布、引用来源可追溯、权限一致 |
| P5 高级功能 | 子流程、复杂分支、性能、恢复与端到端强化 | 大图仍易操作，进程失联与历史回放可验证 |

必须覆盖的测试：同一能力多实例、错类型映射、跨项目知识越权、候选未发布不可执行、并行写锁、CLI 断连与崩溃、用户改文件后的核对、已完成写入重规划、知识冲突/撤销、真实 Codex/OpenCode 版本适配和运行预算。

## 14. 当前 main 事实与待完成差距

| 领域 | V2 已有 | Canvas V3 待做 |
| --- | --- | --- |
| 能力与 Profile | Capability Registry、Codex/OpenCode、Skill 引用、cwd 子路径策略 | 画布能力实例、Agent Workspace 与会话 |
| 执行 | DAG/Observation/PlanRevision、运行审计、任务级 Worktree、停止/核对 | PTY、CLI 终端、节点下钻、会话停止/变更接纳 |
| 知识 | Knowledge Hub、版本/作用域/绑定、执行时检索 | 每节点知识契约、Context Manifest、知识演化与影响分析 |
| UI | 表单、JSON 计划、节点/事件列表 | 同画布设计/运行/回溯、连线编辑、差异高亮 |
| 重规划 | 成功结果条件复用、已完成代码写入保护 | 外部写入同等保留、知识依赖、PlanDiff 和安全事务 |

已核对当前 OpenCode 自动适配采用非交互式 `run --standalone --format json --archived`；新增 Web CLI 需要真正的 PTY 和会话协议，不能仅把日志放在黑色窗口冒充终端。

当前 `engine.ts` 对成功 `workspace-write` 的保留有显式检查，但应将 `external-write` 的重规划不可重放/补偿保护提升到同等等级。当前运行时会注入祖先节点结果和授权知识，需逐步迁移为按节点契约最小化上下文。

### 待定产品问题

- 首期 CLI 只读旁观是否对运行中的节点开放？建议开放只读回放；写入必须安全暂停。
- 并行写入何时分离 Worktree？建议按显式分支需求，而非默认每节点独立。
- 自动生成只读能力何时可以自动发布？建议首版仍审核；后续在独立授权策略下讨论。
- 中间知识候选是否自动生成？可以，**发布始终独立**。
- V2 到 V3 的历史迁移？建议旧 Run 只读投影，不热迁状态机。

---

## 15. 与其他设计文档的关系

- [V1 完整设计稿](./AI-Work-OS-设计稿-v1.0.md)：平台总体方向。
- [V2.1 自适应架构](./AI-Work-OS-自适应原子能力架构方案-v2.1.md)：能力、知识、执行与重规划的已有设计基线。
- [V2 实现说明](./自适应工作流V2实现说明.md)：当前代码、API、运行约束和已知限制。
- **本方案**：统一画布 + Agent CLI + 知识流转 + 安全重规划的下一阶段设计基线，不代表已经实现。
