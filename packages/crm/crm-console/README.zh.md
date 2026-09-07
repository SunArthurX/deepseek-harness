---
description: "投资顾问 CRM 的浏览器管理控制台：挂在 harness Web 服务器上的单页管理界面与读写 JSON API，适合偏好仪表盘而非模型驱动工具的运营人员。"
kind: "package-reference"
---

# @deepseek-ai/dsh-crm-console

[English](README.md) | 中文

## 概述

`dsh-crm-console` 在 harness Web 服务器的 `/crm-console` 路径挂载 CRM 的可视化管理页：一个自包含单页应用（总览仪表盘、客户簿、商机看板、任务列表与适当性审计轨迹）加上 `/crm-console/api` 下的读写 JSON API。网关只负责转换——HTTP 路由、线上边界的封闭词汇校验与 JSON 封装——而每条业务规则（适当性、阶段状态机、引用完整性）都留在 [`dsh-crm`](../crm/README.zh.md)。在带 Web 服务器的 profile 中与 `dsh-crm` 一起挂载即完成全部设置。

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

当运营人员需要在代理驱动的同一份持久 CRM 之上获得浏览器仪表盘时挂载本包：顾问无需提示模型即可查看管线，合规人员直接阅读适当性审计轨迹，前台用表单而非对话完成临柜客户建档。

### 何时选择

组装中已运行 Web 服务器与 `dsh-crm`、且人类需要与代理并行的读写权限时选择它。避免用于 headless 或 SDK 组装（没有 Web 服务器可承载）或需要向回环以外暴露的场景——它继承 Web 服务器绑定的主机与端口，自身不带任何认证。

### 最小配置

插件不接受配置；挂载路径（`/crm-console`）是固定的组装级契约。

```yaml
- name: '@deepseek-ai/dsh-crm'
  config:
    riskProfileValidityDays: 730
- name: '@deepseek-ai/dsh-crm-console'
```

| Field | Default | Meaning |
|---|---|---|
| *（无）* | — | 控制台绑定到所组装 Web 服务器的主机与端口 |

### 新手运营首次上手

空客户簿时，仪表盘显示三步欢迎卡片（建团队 → 带测评建客户 → 记咨询自动适当性判定），并附带 **🚀 一键载入演示数据** 按钮——经真实服务规则载入一套贴近实务的演示簿（2 名顾问、8 位覆盖全部容忍度与测评状态的客户、6 次互动、3 次覆盖匹配/超承受/未测评的咨询、5 个含已盖章赢单与留因输单的商机、4 个含 1 条逾期的任务）。对非空客户簿礼貌拒绝，重复点击绝不重复建档；载入后每个页面都有可探索的真实感数据，运营可对照同样的流程服务真实客户。

### 控制台提供什么

- **总览仪表盘** — 客户数与 AUM、存续商机与加权预测、赢单率、任务负载、测评到期预警，以及管线漏斗与客户结构。
- **客户簿** — 可搜索、可过滤的客户表格，带生命周期/容忍度/状态标签；每客户的 360° 抽屉（最近互动、存续与赢单商机、未完成任务）；建档与重新测评对话框；一键记录咨询并自动出适当性判定。
- **商机管线** — 分阶段卡片与商机表，一键推进阶段（终态自动盖章收尾信息），输单须留原因。
- **跟进任务** — 带逾期标记的未完成议程，原位完成与取消。
- **适当性审计** — 摊平的判定轨迹，带匹配/阻断标签与依据，最新在前。

### API 面

每个界面动作都走 `/crm-console/api` 下的 JSON API：`overview`、`advisors`（GET/POST）、`clients`（GET 搜索、POST 建档、GET/PATCH `:id` 读取 360° 与更新）、`interactions`（GET/POST）、`consultations`（GET/POST）、`opportunities`（GET/POST、GET `:id`、POST `:id/move`）、`tasks`（GET/POST、POST `:id/complete|cancel|reschedule`、GET `:id` 按客户列任务）与 `audit`（GET）。写入在 wire 边界校验每个封闭词汇，非法值以精确消息回答 `400`；读取返回服务产生的同一规范形状。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本节解释控制台背后的设计决策并指向实现它们的代码；可观察行为完整覆盖在[使用本包](#use-this-package)。

### 设计理念

控制台建立在三项承诺上：

- **是网关，不是第二个 CRM。** 插件把 HTTP 翻译为 `ctx.crm` 调用、把结果翻译回 JSON；它不持有状态、不定义规则、绝不直接触碰持久域。控制台展示的一切都是服务会返回给模型或 SDK 调用方的内容。
- **wire 边界即校验边界。** 每个封闭词汇（生命周期、容忍度、互动渠道、主题、产品类别、阶段、任务状态、优先级）只声明一次，以服务联合类型约束（漂移直接编译失败），并对每个入站字段强制执行——未知成员以 `400` 点名字段。
- **组合而非占有。** 控制台从不打开套接字：它在 `ctx.webServer` 上注册一个精确路由（页面）与一个前缀路由（API），并把两个销毁器接到自己的 fiber，卸载插件即释放路由而服务器继续监听。

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：类型化线上词汇、body/query 读取器、API 分发器、销毁器接 fiber 的路由注册 |
| [`src/page.ts`](src/page.ts) | 单页控制台（一份自包含 HTML 文档，无外部资源） |
| [`src/invariant.ts`](src/invariant.ts) | 空不变式伴随插件；规则由所属能力缝承载 |

### 导出形状

插件是函数/命名空间插件：导出 `name` / `inject` / `apply` 且没有默认导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`（见 [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 请求生命周期

每个 API 请求解析一次为 `ApiRequest`（方法、路径段、查询、可选解码 body），经资源头的全量 switch 分发，`200` 返回服务的规范 JSON 或 `400` 返回失败消息。变更经服务的串行变更链解决，因此两个并发的控制台写入与两个并发的模型工具调用完全同序。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。

- [crm group map](../README.zh.md) — 兄弟组页面及其包表。
- [`dsh-crm`](../crm/README.zh.md) — 拥有数据与控制台所展示全部规则的服务。
- [`dsh-tool-crm`](../tool-crm/README.zh.md) — 同一服务之上的面向模型工具。
- [Web server](../../host/webserver/README.zh.md) — 控制台挂载的路由注册表。
- [CRM 插件 Agent Note](../../../.agents/notes/implemented/feature/2026-09-04-crm-plugin.zh.md) — CRM 能力的设计记录。

-----

<a id="model-experience"></a>
## 模型体验

无：`dsh-crm-console` 不注册工具、提示或会话事件；它是面向运营者的 HTTP 表面。间接地，经 `dsh-crm`，控制台写入改变模型 `crm_*` 工具读取的持久数据，浏览器里建档的客户立刻对 `crm_client_search` 可见。

#### KV Cache effect

控制台不发起模型请求，也不贡献任何提示或模式内容，因此它不会使任何可复用请求前缀失效；其唯一的模型可见后果是经工具包结果可观察的数据变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义控制台何时是不合适的选择。它们是当前包约束，而非任务积压。

- **自身不带认证** — 控制台继承 Web 服务器的绑定与部署方添加的前置代理；未经代理不得暴露到回环之外。
- **读写面镜像服务而非工具** — 报表仅经 overview 聚合提供；`crm_report` 工具的四类报表尚无专属控制台页面。
- **固定挂载路径** — `/crm-console` 是组装级契约；需要不同路径的部署须以前置代理转换。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本 Dev Note 是维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付的行为、限制与接受的依据存在于上方章节、包代码与链接的 Agent Notes 中。

#### Future: server-sent events for live updates

页面目前按需拉取；实时仪表盘可订阅 `domain/changed` 并推送增量。事件存在、缝是干净的——开放问题是一个消费者是否值得为每个运营者标签页维持一条长连接。

</details>
