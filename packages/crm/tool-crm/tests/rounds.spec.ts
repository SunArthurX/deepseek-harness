// Third sweep of enterprise-soundness tests: defensive-copy contracts, strict
// ISO details, exhaustive filter combinations, concurrent stress, golden seed
// timestamps, chained patch semantics, and error pass-through via tools.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEED_NOW } from '../../crm/tests/helpers/seed.ts'
import { DAY } from '../../crm/tests/helpers/seed.ts'
import { toolHarness } from './helpers/tool-harness.ts'
import type { ToolHarness } from './helpers/tool-harness.ts'

let harness: ToolHarness | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: SEED_NOW })
  harness = await toolHarness({ seed: false, setTime: ms => vi.setSystemTime(ms) })
})

afterEach(async () => {
  vi.useRealTimers()
  await harness?.dispose()
  harness = undefined
})

/** The per-test harness, narrowing the module-level optional once. */
function current(): ToolHarness {
  if (harness === undefined) throw new Error('harness not booted')
  return harness
}

/** Swap the unseeded harness for a seeded one at the reference time. */
async function reseed(): Promise<void> {
  await harness?.dispose()
  vi.setSystemTime(SEED_NOW)
  harness = await toolHarness({ setTime: ms => vi.setSystemTime(ms) })
}

describe('defensive-copy contracts', () => {
  it('isolates stored records from later caller-array mutation', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明', specialties: ['tax'] })
    const tags = ['私行客户']
    const topics: ['retirement'] = ['retirement']
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id, tags })
    await ctx.crm.logInteraction({ clientId: client.id, summary: 'x', topics })
    tags.push('被篡改')
    topics.splice(0, topics.length)
    expect(ctx.crm.getClient(client.id)?.tags).toEqual(['私行客户'])
    expect(ctx.crm.listInteractions({ clientId: client.id })[0]?.topics).toEqual(['retirement'])
    expect(ctx.crm.getAdvisor(advisor.id)?.specialties).toEqual(['tax'])
  })
})

describe('strict ISO details', () => {
  it('accepts T and space separators and explicit offsets', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const t = await ctx.crm.logInteraction({
      clientId: client.id,
      summary: 'T 分隔',
      occurredAt: Date.parse('2026-08-15T02:30:00Z'),
    })
    const space = await ctx.crm.logInteraction({
      clientId: client.id,
      summary: '空格分隔',
      occurredAt: Date.parse('2026-08-15 02:30:00Z'),
    })
    const offset = await ctx.crm.logInteraction({
      clientId: client.id,
      summary: '偏移',
      occurredAt: Date.parse('2026-08-15T04:30:00+02:00'),
    })
    expect(t.occurredAt).toBe(space.occurredAt)
    expect(offset.occurredAt).toBe(t.occurredAt)
  })

  it('rejects non-zero-padded calendar dates through the tool', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    void client
    const result = await harness!.call('crm_interaction_log', {
      clientId: client.id,
      summary: 'x',
      occurredAt: '2026-9-1',
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('ISO 8601')
  })
})

describe('exhaustive filter combinations', () => {
  it('matches manual recomputation for every lifecycle × tolerance pair over the seed', async () => {
    await reseed()
    const { ctx, seed } = current()
    const lifecycles = ['lead', 'prospect', 'onboarding', 'active', 'dormant', 'lost'] as const
    const tolerances = ['C1', 'C2', 'C3', 'C4', 'C5'] as const
    for (const lifecycle of lifecycles) {
      for (const tolerance of tolerances) {
        const rows = ctx.crm.searchClients({ lifecycle, tolerance })
        const expected = seed!.clients.filter(client =>
          client.lifecycle === lifecycle && client.riskProfile?.tolerance === tolerance)
        expect(rows, `${lifecycle}/${tolerance}`).toHaveLength(expected.length)
      }
    }
  })
})

describe('concurrent stress', () => {
  it('completes fifty alternating writes and reads without loss', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const work: Promise<unknown>[] = []
    for (let i = 0; i < 25; i += 1) {
      work.push(ctx.crm.logInteraction({ clientId: client.id, summary: `并发${String(i)}` }))
      work.push(Promise.resolve(ctx.crm.clientBook(client.id)))
    }
    await Promise.all(work)
    expect(ctx.crm.listInteractions({ clientId: client.id, limit: 200 })).toHaveLength(25)
    expect(ctx.crm.clientBook(client.id).interactions).toHaveLength(10)
  })

  it('keeps dueSoon stable for equal due times', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const task = await ctx.crm.createTask({ advisorId: advisor.id, title: `同刻${String(i)}`, dueAt: SEED_NOW })
      ids.push(task.id)
    }
    const load = ctx.crm.taskLoad()
    expect(load.dueSoon.map(task => task.id)).toEqual(ids)
  })
})

describe('golden seed timestamps', () => {
  it('pins the featured assessment windows to their exact instants', async () => {
    await reseed()
    const { ctx } = current()
    const find = (name: string) => {
      const row = ctx.crm.searchClients({ query: name })[0]
      if (row === undefined) throw new Error(`seed client ${name} missing`)
      return ctx.crm.getClient(row.id)
    }
    // 王建国: assessed 10 days back, 730-day validity.
    expect(find('王建国')?.riskProfile?.expiresAt).toBe(SEED_NOW - 10 * DAY + 730 * DAY)
    // 陈志强: assessed 800 days back — expired 70 days ago.
    expect(find('陈志强')?.riskProfile?.expiresAt).toBe(SEED_NOW - 800 * DAY + 730 * DAY)
  })
})

describe('chained patch semantics', () => {
  it('carries a notes update on a stage move into the terminal record', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const deal = await ctx.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100 })
    await ctx.crm.moveOpportunity({ opportunityId: deal.id, to: 'proposal', notes: '方案 v2 已送达' })
    const won = await ctx.crm.moveOpportunity({ opportunityId: deal.id, to: 'won' })
    expect(won).toMatchObject({ stage: 'won', notes: '方案 v2 已送达', probability: 100 })
    expect(won.closedAt).toBeDefined()
  })

  it('round-trips a done task through the tools', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const created = await harness!.call('crm_task_create', {
      advisorId: advisor.id,
      clientId: client.id,
      title: '回执归档',
      dueAt: '2026-09-06T00:00:00.000Z',
    })
    const taskId = (created.value as { task: { id: string } }).task.id
    const done = await harness!.call('crm_task_complete', { taskId })
    expect((done.value as { task: { status: string } }).task.status).toBe('done')
    const listed = await harness!.call('crm_task_list', { clientId: client.id, status: 'done' })
    expect((listed.value as { tasks: { id: string }[] }).tasks.map(t => t.id)).toEqual([taskId])
  })
})

describe('error pass-through matrix', () => {
  it('surfaces unknown-id failures for client, task, and deal tools', async () => {
    const unknownClient = await harness!.call('crm_client_update', { clientId: 'missing-client', lifecycle: 'active' })
    expect(unknownClient.isError).toBe(true)
    expect(unknownClient.text).toContain("unknown CRM client 'missing-client'")
    const unknownTask = await harness!.call('crm_task_complete', { taskId: 'missing-task' })
    expect(unknownTask.isError).toBe(true)
    expect(unknownTask.text).toContain("unknown CRM task 'missing-task'")
    const unknownDeal = await harness!.call('crm_opportunity_move', { opportunityId: 'missing-deal', to: 'won' })
    expect(unknownDeal.isError).toBe(true)
    expect(unknownDeal.text).toContain("unknown CRM opportunity 'missing-deal'")
  })

  it('renders fractional deal amounts to two digits', async () => {
    const { ctx } = current()
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const result = await harness!.call('crm_opportunity_create', {
      clientId: client.id,
      productKind: 'fund',
      amount: 1234.567,
    })
    expect(result.text).toContain('at 1234.57 CNY')
    expect((result.value as { opportunity: { amount: number } }).opportunity.amount).toBe(1234.567)
  })
})

describe('seed report shapes', () => {
  it('sums per-priority counts to the open total', async () => {
    await reseed()
    const report = await current().call('crm_report', { kind: 'tasks' })
    const load = (report.value as { tasks: { open: number; byPriority: { count: number }[] } }).tasks
    expect(load.byPriority.reduce((sum, row) => sum + row.count, 0)).toBe(load.open)
  })

  it('keeps the scoped book inside the global one', async () => {
    await reseed()
    const { ctx, seed } = current()
    const advisor = seed!.advisors[0]
    if (advisor === undefined) throw new Error('seed advisor missing')
    const global = ctx.crm.bookSnapshot()
    const scoped = ctx.crm.bookSnapshot(advisor.id)
    expect(scoped.totalClients).toBeLessThanOrEqual(global.totalClients)
    expect(scoped.totalAum).toBeLessThanOrEqual(global.totalAum)
  })
})
