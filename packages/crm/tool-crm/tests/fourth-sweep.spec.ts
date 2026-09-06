// Fourth sweep: list-method equivalence matrices over the seed, the blocking
// predicate, exact render text with the lost count, the derived warning
// window, institution-client paths, abandoned-terminal rejection, the harness
// clock contract, and a hundred-operation concurrent stress run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isBlockingVerdict } from '@deepseek-ai/dsh-crm'
import { DAY, SEED_NOW } from '../../crm/tests/helpers/seed.ts'
import { toolHarness } from './helpers/tool-harness.ts'
import type { ToolHarness } from './helpers/tool-harness.ts'

let harness: ToolHarness | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: SEED_NOW })
  harness = await toolHarness({ setTime: ms => vi.setSystemTime(ms) })
})

afterEach(async () => {
  vi.useRealTimers()
  await harness?.dispose()
  harness = undefined
})

function current(): ToolHarness {
  if (harness === undefined) throw new Error('harness not booted')
  return harness
}

describe('blocking-verdict predicate', () => {
  it('blocks every non-match outcome and passes the match', () => {
    expect(isBlockingVerdict('matched')).toBe(false)
    expect(isBlockingVerdict('product-exceeds-profile')).toBe(true)
    expect(isBlockingVerdict('assessment-expired')).toBe(true)
    expect(isBlockingVerdict('missing-profile')).toBe(true)
  })
})

describe('list-method equivalence matrices', () => {
  it('matches manual recomputation for opportunities across stages and advisors', () => {
    const { ctx } = current()
    const seed = current().seed
    if (seed === undefined) throw new Error('seed missing')
    for (const stage of ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'abandoned'] as const) {
      const rows = ctx.crm.listOpportunities({ stage, limit: 200 })
      expect(rows, stage).toHaveLength(seed.opportunities.filter(deal => deal.stage === stage).length)
    }
    const advisor = seed.advisors[0]
    if (advisor === undefined) throw new Error('seed advisor missing')
    expect(ctx.crm.listOpportunities({ advisorId: advisor.id, limit: 200 }))
      .toHaveLength(seed.opportunities.filter(deal => deal.advisorId === advisor.id).length)
  })

  it('matches manual recomputation for interactions by kind and advisor', () => {
    const { ctx } = current()
    const seed = current().seed
    if (seed === undefined) throw new Error('seed missing')
    for (const kind of ['consultation', 'call', 'wechat', 'meeting', 'email', 'report_review'] as const) {
      expect(ctx.crm.listInteractions({ kind, limit: 200 }))
        .toHaveLength(seed.interactions.filter(record => record.kind === kind).length)
    }
    const advisor = seed.advisors[1]
    if (advisor === undefined) throw new Error('seed advisor missing')
    expect(ctx.crm.listInteractions({ advisorId: advisor.id, limit: 200 }))
      .toHaveLength(seed.interactions.filter(record => record.advisorId === advisor.id).length)
  })
})

describe('report render text', () => {
  it('includes the lost count beside the won count', async () => {
    const { ctx } = current()
    const text = (await current().call('crm_report', { kind: 'pipeline' })).text
    const snapshot = ctx.crm.pipelineSnapshot()
    expect(text).toContain(`${snapshot.wonCount} won, ${snapshot.lostCount} lost`)
  })

  it('derives the warning-window day count from the service constant', async () => {
    const { ctx } = current()
    const text = (await current().call('crm_report', { kind: 'book' })).text
    const snapshot = ctx.crm.bookSnapshot()
    expect(text).toContain(`expiring within 30 days, ${snapshot.expiredProfiles.length} expired`)
    expect(text).toContain(`AUM ${snapshot.totalAum}`)
  })
})

describe('institution-client paths', () => {
  it('creates, searches, and reads an institution client through the tools', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const created = await current().call('crm_client_create', {
      name: '北京磐石资本管理有限公司',
      kind: 'institution',
      lifecycle: 'onboarding',
      advisorId: advisor.id,
      region: '北京',
      totalAum: 50_000_000,
    })
    const id = (created.value as { client: { id: string; kind: string } }).client.id
    expect((created.value as { client: { kind: string } }).client.kind).toBe('institution')
    const found = await current().call('crm_client_search', { query: '磐石资本' })
    expect((found.value as { clients: { id: string; kind: string }[] }).clients.map(c => c.id)).toEqual([id])
    expect((found.value as { clients: { kind: string }[] }).clients[0]?.kind).toBe('institution')
    const got = await current().call('crm_client_get', { clientId: id })
    expect((got.value as { client: { kind: string } }).client.kind).toBe('institution')
  })
})

describe('terminal rejection', () => {
  it('rejects any move out of the abandoned stage', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const deal = await ctx.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100 })
    await ctx.crm.moveOpportunity({ opportunityId: deal.id, to: 'abandoned', closeReason: '客户暂缓' })
    await expect(ctx.crm.moveOpportunity({ opportunityId: deal.id, to: 'new' })).rejects.toThrow(/terminal/)
  })
})

describe('harness clock contract', () => {
  it('refuses to seed without a clock setter', async () => {
    await expect(toolHarness({ seed: true })).rejects.toThrow(/setTime/)
  })
})

describe('hundred-operation stress', () => {
  it('lands one hundred concurrent client creations with unique ids', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const created = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        ctx.crm.createClient({ name: `压测${String(i)}`, kind: 'individual', advisorId: advisor.id })))
    expect(new Set(created.map(client => client.id)).size).toBe(100)
    expect(ctx.crm.searchClients({ limit: 100 })).toHaveLength(100)
  })
})

describe('interaction time boundaries', () => {
  it('includes the exact since instant and excludes one millisecond later', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const at = SEED_NOW - 5 * DAY + 3_600_000
    await ctx.crm.logInteraction({ clientId: client.id, summary: '时刻边界', occurredAt: at })
    expect(ctx.crm.listInteractions({ clientId: client.id, since: at, limit: 200 })).toHaveLength(1)
    expect(ctx.crm.listInteractions({ clientId: client.id, since: at + 1, limit: 200 })).toHaveLength(0)
  })
})

describe('golden amount formatting through tools', () => {
  it('echoes an integral amount unchanged', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const result = await current().call('crm_opportunity_create', {
      clientId: client.id,
      productKind: 'fund',
      amount: 100_000,
    })
    expect(result.text).toContain('at 100000 CNY')
  })
})
