# Agent Note: Import external agent sessions as continuable harness sessions

Status: implemented

English | [中文](2026-09-03-agent-session-import.zh.md)

## Problem

Work that started in another coding agent — Claude Code, Codex — was stranded there: the harness could delegate one-shot tasks to those agents (the subagent providers), and could even run them as children, but a conversation that already happened in them could not move onto the harness's durable session log. Teams lost the context those conversations produced or kept copy-pasting it by hand, and any governance the harness applies to its own sessions (durability, projection, export, redaction at the model edge) never reached foreign history. The on-disk stores were already local — `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**` — but nothing in the repo read them.

## Decision

New package `packages/import/session-import` (`@deepseek-ai/dsh-session-import`, plugin `session-import`, service `ctx.sessionImport`) implements a four-stage pipeline: **discover** (read-only listing of each store), **parse** (store lines → provider-neutral `ExternalConversation` entries), **translate** (entries → a validated harness session seed), **materialize** (seed → durable session through the composed persistence backend, bypassing the live store). The model gets a `session_import` tool (`list`/`import`); drivers get `continueSession`, which resumes the imported session and follows up with a prompt.

Load-bearing choices:

- **The imported log is a first-class seed, not a transcript attachment.** It opens with a `request/header` carrying the source model, records a `session-import/source` provenance event (source id/path/size/mtime, import time, redaction and skip counts) at seq 1, and replays exchanges as balanced turns whose assistant tool calls keep their names and arguments. This is what makes the result continuable by the ordinary loop, forkable, projectable, and exportable with zero extra glue.
- **Every assistant tool call is closed.** A call the source never answered gets an explicit error tool result; a call recorded without its assistant message opens an implicit one; a result without its call is skipped and counted. An unclosed tool call would make the first continued request provider-invalid, so the translator guarantees balance and validates its own output (`findSeedStructuralError`) before returning.
- **Materialize through persistence, not the live store.** `importSource` writes `persistence.create(header)` + `append(id, seed)` directly. The session therefore never blocks the resume path (a live session rejects `persistence.prepare`), and in-process continuation is the same code path as cross-process continuation. Without a composed persistence backend the import fails loudly — an in-memory import would be lost on exit and is not offered.
- **Idempotency is provenance-based.** The deterministic target id `ext-<provider>-<sourceId>` plus the stored provenance's size/mtime give `imported` / `up-to-date` / `conflict` semantics; a target owned by a non-import session is a hard `TargetCollisionError`, never an overwrite.
- **Redaction is default-on and logged.** Imported history will be sent to the model on the next turn, so credential-shaped strings (AWS/GitHub/Slack/OpenAI/Anthropic/Google tokens, PEM blocks) are replaced with `[REDACTED:<kind>]` before the log is written; the count lands in the provenance event. Deployments can opt out explicitly.
- **Foreign noise is not user content.** Claude `isMeta` lines, `system-reminder`/command markup, Codex `<environment_context>`-style injections, `wait` polls, and token-count events are stripped or skipped, counted in `skippedRecords`, and never become user messages.

## Alternatives considered

- **Resume the foreign agent instead of importing** (shell out to `claude --resume <id>` / `codex resume <id>`, the Threadock approach) — rejected as the primary mechanism: it keeps history in the foreign runtime, outside the harness log, and needs the foreign CLI installed at continue time. The import outcome still carries `sourceResumeHint` because both destinations are legitimate.
- **Piggyback on the subagent seam** — a delegation provider creates NEW child sessions; importing is a different contract (adopt existing history, no turn is ever run by the source). Reuse would have bent one seam to two contracts.
- **Hand-rolled transcript framing in the model context** (paste a summary of the foreign conversation into the system prompt) — durable nowhere, invisible to projection/UI/export, and unbounded in size.
- **Seed straight into `sessions.create`** — the first implementation did; it left the session live in the process, which then blocked the resume path (`persistence.prepare` refuses live sessions) and made in-process continuation impossible without store-removal APIs that do not exist. Direct persistence writes are the backend's own contract and need no live session.
- **Support the SQLite stores (Cursor, ZCode, MiniMax) in v1** — deferred: it needs a maintained SQLite reader dependency, which is a deliberate decision the JSONL sources do not require. The adapter interface is the seam; these sources land behind it.

## Design refinements after first contact with real stores

Three decisions changed when the adapters met real corpora (a 20 GB Codex store whose largest rollout is 4.7 GB, and Claude transcripts with multi-text-block user lines), and both refinements are covered by tests on synthetic fixtures mirroring the real shapes:

- **Streaming parse.** Whole-file reads died on multi-gigabyte rollouts; `parseJsonlFile` now streams line by line with a bounded per-line cap, so memory is constant at any file size, and the default `maxFileBytes` budget rose from 64 MB to 2 GB (time-guard only — real rollouts exceed the old default). Codex first-line discovery likewise reads a bounded 256 KB prefix instead of stat-gated whole files.
- **Named custom tool calls.** The JS-bridge parser (`tools.<name>(...)`) assumed Codex's new encoding, but real rollouts carry `custom_tool_call` records with an explicit `name` (apply_patch) and a raw patch as `input`; a named record is now imported with `{"input": ...}` arguments and its output pairs by `call_id`, instead of being dropped with its result (the worst single loss measured on real data: 217+ edit calls in one 604 MB rollout).
- **Listing completeness.** `listSources` supports a `limit` (newest first, via the model tool's `limit` argument), imported listing rows carry the resumable harness `sessionId`, and per-cause skip accounting separates `skippedRecords` (unreadable/unrecognized/injected) from `oversizedRecords` (over the per-line size cap).
- **Record semantics.** Codex `event_msg` telemetry and encrypted-only `reasoning` items are recognized-and-ignored (not skip-counted); injected Codex user contexts, developer-role messages, and Claude `isSidechain` lines are recognized-and-counted; `is_error` (Claude) and exit-code envelopes (Codex) flow into the tool-result error flag so imported failures stay failures.

## Consequences

An imported session is an ordinary session: resume (ACP, profiles, SDK), fork, titles, projection, and export all work without glue, and the first continued request carries the full foreign history to the configured model route. New durable vocabulary was added (`session-import/source`), so the generated persistence catalog gained the type and a package invariant companion enforces one provenance record per session at seq 1. Import is explicit and one-shot — there is no watcher tailing live foreign sessions and no auto-sync; `claude --resume`-style hints remain available in the outcome for users who want the source tool instead. The known-event vocabulary means older runtimes refuse imported logs loudly rather than misreading them, which is the intended fail-closed behavior for cross-version movement of these sessions.
