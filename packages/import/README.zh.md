---
description: "import 分组地图：外部智能体会话导入——将 Claude Code / Codex 转录变为可在 DeepSeek Harness 上继续的会话——供用户与维护者导航。"
kind: "package-group"
---

# packages/import

[English](README.md) | 中文

## 摘要

import 分组把发生在其他编码智能体里的对话带上 harness 的持久会话日志。它是一个产品包 `dsh-session-import`：只读适配器发现并解析 Claude Code 与 Codex 的 JSONL 存储，翻译器把来源交流重放为通过校验的 harness 会话种子，导入出的会话经由全部既有恢复路径继续执行。导入幂等、携带持久溯源事件，并默认对凭据样式的字符串脱敏。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [维护者备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`session-import`](session-import/README.zh.md) | 将外部智能体对话导入为可继续的 harness 会话；注册 `session_import` 工具 | `ctx.sessionImport` |
| [`session-import-console`](session-import-console) | 导入服务的浏览器管理台：提供方页签、内容检索与一键导入，挂载于 `/session-import-console` | — |

-----

<a id="related-documentation"></a>
## 相关文档

- [会话子系统](../../docs/subsystems/session.zh.md) — 翻译器目标的事件日志与种子机制。
- [生成的工具目录](../../docs/tool-catalog.zh.md) — 模型收到的 `session_import` schema。
- [生成的配置目录](../../docs/config-catalog.zh.md) — 全部接受配置字段。
- [智能体会话导入 Agent Note](../../.agents/notes/implemented/feature/2026-09-03-agent-session-import.zh.md) — 设计、备选方案与延后的适配器。

-----

<a id="dev-note"></a>
## 维护者备注

新来源通过适配器接口（`discover` + `parse`，返回 `ExternalConversation`）接入；翻译器与服务与来源无关。存储为数据库的来源需要先落定维护中的读取依赖——见包页的已知限制。
