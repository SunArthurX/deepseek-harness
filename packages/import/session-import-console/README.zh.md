---
description: "会话导入的浏览器管理台：挂在 harness web 服务器上的单页管理界面与 JSON API，适合偏好仪表盘而非模型驱动工具的操作者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-import-console

[English](README.md) | 中文

## 概述

`dsh-session-import-console` 在 harness web 服务器的 `/session-import-console` 挂载会话导入的可视化管理页：一个自包含单页应用（提供方页签、内容检索、逐会话导入状态）加 `/session-import-console/api` 下的读写 JSON API。网关只负责翻译——HTTP 路由、线边界上的封闭词表校验与 JSON 信封——而全部业务规则（发现、翻译、幂等、脱敏）都留在 [`dsh-session-import`](../session-import/README.zh.md)。在带 web 服务器的 profile 里与 `dsh-session-import` 并排挂载是唯一的设置。

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

当操作者需要浏览器仪表盘来使用模型所驱动的同一导入服务时挂载本包：查看外部对话、按内容检索、一键导入——完全不必提示模型。

### 何时选择它

组合已运行 web 服务器与 `dsh-session-import`、且人需要与智能体并行的导入入口时选择它。headless 或 SDK 组合（没有 web 服务器可托管）或需要暴露到回环之外时不要用——它继承 web 服务器绑定的主机与端口，自身不做任何鉴权；模型的 `session_import` 工具也不需要控制台。

### 最小配置

插件无配置；挂载路径（`/session-import-console`）是固定的组合级契约。

```yaml
- name: '@deepseek-ai/dsh-session-import'
  config:
    redactSecrets: true
- name: '@deepseek-ai/dsh-session-import-console'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| *（无）* | — | 控制台绑定到所组合 web 服务器的主机与端口 |

### 控制台提供什么

- **提供方页签** — Claude Code / Codex / ZCode / MiniMax，各自按最新优先列出会话并带导入状态徽章。
- **内容检索** — 子串过滤转发给服务（ZCode/MiniMax 走 SQLite `LIKE`，JSONL 存储走流式扫描）。
- **同步全部** — 重新发现各来源存储并刷新左侧列表；绝不导入任何内容，导入只通过单个会话自己的按钮发生。
- **导入** — 每会话一键导入；结果徽章区分 `imported`、`up-to-date` 与 `conflict`（来源变化后经「重新导入」落到版本化 `-v2` 目标，绝不覆盖原会话）。

### API 面

每个界面动作都走 `/session-import-console/api` 下的 JSON API：`providers`（GET）、`sources`（GET，可选 `provider`/`query`/`limit`）、`import`（POST，`provider`/`sourceId`/可选 `targetId`）。所有应答都是 `{ ok: true, data }` 或 `{ ok: false, error }`；失败以 `400` 附带准确消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 设计哲学

- **网关，而非第二个导入器。** 插件把 HTTP 翻译为 `ctx.sessionImport` 调用并把结果翻回 JSON；它不持状态、绝不自行触碰来源存储。控制台展示的一切都是服务会给模型工具的同一结果。
- **线边界即校验边界。** 提供方词表声明一次、按服务联合类型化，并在每个入站字段上强制——未知成员以 `400` 指名字段应答。
- **组合而非占有。** 控制台从不打开 socket：在 `ctx.webServer` 上注册一个 exact 路由（页面）与一个 prefix 路由（API），卸载插件即释放路由而服务器继续监听。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：路由注册、JSON 体读取、写信封的 handler |
| [`src/api.ts`](src/api.ts) | API 分发器：请求校验与服务调用翻译 |
| [`src/page.ts`](src/page.ts) | 单页控制台（一个自包含 HTML 文档，无外部资源） |
| [`src/invariant.ts`](src/invariant.ts) | 空不变量伴生；规则由所属接缝承载 |

### 请求生命周期

每个 API 请求解析一次为 `ApiRequest`（方法、路径段、查询、可选已解码体），经资源头的全量 switch 分发，以 `200` + 服务规范 JSON 或 `400` + 失败消息应答。整个分支——含体解码——都经信封应答，页面绝不会解析裸状态码。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够时阅读这些页面。

- [session-import](../session-import/README.zh.md) — 本控制台挂载的服务：提供方、幂等、脱敏。
- [import 分组地图](../README.zh.md) — 同组分组页与包表。
- [CRM 控制台](../../crm/crm-console/README.zh.md) — 同一控制台模式在另一服务上的实现，读写视图更丰富。

-----

<a id="model-experience"></a>
## 模型体验

None, as 控制台不注册工具、提示词段或会话事件，其唯一的模型可见后果是 `session_import` 工具读取的数据。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定控制台的刻意精简之处。它们是当前包约束，不是任务清单。

- **自身无鉴权** — 控制台继承 web 服务器的绑定；暴露非回环主机即把导入 API 无鉴权暴露给该网络。
- **列表无分页界面** — API 接受 `limit`；页面始终渲染当前页签与查询的完整列表。
- **无续跑动作** — 导入产物是普通会话；续跑留在 harness 原生会话界面，刻意不在此重复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本备注是维护者的工作上下文：未决问题与方向，尚未决定。它明确地非权威——已交付的行为、限制与已接受的依据位于上文章节、包代码与链接的 Agent Note 中。

#### 未来：设置面板集成

主 Web 客户端的设置面板可以承载更深的集成（Typert remote 命名空间加 `settings.section` 槽位）而非独立页面；独立控制台先行，因为它无需 client-bundle 接线即可组合进任何带 web 服务器的 profile。

</details>
