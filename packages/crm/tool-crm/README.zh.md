---
description: "dsh-crm 服务之上的面向模型 crm_* 工具：客户档案、顾问名册、互动记录、适当性审计咨询、商机管线、跟进任务、投顾方案与读模型报表，供组装代理 CRM 表面的用户与维护者参考。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-crm

[English](README.md) | 中文

## 概述

`dsh-tool-crm` 给代理 22 个基于持久顾问 CRM 的 `crm_*` 工具：注册与列出顾问；创建、搜索、360° 读取与更新客户；记录与列出互动；记录带适当性审计的咨询；开启、推进与列出管线商机；安排、列出、完成、取消与改期跟进任务；创建、列出、推进与评审三类投顾方案（定投、资产配置、保障缺口）；以及运行管线、客户簿、任务负载与适当性报表。工具层只负责线上转换——ISO 8601 时间戳、封闭枚举词汇、规范记录序列化——而每条业务规则都留在 [`dsh-crm`](../crm/README.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当代理本身应当操作顾问 CRM——为客户对话做准备、记录发生了什么、记录带适当性判定的咨询、推进商机、按时跟进并报告客户簿——时，把本包与 `dsh-crm` 一起挂载。360° 读取是窗口化的——十次互动、十个最早到期的未完成任务、十次咨询、存续商机加最近五笔赢单——因此规范输出保持有界。

### 何时选择

当代理对话是顾问展业的工作表面时选择它。工具对持久簿进行读写，每个动作都落入存储并比会话长寿。避免用于从不运行模型的纯自动化组装，或产品 UI 应该拥有 CRM 编辑的场景——那些直接调用 `ctx.crm`。

### 最小配置

插件不接受配置；在两个被注入的服务之后挂载即可。

```yaml
- name: '@deepseek-ai/dsh-crm'
  config:
    riskProfileValidityDays: 730
- name: '@deepseek-ai/dsh-tool-crm'
```

| Field | Default | Meaning |
|---|---|---|
| *（无）* | — | 工具接受显式参数；所属服务拥有策略 |

### Tool roster

| Tool | Purpose |
|---|---|
| `crm_advisor_list` / `crm_advisor_register` | 解析或新增团队顾问 |
| `crm_client_create` / `crm_client_search` / `crm_client_get` / `crm_client_update` | 客户录入、查找、360° 读取与修补 |
| `crm_interaction_log` / `crm_interaction_list` | 展业历史 |
| `crm_consultation_record` | 带逐产品适当性判定的正式咨询 |
| `crm_opportunity_create` / `crm_opportunity_move` / `crm_opportunity_list` | 管线作业 |
| `crm_task_create` / `crm_task_list` / `crm_task_complete` / `crm_task_cancel` / `crm_task_reschedule` | 跟进纪律 |
| `crm_plan_create` / `crm_plan_list` / `crm_plan_review` / `crm_plan_transition` | 投顾方案：定投、资产配置、保障缺口 |
| `crm_report` | pipeline \| book \| tasks \| suitability 聚合 |

### Timestamps and vocabularies

模型使用 ISO 8601 字符串与封闭词汇表（容忍度 `C1`–`C5`、产品风险 `R1`–`R5`、阶段、类别、优先级、主题）；工具层在此 JSON 边界转换为服务的 epoch 毫秒与品牌 id。列表工具接受显式 `limit` 参数，服务将其钳制到协议上限（搜索 100、列表 200）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本节解释工具背后的设计决策并指向实现它们的代码；可观察行为完整覆盖在 [Use this package](#use-this-package)。

### Design philosophy

工具层建立在三项承诺上：

- **只做线上转换。** 业务规则留在服务；每个 `execute` 把参数映射为服务请求、把记录序列化回来并渲染一行文字。
- **JSON 边界即校验边界。** 时间戳要么解析要么高声失败；枚举在模式处封闭；可选字段双向流经同样的条件形态，规范值与声明的模式完全一致（处处 `additionalProperties: false`）。
- **诚实的失败。** 领域失败抛出类型化错误（`CrmUnknownClientError`、`CrmStageTransitionError`……）并以携带精确消息的 `isError` 结果呈现；没有静默回退。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：注册每个工具的 `name`/`inject`/`apply` |
| [`src/wire.ts`](src/wire.ts) | 枚举词汇、ISO 转换、纯记录序列化器 |
| [`src/schemas.ts`](src/schemas.ts) | 与序列化器保持同步的可复用输出模式片段 |
| [`src/tools-client.ts`](src/tools-client.ts) | 顾问与客户工具 |
| [`src/tools-engagement.ts`](src/tools-engagement.ts) | 互动与咨询工具 |
| [`src/tools-pipeline.ts`](src/tools-pipeline.ts) | 商机与任务工具 |
| [`src/tools-report.ts`](src/tools-report.ts) | 报表工具 |
| [`src/invariant.ts`](src/invariant.ts) | 空不变式伴随插件；所属能力缝承载规则 |

### Export shape

插件是函数/命名空间插件：导出 `name` / `inject` / `apply` 且没有默认导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`（见 [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 咨询审计强调

`crm_consultation_record` 的描述指示模型即使判定不利也要记录咨询——审计轨迹必须完整——并呈现被阻断的判定而非推荐。规范输出重复逐产品判定与 matched/blocked 计数，使该约束在结果本身中保持可见。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。

- [crm group map](../README.zh.md) — 兄弟组页面及其包表。
- [`dsh-crm`](../crm/README.zh.md) — 拥有数据与规则的服务。
- [Generated tool catalog](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-crm) — 模型收到的每个 `crm_*` 模式。
- [CRM 插件 Agent Note](../../../.agents/notes/implemented/feature/2026-09-04-crm-plugin.zh.md) — 设计记录。

-----

<a id="model-experience"></a>
## 模型体验

### Tool schema

#### What the model sees

模型看到生成的 [`crm_*` 模式](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-crm)：22 个带封闭枚举词汇（容忍度、产品风险、阶段、类别、优先级、主题）、ISO 8601 时间戳参数、必填 id / 可选细节形态的工具。每个描述陈述其范围与失败纪律（例如咨询工具的"即使被阻断也要记录"指令）。

#### Token effect

工具可见的每个请求上固定模式成本；模式按组装静态。

#### KV Cache effect

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使这些模式的重用失效。

### Tool-call history and result

#### What the model sees

结果是规范记录（ISO 时间戳、搜索行上未知容忍度/AUM 的显式 null、任务上的派生 `overdue` 标记）加各一行文字；列表渲染最多拼出五行并把其余折叠为溢出计数，因此无论页大小如何，结果文字保持有界。稳定失败是类型化服务错误，例如 ``Error: unknown CRM client '<id>'`` 与 ``Error: cannot move opportunity '<id>' from 'won' to 'lost': 'won' is terminal``。

#### Token effect

列表结果受调用方 `limit` 与协议上限约束；单记录结果是固定形态。调用参数与结果留在历史中直到压缩。

#### KV Cache effect

只增；新可见的调用与结果跟随可复用请求前缀，不会使既有 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义工具何时是不合适的选择。它们是当前包约束，而非任务积压。

- **无批量操作** — 每次调用一个客户、互动或商机；批量导入属于服务缝上的未来提供者，而非面向模型的工具。
- **无 UI 卡片特化** — 每个挂起调用渲染通用卡片；有需求时 Web Client 卡片可从原始事件派生。
- **无 PTC 专用投影** — 规范 JSON 值已经对程序友好，因此 `run_code` 组合不需要专用表面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本 Dev Note 是维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付的行为、限制与接受的依据存在于上方章节、包代码与链接的 Agent Notes 中。

#### Future: consultation-linked task creation

`crm_consultation_record` 刻意不自动创建跟进任务；模型用 `crm_task_create` 显式安排。如果重复流程显现，可选的 `createFollowUpTask` 参数可以在不改变持久记录形态的前提下折入该步骤。

</details>
