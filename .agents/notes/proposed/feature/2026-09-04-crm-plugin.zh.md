# Agent Note: 面向投资顾问的企业级 CRM 插件

Status: proposed

[English](2026-09-04-crm-plugin.md) | 中文

## Problem

Harness 没有客户关系管理能力。使用 `dsh` 的顾问团队（投资顾问/财富管理）可以保留会话日志，但该领域的持久业务对象——带风险测评的客户档案、顾问名册、互动历史、适当性审计咨询、商机管线、跟进任务——没有归宿，而顾问工作中合规关键的部分（中国证券业适当性 C1–C5 对 R1–R5、测评有效期窗口、完整审计轨迹）也没有强制点。

## Proposal

两个包在新 `packages/crm/` 组下构成 CRM 能力缝：

- `packages/crm/crm`（`@deepseek-ai/dsh-crm`，服务 `ctx.crm`，注入 `storageDomain`，必填配置 `riskProfileValidityDays`）：一个含六张 Zod 校验表（顾问、客户、互动、咨询、商机、任务）的持久 `crm` 存储域、纯适当性引擎、带终态收尾语义的商机阶段状态机、顾问解析与写入时引用完整性、服务级变更串行，以及读模型分析（管线、客户簿、任务负载、适当性审计）。
- `packages/crm/tool-crm`（`@deepseek-ai/dsh-tool-crm`，插件 `tool-crm`，注入 `tools`+`crm`）：18 个面向模型的 `crm_*` 工具，只负责线上转换（ISO 8601 时间戳、封闭枚举词汇、规范记录序列化），处于 `additionalProperties: false` 模式之下。

CRM 数据是跨会话旁路域（与 `message-feedback`/`workspace` 一致）而非会话事件；存储缝即提供者缝；不利的适当性判定被记录（完整审计）而非阻断写入；逾期与档案有效性在读取时派生、绝不落盘；不变式伴随插件断言落库行的跨表引用完整性。

## Alternatives considered

- 合并服务与工具的单包——否决：能力缝规则；服务（数据+规则）与工具（模型词汇）独立演进。
- 独立的 CRM Definition/Provider 拆分——否决：存储缝已是可替换的提供者层；CRM 内部再拆分是缝上之缝。
- 用会话事件承载 CRM 状态——否决：客户档案必须比会话长寿；每会话日志会按对话分叉记录。
- 专门的删除 API——否决：退役即 lifecycle/stage/status 变更；审计姿态保留每一行。

## Acceptance criteria

- 两个包通过 typecheck、lint,并通过 `pnpm run constraints`、`pnpm run build`、`pnpm run hygiene`。
- 每个 `src` 文件逐文件 100% 测试覆盖率（CI 覆盖率门槛），包括每个可选字段与过滤排除分支。
- 企业规模确定性种子数据（4 名顾问、60 名客户、170+ 互动、覆盖每个适当性判定的 25 次咨询、经真实阶段状态机收尾的 40 个商机、含 12 个逾期的 30 个任务），分析期望从种子自身重算。
- 两个包的 REAL-loader cordis.yml 组合测试；导出形状与销毁测试。
- 带 Model Experience 契约的 README 三联、组 README、子系统页面、Agent Note,以及双语的生成目录条目（工具、配置、能力图）；`pnpm run doc-sync` 全绿。

## Risks

- 新业务领域组树立结构先例：未来领域包会复制此形状，因此缝决策（旁路域、无提供者拆分、审计不阻断）将延续。
- 无硬删除使存储单调增长；审计姿态以空间换完整性。
- 单进程变更排序：多进程部署依赖存储后端提供跨进程排序。
