---
description: "Import conversations recorded by external coding agents (Claude Code, Codex) as fully continuable DeepSeek Harness sessions, with read-only adapters, secret redaction, idempotent provenance, and the session_import tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-import

English | [中文](README.zh.md)

## Summary

`dsh-session-import` brings conversations that happened in other coding agents into this harness: it discovers the on-disk session stores of Claude Code (`~/.claude/projects/**/*.jsonl`), Codex (`~/.codex/sessions/**` and `~/.codex/archived_sessions/**`), ZCode (`~/.zcode/cli/db/db.sqlite`), and MiniMax (`~/.minimax/v2/sqlite/runtime-state.sqlite`) — the SQLite stores read through the built-in `node:sqlite` module, parses them read-only into a provider-neutral transcript, and materializes each conversation as a brand-new DeepSeek Harness session whose log replays the original exchange. An imported session is an ordinary harness session — it resumes, continues, forks, exports, and projects through every existing surface, because its history is a validated seed in the standard event format. Every import is idempotent, records its source in a durable provenance event, and redacts credential-shaped strings before they can reach a later model request.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when work started in another agent and should continue here: a conversation that produced context worth keeping, an unfinished task, or a transcript the team wants on the harness's durable log. Mounting the plugin is the only setup; the model then gets the `session_import` tool, and drivers get the `ctx.sessionImport` service.

### When to choose it

Choose it when the source agent stores JSONL transcripts on the same machine and the goal is continuation on this harness — the common migration shape. Avoid it when you only need to delegate one-shot tasks to those agents (the `dsh-subagent-claude-code` and `dsh-subagent-codex` providers cover that) or when the source store is a database rather than JSONL (Cursor, this harness's own sessions — see limitations).

### Minimal configuration

Home-directory settings fall back to the current user's `~/.claude` and `~/.codex`; every other field has a documented default applied in the service's explicit resolve step. A source conversation that records no model id is imported only when `defaultModel` (or the request) supplies one — the import fails loudly otherwise, never guesses.

```yaml
- name: '@deepseek-ai/dsh-session-import'
  config:
    redactSecrets: true
```

| Field | Default | Meaning |
|---|---|---|
| `claudeHome` | `~/.claude` | Claude home directory to scan |
| `codexHome` | `~/.codex` | Codex home directory to scan |
| `zcodeHome` | `~/.zcode` | ZCode home directory to scan |
| `minimaxHome` | `~/.minimax` | MiniMax home directory to scan |
| `defaultModel` | none | Model id recorded when a source conversation reports none |
| `maxFileBytes` | `2147483648` | Rejection budget for one source file, in bytes; real Codex rollouts reach multiple gigabytes |
| `maxToolResultChars` | `20000` | Per-tool-result text cap, in characters |
| `includeReasoning` | `false` | Keep source reasoning text as `reasoning` blocks |
| `redactSecrets` | `true` | Replace credential-shaped substrings before import |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for the accepted fields.

### What an import produces

One import reads one source conversation and creates one new session with the deterministic id `ext-<provider>-<sourceId>`. The imported log opens with a `request/header` carrying the source model, followed by a `session-import/source` provenance event (source id, path, size, mtime, import time, redaction and skip counts), then the source exchanges replayed as balanced turns. Assistant tool calls keep their names and arguments and are always closed by a tool result — a result the source never recorded becomes an explicit error result, so the first continued request is provider-valid. The session's `cwd` is the source conversation's working directory when it is absolute.

### Idempotency and conflicts

Importing an unchanged source again returns `up-to-date` — the check compares the stored provenance's size and mtime against the source file. When the deterministic target already exists and holds a DIFFERENT import (or the source changed since), the import returns `conflict` rather than overwriting history; pass an explicit `targetId` to import the changed source as a new session, and a collision with a non-import session is a hard error.

### Continuing an imported session

An imported session continues like any session: drivers call `ctx.sessionImport.continueSession(id, prompt, { agentOptions })`, which follows up on the live agent or resumes the persisted one, or compose `ctx.agents.resume({ resumeSessionId })` directly. The `agentOptions` route is the deployer's model decision; the imported header never dispatches anywhere.

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

### Reading sources safely

Adapters open source files read-only, never write them, and never follow live-app conventions beyond reading complete lines. Files over `maxFileBytes` are rejected; lines that do not parse are counted on the conversation (visible in the provenance event) instead of failing the import; Codex's first-line discovery reads one bounded line per rollout.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Design and source map — click to expand</summary>

The pipeline is four stages, each a pure module boundary: discover (list stores), parse (store lines → `ExternalConversation` entries), translate (entries → session seed events), materialize (seed → live session through `ctx.sessions.create` and optional persistence `ensureMaterialized`). The translator is the correctness core: it buffers assistant text so tool-call blocks attach to the right assistant message, opens an implicit assistant message for calls recorded without one, synthesizes error results for calls the source never answered, and validates its own output with `findSeedStructuralError` before returning.

| Concern | Source |
|---|---|
| Plugin entry: config, service, tool registration | [src/index.ts](src/index.ts), [src/service.ts](src/service.ts) |
| Claude Code adapter (discovery + parse) | [src/adapters/claude-code.ts](src/adapters/claude-code.ts) |
| Codex adapter (rollouts, legacy + JS-bridge calls) | [src/adapters/codex.ts](src/adapters/codex.ts) |
| Shared parsing guards and sanitizers | [src/adapters/shared.ts](src/adapters/shared.ts) |
| Bounded JSONL reading with skip accounting | [src/jsonl.ts](src/jsonl.ts) |
| Entries → seed events, structural validator | [src/translate.ts](src/translate.ts) |
| Credential redaction rules | [src/redact.ts](src/redact.ts) |
| Provenance event vocabulary | [src/types.ts](src/types.ts) |
| Provenance invariants (one record, at seq 1) | [src/invariant.ts](src/invariant.ts) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Extension cookbook](../../../docs/cookbook/extension-cookbook.md) — the extension points this package composes (`ctx.sessions`, `ctx.agents`, `ctx.tools`).
- [Session subsystem reference](../../../docs/subsystems/session.md) — the event log and seed mechanics the translator targets.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-session-import) — the `session_import` schema the model receives.
- [Generated configuration catalog](../../../docs/config-catalog.md) — every accepted config field and its source declaration.
- [Agent session import Agent Note](../../../.agents/notes/implemented/feature/2026-09-03-agent-session-import.md) — the design, alternatives, and deferred adapters.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`session_import` schema](../../../docs/tool-catalog.md#deepseek-aidsh-session-import): a required `action` of `list` or `import`, an optional `provider` (`claude-code` or `codex`; required for `import`), an optional `sourceId` from a previous listing, and an optional `limit` capping `list` rows to the newest conversations. The description tells the model importing is idempotent and never overwrites an existing target.

#### Token effect

Fixed schema cost on every request where the tool is visible; the description is stable for a given configuration. `list` results grow with the number of external conversations on the machine.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

A `list` call returns one row per discovered conversation (`provider`, `sourceId`, `imported`, `sizeBytes`, `mtimeMs`) and the model-facing text `Discovered <n> external conversation(s).` An `import` call returns `action`, `status` (`imported`, `up-to-date`, or `conflict`), the new `sessionId`, and the source title when imported — rendered as `Import <status>: <sessionId>`. Failures are the typed errors: missing `provider`/`sourceId`, an unknown source id, or a rejected source (over budget, empty, or model-less without a fallback).

#### Token effect

Listing rows scale with the store size the deployment exposes; import results are small and fixed-shape.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the package is a poor fit. They are current package constraints, not a task backlog.

- **Cursor remains unsupported** — ZCode and MiniMax are covered (SQLite via the built-in `node:sqlite`); Cursor's store shape still needs its own adapter.
- **One-shot import, no live watching** — re-import is explicit; there is no file watcher that tails a live foreign session, and no auto-sync.
- **History fidelity is transcript-fidelity** — source reasoning is dropped unless `includeReasoning` is set, harness-injected blocks are stripped, and usage/accounting is not imported; the imported log replays the conversation, not the foreign runtime. Lines over the per-line cap and results over `maxToolResultChars` are dropped or truncated with the counts recorded in the provenance event.
- **Non-text tool-result content is not carried over** — image or other non-text blocks inside a foreign tool result contribute no text; the result imports with an explicit placeholder when it had none at all.
- **Skips are counted by cause** — unreadable/unrecognized records and injected runtime blocks count under `skippedRecords`; lines dropped for exceeding the size cap count under `oversizedRecords`. Both travel on the `session-import/source` event.
- **Redaction is pattern-based and default-on** — shape-strict rules keep false positives out of prose, but a credential format outside the rule set passes through; set `redactSecrets: false` only for stores you would send to the model unredacted.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

#### Future: SQLite-backed sources and a user command

The adapter interface (`discover` + `parse` returning `ExternalConversation`) is the seam for new sources; a SQLite adapter needs a dependency decision first. A user-facing `/import` command over the commands seam, and an auto-sync loop with freshness windows, are product decisions that follow the same service API.

</details>
