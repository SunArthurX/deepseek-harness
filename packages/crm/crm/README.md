---
description: "The investment-advisory CRM capability: the durable client book, advisor roster, interactions, suitability-audited consultations, opportunity pipeline, follow-up tasks, and read-model analytics behind ctx.crm, for users and maintainers composing or extending the CRM."
kind: "package-reference"
---

# @deepseek-ai/dsh-crm

English | [中文](README.zh.md)

## Summary

`dsh-crm` is the durable Customer Relationship Management capability for the investment-advisory domain (投资顾问/财富管理). It owns one `crm` storage domain with six tables — advisors, clients, interactions, consultations, opportunities, and tasks — plus the business rules that keep them coherent: the Chinese-securities suitability standard (client tolerance C1–C5 against product risk R1–R5 with a configurable assessment validity window), a pipeline stage machine with terminal close semantics, advisor resolution and referential integrity on every write, and derived (never stored) overdue flags. Read models aggregate the pipeline, the client book, the task load, and the suitability audit trail. The service is backend-agnostic: the deployment's `storageDomain` routes it to SQLite or JSON through the storage seam.

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

Mount this package when a composition needs durable advisory CRM data: client profiles with risk assessments, engagement history, suitability-audited consultations, a sales pipeline, and follow-up tasks that outlive any conversation. Model-facing surfaces reach it through [`dsh-tool-crm`](../tool-crm/README.md); product surfaces call `ctx.crm` directly.

### When to choose it

Choose it when CRM data must persist across sessions behind one service, with the storage backend chosen by the deployment. The service owns validation and business rules; it never renders anything to a model. Do not use it for per-session scratch state — that belongs on the session log — or when you need a remote CRM system of record; those would be future providers on the same seam.

### Minimal configuration

`riskProfileValidityDays` is required with no default: a composition that omits it fails at load. It decides how long one risk assessment satisfies suitability before re-assessment is required; a re-assessment restarts the window.

```yaml
- name: '@deepseek-ai/dsh-crm'
  config:
    riskProfileValidityDays: 730
```

| Field | Default | Meaning |
|---|---|---|
| `riskProfileValidityDays` | required | Days one risk assessment stays valid; expiry blocks suitability until re-assessment |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-crm) is the exhaustive source for the accepted field.

### What the service guarantees

- **Suitability before recommendation.** `recordConsultation` evaluates every discussed product against the client's profile at consultation time — matched, product-exceeds-profile, assessment-expired, or missing-profile — and stores the verdict with rationale in the durable record. An unfavorable verdict never blocks the record: the audit trail must be complete.
- **A closed stage machine.** `won`, `lost`, and `abandoned` are terminal; entering `lost` or `abandoned` requires a close reason; entering any terminal stage stamps the close time and forces the stage's probability (won 100, lost/abandoned 0).
- **Referential integrity at write time.** Every advisor-scoped row references an existing client and advisor at the moment it lands; a task's optional client and opportunity must agree with each other.
- **Overdue is derived.** A task past due is computed on read against the caller's clock; nothing stale is stored.
- **Serialization by construction.** All mutations run on one service-level chain, so each read-validate-write step observes the previous one's landed state.

### Analytics

`pipelineSnapshot` aggregates per-stage counts, amounts, a probability-weighted forecast, and the win rate; `bookSnapshot` distributes clients by lifecycle and tolerance with AUM totals and assessment-expiry notices (a fixed 30-day warning window); `taskLoad` reports open and overdue counts by priority with the next due items; `suitabilityAudit` flattens every recorded product verdict into one audit trail. Every snapshot accepts an optional advisor scope.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on four commitments:

- **Cross-session sidecar, not session state.** CRM records must outlive any conversation and never enter model history implicitly; the domain store is the source of truth, exactly like `message-feedback` and `workspace`.
- **Business rules live in one place.** Suitability, stage transitions, advisor resolution, and value constraints are enforced inside the service's mutation chain — the tool layer and any future provider inherit them.
- **The storage seam is the provider seam.** The service injects only `storageDomain`; SQLite, JSON, and any future backend are deployment choices behind one interface, so the CRM needs no provider split of its own.
- **Deterministic reads.** Text ordering uses UTF-16 code units rather than `localeCompare`, so listings sort identically on every ICU build.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `CrmService` (`ctx.crm`), request types, error classes, and the mutation chain |
| [`src/types.ts`](src/types.ts) | Pure domain types: branded ids, closed vocabularies, records, read models |
| [`src/spec.ts`](src/spec.ts) | Zod record schemas and the `crm` domain declaration |
| [`src/suitability.ts`](src/suitability.ts) | The pure suitability engine |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion asserting cross-table referential integrity |

### Suitability engine

`evaluateSuitability(profile, product, now)` is pure: checks run in a fixed order — missing profile, expired assessment (expiry is inclusive), then tolerance level versus product level — and each verdict carries a rationale naming the deciding levels or dates, so the audit trail explains itself. `riskProfileValidityDays` only derives expiry windows; the rule structure is a fixed domain standard.

### Mutation chain and disposal

Every write method queues one whole read-validate-write job on a single promise chain and rejects new work once disposal begins, mirroring `message-feedback`'s per-session tails but service-wide, because CRM mutations span clients. The service's `[Service.init]` opens the domain, binds the tables, and installs a `ctx.effect` disposer that closes the domain after the chain drains.

### Durable-boundary validation

The zod schemas in `src/spec.ts` validate every record as the domain loads it: enum vocabularies, currency shape, score and probability ranges, expiry not preceding assessment, close times only on terminal deals, close reasons on lost/abandoned, and completion times only on done tasks. The service produces records that satisfy them by construction; the boundary rejects anything else.

### Invariant companion

The companion listens to `domain/changed` for the `crm` domain and asserts that every landed row references existing client/advisor/opportunity records — the same rules the service enforces inside each mutation, asserted again over whatever reaches the medium by any path.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [crm group map](../README.md) — the sibling group page and its package table.
- [`dsh-tool-crm`](../tool-crm/README.md) — the model-facing tools over this service.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-crm) — every accepted config field and its source declaration.
- [Storage domain](../../storage/storage-domain/README.md) — the KV domain form this service consumes.
- [CRM plugin Agent Note](../../../.agents/notes/implemented/feature/2026-09-04-crm-plugin.md) — the design record for this capability.

-----

<a id="model-experience"></a>
## Model Experience

None, as `dsh-crm` is a host-side service with no model-facing surface. Indirectly, through `dsh-tool-crm`, its tools expose the service's data to the model; the schema and token effects are owned by that package.

#### KV Cache effect

The service issues no model requests and contributes no prompt or schema content, so it does not invalidate any reusable request prefix; its only model-visible consequence arrives through the tool package's tool calls and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the service is a poor fit. They are current package constraints, not a task backlog.

- **No hard deletes** — clients retire to lifecycle `lost`, deals to `abandoned`, tasks to `cancelled`; the audit posture keeps every row, so storage grows monotonically.
- **Single-process serialization** — the mutation chain orders writes inside one service instance; multi-process deployments need the deployment's storage backend to provide cross-process ordering.
- **No remote providers yet** — the seam anticipates remote CRM adapters (system-of-record sync), but only the domain-storage implementation exists.
- **Single currency per record** — monetary fields share one ISO 4217 code per record; no conversion or multi-currency netting.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: pagination and secondary indexes

List methods filter and sort in memory over the domain's snapshot, which is honest at advisory-team scale (thousands of clients). A future revision may add cursor pagination once a real deployment outgrows the protocol bounds.

</details>
