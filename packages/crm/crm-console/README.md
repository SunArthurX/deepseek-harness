---
description: "The browser management console for the investment-advisory CRM: a single-page admin UI and read/write JSON API over the harness web server, for operators who prefer a dashboard to model-driven tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-crm-console

English | [中文](README.zh.md)

## Summary

`dsh-crm-console` mounts a visual management page for the CRM at `/crm-console` on the harness web server: one self-contained single-page application (dashboard, client book, pipeline board, task list, and the suitability audit trail) plus a read/write JSON API under `/crm-console/api`. The gateway owns translation only — HTTP routing, closed-vocabulary validation at the wire boundary, and JSON envelopes — while every business rule (suitability, the stage machine, referential integrity) stays in [`dsh-crm`](../crm/README.md). Mounting it beside `dsh-crm` in a profile that carries the web server is the only setup.

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

Mount this package when operators need a browser dashboard over the same durable CRM the agent drives: advisors review the pipeline without prompting the model, compliance staff read the suitability audit trail directly, and front-desk staff onboard walk-in clients through a form instead of a chat.

### When to choose it

Choose it when the composition already runs the web server and `dsh-crm`, and humans need read/write access alongside the agent. Avoid it in headless or SDK compositions (no web server to serve it) or when the console must be exposed beyond loopback — it inherits whatever host/port the web server binds and adds no authentication of its own.

### Minimal configuration

The plugin takes no configuration; the mount path (`/crm-console`) is a fixed composition-level contract.

```yaml
- name: '@deepseek-ai/dsh-crm'
  config:
    riskProfileValidityDays: 730
- name: '@deepseek-ai/dsh-crm-console'
```

| Field | Default | Meaning |
|---|---|---|
| *(none)* | — | The console binds to the composed web server's host and port |

### First-run onboarding for new operators

A fresh book shows a three-step welcome card on the dashboard (build the team → create clients with assessments → record consultations with automatic suitability verdicts) plus one button — **🚀 一键载入演示数据** — which loads a realistic demo book (2 advisors, 8 clients covering every tolerance and profile status, 6 interactions, 3 suitability-varied consultations, 5 pipeline deals including stamped won/lost, 4 tasks including one overdue) through the real service rules. It refuses politely on a non-empty book, so pressing it twice never duplicates rows; after loading, every screen has meaningful data to explore and the operator can mirror the same flows against real clients.

### What the console offers

- **总览 dashboard** — client count and AUM, open deals with the weighted forecast, win rate, task load, and assessment-expiry warnings, plus the pipeline funnel and book composition.
- **客户簿 client book** — searchable, filterable client table with lifecycle/tolerance/status pills; a 360° drawer per client (recent interactions, live and won deals, open tasks); client creation and re-assessment dialogs; and one-click consultation recording with automatic suitability verdicts.
- **商机管线 pipeline** — per-stage cards and a deal table with one-click stage advancement (terminal moves auto-stamp close data) and loss abandonment with a reason.
- **跟进任务 tasks** — the open agenda with overdue flags, completion and cancellation in place.
- **适当性审计 audit** — the flattened verdict trail with matched/blocked pills and rationales, newest first.

### API surface

Every UI action rides the JSON API under `/crm-console/api`: `overview`, `advisors` (GET/POST), `clients` (GET search, POST create, GET/PATCH `:id` for the 360° view and updates), `interactions` (GET/POST), `consultations` (GET/POST), `opportunities` (GET/POST, GET `:id`, POST `:id/move`), `tasks` (GET/POST, POST `:id/complete|cancel|reschedule`, GET `:id` for a client's tasks), and `audit` (GET). Writes validate every closed vocabulary at the wire boundary and answer `400` with the precise message; reads answer the same canonical shapes the service produces.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the console and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The console is built on three commitments:

- **A gateway, not a second CRM.** The plugin translates HTTP to `ctx.crm` calls and their results back to JSON; it holds no state, defines no rules, and never touches the durable domain directly. Everything the console shows is what the service would return to the model or an SDK caller.
- **The wire boundary is a validation boundary.** Every closed vocabulary (lifecycles, tolerances, interaction kinds, topics, product kinds, stages, task statuses, priorities) is declared once, typed as the service unions (so drift fails compilation), and enforced on every inbound field — unknown members answer `400` naming the field.
- **Composition over possession.** The console never opens a socket: it registers one exact route (the page) and one prefix route (the API) on `ctx.webServer` and wires both disposers to its own fiber, so unloading the plugin frees the routes while the server keeps listening.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: typed wire vocabularies, body/query readers, the API dispatcher, route registration with fiber-wired disposal |
| [`src/page.ts`](src/page.ts) | The single-page console (one self-contained HTML document, no external assets) |
| [`src/invariant.ts`](src/invariant.ts) | Empty invariant companion; the owning seam carries the rules |

### Export shape

The plugin is a function/namespace plugin: it exports `name` / `inject` / `apply` and no default export. A stray `export default` would make the Loader's `unwrapExports` collapse the module and drop `inject` (see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Request lifecycle

Each API request parses once into an `ApiRequest` (method, path segments, query, optional decoded body), dispatches through one total switch over the resource head, and answers `200` with the service's canonical JSON or `400` with the failure message. Mutations resolve through the service's serialized mutation chain, so two concurrent console writes order exactly like two concurrent model tool calls.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [crm group map](../README.md) — the sibling group page and its package table.
- [`dsh-crm`](../crm/README.md) — the service owning the data and every rule the console displays.
- [`dsh-tool-crm`](../tool-crm/README.md) — the model-facing tools over the same service.
- [Web server](../../host/webserver/README.md) — the route registry the console mounts onto.
- [CRM plugin Agent Note](../../../.agents/notes/implemented/feature/2026-09-04-crm-plugin.md) — the design record for the CRM capability.

-----

<a id="model-experience"></a>
## Model Experience

None, as `dsh-crm-console` registers no tools, prompts, or session events; it is an operator-facing HTTP surface. Indirectly, through `dsh-crm`, console writes change the durable data the model's `crm_*` tools read, so a client created in the browser is immediately visible to `crm_client_search`.

#### KV Cache effect

The console issues no model requests and contributes no prompt or schema content, so it does not invalidate any reusable request prefix; its only model-visible consequence is data changes observable through the tool package's results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the console is a poor fit. They are current package constraints, not a task backlog.

- **No authentication of its own** — the console inherits the web server's bind and whatever fronting proxy the deployment adds; it must not be exposed beyond loopback without one.
- **Read/write surface mirrors the service, not the tools** — reports are served through the overview aggregate only; the `crm_report` tool's four kinds have no dedicated console page yet.
- **One fixed mount path** — `/crm-console` is a composition-level contract; deployments needing a different path must front it with a proxy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: server-sent events for live updates

The page polls on demand today; a live dashboard would subscribe to `domain/changed` and push deltas. The event exists and the seam is clean — the open question is whether one consumer justifies a persistent connection per operator tab.

</details>
