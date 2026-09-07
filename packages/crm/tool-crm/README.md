---
description: "The model-facing crm_* tools over the investment-advisory CRM service: client book, advisor roster, interactions, suitability-audited consultations, pipeline, follow-up tasks, advisory plans, and reports, for users and maintainers composing the agent's CRM surface."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-crm

English | [中文](README.zh.md)

## Summary

`dsh-tool-crm` gives the agent 22 model-facing `crm_*` tools over the durable advisory CRM: register and list advisors; create, search, read (360°), and update clients; log and list interactions; record suitability-audited consultations; open, move, and list pipeline opportunities; schedule, list, complete, cancel, and reschedule follow-up tasks; create, list, transition, and review the three advisory plan kinds (定投 recurring investment, asset allocation, protection gap); and run pipeline, book, task-load, and suitability reports. The tool layer owns wire conversion only — ISO 8601 timestamps, closed enum vocabularies, and canonical record serialization — while every business rule stays in [`dsh-crm`](../crm/README.md).

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

Mount this package beside `dsh-crm` when the agent itself should operate the advisory CRM: prepare for a client conversation, log what happened, record consultations with suitability verdicts, advance deals, keep follow-ups on schedule, and report on the book. The 360° read is windowed — ten interactions, ten soonest-due open tasks, ten consultations, live deals plus the five most recent wins — so the canonical output stays bounded.

### When to choose it

Choose it when an agent conversation is the working surface for advisory engagement. The tools are read/write over the durable book, so every action lands in storage and outlives the session. Avoid it for automation-only compositions that never run a model, or when a product UI should own CRM edits — those call `ctx.crm` directly.

### Minimal configuration

The plugin takes no configuration; mount it after its two injected services.

```yaml
- name: '@deepseek-ai/dsh-crm'
  config:
    riskProfileValidityDays: 730
- name: '@deepseek-ai/dsh-tool-crm'
```

| Field | Default | Meaning |
|---|---|---|
| *(none)* | — | Tools take explicit parameters; the owning service owns policy |

### Tool roster

| Tool | Purpose |
|---|---|
| `crm_advisor_list` / `crm_advisor_register` | Resolve or add team advisors |
| `crm_client_create` / `crm_client_search` / `crm_client_get` / `crm_client_update` | Client intake, lookup, 360° read, and patch |
| `crm_interaction_log` / `crm_interaction_list` | Engagement history |
| `crm_consultation_record` | Formal consultation with per-product suitability verdicts |
| `crm_opportunity_create` / `crm_opportunity_move` / `crm_opportunity_list` | Pipeline work |
| `crm_task_create` / `crm_task_list` / `crm_task_complete` / `crm_task_cancel` / `crm_task_reschedule` | Follow-up discipline |
| `crm_plan_create` / `crm_plan_list` / `crm_plan_review` / `crm_plan_transition` | Advisory plans: 定投, asset allocation, protection gap |
| `crm_report` | pipeline \| book \| tasks \| suitability aggregations |

### Timestamps and vocabularies

The model speaks ISO 8601 strings and the closed vocabularies (tolerances `C1`–`C5`, product risks `R1`–`R5`, stages, kinds, priorities, topics); the tool layer converts to the service's epoch milliseconds and branded ids at this JSON boundary. Listing tools take explicit `limit` parameters the service clamps to protocol bounds (100 for search, 200 for lists).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tools and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The tool layer is built on three commitments:

- **Wire conversion only.** Business rules live in the service; each `execute` maps arguments to a service request, serializes the record back, and renders one prose line.
- **The JSON boundary is a validation boundary.** Timestamps parse or fail loud; enums are closed at the schema; optional fields flow through the same conditional shape in both directions, so the canonical value matches the declared schema exactly (`additionalProperties: false` everywhere).
- **Honest failure.** Domain failures throw typed errors (`CrmUnknownClientError`, `CrmStageTransitionError`, …) and surface as `isError` results carrying the precise message; no silent fallbacks.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`/`inject`/`apply` registering every tool |
| [`src/wire.ts`](src/wire.ts) | Enum vocabularies, ISO conversion, pure record serializers |
| [`src/schemas.ts`](src/schemas.ts) | Reusable output-schema fragments kept in lockstep with the serializers |
| [`src/tools-client.ts`](src/tools-client.ts) | Advisor and client tools |
| [`src/tools-engagement.ts`](src/tools-engagement.ts) | Interaction and consultation tools |
| [`src/tools-pipeline.ts`](src/tools-pipeline.ts) | Opportunity and task tools |
| [`src/tools-report.ts`](src/tools-report.ts) | The report tool |
| [`src/invariant.ts`](src/invariant.ts) | Empty invariant companion; the owning seam carries the rules |

### Export shape

The plugin is a function/namespace plugin: it exports `name` / `inject` / `apply` and no default export. A stray `export default` would make the Loader's `unwrapExports` collapse the module and drop `inject` (see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Consultation audit emphasis

`crm_consultation_record`'s description instructs the model to record the consultation even when a verdict is unfavorable — the audit trail must be complete — and to surface blocked verdicts instead of recommending. The canonical output repeats per-product verdicts and matched/blocked counts so the constraint stays visible in the result itself.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [crm group map](../README.md) — the sibling group page and its package table.
- [`dsh-crm`](../crm/README.md) — the service owning the data and rules.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-crm) — every `crm_*` schema the model receives.
- [CRM plugin Agent Note](../../../.agents/notes/implemented/feature/2026-09-04-crm-plugin.md) — the design record.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`crm_*` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-crm): 22 tools with closed enum vocabularies (tolerance, product risk, stages, kinds, priorities, topics), ISO 8601 timestamp parameters, and required-id / optional-detail shapes. Each description states its scope and its failure discipline (for example, the consultation tool's record-even-when-blocked instruction).

#### Token effect

Fixed schema cost on every request where the tools are visible; the schemas are static per composition.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas.

### Tool-call history and result

#### What the model sees

Results are canonical records (ISO timestamps, explicit nulls for unknown tolerance/AUM on search rows, derived `overdue` flags on tasks) plus one prose line each; list renderings spell out at most five rows and fold the rest into an overflow count, so result prose stays bounded no matter the page size. Stable failures are the typed service errors, for example ``Error: unknown CRM client '<id>'`` and ``Error: cannot move opportunity '<id>' from 'won' to 'lost': 'won' is terminal``.

#### Token effect

List results are bounded by the caller's `limit` and the protocol cap; single-record results are fixed-shape. Call arguments and results remain in history until compaction.

#### KV Cache effect

Append-only; newly visible calls and results follow the reusable request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tools are a poor fit. They are current package constraints, not a task backlog.

- **No batch operations** — one client, interaction, or deal per call; bulk import belongs to a future provider on the service seam, not to model-facing tools.
- **No UI card specialization** — every pending call renders a generic card; Web Client cards would derive from the raw events when a demand exists.
- **No PTC-specific projections** — the canonical JSON values are already program-friendly, so `run_code` composition needs no dedicated surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: consultation-linked task creation

`crm_consultation_record` deliberately does not auto-create follow-up tasks; the model schedules them explicitly with `crm_task_create`. If repeated flows emerge, an optional `createFollowUpTask` parameter could fold the step in without changing the durable record shape.

</details>
