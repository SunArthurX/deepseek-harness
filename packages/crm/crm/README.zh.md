---
description: "投资顾问 CRM 能力：ctx.crm 背后的持久客户档案、顾问名册、互动记录、适当性审计咨询、商机管线、跟进任务与读模型分析，供组装或扩展 CRM 的用户与维护者参考。"
kind: "package-reference"
---

# @deepseek-ai/dsh-crm

[English](README.md) | 中文

## 概述

`dsh-crm` 是投资顾问领域（投资顾问/财富管理）的持久化客户关系管理能力。它拥有一个含六张表——顾问、客户、互动、咨询、商机、任务——的 `crm` 存储域，以及保证它们一致的规则：中国证券业适当性标准（客户容忍度 C1–C5 对应产品风险 R1–R5，测评有效期可配置）、带终态收尾语义的商机阶段状态机、每次写入的顾问解析与引用完整性，以及派生（绝不落盘）的逾期标记。读模型聚合管线、客户簿、任务负载与适当性审计轨迹。服务与后端无关：部署方经 storage 缝将 `storageDomain` 路由到 SQLite 或 JSON。

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

当一个组装需要持久的顾问 CRM 数据——带风险测评的客户档案、互动历史、适当性审计咨询、销售管线、比任何对话都长寿的跟进任务——时挂载本包。面向模型的表面经 [`dsh-tool-crm`](../tool-crm/README.zh.md) 使用它；产品表面直接调用 `ctx.crm`。

### 何时选择

当 CRM 数据必须在某个服务之后跨会话持久、由部署方选择存储后端时选择它。服务拥有校验与业务规则；它绝不向模型渲染任何内容。不要用它承载会话内临时状态——那属于会话日志——也不要在需要远程 CRM 主数据系统时使用；那将是同一能力缝上的未来提供者。

### 最小配置

`riskProfileValidityDays` 必填且无默认值：省略它的组装会在加载时失败。它决定一次风险测评在需要重新测评之前满足适当性的时长；重新测评会重启该窗口。

```yaml
- name: '@deepseek-ai/dsh-crm'
  config:
    riskProfileValidityDays: 730
```

| Field | Default | Meaning |
|---|---|---|
| `riskProfileValidityDays` | required | 一次风险测评的有效天数；过期将阻断适当性直到重新测评 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-crm)是接受字段的详尽来源。

### 服务保证

- **推荐之前先适当性。** `recordConsultation` 在咨询时对每个讨论产品评估客户档案——matched、product-exceeds-profile、assessment-expired 或 missing-profile——并将判定连同依据存入持久记录。不利判定绝不阻断记录：审计轨迹必须完整。
- **封闭阶段状态机。** `won`、`lost`、`abandoned` 是终态；进入 `lost` 或 `abandoned` 需要收尾原因；进入任何终态都会盖章收尾时间并强制该阶段的概率（won 100，lost/abandoned 0）。
- **写入时引用完整性。** 每条顾问维度的行在落库那一刻引用既存的客户与顾问；任务的可选客户与商机必须彼此一致。
- **逾期是派生的。** 是否逾期在读取时按调用方时钟计算；不存储任何会过期的内容。
- **构造即串行。** 所有变更运行在一条服务级链上，每个读-校验-写步骤都观察到前一步落库后的状态。

### 分析

`pipelineSnapshot` 聚合各阶段数量、金额、概率加权预测与赢单率；`bookSnapshot` 按生命周期与容忍度分布客户并给出 AUM 总额与测评到期提醒（固定 30 天预警窗口）；`taskLoad` 按优先级报告未完成与逾期数量及下一批到期项；`suitabilityAudit` 把所有已记录的产品判定摊平为一条审计轨迹。每个快照都接受可选的顾问范围。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本节解释服务背后的设计决策并指向实现它们的代码；可观察行为完整覆盖在 [Use this package](#use-this-package)。

### Design philosophy

服务建立在四项承诺上：

- **跨会话旁路，而非会话状态。** CRM 记录必须比任何对话长寿且绝不隐式进入模型历史；域存储是事实来源，与 `message-feedback` 和 `workspace` 完全一致。
- **业务规则集中一处。** 适当性、阶段流转、顾问解析与取值约束都在服务的变更链内强制执行——工具层和任何未来提供者都继承它们。
- **存储缝即提供者缝。** 服务只注入 `storageDomain`；SQLite、JSON 及任何未来后端都是同一接口背后的部署选择，因此 CRM 自身无需提供者拆分。
- **读取确定性。** 文本排序使用 UTF-16 码元而非 `localeCompare`，列表在任何 ICU 构建上排序一致。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `CrmService`（`ctx.crm`）、请求类型、错误类与变更链 |
| [`src/types.ts`](src/types.ts) | 纯领域类型：品牌 id、封闭词汇表、记录、读模型 |
| [`src/spec.ts`](src/spec.ts) | Zod 记录模式与 `crm` 域声明 |
| [`src/suitability.ts`](src/suitability.ts) | 纯适当性引擎 |
| [`src/invariant.ts`](src/invariant.ts) | 断言跨表引用完整性的不变式伴随插件 |

### Suitability engine

`evaluateSuitability(profile, product, now)` 是纯函数：检查按固定顺序执行——档案缺失、测评过期（过期含等号）、再是容忍度等级对产品等级——每个判定都携带点名决定性等级或日期的依据，审计轨迹因此自我解释。`riskProfileValidityDays` 只推导过期窗口；规则结构本身是固定的领域标准。

### 变更链与销毁

每个写方法把一个完整的读-校验-写作业排入一条 promise 链，并在销毁开始后拒绝新工作——与 `message-feedback` 的每会话尾链一致但服务级，因为 CRM 变更跨客户。服务的 `[Service.init]` 打开域、绑定各表，并安装一个在链排空后关闭域的 `ctx.effect` 销毁器。

### 持久边界校验

`src/spec.ts` 中的 Zod 模式在域加载时校验每条记录：枚举词汇、货币形态、分数与概率范围、过期不早于测评、收尾时间只在终态商机上、lost/abandoned 必有收尾原因、完成时间只落在完成任务上。服务构造的记录天然满足它们；边界拒绝其余一切。

### 不变式伴随插件

伴随插件监听 `crm` 域的 `domain/changed`，断言每条落库的行引用既存的客户/顾问/商机——与服务在每次变更内强制执行的规则相同，只是对经任何路径到达介质的行再断言一次。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。

- [crm group map](../README.zh.md) — 兄弟组页面及其包表。
- [`dsh-tool-crm`](../tool-crm/README.zh.md) — 该服务之上的面向模型工具。
- [Generated configuration catalog](../../../docs/config-catalog.zh.md#deepseek-aidsh-crm) — 每个接受配置字段及其来源声明。
- [Storage domain](../../storage/storage-domain/README.zh.md) — 本服务消费的 KV 域形态。
- [CRM 插件 Agent Note](../../../.agents/notes/implemented/feature/2026-09-04-crm-plugin.zh.md) — 该能力的设计记录。

-----

<a id="model-experience"></a>
## 模型体验

无：`dsh-crm` 是没有面向模型表面的宿主侧服务。间接地，经 `dsh-tool-crm`，其工具把服务的数据暴露给模型；模式与 token 影响由那个包拥有。

#### KV Cache effect

服务不发起模型请求，也不贡献任何提示或模式内容，因此它不会使任何可复用请求前缀失效；其唯一的模型可见后果经由工具包的工具调用与结果到达。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义服务何时是不合适的选择。它们是当前包约束，而非任务积压。

- **无硬删除** — 客户退到生命周期 `lost`、商机退到 `abandoned`、任务退到 `cancelled`；审计姿态保留每一行，因此存储单调增长。
- **单进程串行** — 变更链在单个服务实例内排序写入；多进程部署需要部署方的存储后端提供跨进程排序。
- **尚无远程提供者** — 能力缝 anticipated 远程 CRM 适配器（主数据同步），但目前只有域存储实现。
- **每条记录单一货币** — 货币字段共享每条记录一个 ISO 4217 代码；无换算或多货币轧差。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本 Dev Note 是维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付的行为、限制与接受的依据存在于上方章节、包代码与链接的 Agent Notes 中。

#### Future: pagination and secondary indexes

列表方法在域快照上内存过滤排序，这在顾问团队规模（数千客户）下是诚实的。一旦真实部署超出协议上限，未来修订可加入游标分页。

</details>
