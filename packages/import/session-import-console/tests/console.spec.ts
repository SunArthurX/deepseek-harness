import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionImportService from '@deepseek-ai/dsh-session-import'
import * as Console from '../src/index.ts'
import { CONSOLE_PROVIDERS, dispatchApi } from '../src/index.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-import-console-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** Recorded calls captured by the service double. */
interface DoubleCalls {
  readonly list: unknown[]
  readonly import: unknown[]
}

/** A minimal session-import service double: records calls, returns canned rows. */
function serviceDouble(overrides: Partial<{
  listSources: (options: unknown) => Promise<unknown>
  importSource: (request: unknown) => Promise<unknown>
}> = {}): SessionImportService & { calls: DoubleCalls } {
  const calls: DoubleCalls = { list: [], import: [] }
  const fallbackList = async (options: unknown): Promise<unknown> => {
    calls.list.push(options)
    return []
  }
  const fallbackImport = async (request: unknown): Promise<unknown> => {
    calls.import.push(request)
    return { status: 'imported', sessionId: 'ext-x' }
  }
  return {
    calls,
    listSources: (overrides.listSources ?? fallbackList) as SessionImportService['listSources'],
    importSource: (overrides.importSource ?? fallbackImport) as SessionImportService['importSource'],
  } as SessionImportService & { calls: DoubleCalls }
}

/** Build one dispatch request without going through HTTP. */
function api(method: string, segments: readonly string[], query = new URLSearchParams(), body?: Record<string, unknown>) {
  return dispatchApi(serviceDouble(), body === undefined
    ? { method, segments, query, body: undefined }
    : { method, segments, query, body })
}

describe('api dispatch', () => {
  it('lists the console providers', async () => {
    const response = await api('GET', ['providers'])
    expect(response).toEqual({ ok: true, data: CONSOLE_PROVIDERS })
  })

  it('rejects wrong methods and unknown resources', async () => {
    expect((await api('POST', ['providers'])).ok).toBe(false)
    expect((await api('POST', ['sources'])).ok).toBe(false)
    expect((await api('GET', ['nope'])).ok).toBe(false)
    expect((await api('GET', [])).ok).toBe(false)
  })

  it('forwards provider, query, and limit to listSources', async () => {
    const service = serviceDouble()
    const query = new URLSearchParams({ provider: 'codex', query: 'lucene', limit: '5' })
    const response = await dispatchApi(service, { method: 'GET', segments: ['sources'], query })
    expect(response.ok).toBe(true)
    expect(service.calls.list).toEqual([{ provider: 'codex', query: 'lucene', limit: 5 }])
  })

  it('validates provider and limit on the sources listing', async () => {
    expect((await api('GET', ['sources'], new URLSearchParams({ provider: 'cursor' }))).ok).toBe(false)
    expect((await api('GET', ['sources'], new URLSearchParams({ limit: '-1' }))).ok).toBe(false)
    expect((await api('GET', ['sources'], new URLSearchParams({ limit: 'x' }))).ok).toBe(false)
  })

  it('imports with provider and sourceId, optional targetId', async () => {
    const service = serviceDouble()
    const response = await dispatchApi(service, {
      method: 'POST', segments: ['import'], query: new URLSearchParams(),
      body: { provider: 'zcode', sourceId: 'sess_1', targetId: 'custom-target' },
    })
    expect(response).toEqual({ ok: true, data: { status: 'imported', sessionId: 'ext-x' } })
    expect(service.calls.import).toEqual([{ provider: 'zcode', sourceId: 'sess_1', targetId: 'custom-target' }])
  })

  it('validates the import body fields', async () => {
    expect((await api('POST', ['import'])).ok).toBe(false)
    expect((await api('POST', ['import'], new URLSearchParams(), { sourceId: 'x' })).ok).toBe(false)
    expect((await api('POST', ['import'], new URLSearchParams(), { provider: 'x' })).ok).toBe(false)
    expect((await api('POST', ['import'], new URLSearchParams(), { provider: 'codex' })).ok).toBe(false)
    expect((await api('POST', ['import'], new URLSearchParams(), { provider: 1, sourceId: 'x' })).ok).toBe(false)
    expect((await api('POST', ['import'], new URLSearchParams(), { provider: 'codex', sourceId: '' })).ok).toBe(false)
    expect((await api('POST', ['import', 'extra'], new URLSearchParams(), { provider: 'codex', sourceId: 'x' })).ok).toBe(false)
    expect((await api('GET', ['import'])).ok).toBe(false)
  })

  it('covers non-Error throws, absent query params, and GET-without-body dispatch', async () => {
    // A non-Error throw stringifies through the envelope.
    const thrown = await dispatchApi(serviceDouble({
      importSource: async () => { throw 'raw string failure' },
    }), { method: 'POST', segments: ['import'], query: new URLSearchParams(), body: { provider: 'codex', sourceId: 'x' } })
    expect(thrown).toEqual({ ok: false, error: 'raw string failure' })

    // Sources with no query params at all: every optional is omitted.
    const service = serviceDouble()
    const bare = await dispatchApi(service, { method: 'GET', segments: ['sources'], query: new URLSearchParams() })
    expect(bare.ok).toBe(true)
    expect(service.calls.list).toEqual([{}])

    // A whitespace-only query is still a non-empty string: forwarded verbatim
    // (the page trims before sending; the API does not re-trim).
    const blank = new URLSearchParams({ query: '  ' })
    expect((await dispatchApi(service, { method: 'GET', segments: ['sources'], query: blank })).ok).toBe(true)
    expect(service.calls.list.at(-1)).toEqual({ query: '  ' })
  })

  it('previews with provider and sourceId, optional maxMessages', async () => {
    const calls: unknown[] = []
    const service = {
      previewSource: async (request: unknown, options: unknown) => {
        calls.push({ request, options })
        return { provider: 'codex', sourceId: 'x', messages: [], hasMore: false, totalEntries: 0, totalToolCalls: 0, skippedRecords: 0, oversizedRecords: 0 }
      },
    } as unknown as SessionImportService
    const ok = await dispatchApi(service, {
      method: 'GET', segments: ['preview'],
      query: new URLSearchParams({ provider: 'codex', sourceId: 'x' }),
    })
    expect(ok.ok).toBe(true)
    expect(calls[0]).toEqual({ request: { provider: 'codex', sourceId: 'x' }, options: {} })

    const capped = await dispatchApi(service, {
      method: 'GET', segments: ['preview'],
      query: new URLSearchParams({ provider: 'codex', sourceId: 'x', maxMessages: '5' }),
    })
    expect(capped.ok).toBe(true)
    expect((calls.at(-1) as { options: { maxMessages: number } }).options).toEqual({ maxMessages: 5 })
  })

  it('forwards force to importSource', async () => {
    const service = serviceDouble()
    const response = await dispatchApi(service, {
      method: 'POST', segments: ['import'], query: new URLSearchParams(),
      body: { provider: 'codex', sourceId: 'x', force: true },
    })
    expect(response.ok).toBe(true)
    expect(service.calls.import).toEqual([{ provider: 'codex', sourceId: 'x', force: true }])
  })

  it('syncs with optional provider and limit, validating both', async () => {
    const calls: unknown[] = []
    const service = {
      syncAll: async (options: unknown) => {
        calls.push(options)
        return { results: [], imported: 0, upToDate: 0, conflicts: 0, errors: 0, deferred: 0 }
      },
    } as unknown as SessionImportService
    const bare = await dispatchApi(service, { method: 'POST', segments: ['sync'], query: new URLSearchParams() })
    expect(bare).toEqual({ ok: true, data: { results: [], imported: 0, upToDate: 0, conflicts: 0, errors: 0, deferred: 0 } })
    const scoped = await dispatchApi(service, {
      method: 'POST', segments: ['sync'], query: new URLSearchParams(),
      body: { provider: 'codex', limit: 5 },
    })
    expect(scoped.ok).toBe(true)
    expect(calls.at(-1)).toEqual({ provider: 'codex', limit: 5 })
    expect((await api('GET', ['sync'])).ok).toBe(false)
    expect((await api('POST', ['sync', 'x'])).ok).toBe(false)
    expect((await api('POST', ['sync'], new URLSearchParams(), { provider: 'cursor' })).ok).toBe(false)
    expect((await api('POST', ['sync'], new URLSearchParams(), { limit: -1 })).ok).toBe(false)
    expect((await api('POST', ['sync'], new URLSearchParams(), { limit: 'x' })).ok).toBe(false)
  })

  it('validates the preview query fields', async () => {
    expect((await api('POST', ['preview'])).ok).toBe(false)
    expect((await api('GET', ['preview'])).ok).toBe(false)
    expect((await api('GET', ['preview'], new URLSearchParams({ provider: 'codex' }))).ok).toBe(false)
    expect((await api('GET', ['preview'], new URLSearchParams({ sourceId: 'x' }))).ok).toBe(false)
    expect((await api('GET', ['preview'], new URLSearchParams({ provider: 'cursor', sourceId: 'x' }))).ok).toBe(false)
    expect((await api('GET', ['preview'], new URLSearchParams({ provider: 'codex', sourceId: '' }))).ok).toBe(false)
    expect((await api('GET', ['preview'], new URLSearchParams({ provider: 'codex', sourceId: 'x', maxMessages: '0' }))).ok).toBe(false)
    expect((await api('GET', ['preview'], new URLSearchParams({ provider: 'codex', sourceId: 'x', maxMessages: 'z' }))).ok).toBe(false)
    expect((await api('GET', ['preview', 'extra'], new URLSearchParams({ provider: 'codex', sourceId: 'x' }))).ok).toBe(false)
  })

  it('wraps service failures in the error envelope', async () => {
    const service = serviceDouble({
      importSource: async () => { throw new Error('boom') },
    })
    const response = await dispatchApi(service, {
      method: 'POST', segments: ['import'], query: new URLSearchParams(),
      body: { provider: 'codex', sourceId: 'x' },
    })
    expect(response).toEqual({ ok: false, error: 'boom' })
  })
})

describe('console routes over the web server', () => {
  it('serves the page and the JSON API end to end', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const claudeHome = join(root, 'claude')
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionImportService, {
      claudeHome, codexHome: join(root, 'no-codex'), zcodeHome: join(root, 'no-zcode'), minimaxHome: join(root, 'no-minimax'),
    })
    await ctx.plugin(Console)
    const base = `http://127.0.0.1:${String(ctx.webServer.port)}`

    const page = await fetch(`${base}/session-import-console`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('会话导入控制台')

    const providers = await fetch(`${base}/session-import-console/api/providers`)
    expect(await providers.json()).toEqual({ ok: true, data: CONSOLE_PROVIDERS })

    const sources = await fetch(`${base}/session-import-console/api/sources?provider=claude-code`)
    expect(await sources.json()).toEqual({ ok: true, data: [] })

    const bad = await fetch(`${base}/session-import-console/api/sources?provider=cursor`)
    expect(bad.status).toBe(400)
    expect((await bad.json() as { ok: boolean }).ok).toBe(false)

    const importResult = await fetch(`${base}/session-import-console/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code', sourceId: 'missing' }),
    })
    expect(importResult.status).toBe(400)
    expect((await importResult.json() as { error: string }).error).toContain('was not found')

    await ctx.fiber.dispose()
  }, 30_000)

  it('rejects non-object and invalid JSON bodies with the error envelope', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const claudeHome = join(root, 'claude')
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionImportService, {
      claudeHome, codexHome: join(root, 'no-codex'), zcodeHome: join(root, 'no-zcode'), minimaxHome: join(root, 'no-minimax'),
    })
    await ctx.plugin(Console)
    const base = `http://127.0.0.1:${String(ctx.webServer.port)}/session-import-console/api`

    // Undici sends no content-type for raw string bodies; the gateway parses
    // the bytes regardless, so set the header the page always sends.
    const array = await fetch(`${base}/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]',
    })
    expect(array.status).toBe(400)
    expect((await array.json() as { error: string }).error).toContain('JSON object')

    const broken = await fetch(`${base}/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope',
    })
    expect(broken.status).toBe(400)
    expect((await broken.json() as { error: string }).error).toContain('invalid JSON body')

    const empty = await fetch(`${base}/import`, { method: 'POST' })
    expect(empty.status).toBe(400)
    expect((await empty.json() as { error: string }).error).toContain('`provider` is required')

    await ctx.fiber.dispose()
  }, 30_000)
})

describe('invariant companion', () => {
  it('registers under the invariants service', async () => {
    const Companion = await import('../src/invariant.ts')
    const registered: string[] = []
    const ctx = {
      invariants: { register: (name: string) => { registered.push(name); return () => {} } },
    } as unknown as Context
    const dispose = await Companion.apply(ctx)
    expect(registered).toEqual(['@deepseek-ai/dsh-session-import-console'])
    expect(typeof dispose).toBe('function')
  })
})
