# AI Work OS：自适应原子能力与知识驱动工作流架构方案 V2.1

> 状态：架构设计提案（Design Proposal）  
> 更新日期：2026-11-11  
> 主要目标环境：Linux（优先单机、后续可扩展分布式）  
> 面向对象：软件开发、故障诊断与其他可验证的工程任务  
> 本文定义目标架构与实施次序，不代表全部功能已经实现。

## 0. 执行摘要

AI Work OS 的目标是：接收用户任务及验收标准，利用**编排原子能力**从能力注册表选择可复用能力，结合授权知识生成**执行 DAG 与阶段观察策略**，经确定性校验后由事件驱动调度器按需调用**执行原子能力**。到达关键阶段或发生异常时，按观察策略调用**进度评估能力**，必要时受控重编排尚未完成的工作流。交付后把可验证的执行结果沉淀为知识及能力改进候选。

核心公式：

**Task + Capability Registry + Knowledge Hub → PlanRevision + ObservationPolicy → Event Scheduler → CapabilityInvocation → Artifact / Evidence → Evaluation / Replan → Delivery / Learning**

基本原则：

1. **智能与控制分离**：Agent 负责提出规划、评估与改进建议；状态转换、权限、锁、预算、契约校验和持久化提交由确定性程序执行。
2. **能力与执行配置分离**：Capability 描述“做什么”和输入输出；ExecutionProfile 描述“用哪个 Agent、Model、Skill、MCP、工作目录策略来做”。
3. **知识独立管理**：全局、项目、能力、任务知识是具备来源、版本、权限与生命周期的资产，不是散落在 Prompt 中的自由文本。
4. **工作流可变，历史不可覆盖**：每次重规划形成新 PlanRevision，历史调用、工件和证据保留。
5. **执行器非持续会话**：一个 Invocation 可只运行一个能力，完成即退出；持久化控制面负责推进跨小时或跨天的任务。
6. **全行为基础留痕、复杂分析后置**：从 P0 开始保持可靠事件与工件索引，完整监控大屏及自动优化放到 P3。
7. **安全不由 Skill / Agent 提权**：能力、知识、文件、MCP、网络、脚本和外部副作用的使用均受平台授权。
8. **不要宣称已有并行执行**：当前代码中的 Worker 仍按拓扑序串行执行；并行调度属于后续演进。

## 1. 产品定位与边界

### 1.1 目标

- 面向开发任务、故障诊断、重构、验证、代码审查等工程任务，支持自然语言任务下发和可核验的成果交付。
- 用户可以人工创建能力、知识、执行配置与工作流，也可以从现有 Skill 智能生成候选能力。
- 一项任务下发后，由编排 Agent 组装能力 DAG，且明确标记**在哪些阶段必须观察执行进度**以及哪些异常事件会触发观察。
- 每个能力具备机器可验证的输入输出契约、独立执行记录、权限和失败策略。
- 运行中根据实际证据决定继续、重试、等待、暂停或重新编排。
- 沉淀经验与能力候选，以证据和评估为依据持续迭代。

### 1.2 首期非目标

- 不要求把所有任务交给完全自主 Agent，无条件自动批准高风险执行。
- 不要求原生支持任意循环与无限重规划；先支持有界 DAG 和显式观察/变更。
- 不要求首期引入 Kafka、Temporal、分布式 Worker、跨机器共享 Worktree。
- 不要求首期完成全量调用链大屏或自动优化发布。
- 不把 Skill 自动转换的 AI 推断当作真实可用的确定性接口；候选能力必须验证。
- 不宣称 Worktree 或 Linux cgroup 本身已提供完整的网络、凭据和外部工具安全沙箱。

## 2. 分层架构与职责

~~~mermaid
flowchart TD
    T[任务入口 Task] --> P[编排能力 Planner]
    CR[能力注册表 Capability Registry] --> P
    KH[知识中心 Knowledge Hub] --> P
    P --> WD[执行 DAG 与观察策略]
    WD --> VC[工作流编译和安全校验]
    VC --> ES[事件驱动调度器]
    ES --> IV[单节点能力调用 Invocation]
    CR --> IV
    KH --> IV
    IV --> AR[结果与工件 / 证据]
    AR --> ES
    ES --> OC{命中观察策略?}
    OC -->|否| ES
    OC -->|是| EV[评估能力 Evaluator]
    EV -->|CONTINUE| ES
    EV -->|REPLAN| RP[重规划能力 Planner]
    RP --> VC
    EV -->|WAIT / STOP| WS[等待或终止]
    ES --> DL[成果交付与验收]
    AR --> EH[事件与审计历史]
    EV --> EH
    DL --> EH
    EH --> LC[知识提取与优化候选]
    LC --> KH
    LC --> CR
~~~

| 分层 | 主要组件 | 决策权限 |
| --- | --- | --- |
| 资产层 | Capability Registry、ExecutionProfile、Skill Source、Knowledge Hub、Workflow Template、Artifact Store | 版本发布、范围、授权 |
| 智能层 | Planner、Progress Evaluator、受控 Replanner、经验提取 Agent | 提出候选计划与建议，不直接变更运行中的权威状态 |
| 控制层 | 编译器、策略引擎、工作流状态机、Observation Engine、Event/Outbox、恢复协调器 | 验证、提交状态、派发、限额、锁与审计 |
| 执行层 | Agent Runner、Program Runner、MCP Adapter、Human/External Event Adapter | 只运行所授权的单次能力调用 |
| 治理层 | 证据、指标、执行历史、候选评估、灰度发布与回滚 | 根据可验证结果改进资产 |

**设计约束**：编排能力、评估能力本身也属于 Capability，可通过相同的 ExecutionProfile 和 Invocation 协议执行，但仅获授执行其职责必需的权限。

## 3. 原子能力模型

### 3.1 定义与分类

Capability 是具有明确业务语义、版本、输入输出契约、独立可调用行为和结果验证规则的最小可复用操作。最小不意味着只能完成一条指令；关键是边界清晰、结果可验证。

- 业务执行能力：需求分析、代码检索、代码修改、测试、代码审查、文档交付、故障诊断。
- 控制认知能力：初始编排、进度评估、重规划提案。
- 外部交互能力：受限 MCP 调用、人工审批、等待外部 webhook / 定时事件。
- 组合能力：可把已经发布的子工作流封装为 Capability，但必须声明其权限与副作用上界。

### 3.2 核心实体

| 实体 | 必备字段 | 说明 |
| --- | --- | --- |
| CapabilityDefinition | id、version、name、description、inputSchema、outputSchema、sideEffectClass、status | 稳定业务契约 |
| ExecutionProfile | id、version、executorType、agent、model、skillRefs、mcpGrants、workspacePolicy、limits | 实现与资源配置；可分离升级 |
| CapabilityBinding | capabilityRef、allowedProfileRefs、defaultProfileRef、projectScope | 把能力绑定到允许的配置集合 |
| CapabilityInvocation | id、runId、planRevision、nodeId、attempt、inputDigest、effectiveProfileDigest、lease、status | 一次可独立恢复的调用 |
| CapabilityResult | executionStatus、businessStatus、output、artifacts、evidenceRefs、metrics、error | 不把“工具成功返回”混同“业务通过” |
| Artifact | id、kind、uri、sha256、size、acl、retention | 大文本/日志/文件通过引用交换 |

建议的声明式能力定义：

~~~yaml
id: code.review
version: 1.0.0
name: 代码变更审查
inputSchema: schemas/code-review-input.json
outputSchema: schemas/code-review-output.json
sideEffectClass: read-only
allowedProfiles:
  - review-reasoning@2
outputValidation:
  requireEvidence: true
  requireBusinessVerdict: true
status: published
~~~

示例 ExecutionProfile：

~~~yaml
id: review-reasoning
version: 2
executorType: agent
agent: codex
model: configured-reasoning-model
skillRefs:
  - external-skill://source/relative/path#sha256
mcpGrants:
  - server: code-search
    actions: [read]
workspacePolicy:
  mode: read-only
  source: run-worktree
limits:
  timeoutSeconds: 600
  maxTokenBudget: 20000
  maxCostUsd: 2
~~~

上面 model 与 skillRef 为配置示例，实际必须校验模型可用性、Skill 来源完整性与执行器权限；禁止将配置文本直接当作授权。

### 3.3 输入输出契约

- 节点输入是显式 inputBindings，从 Task 参数、知识检索结果、ArtifactRef 或已完成节点输出中取值。
- 编译阶段检查静态 Schema 兼容、必需字段和可达性；执行阶段还必须校验实际 JSON 输出。
- 大型工件保留为带摘要和访问控制的 ArtifactRef，不在节点之间复制大量日志或仓库内容。
- 区分 executionStatus（执行基础设施成功/失败）与 businessStatus（业务接受/拒绝/不确定）。
- 错误标准化为 transient / permanent / policy_denied / uncertain_side_effect / validation_failed，决定不同恢复策略。
- 知识、Skill 和任务输入属于不可信上下文，不能覆盖授权策略与系统约束。

结果示例：

~~~json
{
  "invocationId": "inv-123",
  "executionStatus": "succeeded",
  "businessStatus": "rejected",
  "output": {"approved": false, "findings": [{"severity": "high", "evidenceRef": "artifact://review-1"}]},
  "artifacts": [{"ref": "artifact://review-report", "sha256": "..."}],
  "metrics": {"durationMs": 42000}
}
~~~

## 4. 基于已有 Skill 智能生成原子能力

### 4.1 核心原则

**Skill 是实现资源；Capability 是经过验证、可被工作流消费的标准业务接口。** 二者不是一一对应：一个 Skill 可生成多个能力，一个能力也可引用多个 Skill。

外部 Skill 优先采用**引用而非复制**：记录来源、相对路径、内容摘要、版本/校验信息。运行时访问辅助资源需通过明确授权与访问机制，不能因为扫描到文件就自动挂载脚本、扩展 Agent 权限。

### 4.2 智能转化流水线

1. **发现**：用户注册本机 Linux Skill 目录；扫描 SKILL.md、metadata、references、scripts、assets；记录来源及变更摘要。跳过未经授权的符号链接及越界路径。
2. **理解**：Skill Analyzer Agent 从文档中识别用途、前置条件、适用场景、示例、依赖工具、可能副作用与失败模式。
3. **候选合成**：生成一个或多个 CapabilityDefinition、输入输出 JSON Schema、建议的 ExecutionProfile、最小权限需求和测试用例。
4. **静态校验**：检查 Schema、名称/版本冲突、引用可用性、依赖清单、工具权限和脚本安全策略。
5. **动态验证**：在受控环境使用合成案例及真实可授权样例验证输出契约、可重复性、失败行为和副作用。
6. **用户确认 / 发布**：候选状态 candidate → validated → published；不能跳过权限确认直接上线。
7. **变更检测**：来源 Skill 发生变化，只生成新候选与验证请求，不静默修改已发布能力或既有 Run 快照。

### 4.3 用户交互

在“能力中心”支持**导入 Skill 目录 → 查看扫描结果 → AI 生成候选能力 → 查看/修改输入输出和执行配置 → 运行验证 → 发布**。

AI 推断的输入输出仅为候选，必须明确标识“推断、未经验证”；权限范围必须显式确认。若 Skill 无稳定机器接口，允许将其声明为“需人工验证的半结构化能力”，而不是伪造强类型契约。

## 5. Knowledge Hub：全局与能力可访问的知识管理

知识管理是与 Capability Registry **并列的一等核心资产层**，允许用户主动创建和维护。知识不是自动注入所有 Prompt 的全文缓存。

### 5.1 作用域与类型

| 作用域 | 例子 | 默认访问边界 |
| --- | --- | --- |
| global | 通用工程规范、通用故障经验、全局能力说明 | 仅被策略允许的调用可访问；global 不代表无条件公开 |
| project | 仓库架构、ADR、业务规则、安全约束 | 指定项目与经授权的能力 |
| capability | 某个诊断能力的标准操作规程、参考案例 | 指定 Capability 或能力族 |
| task | 当前任务证据、临时决策、调查笔记 | 当前任务及授权的关联执行 |
| derived | 从任务执行提取的模式与经验 | 候选验证后才能扩大可见范围 |

知识形式至少覆盖 Markdown 文档、结构化条目、外部文件引用、代码/文档索引和带证据的经验条目。后续可增加语义向量检索，但不应把向量数据库作为首期的唯一存储模型。

### 5.2 知识资产实体

~~~yaml
id: knowledge-java-oom-guide
title: Java 内存故障诊断指南
scope: global
kind: troubleshooting-guide
version: 1.0.0
status: published
source:
  type: user-authored
  provenanceRefs: []
tags: [java, oom, jvm]
acl:
  allowedCapabilities: [java.oom.analyze, java.performance.diagnose]
bindingDefaults:
  mode: on-demand
lifecycle:
  reviewAfter: null
~~~

建议包含：owner、createdAt、updatedAt、source、evidenceRefs、checksum、status、effectiveFrom、reviewAfter、ACL、tags、conflictsWith、supersedes；需要区分“作者声明”“已核实事实”“Agent 推断”和“过期/有争议”的内容。

### 5.3 用户操作

支持创建、编辑、导入、外部引用、分类、搜索、版本化、发布、撤销、归档、查看引用关系与权限、将知识绑定至特定 Capability、指定检索方式。

首期搜索可先使用 metadata 与全文索引；需要时再引入分块、关键词/语义混合检索与重排序。

### 5.4 Knowledge Binding 与使用策略

| 模式 | 含义 | 示例 |
| --- | --- | --- |
| required | 执行前必须得到指定知识版本，缺失则阻塞 | 安全审查规范 |
| retrieve-on-demand | 根据输入和查询选择相关内容 | 既往 OOM 故障 |
| optional | Agent 经允许按需请求 | 通用调优文章 |

每次知识获取应记录查询摘要、作用域、权限决策、返回条目 ID/版本/内容摘要及可追溯引用。不要默认将所有 global 知识注入模型，防止上下文膨胀与敏感信息越权。

运行准备时冻结**知识绑定规则及所选必需版本**；按需检索的查询与实际返回结果在 Invocation 层记录快照，以便后续解释某一步为什么采用该知识。历史知识修订不能静默改变已完成的执行证据。

### 5.5 知识安全与冲突

- 用户手工创建可草拟/发布，但高影响的全局知识应支持复核。
- AI 生成的知识先进入 candidate，附来源与证据；不能把模型的猜测直接标为事实。
- 项目知识不能因 global 检索入口而泄露给无权访问的项目/Agent。
- 任务的临时认知不能覆盖平台强制权限与安全规则。
- 多个知识版本存在冲突时显式返回冲突/不确定性，并引导评估，不依赖简单“最新覆盖旧版”。

## 6. 初始智能编排：生成工作流与观察策略

### 6.1 任务输入

Task 下发至少包含 title、objective、acceptanceCriteria、project、constraints、budget、optionalFlowRequirements。可以额外指定优先能力、禁止使用的工具、可接受的副作用类型与截止条件。

编排 Agent 读取**用户授权的** Capability Catalog、匹配知识、项目上下文和平台策略，输出：

1. ExecutionPlan：节点、capabilityRef、profileRef、inputBindings、dependsOn、条件、失败策略、结果绑定。
2. ObservationPolicy：何时、以何种事件和阈值启动评估能力；观察是阻塞还是建议。
3. Rationale：关键选择依据、风险、不确定性、预期成本及请求用户确认的事项。

### 6.2 计划规范与校验

- 能力/配置版本存在并已发布，项目及调用者有访问权限。
- 所有必需输入可从任务或前驱输出绑定，Schema 兼容。
- DAG 无环、无悬空依赖、终态交付可达；条件分支与汇合有明确语义。
- 软件开发任务的必要测试、审查与交付门槛不可由 Agent 删除；诊断流程不可伪造确认根因。
- 敏感写入、外部发布、远程变更须满足人工批准和副作用账本要求。
- 编排能力只能从授权的 Capability Registry 选择；能力缺失可提出建议，不能创建一个未审批能力后立即执行。
- 设置节点数、最大深度、token/费用/时间预算、可重规划次数上限。

不通过编译的计划应返回结构化错误供 Planner 修正或人工处理，**不能直接派发**。

## 7. 关键阶段观察点与受控重规划

### 7.1 观察策略必须在初始编排时确定

Planner 不只回答“先做什么”，还需回答“执行到哪里应该重新评估计划”。

观察规则包括：

- **计划观察点**：需求分析后、可行性验证后、核心实现后、测试后、交付前等。
- **异常观察点**：失败、超时、关键证据缺失、预算越界、目标偏移、人工反馈。
- **阻塞观察点（barrier）**：后续受影响节点必须等待评估完成。
- **建议观察点（advisory）**：评估不阻断不受风险影响的节点；当评估建议改变计划时仍需安全切换。

失败触发观察必须由**事件订阅/状态转移**唤醒，不能只依赖 DAG 的成功完成依赖，否则失败后评估永远不会运行。

### 7.2 决策输出

~~~json
{
  "checkpointId": "after-test",
  "decision": "REPLAN",
  "reason": "测试结果与初始假设不符",
  "evidenceRefs": ["artifact://test-log-3"],
  "affectedNodeIds": ["fix", "review", "deliver"],
  "suggestedChanges": ["增加根因定位能力", "推迟代码修复"],
  "confidence": 0.78
}
~~~

固定决策枚举：CONTINUE / REPLAN / RETRY / WAIT_INPUT / WAIT_APPROVAL / STOP。由控制面校验决策是否有充分证据以及是否越权；confidence 不是自动授权阈值。

### 7.3 重规划协议

1. 观察事件到达，调度器建立评估 Invocation，获取冻结的运行进度、关键结果和证据引用。
2. Evaluator 仅做判断，若为 REPLAN，生成待重规划请求。
3. 控制面阻断受影响节点的新派发；对正在执行的能力等待完成或确认安全终止。
4. Replanner 读取原计划、执行历史、未完成节点、预算剩余与新证据，输出候选 PlanRevision。
5. 编译器重新校验依赖、权限、必需门槛、结果引用以及节点失效范围。
6. 原子提交新版本与状态变化（事务 + Outbox），重算就绪节点；拒绝修改则保留原状态并请求人工处理。

**已完成节点不被覆盖**；其结果可复用，也可因新证据被标记 invalidated，但不删除历史。修改仅作用于未执行节点及允许重新调度的节点。设置最大重规划次数/成本，防止无限循环。

## 8. 事件驱动调度与按需执行

### 8.1 核心模型

- WorkflowRun：任务的一次运行、当前 PlanRevision、聚合状态与预算。
- NodeRun：当前计划中的节点状态、依赖、结果/工件引用。
- CapabilityInvocation：一次真实能力调用，包含 attempt、执行配置快照、幂等键、租约及输出。
- ExecutionEvent：唯一 eventId、traceId、taskId、runId、planRevision、nodeId、invocationId、type、时间、actor、payloadRef。
- Outbox / DispatchIntent：持久化待派发动作，防止事务提交与进程退出之间丢失任务。
- SideEffectLedger：记录外部写入命令、幂等键、请求指纹、确认状态和必要的补偿/人工核对信息。

### 8.2 最小执行状态机

~~~text
pending -> ready -> queued -> running -> succeeded | failed | waiting | uncertain
                                          |
                                          +-> cancelling -> cancelled

failed -> (policy/observation) retry | replan | wait | stop
uncertain -> reconcile -> succeeded | retry-safe | wait-human
~~~

Agent 按需执行一个 Invocation，返回结构化结果后退出。调度服务可以常驻，但不需要让 Agent 会话跨越整个长任务。

### 8.3 调度算法

1. 持久化任务、已通过校验的计划与观察规则。
2. 事务性计算 ready 节点并写入队列/Outbox。
3. Worker 原子领取 Invocation（租约 + epoch / fencing token）。
4. 按授权配置准备工作区和输入，实际执行 Agent/程序/MCP/人工事件适配器。
5. 校验输出 Schema 和业务结果，将结果及工件索引持久化。
6. 提交状态与事件，并使下一轮调度可被唤醒。
7. 优先评估命中的 barrier Checkpoint，再派发可能受其影响的下游节点。
8. 依赖补偿扫描以恢复通知丢失、Worker 失联等情形。

### 8.4 一致性、幂等和 Linux 安全

- 目标是**至少一次可靠派发 + 幂等处理 + 外部副作用核对**；不承诺所有外部系统提供 exactly-once。
- 只读能力可按策略自动重试；写入能力在超时、崩溃、ACK 丢失时进入 uncertain/reconciling，未确认前不得盲目重放。
- 对共享代码 Worktree 的写节点建立排他锁；多只读节点可使用受控快照。未来并行执行须防止冲突和结果过时。
- Linux 优先验证 cgroup v2/进程树终止、遗留子进程、资源配额、文件系统与网络权限、凭据边界；**cgroup 不等于完整沙箱**。
- 不支持时应保留锁、停止自动推进，进入人工确认路径。
- 保留调用输入摘要、profile/知识/Skill 版本、配置漂移检查和工件校验，支持可解释恢复；无法完全重放外部模型输出时明确承认此限制。

## 9. 知识沉淀、行为留痕与优化

### 9.1 从 P0 就建设最小事件链

“监控与分析”作为 P3 优化建设，但“必要事件记录”是 P0 的可靠性要求。必须留存：创建/修改任务、编排、校验拒绝、能力选型、授权/知识读取、执行状态、工具副作用、工件、观察决策、重规划、验收、知识和能力版本变化。

统一使用 traceId、runId、planRevision、nodeId、invocationId 做关联，事件正文只记录必要元数据与摘要；大型正文放到受访问控制的工件存储。机密、令牌、隐私信息必须脱敏并设计保留/删除策略。

### 9.2 知识提取与能力改进

- 从历史任务提取事实、证据、失败模式、成功路径和候选 Workflow Pattern。
- AI 生成的知识、Skill 改进、Profile 建议、Capability 定义，均以 candidate 状态进入待验证区。
- 评估维度：契约通过率、业务验收率、重试/重规划率、耗时/成本、风险与回归、证据质量。
- 通过不可变测试集、对照实验/灰度等评估后才能发布；旧运行维持原版本快照，支持回滚。
- 将“观察点是否真正改变了决策”“重规划是否带来收益”纳入后期分析，避免无效 Checkpoint 带来额外模型成本。

## 10. 建议的 API 与交互（目标设计，尚非现有全部接口）

### 10.1 用户界面

- **任务中心**：自然语言下发、验收条件、风险/预算、任务级流程偏好、预览 DAG 与观察点、执行历史。
- **能力中心**：创建能力、管理 ExecutionProfile、从本地 Skill 扫描并智能转化候选能力、验证与发布。
- **知识中心**：创建/导入/引用知识、组织全局/项目/能力/任务知识，配置访问授权及 Knowledge Binding，查看使用记录。
- **工作流中心**：管理模板、查看当前 PlanRevision、观察点、重规划差异、人工批准。
- **执行台**：节点状态、当前能力、输出/工件、等待/失败/恢复原因、观察决策。
- **优化中心（后期）**：成功率、成本、能力可靠性、知识质量、改进候选与评估发布。

### 10.2 拟议 API

~~~text
POST   /api/v2/capabilities
GET    /api/v2/capabilities
POST   /api/v2/capabilities/import-skill
POST   /api/v2/capability-candidates/:id/validate
POST   /api/v2/capability-candidates/:id/publish
POST   /api/v2/execution-profiles
POST   /api/v2/knowledge
GET    /api/v2/knowledge
POST   /api/v2/knowledge/:id/publish
POST   /api/v2/knowledge-bindings
POST   /api/v2/tasks/:id/compose
POST   /api/v2/workflows/validate
POST   /api/v2/runs/:id/observations
POST   /api/v2/runs/:id/plan-revisions
GET    /api/v2/runs/:id/events
GET    /api/v2/runs/:id/invocations
~~~

这里只表达资源边界，尚未锁定请求和响应 Schema；版本号 v2 为设计占位，不意味着必须立即更换已有 v1 API。现有鉴权、乐观并发控制、幂等键及错误码应尽量复用。

## 11. 端到端示例：Java OOM 排查与修复

输入：用户要求调查 Java 服务 OOM，明确证据、确认风险并提出可验证修复。

1. Planner 从能力库匹配日志采集、GC/堆分析、Native Memory 分析、根因验证、代码修复、测试、审查和交付能力；从知识中心获取该 JVM/项目适用的知识及历史案例。
2. 生成初始计划：采集日志 → GC/内存分析 → **观察点 A** → 根因验证 → 修复 → 测试 → **观察点 B** → 审查 → 交付。
3. 观察点 A 检查当前证据是否支持初始假设；若发现堆内存证据不足而 Native Memory 更可疑，返回 REPLAN。
4. 调度器冻结受影响后继，Planner 将 Native Memory 和线程调查插入 PlanRevision 2；已采集的证据继续复用。
5. 验证通过后执行修复、运行测试、评估是否满足验收条件；不充分则继续受限重规划或等待用户确认。
6. 交付时提供代码变更、测试报告、证据、历史重规划原因与尚存风险。
7. 经验提取服务生成有来源的 OOM 排查候选知识或 Skill 改进候选，验证后发布。

注意：无实验支持时不能把候选根因描述为“已确认”。在生产环境执行写入或发布动作之前必须经过相应授权。

## 12. 与当前仓库及已提出 PR 的关系

此处描述截至 2026-11-11 核对的状态。以实际 GitHub 分支及 PR 为准。

| 主题 | 当前 main 基础 | 待合并工作 | V2.1 后续目标 |
| --- | --- | --- | --- |
| 任务与资源 | Task、Skill/Knowledge/Workflow 版本、prepare/start、Run manifest | — | Task 到 Capability/Knowledge 的标准绑定 |
| 工作流 | 模板、DAG 验证、暂停后修改计划 | PR #2：任务级标准/compose/graph 流程需求及预览 | Planner 自动选择能力并输出观察策略 |
| Skill | 内部版本资源 | PR #1：外部 Skill 目录扫描及引用 | Skill Analyzer → 候选能力 → 验证发布 |
| 执行 | Worker 当前一次运行按拓扑序串行处理多个节点 | — | 单节点 Invocation、事件驱动 DAG、条件/并行 |
| 事件与恢复 | Event、Outbox、Supervisor、部分进程/运行恢复能力 | — | 调用级租约、外部副作用账本、Linux 崩溃核对 |
| 知识 | 带来源的版本化知识资源 | — | 独立 Knowledge Hub、用户创建、作用域、ACL、Knowledge Binding |
| 优化 | 已有候选评估与发布基础 | — | 执行观察与重规划效果分析，后置高级分析功能 |

相关：
- PR #1（外部 Skill 引用）：https://github.com/Hippop/ai-work-os/pull/1
- PR #2（任务级动态流程需求）：https://github.com/Hippop/ai-work-os/pull/2
- 原有 v1.0 设计稿：./AI-Work-OS-设计稿-v1.0.md
- 实现进度：./代码结构与实现计划.md

**整合注意**：PR #1 和 PR #2 目前为独立草稿，合并时要复核 TaskInput、ResourceService.context、工作流服务和 Web UI 的冲突；不能把尚未合并的设计误记为 main 已实现。

## 13. 分阶段交付计划与验收门槛

| 阶段 | 交付内容 | 最小验收条件 |
| --- | --- | --- |
| P0：资产契约和知识基础 | Capability、ExecutionProfile、ArtifactRef、Knowledge Hub 的 CRUD/版本/ACL、KnowledgeBinding、统一事件 ID | 用户可创建并发布知识；能力可声明/验证输入输出；知识越权读取被拒绝；事件可追踪 |
| P1：Skill 转化与执行解耦 | Skill 扫描引用、AI 生成候选能力、验证发布、单节点 Invocation、持久化派发、Linux 恢复 | 导入现有 Skill 后可审阅候选；单节点断线恢复；不重复危险副作用；旧版本不被覆盖 |
| P2：自适应工作流 | Planner DAG、ObservationPolicy、Evaluator、受控 PlanRevision、输入输出类型校验 | 任务能从自然语言编排；关键节点观察；失败触发重规划；历史可追溯；权限/验收门槛不可绕过 |
| P3：知识闭环与高级分析 | 自动经验候选、执行质量与成本分析、能力/Skill/知识改进对照、灰度发布 | 候选有证据和评估；可回滚；优化指标有真实运行来源 |
| P4：扩展调度 | 受控并行、条件分支、跨进程/跨机器执行、策略化资源调配 | 共享写入无冲突；依赖结果类型正确；断点恢复可核查 |

建议按 **P0 → P1 → P2 → P3 → P4** 推进。基础事件与工件审计从 P0 开始，但监控仪表盘和自动优化不进入早期关键路径。

### 13.1 必测故障与安全场景

- 输入输出 Schema 不匹配、必需知识不可达、能力无权限、目录引用失效、Skill 版本漂移。
- DAG 循环、必需测试/审查缺失、观察点失败后不触发、条件分支汇合不可达。
- Agent 输出业务失败但执行器本身成功、评估提出越权重规划、达到重规划次数/预算上限。
- Worker 崩溃于外部写入 ACK 之前、Outbox 重投、租约失效后的陈旧 Worker 回报、控制面重启。
- 正在写入 Worktree 时重规划，旧结果应失效、锁不可错误释放。
- 项目 A 不能读项目 B 的知识；候选知识不能被误当作已验证全局事实。
- 日志/事件不能泄漏凭据；撤销知识或能力后新运行应被阻断，历史审计仍可定位版本。

## 14. 待决策事项（不得擅自假定已确定）

1. 首期 Capability 是否允许同步组合其他 Capability，还是统一通过子工作流包装？建议先采用独立 Invocation + 显式组合。
2. 首期知识权限模型是否只支持全局/项目/能力/任务四级，或需用户/团队 ACL？建议先单用户 Linux 场景，但保留 ACL 字段。
3. Planner 是否允许自动执行低风险任务？建议基于 capability 的 sideEffectClass、项目许可和预算策略决定，不用单一全局开关。
4. Checkpoint 的最大数量与默认触发策略如何确定？建议按任务不确定性/风险估计，并通过真实运行数据校准。
5. 并行 DAG 在共享 Worktree 下如何解决写冲突？建议首期同一 Worktree 写节点串行，多读节点使用快照。
6. 后续何时引入外部调度引擎或消息队列？在单机可靠性与真实负载指标明确后再评估，不以技术选型代替协议设计。

## 15. 一句话架构原则

> **以可验证的 Capability 定义“系统能做什么”，以有权限和来源的 Knowledge 管理“系统知道什么”，以可观察、可修订的 Workflow 定义“系统怎样做”；Agent 提出决策，确定性控制面保证安全与恢复，事件历史驱动持续改进。**
