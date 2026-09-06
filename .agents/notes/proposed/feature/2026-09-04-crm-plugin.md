# Agent Note: Enterprise CRM plugin for investment advisory

Status: proposed

English | [中文](2026-09-04-crm-plugin.zh.md)

## Problem

The harness has no Customer Relationship Management capability. An advisory team (投资顾问/财富管理) using `dsh` can keep session logs, but the durable business objects of the domain — clients with risk assessments, the advisor roster, engagement history, suitability-audited consultations, the opportunity pipeline, follow-up tasks — have no home, and the compliance-critical parts of advisory work (Chinese securities suitability C1–C5 vs R1–R5, assessment validity windows, complete audit trails) have no enforcement point.

## Proposal

Two packages form the CRM capability seam under a new `packages/crm/` group:

- `packages/crm/crm` (`@deepseek-ai/dsh-crm`, service `ctx.crm`, inject `storageDomain`, required config `riskProfileValidityDays`): one durable `crm` storage domain with six zod-validated tables (advisors, clients, interactions, consultations, opportunities, tasks), the pure suitability engine, a pipeline stage machine with terminal close semantics, advisor resolution and write-time referential integrity, service-level mutation serialization, and read-model analytics (pipeline, book, task load, suitability audit).
- `packages/crm/tool-crm` (`@deepseek-ai/dsh-tool-crm`, plugin `tool-crm`, inject `tools`+`crm`): 18 model-facing `crm_*` tools owning wire conversion only (ISO 8601 timestamps, closed enum vocabularies, canonical record serialization) under `additionalProperties: false` schemas.

CRM data is a cross-session sidecar domain (like `message-feedback`/`workspace`), not session events; the storage seam is the provider seam; unfavorable suitability verdicts are recorded (complete audit) rather than blocking writes; overdue and profile validity are derived on read, never stored; an invariant companion asserts cross-table referential integrity of landed rows.

## Alternatives considered

- One package combining service and tools — rejected: the capability-seam rule; the service (data + rules) and the tools (model vocabulary) evolve independently.
- A separate CRM Definition/Provider split — rejected: the storage seam is already the swappable provider layer; a CRM-internal provider split would be a seam over a seam.
- Session events for CRM state — rejected: client records must outlive sessions; the per-session log would fork the record per conversation.
- A dedicated delete API — rejected: retirement is lifecycle/stage/status change; the audit posture keeps every row.

## Acceptance criteria

- Both packages typecheck, lint, and pass `pnpm run constraints`, `pnpm run build`, `pnpm run hygiene`.
- Per-file 100% test coverage on every `src` file (the CI coverage gate), including every optional-field and filter-exclusion branch.
- Enterprise-scale deterministic seed data (4 advisors, 60 clients, 170+ interactions, 25 consultations covering every suitability verdict, 40 opportunities closed through the real stage machine, 30 tasks with 12 overdue) with analytics expectations recomputed from the seed itself.
- REAL-loader cordis.yml composition tests for both packages; export-shape and disposal tests.
- README triples with the Model Experience contract, group README, subsystem page, Agent Note, and generated catalog entries (tool, config, capability graph) in both languages; `pnpm run doc-sync` green.

## Risks

- New business-domain group sets a structural precedent: future domain packages will copy this shape, so the seam decisions (sidecar domain, no provider split, audit-not-block) carry forward.
- No hard deletes keeps storage growing monotonically; the audit posture trades space for integrity.
- Single-process mutation ordering: multi-process deployments rely on the storage backend for cross-process ordering.
