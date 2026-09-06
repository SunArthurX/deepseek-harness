// Real-HTTP integration for the console gateway: boots the actual WebServer on
// an OS-assigned loopback port with the real CRM service behind it, then walks
// every API resource over fetch — including wire-boundary rejections — and
// proves disposal releases the routes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import CrmService from '@deepseek-ai/dsh-crm'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as ConsoleGateway from '../src/index.ts'
import * as ConsoleInvariant from '../src/invariant.ts'

let ctx: Context | undefined
let base: string | undefined
let consoleFiber: Awaited<ReturnType<Context['plugin']>> | undefined

beforeEach(async () => {
  const next = new Context()
  await next.plugin(Storage)
  next.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(next, { backend: 'memory', routes: {} })
  next.storage.mount('domain', facility)
  next.provide('storageDomain', facility)
  await next.plugin(CrmService, { riskProfileValidityDays: 730 })
  await next.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  consoleFiber = await next.plugin(ConsoleGateway)
  ctx = next
  base = `http://127.0.0.1:${String(next.webServer.port)}`
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  base = undefined
  consoleFiber = undefined
})

interface Json {
  [key: string]: unknown
}

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`)
}

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { status: response.status, json: await response.json() as Json }
}

describe('console page', () => {
  it('serves the single-page console at the fixed path', async () => {
    const response = await get('/crm-console')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('投顾 CRM 控制台')
    expect(html).toContain('client-q')
  })
})

describe('console API', () => {
  it('answers the overview with all three snapshots', async () => {
    const { status, json } = await send('GET', '/crm-console/api/overview')
    expect(status).toBe(200)
    expect(json.pipeline).toMatchObject({ openCount: 0, wonCount: 0 })
    expect(json.book).toMatchObject({ totalClients: 0 })
    expect(json.taskLoad).toMatchObject({ open: 0, overdue: 0 })
  })

  it('walks the full advisory lifecycle over HTTP', async () => {
    // Team
    const advisor = await send('POST', '/crm-console/api/advisors', {
      name: '张伟明', team: '财富管理一部', licenseNo: 'S14400002001', specialties: ['asset_allocation'],
    })
    expect(advisor.status).toBe(200)
    const advisorId = (advisor.json as { id: string }).id
    const roster = await send('GET', '/crm-console/api/advisors')
    expect((roster.json as unknown as unknown[])).toHaveLength(1)

    // Client intake with assessment
    const client = await send('POST', '/crm-console/api/clients', {
      name: '王建国', kind: 'individual', lifecycle: 'active', advisorId,
      tolerance: 'C3', score: 62, region: '上海', totalAum: 3_800_000, tags: ['私行客户'],
    })
    expect(client.status).toBe(200)
    const clientId = (client.json as { id: string }).id
    const found = await send('GET', `/crm-console/api/clients?query=${encodeURIComponent('王')}`)
    expect((found.json as unknown as unknown[])).toHaveLength(1)

    // 360° view
    const book = await send('GET', `/crm-console/api/clients/${clientId}`)
    expect(book.status, String(book.json.error)).toBe(200)
    expect((book.json as { client: { name: string } }).client.name).toBe('王建国')

    // Patch: re-assess one level up
    const patched = await send('PATCH', `/crm-console/api/clients/${clientId}`, { tolerance: 'C4' })
    expect((patched.json as { riskProfile: { tolerance: string } }).riskProfile.tolerance).toBe('C4')

    // Interaction
    const interaction = await send('POST', '/crm-console/api/interactions', {
      clientId, kind: 'meeting', summary: '面谈回顾持仓', topics: ['asset_allocation'],
    })
    expect(interaction.status).toBe(200)
    const history = await send('GET', `/crm-console/api/interactions?clientId=${clientId}`)
    expect((history.json as unknown as unknown[])).toHaveLength(1)

    // Consultation with per-product suitability verdicts
    const consultation = await send('POST', '/crm-console/api/consultations', {
      clientId,
      topics: ['asset_allocation'],
      products: [
        JSON.stringify({ name: '中证红利低波ETF联接A', kind: 'fund', riskLevel: 'R3' }),
        JSON.stringify({ name: '雪球结构·中证500两年期', kind: 'structured', riskLevel: 'R5' }),
      ],
      followUpRequired: true,
      summary: '季度再平衡',
    })
    expect(consultation.status).toBe(200)
    const products = (consultation.json as { products: { verdict: string }[] }).products
    expect(products.map(product => product.verdict)).toEqual(['matched', 'product-exceeds-profile'])

    // Opportunity to a won close
    const deal = await send('POST', '/crm-console/api/opportunities', {
      clientId, productKind: 'fund', productName: '中证红利低波ETF联接A', amount: 1_500_000,
    })
    const dealId = (deal.json as { id: string }).id
    const single = await send('GET', `/crm-console/api/opportunities/${dealId}`)
    expect((single.json as { stage: string }).stage).toBe('new')
    await send('POST', `/crm-console/api/opportunities/${dealId}/move`, { to: 'qualified' })
    const won = await send('POST', `/crm-console/api/opportunities/${dealId}/move`, { to: 'won' })
    expect((won.json as { stage: string; probability: number }).probability).toBe(100)
    const byStage = await send('GET', '/crm-console/api/opportunities?stage=won')
    expect((byStage.json as unknown as unknown[])).toHaveLength(1)

    // Tasks: create, list by client, reschedule, complete
    const task = await send('POST', '/crm-console/api/tasks', {
      clientId, title: '发送再平衡建议书', priority: 'high', dueAt: 1_790_000_000_000,
    })
    const taskId = (task.json as { id: string }).id
    const mine = await send('GET', `/crm-console/api/tasks/${clientId}`)
    expect((mine.json as unknown as unknown[])).toHaveLength(1)
    const moved = await send('POST', `/crm-console/api/tasks/${taskId}/reschedule`, { dueAt: 1_790_864_000_000 })
    expect((moved.json as { dueAt: number }).dueAt).toBe(1_790_864_000_000)
    const done = await send('POST', `/crm-console/api/tasks/${taskId}/complete`)
    expect((done.json as { status: string }).status).toBe('done')
    const second = await send('POST', '/crm-console/api/tasks', {
      advisorId, title: '季度问候', dueAt: 1_790_000_000_000,
    })
    await send('POST', `/crm-console/api/tasks/${(second.json as { id: string }).id}/cancel`)

    // Audit trail
    const audit = await send('GET', '/crm-console/api/audit')
    expect((audit.json as unknown as { verdict: string }[]).map(entry => entry.verdict)).toContain('matched')
  })

  it('rejects wire-boundary violations with a 400 and a precise message', async () => {
    const badLifecycle = await send('GET', '/crm-console/api/clients?lifecycle=frozen')
    expect(badLifecycle.status).toBe(400)
    expect((badLifecycle.json as { error: string }).error).toContain('lifecycle')
    const badTolerance = await send('POST', '/crm-console/api/clients', { name: 'x', kind: 'individual', tolerance: 'C9' })
    expect(badTolerance.status).toBe(400)
    const missing = await send('POST', '/crm-console/api/clients', { kind: 'individual' })
    expect(missing.status).toBe(400)
    expect((missing.json as { error: string }).error).toContain('name')
    const unknown = await send('GET', '/crm-console/api/ghost')
    expect(unknown.status).toBe(400)
    expect((unknown.json as { error: string }).error).toContain('ghost')
    const badTaskAction = await send('POST', '/crm-console/api/tasks/x/reopen')
    expect(badTaskAction.status).toBe(400)
    const badProducts = await send('POST', '/crm-console/api/consultations', {
      clientId: 'c', products: ['not-json{'],
    })
    expect(badProducts.status).toBe(400)
  })

  it('rejects a malformed JSON body with a 400', async () => {
    const response = await fetch(`${base}/crm-console/api/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBeDefined()
  })

  it('releases the routes when the plugin fiber disposes', async () => {
    const before = await get('/crm-console')
    expect(before.status).toBe(200)
    // Dispose only the console plugin; the web server itself keeps listening.
    await consoleFiber!.dispose()
    const after = await get('/crm-console')
    expect(after.status).toBe(404)
    const apiAfter = await get('/crm-console/api/overview')
    expect(apiAfter.status).toBe(404)
  })
})

describe('invariant companion', () => {
  it('registers under the package name and installs cleanly', async () => {
    const standalone = new Context()
    await standalone.plugin(InvariantRegistry)
    await standalone.plugin(ConsoleInvariant)
    expect(standalone.get('crm-console-invariant')).toBeUndefined()
    await standalone.fiber.dispose()
  })
})

describe('wire-boundary odd payloads', () => {
  it('treats a non-object JSON body as absent and rejects missing required fields', async () => {
    const response = await fetch(`${base}/crm-console/api/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '"just a string"',
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toContain('name')
  })

  it('rejects non-string array members in closed-vocabulary lists', async () => {
    const bad = await send('POST', '/crm-console/api/advisors', { name: '甲', specialties: [42] })
    expect(bad.status).toBe(400)
    expect((bad.json as { error: string }).error).toContain('specialties')
    const nonArray = await send('POST', '/crm-console/api/advisors', { name: '乙', specialties: 'tax' })
    expect(nonArray.status).toBe(200)
    expect((nonArray.json as { specialties: string[] }).specialties).toHaveLength(0)
  })

  it('rejects an unknown top-level resource with the empty head named', async () => {
    const empty = await send('GET', '/crm-console/api')
    expect(empty.status).toBe(400)
    expect((empty.json as { error: string }).error).toContain("''")
  })

  it('rejects a task action addressed without an action segment', async () => {
    const actionless = await send('POST', '/crm-console/api/tasks/some-id')
    expect(actionless.status).toBe(400)
    expect((actionless.json as { error: string }).error).toContain("unknown task action ''")
  })

  it('creates a client with a tolerance-only assessment (no score)', async () => {
    const advisor = await send('POST', '/crm-console/api/advisors', { name: '测评师' })
    const advisorId = (advisor.json as { id: string }).id
    const client = await send('POST', '/crm-console/api/clients', {
      name: '无分数客户', kind: 'individual', advisorId, tolerance: 'C2',
    })
    expect((client.json as { riskProfile: { tolerance: string; score?: number } }).riskProfile.tolerance).toBe('C2')
    expect((client.json as { riskProfile: { score?: number } }).riskProfile.score).toBeUndefined()
  })

  it('ignores a non-string member inside a plain tags array', async () => {
    const tagged = await send('POST', '/crm-console/api/clients', {
      name: '混合标签客户', kind: 'individual', tags: [42],
    })
    // list() rejects arrays containing non-strings → the field is treated as absent.
    expect((tagged.json as { tags: string[] }).tags).toEqual([])
  })
})

describe('console filter passthroughs', () => {
  it('filters clients by kind, interactions by topic, tasks by kind, and audit by advisor', async () => {
    const advisor = await send('POST', '/crm-console/api/advisors', { name: '张伟明' })
    const advisorId = (advisor.json as { id: string }).id
    await send('POST', '/crm-console/api/clients', { name: '个人客户', kind: 'individual', advisorId })
    const institution = await send('POST', '/crm-console/api/clients', { name: '机构客户', kind: 'institution', advisorId })
    expect((institution.json as { kind: string }).kind).toBe('institution')
    const onlyIndividuals = await send('GET', '/crm-console/api/clients?kind=individual&limit=100')
    expect((onlyIndividuals.json as unknown as { kind: string }[]).every(row => row.kind === 'individual')).toBe(true)
    const onlyInstitutions = await send('GET', '/crm-console/api/clients?kind=institution&limit=100')
    expect((onlyInstitutions.json as unknown as { kind: string }[]).every(row => row.kind === 'institution')).toBe(true)
    const badKind = await send('GET', '/crm-console/api/clients?kind=corp')
    expect(badKind.status).toBe(400)

    const client = await send('POST', '/crm-console/api/clients', { name: '互动客户', kind: 'individual', advisorId })
    const clientId = (client.json as { id: string }).id
    await send('POST', '/crm-console/api/interactions', { clientId, summary: '税务讨论', topics: ['tax'] })
    await send('POST', '/crm-console/api/interactions', { clientId, summary: '闲聊', topics: ['other'] })
    const taxOnly = await send('GET', `/crm-console/api/interactions?clientId=${clientId}&topic=tax&limit=10`)
    expect((taxOnly.json as unknown as { summary: string }[]).map(row => row.summary)).toEqual(['税务讨论'])
    const badTopic = await send('GET', '/crm-console/api/interactions?topic=astrology')
    expect(badTopic.status).toBe(400)

    await send('POST', '/crm-console/api/tasks', { advisorId, title: '合规任务', kind: 'compliance_check', dueAt: 1_790_000_000_000 })
    await send('POST', '/crm-console/api/tasks', { advisorId, title: '普通跟进', dueAt: 1_790_000_000_000 })
    const complianceOnly = await send('GET', '/crm-console/api/tasks?kind=compliance_check&limit=10')
    expect((complianceOnly.json as unknown as { title: string }[]).map(row => row.title)).toEqual(['合规任务'])
    const badTaskKind = await send('GET', '/crm-console/api/tasks?kind=watering_plants')
    expect(badTaskKind.status).toBe(400)

    await send('POST', '/crm-console/api/consultations', {
      clientId,
      products: [JSON.stringify({ name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' })],
    })
    const scopedAudit = await send('GET', `/crm-console/api/audit?advisorId=${advisorId}`)
    expect((scopedAudit.json as unknown as unknown[]).length).toBeGreaterThanOrEqual(1)
    const emptyAudit = await send('GET', '/crm-console/api/audit?advisorId=00000000-0000-0000-0000-000000000000')
    expect((emptyAudit.json as unknown as unknown[]).length).toBe(0)
  })

  it('serves the inline favicon with the page', async () => {
    const html = await (await get('/crm-console')).text()
    expect(html).toContain('rel="icon"')
    expect(html).toContain('dlg-deal')
    expect(html).toContain('dlg-interaction')
    expect(html).toContain('dlg-task')
  })
})

describe('demo-data onboarding', () => {
  it('seeds through POST and refuses a second press', async () => {
    const seeded = await send('POST', '/crm-console/api/demo-data')
    expect(seeded.status).toBe(200)
    expect(seeded.json).toMatchObject({ advisors: 2, clients: 8, opportunities: 5, tasks: 4 })
    const overview = await send('GET', '/crm-console/api/overview')
    expect((overview.json as { book: { totalClients: number } }).book.totalClients).toBe(8)
    const again = await send('POST', '/crm-console/api/demo-data')
    expect(again.status).toBe(400)
    expect((again.json as { error: string }).error).toContain('not empty')
    const wrongMethod = await send('GET', '/crm-console/api/demo-data')
    expect(wrongMethod.status).toBe(400)
  })

  it('carries the onboarding card and demo button in the empty overview page', async () => {
    const html = await (await get('/crm-console')).text()
    expect(html).toContain('demo-seed')
    expect(html).toContain('三步上手')
  })
})
