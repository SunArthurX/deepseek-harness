---
description: "The import group map: external agent session import — Claude Code / Codex transcripts as continuable DeepSeek Harness sessions — for users and maintainers navigating the group."
kind: "package-group"
---

# packages/import

English | [中文](README.zh.md)

## Summary

The import group brings conversations that happened in other coding agents onto the harness's durable session log. It is one product package, `dsh-session-import`: read-only adapters discover and parse the Claude Code and Codex JSONL stores, a translator replays the source exchange as a validated harness session seed, and the imported session continues through every existing resume path. Imports are idempotent, carry a durable provenance event, and redact credential-shaped strings by default.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`session-import`](session-import/README.md) | Imports external agent conversations as continuable harness sessions; registers the `session_import` tool | `ctx.sessionImport` |
| [`session-import-console`](session-import-console) | Browser management console for the import service: provider tabs, content search, and one-click import at `/session-import-console` | — |

-----

<a id="related-documentation"></a>
## Related documentation

- [Session subsystem](../../docs/subsystems/session.md) — the event log and seed mechanics the translator targets.
- [Generated tool catalog](../../docs/tool-catalog.md) — the `session_import` schema the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md) — every accepted config field.
- [Agent session import Agent Note](../../.agents/notes/implemented/feature/2026-09-03-agent-session-import.md) — the design, alternatives, and deferred adapters.

-----

<a id="dev-note"></a>
## Dev Note

New sources join through the adapter interface (`discover` + `parse` returning an `ExternalConversation`); the translator and service are source-agnostic. Sources whose stores are databases need a maintained reader dependency first — see the package's Known Limitations.
