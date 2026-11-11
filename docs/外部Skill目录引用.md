# 外部 Skill 目录引用

## 设计原则

AI Work OS 允许注册本机 Skill 来源目录，不把源目录复制进平台项目、Git 仓库或任务 Worktree。注册层仅持久化来源路径、Skill 相对路径、名称、描述、摘要及状态。来源目录继续由原工具和用户维护。

用户在「能力与知识」填写本机绝对路径后，服务递归发现含 SKILL.md 的目录。扫描自身也可为 Skill，最多深入 6 层、4000 目录、300 Skill。跳过符号链接和常见依赖/构建目录。坏文件会出警告，不删除已有引用。目录消失后状态变为 missing，原引用 ID 保留。

## 冻结与更新

任务通过 externalSkillIds 选择外部 Skill，与平台内部 skillVersionIds 独立。每次执行准备重新读取所选 SKILL.md、计算 SHA-256、将该次指令内容及来源信息冻结在运行 manifest；**这只是运行审计快照，不是将 Skill 目录复制到项目或 Worktree**。

- 准备到启动期间内容变化，准备摘要会失效。
- 下一次新运行自然读取最新内容，无需复制或重新发布。
- 已启动运行使用原指令快照；暂停后恢复不静默升级。
- 缺失、不可读或非法 Skill 不允许新任务启动。
- 同名内部/外部 Skill 触发冲突检测。

## 辅助文件限制

外部的 scripts/、references/、assets/ 仍在源目录，不复制、自动挂载或自动执行。执行上下文会记录 external.directoryPath，但执行器是否能读取这些辅助文件，受其沙箱和文件权限约束。当前只保证 SKILL.md 指令快照的稳定性，不保证依赖动态外部文件的 Skill 完整可复现。后续可增加文件依赖清单、读权限预检、运行时漂移检测和受控只读资源访问，不应自动扩大 Agent 权限。

## 接口

- GET /api/v1/skill-sources：列出注册目录
- POST /api/v1/skill-sources：接受 JSON 对象 {path: absoluteDirectory}
- POST /api/v1/skill-sources/:id/scan：重新扫描，报告发现数、缺失数及警告
- GET /api/v1/external-skills：列出引用记录及状态
- POST /api/v1/tasks：新增 externalSkillIds UUID 数组，可多选

全部接口使用现有本机令牌鉴权。浏览器常规文件选择器无法把用户电脑的任意绝对文件夹路径授权给本机服务，因此首版使用显式路径输入，不提供自动监控或远程目录访问。
