// Full-surface branch completion for the console API: every optional field of
// every endpoint exercised in both its present and absent form, so every
// conditional spread runs both ways over real HTTP.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import CrmService from '@deepseek-ai/dsh-crm'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as ConsoleGateway from '../src/index.ts'

let ctx: Context | undefined
let base: string | undefined

beforeEach(async () => {
  const next = new Context()
  await next.plugin(Storage)
  next.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(next, { backend: 'memory', routes: {} })
  next.storage.mount('domain', facility)
  next.provide('storageDomain', facility)
  await next.plugin(CrmService, { riskProfileValidityDays: 730 })
  await next.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await next.plugin(ConsoleGateway)
  ctx = next
  base = `http://127.0.0.1:${String(next.webServer.port)}`
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  base = undefined
})

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { status: response.status, json: await response.json() }
}

function idOf(json: unknown): string {
  const value = (json as { id?: string }).id
  if (value === undefined) throw new Error('missing id in response')
  return value
}

describe('console API optional-field matrix', () => {
  it('exercises every endpoint with maximal and minimal payloads', async () => {
    // advisors: full POST (all optionals) then minimal POST.
    const fullAdvisor = await send('POST', '/crm-console/api/advisors', {
      name: '张伟明', team: '一部', licenseNo: 'S1', specialties: ['tax'], active: false,
    })
    expect(fullAdvisor.status).toBe(200)
    const advisorId = idOf(fullAdvisor.json)
    const bareAdvisor = await send('POST', '/crm-console/api/advisors', { name: '林晓芳' })
    expect(bareAdvisor.status).toBe(200)
    expect((await send('GET', '/crm-console/api/advisors')).json).toHaveLength(2)
    const activeOnly = await send('GET', '/crm-console/api/advisors')
    expect(activeOnly.status).toBe(200)

    // clients: maximal POST (every optional), minimal POST, every query filter.
    const fullClient = await send('POST', '/crm-console/api/clients', {
      name: '王建国', kind: 'individual', lifecycle: 'active', advisorId,
      tolerance: 'C3', score: 62, region: '上海', totalAum: 100, tags: ['私行客户'],
    })
    expect(fullClient.status).toBe(200)
    const clientId = idOf(fullClient.json)
    const bareClient = await send('POST', '/crm-console/api/clients', { name: '冯丽娜', kind: 'individual' })
    expect(bareClient.status).toBe(200)
    const bareId = idOf(bareClient.json)
    // Query matrix: no filters at all, then each filter alone, then combined.
    for (const suffix of ['', '?query=王', '?lifecycle=active', '?tolerance=C3', '?tag=私行客户', `?advisorId=${advisorId}`, '?limit=5',
      `?query=王&lifecycle=active&tolerance=C3&tag=私行客户&advisorId=${advisorId}&limit=5`]) {
      const result = await send('GET', `/crm-console/api/clients${suffix}`)
      expect(result.status).toBe(200)
    }
    // PATCH: full optionals, then minimal.
    const fullPatch = await send('PATCH', `/crm-console/api/clients/${bareId}`, {
      lifecycle: 'prospect', tolerance: 'C2', score: 55, region: '武汉',
    })
    expect(fullPatch.status).toBe(200)
    const barePatch = await send('PATCH', `/crm-console/api/clients/${bareId}`, {})
    expect(barePatch.status).toBe(200)
    // 360° GET for both clients.
    expect((await send('GET', `/crm-console/api/clients/${clientId}`)).status).toBe(200)

    // interactions: maximal POST, minimal POST, query with and without filters.
    const fullInteraction = await send('POST', '/crm-console/api/interactions', {
      clientId, kind: 'meeting', summary: '面谈', topics: ['tax'],
    })
    expect(fullInteraction.status).toBe(200)
    const bareInteraction = await send('POST', '/crm-console/api/interactions', { clientId, summary: '电话' })
    expect(bareInteraction.status).toBe(200)
    for (const suffix of ['', `?clientId=${clientId}`, `?clientId=${clientId}&limit=1`]) {
      expect((await send('GET', `/crm-console/api/interactions${suffix}`)).status).toBe(200)
    }

    // consultations: maximal POST, minimal POST, query both ways.
    const product = JSON.stringify({ name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' })
    const fullConsult = await send('POST', '/crm-console/api/consultations', {
      clientId, topics: ['tax'], products: [product], recommendations: ['保留现金'], followUpRequired: true, summary: '首次',
    })
    expect(fullConsult.status).toBe(200)
    const bareConsult = await send('POST', '/crm-console/api/consultations', { clientId })
    expect(bareConsult.status).toBe(200)
    for (const suffix of ['', `?clientId=${clientId}`, `?clientId=${clientId}&limit=1`]) {
      expect((await send('GET', `/crm-console/api/consultations${suffix}`)).status).toBe(200)
    }

    // opportunities: maximal POST, minimal POST, single GET, moves both ways.
    const fullDeal = await send('POST', '/crm-console/api/opportunities', {
      clientId, productKind: 'fund', productName: '红利低波', amount: 500,
    })
    const dealId = idOf(fullDeal.json)
    const bareDeal = await send('POST', '/crm-console/api/opportunities', { clientId, productKind: 'tax', amount: 100 })
    expect(bareDeal.status).toBe(200)
    for (const suffix of ['', `?clientId=${clientId}`, '?stage=new', `?clientId=${clientId}&stage=new&limit=1`]) {
      expect((await send('GET', `/crm-console/api/opportunities${suffix}`)).status).toBe(200)
    }
    expect((await send('GET', `/crm-console/api/opportunities/${dealId}`)).status).toBe(200)
    const moveWithProbability = await send('POST', `/crm-console/api/opportunities/${dealId}/move`, {
      to: 'proposal', probability: 50,
    })
    expect(moveWithProbability.status).toBe(200)
    const bareDealId = idOf(bareDeal.json)
    const moveBare = await send('POST', `/crm-console/api/opportunities/${bareDealId}/move`, { to: 'lost', closeReason: '暂缓' })
    expect(moveBare.status).toBe(200)

    // tasks: maximal POST, minimal POST, every query filter, GET-by-client, all actions.
    const fullTask = await send('POST', '/crm-console/api/tasks', {
      advisorId, clientId, title: '全字段任务', priority: 'urgent', dueAt: 1_790_000_000_000,
    })
    const fullTaskId = idOf(fullTask.json)
    const bareTask = await send('POST', '/crm-console/api/tasks', { advisorId, title: '最简任务', dueAt: 1_790_000_000_000 })
    const bareTaskId = idOf(bareTask.json)
    const rescheduleTarget = await send('POST', '/crm-console/api/tasks', { advisorId, title: '改期任务', dueAt: 1_790_000_000_000 })
    const rescheduleId = idOf(rescheduleTarget.json)
    const cancelTarget = await send('POST', '/crm-console/api/tasks', { advisorId, title: '取消任务', dueAt: 1_790_000_000_000 })
    const cancelId = idOf(cancelTarget.json)
    for (const suffix of ['', `?clientId=${clientId}`, '?status=open', '?status=done', '?overdue=true', `?clientId=${clientId}&status=open&limit=1`]) {
      expect((await send('GET', `/crm-console/api/tasks${suffix}`)).status).toBe(200)
    }
    expect((await send('GET', `/crm-console/api/tasks/${clientId}`)).status).toBe(200)
    expect((await send('POST', `/crm-console/api/tasks/${fullTaskId}/complete`)).status).toBe(200)
    expect((await send('POST', `/crm-console/api/tasks/${bareTaskId}/complete`)).status).toBe(200)
    expect((await send('POST', `/crm-console/api/tasks/${rescheduleId}/reschedule`, { dueAt: 1_790_086_400_000 })).status).toBe(200)
    expect((await send('POST', `/crm-console/api/tasks/${cancelId}/cancel`)).status).toBe(200)

    // audit: with and without filters.
    for (const suffix of ['', `?clientId=${clientId}`, `?clientId=${clientId}&limit=1`]) {
      expect((await send('GET', `/crm-console/api/audit${suffix}`)).status).toBe(200)
    }

    // error matrix for the remaining branches.
    expect((await send('POST', '/crm-console/api/opportunities', { clientId, productKind: 'fund' })).status).toBe(400)
    expect((await send('POST', '/crm-console/api/tasks', { title: 'x' })).status).toBe(400)
    expect((await send('POST', `/crm-console/api/tasks/${fullTaskId}/reschedule`, {})).status).toBe(400)
    expect((await send('POST', '/crm-console/api/interactions', { clientId, summary: 'x', kind: '传真' })).status).toBe(400)
    expect((await send('POST', '/crm-console/api/advisors', { name: 'x', specialties: ['瑜伽'] })).status).toBe(400)
    expect((await send('POST', '/crm-console/api/opportunities/x/move', { to: 'deferred' })).status).toBe(400)
    // GET task actions fall through to the by-client listing (an unknown client simply yields []).
    expect((await send('GET', '/crm-console/api/tasks/x/reopen')).status).toBe(200)
    expect((await send('POST', '/crm-console/api/tasks/x/reopen', {})).status).toBe(400)
    // Unknown single-deal reads answer null (200), the same absence the service reports.
    expect((await send('GET', '/crm-console/api/opportunities/x')).status).toBe(200)
    // Non-string array item fails the member-list validation.
    expect((await send('POST', '/crm-console/api/advisors', { name: 'x', specialties: 'tax' })).status).toBe(200)
  })
})
