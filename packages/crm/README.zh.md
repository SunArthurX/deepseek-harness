---
description: "crm 包组：投资顾问 CRM 能力——一个持久化服务和一组面向模型的工具——供选择、组装或调试 CRM 的用户与维护者参考。"
kind: "package-group"
---

# crm/ — 投资顾问 CRM

[English](README.md) | 中文

## 概述

crm 包组承载投资顾问领域的客户关系管理能力：带风险测评的持久客户档案、顾问名册、互动历史、适当性审计咨询、商机管线、跟进任务与读模型分析。一个服务包拥有数据与业务规则（`ctx.crm`）；一个工具包将其以 `crm_*` 工具暴露给模型；一个控制台包给运营者同一服务之上的浏览器仪表盘。该拆分遵循能力缝规则：存储后端是经 `ctx.storageDomain` 可替换的提供者层，因此 CRM 恰好需要这两个角色独立演进的包。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| Package | Role |
|---|---|
| [`crm`](crm/README.zh.md) | CRM 能力：持久化域、适当性引擎、阶段状态机、`ctx.crm` 后面的分析 |
| [`tool-crm`](tool-crm/README.zh.md) | 基于 `ctx.crm` 的面向模型 `crm_*` 工具 |
| [`crm-console`](crm-console/README.zh.md) | 浏览器管理控制台：`ctx.crm` 之上的单页管理界面 + JSON API |

CRM 数据是跨会话的持久旁路状态：客户档案比任何对话都长寿，且绝不隐式进入模型历史。适当性遵循中国证券业标准——客户容忍度 C1–C5 对应产品风险 R1–R5 外加测评有效期——每条咨询记录都携带逐产品的判定结论以备审计。

<a id="related-documentation"></a>
## 相关文档

- [CRM 子系统](../../docs/subsystems/crm.zh.md) — 服务表面、领域规则与持久布局。
- [`dsh-crm`](crm/README.zh.md) — 服务契约、配置与不变式。
- [`dsh-tool-crm`](tool-crm/README.zh.md) — 工具清单与线上词汇表。
- [Storage domain](../storage/storage-domain/README.zh.md) — 两个包共同构建的 KV 域形态。
- [CRM 插件 Agent Note](../../.agents/notes/implemented/feature/2026-09-04-crm-plugin.zh.md) — 设计记录。

<a id="dev-note"></a>
## 开发备注

无。
