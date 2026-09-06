---
description: "The browser management console for session import: a single-page admin UI and JSON API over the harness web server, for operators who prefer a dashboard to model-driven tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-import-console

English | [中文](README.zh.md)

## Summary

`dsh-session-import-console` mounts a visual management page for session import at `/session-import-console` on the harness web server: one self-contained single-page application (provider tabs, content search, per-conversation import state) plus a read/write JSON API under `/session-import-console/api`. The gateway owns translation only — HTTP routing, closed-vocabulary validation at the wire boundary, and JSON envelopes — while every business rule (discovery, translation, idempotency, redaction) stays in [`dsh-session-import`](../session-import/README.md). Mounting it beside `dsh-session-import` in a profile that carries the web server is the only setup.

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

Mount this package when operators need a browser dashboard over the same import service the model drives: review which external conversations exist, search them by content, and import them — without prompting the model at all.

### When to choose it

Choose it when the composition already runs the web server and `dsh-session-import`, and humans need import access alongside the agent. Avoid it in headless or SDK compositions (no web server to serve it) or when the console must be exposed beyond loopback — it inherits whatever host/port the web server binds and adds no authentication of its own; the importing `session_import` model tool needs no console.

### Minimal configuration

The plugin takes no configuration; the mount path (`/session-import-console`) is a fixed composition-level contract.

```yaml
- name: '@deepseek-ai/dsh-session-import'
  config:
    redactSecrets: true
- name: '@deepseek-ai/dsh-session-import-console'
```

| Field | Default | Meaning |
|---|---|---|
| *(none)* | — | The console binds to the composed web server's host and port |

### What the console offers

- **提供方页签 provider tabs** — Claude Code / Codex / ZCode / MiniMax, each listing its conversations newest first with imported-state badges.
- **内容检索 search** — a substring filter forwarded to the service (SQLite `LIKE` on ZCode/MiniMax, streaming file scan on the JSONL stores).
- **同步全部 sync-all** — refreshes the sidebar listing by re-discovering every source store. It never imports anything; importing happens only through a conversation's own button.
- **导入 import** — one click per conversation; the outcome pill distinguishes `imported`, `up-to-date`, and `conflict` (a changed source re-imports as a versioned `-v2` target via the re-import button, never overwriting).

### API surface

Every UI action rides the JSON API under `/session-import-console/api`: `providers` (GET), `sources` (GET with optional `provider`/`query`/`limit`), and `import` (POST with `provider`/`sourceId`/optional `targetId`). Every answer is `{ ok: true, data }` or `{ ok: false, error }`; failures answer `400` with the precise message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **A gateway, not a second importer.** The plugin translates HTTP to `ctx.sessionImport` calls and their results back to JSON; it holds no state and never touches source stores itself. Everything the console shows is what the service would return to the model tool.
- **The wire boundary is a validation boundary.** The provider vocabulary is declared once, typed as the service union, and enforced on every inbound field — unknown members answer `400` naming the field.
- **Composition over possession.** The console never opens a socket: it registers one exact route (the page) and one prefix route (the API) on `ctx.webServer`, so unloading the plugin frees the routes while the server keeps listening.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: route registration, JSON-body reading, the envelope-writing handler |
| [`src/api.ts`](src/api.ts) | The API dispatcher: request validation and service-call translation |
| [`src/page.ts`](src/page.ts) | The single-page console (one self-contained HTML document, no external assets) |
| [`src/invariant.ts`](src/invariant.ts) | Empty invariant companion; the owning seam carries the rules |

### Request lifecycle

Each API request parses once into an `ApiRequest` (method, path segments, query, optional decoded body), dispatches through one total switch over the resource head, and answers `200` with the service's canonical JSON or `400` with the failure message. The whole branch — body decode included — answers through the envelope, so the page never parses a bare status code.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [session-import](../session-import/README.md) — the service this console mounts: providers, idempotency, redaction.
- [import group map](../README.md) — the sibling group page and its package table.
- [CRM console](../../crm/crm-console/README.md) — the same console pattern over a different service, with richer read/write views.

-----

<a id="model-experience"></a>
## Model Experience

None, as the console registers no tool, prompt section, or session event, and its only model-visible consequence is data the `session_import` tool reads.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the console is intentionally minimal. They are current package constraints, not a task backlog.

- **No authentication of its own** — the console inherits the web server's binding; exposing a non-loopback host exposes the import API to that network unauthenticated.
- **Listing without pagination UI** — the API accepts `limit`; the page always renders the full listing for the active tab and query.
- **No continue action** — imports land as ordinary sessions; continuing stays in the harness's native session surfaces, deliberately not duplicated here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: settings-panel integration

The main web client's settings panel could host a deeper integration (Typert remote namespace plus a `settings.section` slot) instead of this standalone page; the standalone console ships first because it composes with any web-server profile without client-bundle wiring.

</details>
