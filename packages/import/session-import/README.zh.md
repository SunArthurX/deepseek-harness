---
description: "将其他编码智能体（Claude Code、Codex）记录的对话导入为可在 DeepSeek Harness 上继续执行的会话：只读适配器、密钥脱敏、幂等溯源，以及 session_import 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-import

[English](README.md) | 中文

## 概述

`dsh-session-import` 把发生在其他编码智能体里的对话带进本 harness：它只读发现 Claude Code（`~/.claude/projects/**/*.jsonl`）、Codex（`~/.codex/sessions/**` 与 `~/.codex/archived_sessions/**`）、ZCode（`~/.zcode/cli/db/db.sqlite`）与 MiniMax（`~/.minimax/v2/sqlite/runtime-state.sqlite`）的磁盘会话存储——SQLite 存储经内置 `node:sqlite` 模块读取，解析为提供方中立的转录，并把每个对话物化为一个全新的 DeepSeek Harness 会话——其日志完整重放原始交流。导入出的会话就是普通 harness 会话：续跑、fork、导出、投影全部走既有路径，因为它的历史就是标准事件格式下通过校验的种子。每次导入都幂等、在持久溯源事件中记录来源，并在凭据样式的字符串可能随下一次模型请求离开本机之前完成脱敏。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当工作始于另一个智能体、而需要在这里继续时使用本包：一段产生了值得保留上下文的对话、一个未完成的任务，或团队希望落到 harness 持久日志上的转录。挂载插件是唯一设置；随后模型获得 `session_import` 工具，驱动方获得 `ctx.sessionImport` 服务。

### 何时选择它

当来源智能体在同一台机器上存放 JSONL 转录、且目标是继续到本 harness 时选择它——这是最常见的迁移形态。当只需要向这些智能体一次性委派任务时（`dsh-subagent-claude-code` 与 `dsh-subagent-codex` 提供方覆盖该场景），或来源存储是数据库而非 JSONL 时（Cursor 等，见限制），不要使用。

### 最小配置

主目录设置回退到当前用户的 `~/.claude` 与 `~/.codex`；其余字段都有文档化的默认值，由服务的显式 resolve 步骤应用。来源对话未记录模型 id 时，只有在 `defaultModel`（或请求）提供时才可导入——否则导入明确报错，绝不猜测。

```yaml
- name: '@deepseek-ai/dsh-session-import'
  config:
    redactSecrets: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `claudeHome` | `~/.claude` | 要扫描的 Claude 主目录 |
| `codexHome` | `~/.codex` | 要扫描的 Codex 主目录 |
| `zcodeHome` | `~/.zcode` | 要扫描的 ZCode 主目录 |
| `minimaxHome` | `~/.minimax` | 要扫描的 MiniMax 主目录 |
| `defaultModel` | 无 | 来源对话未记录模型 id 时记录的模型 |
| `maxFileBytes` | `2147483648` | 单个来源文件的拒绝预算（字节）；真实 Codex rollout 可达数 GB |
| `maxToolResultChars` | `20000` | 单条工具结果文本上限（字符） |
| `includeReasoning` | `false` | 保留来源推理文本为 `reasoning` 块 |
| `redactSecrets` | `true` | 导入前替换凭据样式的子串 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是全部接受字段的穷尽来源。

### 一次导入产出什么

一次导入读取一个来源对话，创建一个以 `ext-<provider>-<sourceId>` 确定性命名的会话。导入日志以携带来源模型的 `request/header` 开头，随后是 `session-import/source` 溯源事件（来源 id、路径、大小、mtime、导入时间、脱敏与跳过计数），然后是重放为平衡回合的来源交流。助手工具调用保留其名称与参数，并且总是由工具结果闭合——来源未记录的结果会成为显式错误结果，因此第一次续跑请求必然是提供方合法的。来源对话的工作目录为绝对路径时成为会话 `cwd`。

### 幂等与冲突

重复导入未变化的来源返回 `up-to-date`——检查比对存储溯源中的大小与 mtime。当确定性的目标已存在且持有不同的导入（或来源已变化）时，导入返回 `conflict` 而不是覆盖历史；传入显式 `targetId` 可把变化的来源作为新会话导入，与非导入会话的碰撞是硬错误。

### 继续导入的会话

导入的会话像任何会话一样继续：驱动方调用 `ctx.sessionImport.continueSession(id, prompt, { agentOptions })`——对活跃智能体跟进、否则恢复持久化的那个；也可以直接组合 `ctx.agents.resume({ resumeSessionId })`。`agentOptions` 路由是部署者的模型决策；导入的 header 从不参与分发。

```ts ignore-check
const outcome = await ctx.sessionImport.importSource({
  provider: 'claude-code', sourceId,
})
if (outcome.status === 'imported') {
  await ctx.sessionImport.continueSession(outcome.sessionId, '<your continuation prompt>', {
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  })
}
```

### 安全读取来源

适配器只读打开来源文件、从不写入；超过 `maxFileBytes` 的文件被拒绝；无法解析的行计入对话（溯源事件可见）而不是让整个导入失败；Codex 的首行发现对每个 rollout 只读一条有界行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>设计与源码地图——点击展开</summary>

流水线是四个阶段，每个都是纯模块边界：发现（列出存储）、解析（存储行 → `ExternalConversation` 条目）、翻译（条目 → 会话种子事件）、物化（种子 → 通过持久化后端的持久日志）。翻译器是正确性核心：它缓冲助手文本使 tool-call 块挂到正确的助手消息上，为没有助手消息的调用打开隐式助手消息，为来源未应答的调用合成错误结果，并在返回前用 `findSeedStructuralError` 自检输出。

| 关注点 | 源码 |
|---|---|
| 插件入口：配置、服务、工具注册 | [src/index.ts](src/index.ts)、[src/service.ts](src/service.ts) |
| Claude Code 适配器（发现 + 解析） | [src/adapters/claude-code.ts](src/adapters/claude-code.ts) |
| Codex 适配器（rollout、legacy 与 JS-bridge 调用） | [src/adapters/codex.ts](src/adapters/codex.ts) |
| 共享解析守卫与净化器 | [src/adapters/shared.ts](src/adapters/shared.ts) |
| 有界 JSONL 读取与跳过计数 | [src/jsonl.ts](src/jsonl.ts) |
| 条目 → 种子事件、结构校验器 | [src/translate.ts](src/translate.ts) |
| 凭据脱敏规则 | [src/redact.ts](src/redact.ts) |
| 溯源事件词汇 | [src/types.ts](src/types.ts) |
| 溯源不变量（仅一条、必须 seq 1） | [src/invariant.ts](src/invariant.ts) |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够时阅读这些页面。

- [扩展实操手册](../../../docs/cookbook/extension-cookbook.zh.md) — 本包组合的扩展点（`ctx.sessions`、`ctx.agents`、`ctx.tools`）。
- [会话子系统参考](../../../docs/subsystems/session.zh.md) — 翻译器目标的事件日志与种子机制。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-session-import) — 模型收到的 `session_import` schema。
- [生成的配置目录](../../../docs/config-catalog.zh.md) — 全部接受配置字段及其声明来源。
- [智能体会话导入 Agent Note](../../../.agents/notes/implemented/feature/2026-09-03-agent-session-import.zh.md) — 设计、备选方案与延后的适配器。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`session_import` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-session-import)：必填的 `action`（`list` 或 `import`）、可选 `provider`（`claude-code` 或 `codex`；`import` 必填）、可选 `sourceId`（来自先前列表），以及可选 `limit`（将 `list` 行数限制为最新的若干条）。描述告知模型导入是幂等的、且从不覆盖已存在的目标。

#### Token 影响

工具可见的每个请求上都有固定 schema 开销；描述对给定配置稳定。`list` 结果随机器上外部对话的数量增长。

#### KV Cache 影响

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使本 schema 的复用失效。

### 工具调用历史与结果

#### 模型看到什么

`list` 调用为每个发现的对话返回一行（`provider`、`sourceId`、`imported`、`sizeBytes`、`mtimeMs`），模型侧文本为 `Discovered <n> external conversation(s).`；`import` 调用返回 `action`、`status`（`imported`、`up-to-date` 或 `conflict`）、新 `sessionId`，导入时附来源标题——渲染为 `Import <status>: <sessionId>`。失败是类型化错误：缺少 `provider`/`sourceId`、未知来源 id、或被拒绝的来源（超预算、为空、无模型且无回退）。

#### Token 影响

列表行数随部署暴露的存储规模增长；导入结果小而形状固定。

#### KV Cache 影响

只追加；新可见内容跟随可复用的请求前缀，不会使既有 KV-cache 条目失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了本包不适用的场景。它们是当前包约束，不是任务清单。

- **Cursor 仍不支持** — ZCode 与 MiniMax 已覆盖（SQLite 经内置 `node:sqlite` 读取）；Cursor 的存储形状仍需其专属适配器。
- **一次性导入，无实时监视** — 重新导入是显式的；没有跟踪外部活跃会话的文件监视器，也没有自动同步。
- **历史保真即转录保真** — 未开启 `includeReasoning` 时丢弃来源推理、剥离 harness 注入块、不导入用量核算；导入日志重放对话本身，而非外部运行时。超过单行上限的行与超过 `maxToolResultChars` 的结果会被丢弃或截断，计数记录在溯源事件中。
- **工具结果中的非文本内容不随行** — 外部工具结果中的图片等非文本块不产生文本；结果完全没有文本时以显式占位导入。
- **跳过按原因计数** — 不可解析/未识别记录与注入的运行时块计入 `skippedRecords`；因超过大小上限而整行丢弃的行计入 `oversizedRecords`。两者都随 `session-import/source` 事件记录。
- **脱敏基于规则且默认开启** — 形状严格的规则避免误伤正文，但规则集之外的凭据格式会通过；仅当来源存储可以未脱敏地发给模型时才设 `redactSecrets: false`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本备注是维护者的工作上下文：未决问题与方向，尚未决定。它明确地非权威——已交付的行为、限制与已接受的依据位于上文章节、包代码与链接的 Agent Note 中。

#### 未来：SQLite 来源与用户命令

适配器接口（`discover` + `parse` 返回 `ExternalConversation`）是新来源的接缝；SQLite 适配器需要先做依赖决策。基于命令接缝的用户 `/import` 命令、以及带新鲜度窗口的自动同步循环，是走同一服务 API 的后续产品决策。

</details>
