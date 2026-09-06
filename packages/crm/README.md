---
description: "The crm package group: the investment-advisory CRM capability — a durable service and its model-facing tools — for users and maintainers choosing, composing, or debugging the CRM."
kind: "package-group"
---

# crm/ — investment-advisory CRM

English | [中文](README.zh.md)

## Summary

The crm group owns the Customer Relationship Management capability for the investment-advisory domain: durable client records with risk assessments, advisor roster, engagement history, suitability-audited consultations, the opportunity pipeline, follow-up tasks, and read-model analytics. One service package owns the data and business rules behind `ctx.crm`; one tool package exposes them to the model as `crm_*` tools; one console package gives operators a browser dashboard over the same service. The split follows the capability-seam rule: storage backends are the swappable provider layer through `ctx.storageDomain`, so the CRM needs exactly the two packages whose roles evolve independently.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`crm`](crm/README.md) | The CRM capability: durable domain, suitability engine, stage machine, analytics behind `ctx.crm` |
| [`tool-crm`](tool-crm/README.md) | Model-facing `crm_*` tools over `ctx.crm` |
| [`crm-console`](crm-console/README.md) | Browser management console: single-page admin UI + JSON API over `ctx.crm` |

CRM data is cross-session durable sidecar state: client records outlive any conversation and never enter model history implicitly. Suitability follows the Chinese securities standard — client tolerance C1–C5 against product risk R1–R5 with an assessment validity window — and every recorded consultation carries its per-product verdicts for audit.

<a id="related-documentation"></a>
## Related documentation

- [CRM subsystem](../../docs/subsystems/crm.md) — the service surface, domain rules, and durable layout.
- [`dsh-crm`](crm/README.md) — the service contract, configuration, and invariants.
- [`dsh-tool-crm`](tool-crm/README.md) — the tool roster and wire vocabulary.
- [Storage domain](../storage/storage-domain/README.md) — the KV domain form both packages build on.
- [CRM plugin Agent Note](../../.agents/notes/implemented/feature/2026-09-04-crm-plugin.md) — the design record.

<a id="dev-note"></a>
## Dev Note

None.
