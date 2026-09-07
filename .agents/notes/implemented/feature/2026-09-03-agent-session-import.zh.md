# Agent Note：将外部智能体会话导入为可继续的 harness 会话

Status: implemented

[English](2026-09-03-agent-session-import.md) | 中文

## 问题

始于其他编码智能体——Claude Code、Codex——的工作被困在那里：harness 可以向这些智能体一次性委派任务（subagent 提供方），甚至可以把它们当子进程跑，但已经在它们里面发生过的对话无法迁移到 harness 的持久会话日志上。团队要么丢失这些对话产生的上下文，要么手工复制粘贴；harness 对自身会话施加的一切治理（持久化、投影、导出、模型边缘的脱敏）从未触及外部历史。磁盘存储本来就在本地——`~/.claude/projects/**/*.jsonl` 与 `~/.codex/sessions/**`——但仓库里没有任何东西读它们。

## 决策

新包 `packages/import/session-import`（`@deepseek-ai/dsh-session-import`，插件 `session-import`，服务 `ctx.sessionImport`）实现四段流水线：**发现**（只读列出各存储）、**解析**（存储行 → 提供方中立的 `ExternalConversation` 条目）、**翻译**（条目 → 通过校验的 harness 会话种子）、**物化**（种子 → 经由组合的持久化后端落盘，绕过 live store）。模型获得 `session_import` 工具（`list`/`import`）；驱动方获得 `continueSession`——恢复导入的会话并跟进一条提示词。

承重的设计选择：

- **导入的日志是一等种子，不是转录附件。** 它以携带来源模型的 `request/header` 开头，在 seq 1 记录 `session-import/source` 溯源事件（来源 id/路径/大小/mtime、导入时间、脱敏与跳过计数），并把交流重放为平衡的回合，助手工具调用保留名称与参数。这正是结果可以被普通循环续跑、可 fork、可投影、可导出而无需任何粘合代码的原因。
- **每个助手工具调用都被闭合。** 来源未应答的调用得到显式错误工具结果；没有助手消息的调用打开一个隐式助手；没有调用的结果被跳过并计数。未闭合的 tool call 会让第一次续跑请求在提供方侧非法，因此翻译器保证平衡并在返回前自检（`findSeedStructuralError`）。
- **经持久化物化，不经 live store。** `importSource` 直接写 `persistence.create(header)` + `append(id, seed)`。会话因此永不阻塞恢复路径（活跃会话会被 `persistence.prepare` 拒绝），进程内续跑与跨进程续跑是同一条代码路径。没有组合持久化后端时导入明确报错——内存导入会在退出后丢失，不提供。
- **幂等基于溯源。** 确定性目标 id `ext-<provider>-<sourceId>` 加存储溯源的大小/mtime 给出 `imported` / `up-to-date` / `conflict` 语义；被非导入会话占有的目标是硬 `TargetCollisionError`，绝不覆盖。
- **脱敏默认开启且入账。** 导入的历史会在下一轮发给模型，因此凭据样式的字符串（AWS/GitHub/Slack/OpenAI/Anthropic/Google 令牌、PEM 块）在写日志前被替换为 `[REDACTED:<kind>]`；计数落入溯源事件。部署可以显式关闭。
- **外部运行时噪音不是用户内容。** Claude 的 `isMeta` 行、`system-reminder`/命令标记、Codex 的 `<environment_context>` 式注入、`wait` 轮询、token 计数事件被剥离或跳过、计入 `skippedRecords`，绝不变身用户消息。

## 考虑过的备选方案

- **恢复外部智能体而非导入**（外部调用 `claude --resume <id>` / `codex resume <id>`，Threadock 的做法）——否决为主机制：历史留在外部运行时、脱离 harness 日志，且续跑时需要外部 CLI 在场。导入结果仍携带 `sourceResumeHint`，因为两个目的地都合法。
- **搭 subagent 接缝**——委派提供方创建的是全新子会话；导入是另一种契约（收养既有历史，来源从不跑回合）。复用会把一条接缝弯成两个契约。
- **在模型上下文里手搓转录框架**（把外部对话摘要塞进系统提示词）——无处持久化、投影/UI/导出不可见、尺寸无界。
- **种子直接走 `sessions.create`**——第一版实现如此；它让会话在进程内保持活跃，进而阻塞恢复路径（`persistence.prepare` 拒绝活跃会话），使进程内续跑在没有 store 移除 API 的情况下无法实现。直写持久化是后端自身的契约，不需要活跃会话。
- **v1 就支持 SQLite 存储（Cursor、ZCode、MiniMax）**——延后：需要一个维护中的 SQLite 读取依赖，这是 JSONL 来源不需要的刻意决策。适配器接口就是接缝，这些来源从它后面接入。

## 接触真实存储后的设计修正

三个决策在适配器遇到真实语料后改变（一个 20 GB 的 Codex 存储、最大 rollout 4.7 GB；以及带多文本块用户行的 Claude 转录），两个修正都有镜像真实形状的合成 fixture 测试覆盖：

- **流式解析。** 整文件读取在数 GB 的 rollout 上行不通；`parseJsonlFile` 改为逐行流式读取并有界单行上限，因此任意文件大小下内存恒定，默认 `maxFileBytes` 预算从 64 MB 上调至 2 GB（仅作时间守卫——真实 rollout 超过旧默认）。Codex 首行发现同样只读有界 256 KB 前缀，而非 stat 门控的整文件。
- **命名 custom 工具调用。** JS-bridge 解析器（`tools.<name>(...)`) 假设的是 Codex 新编码，但真实 rollout 携带带显式 `name`（apply_patch）与原始补丁 `input` 的 `custom_tool_call` 记录；带名记录现在以 `{"input": ...}` 参数导入，其输出按 `call_id` 配对，而不是连同结果一起被丢弃（真实数据上最严重的单点丢失：一个 604 MB rollout 中 217+ 次编辑调用）。
- **列表完整性。** `listSources` 支持 `limit`（按最新优先，经模型工具的 `limit` 参数），已导入的列表行携带可续跑的 harness `sessionId`，按因计数将 `skippedRecords`（不可解析/未识别/注入）与 `oversizedRecords`（超过单行上限）区分。
- **记录语义。** Codex `event_msg` 遥测与仅加密的 `reasoning` 条目为"识别但忽略"（不计跳过）；注入式 Codex 用户上下文、developer 角色消息与 Claude `isSidechain` 行为"识别并计数"；Claude 的 `is_error` 与 Codex 的退出码信封会流入工具结果错误标志，使导入的失败仍是失败。

## 后果

导入的会话是普通会话：恢复（ACP、profile、SDK）、fork、标题、投影、导出全部开箱即用，第一次续跑请求把完整外部历史带给配置的模型路由。新增了持久词汇（`session-import/source`），生成的持久化目录收录了该类型，包不变量伴生插件强制每会话一条、必须 seq 1。导入是显式且一次性的——没有尾随外部活跃会话的监视器、没有自动同步；想要来源工具的用户仍可在结果里拿到 `claude --resume` 式提示。已知事件词汇意味着旧运行时会明确拒绝导入日志而不是误读——这是这类会话跨版本迁移的预期 fail-closed 行为。
