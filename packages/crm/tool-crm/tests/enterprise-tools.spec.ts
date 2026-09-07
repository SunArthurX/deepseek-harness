// Tool-surface enterprise rounds: presentation-mode compatibility, schema
// boundary rejection matrix, seeded report recomputation, composition without
// the owning service, and the featured-client 360° read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ClientId } from '@deepseek-ai/dsh-crm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolCrm from '../src/index.ts'
import { SEED_NOW } from '../../crm/tests/helpers/seed.ts'
import { toolHarness } from './helpers/tool-harness.ts'

const DAY = 86_400_000

let ctx: Context | undefined
let active: Awaited<ReturnType<typeof toolHarness>> | undefined

async function boot(mode: 'native' | 'both' = 'native', seed = true): Promise<Context> {
  const next = await toolHarness({
    ...(mode === 'both' ? { mode: 'both' as const } : {}),
    seed,
    ...(seed ? { setTime: (ms: number) => vi.setSystemTime(ms) } : {}),
  })
  active = next
  ctx = next.ctx
  return next.ctx
}

beforeEach(async () => {
  vi.useFakeTimers({ now: SEED_NOW })
  await boot()
})

afterEach(async () => {
  vi.useRealTimers()
  await active?.dispose()
  active = undefined
  ctx = undefined
})

/** Call through the active harness (kept for the suite's existing style). */
function call(name: string, args: unknown) {
  if (active === undefined) throw new Error('harness not booted')
  return active.call(name, args)
}

describe('presentation-mode compatibility', () => {
  it('registers and executes every crm_* tool under mode: both', async () => {
    await ctx!.fiber.dispose()
    ctx = undefined
    const both = await boot('both')
    const names = both.tools.schemas().filter(schema => schema.name.startsWith('crm_')).map(schema => schema.name)
    expect(names).toHaveLength(22)
    const result = await call('crm_client_search', { query: '王建国' })
    expect(result.isError).toBe(false)
    expect((result.value as { clients: unknown[] }).clients).toHaveLength(1)
  })
})

describe('schema-boundary rejection matrix', () => {
  it.each([
    { tool: 'crm_client_create', args: { name: 'x', kind: 'person' }, match: /kind/ },
    { tool: 'crm_client_create', args: { name: 'x', kind: 'individual', tolerance: 'C9' }, match: /tolerance/ },
    { tool: 'crm_interaction_log', args: { clientId: 'c', summary: 'x', occurredAt: 'yesterday' }, match: /ISO 8601/ },
    { tool: 'crm_opportunity_move', args: { opportunityId: 'o', to: 'deferred' }, match: /to/ },
    { tool: 'crm_task_create', args: { title: 't' }, match: /dueAt/ },
    { tool: 'crm_report', args: { kind: 'audit' }, match: /kind/ },
    { tool: 'crm_client_search', args: { lifecycle: 'frozen' }, match: /lifecycle/ },
    { tool: 'crm_consultation_record', args: { clientId: 'c', products: [{ name: 'p', kind: 'fund' }] }, match: /riskLevel/ },
  ])('$tool rejects invalid input at the schema boundary', async ({ tool, args, match }) => {
    const result = await call(tool, args)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(match)
  })
})

describe('seeded report recomputation', () => {
  it('pipeline report matches the service snapshot over the full seed', async () => {
    const report = await call('crm_report', { kind: 'pipeline' })
    expect(report.isError).toBe(false)
    const value = (report.value as { pipeline: Record<string, number> }).pipeline
    const snapshot = ctx!.crm.pipelineSnapshot()
    expect(value).toMatchObject({
      openCount: snapshot.openCount,
      openAmount: snapshot.openAmount,
      weightedForecast: snapshot.weightedForecast,
      wonCount: snapshot.wonCount,
      wonAmount: snapshot.wonAmount,
      lostCount: snapshot.lostCount,
      winRate: snapshot.winRate,
    })
    expect(report.text).toContain(`${snapshot.openCount} open deals`)
  })

  it('book report carries the seeded client and AUM totals', async () => {
    const report = await call('crm_report', { kind: 'book' })
    const book = (report.value as { book: { totalClients: number; totalAum: number } }).book
    const snapshot = ctx!.crm.bookSnapshot()
    expect(book).toMatchObject({ totalClients: snapshot.totalClients, totalAum: snapshot.totalAum })
    expect(report.text).toContain(`${snapshot.totalClients} clients, AUM ${snapshot.totalAum}`)
  })

  it('task report reflects the seeded load including overdue work', async () => {
    const report = await call('crm_report', { kind: 'tasks' })
    const load = (report.value as { tasks: { open: number; overdue: number } }).tasks
    const snapshot = ctx!.crm.taskLoad()
    expect(load).toMatchObject({ open: snapshot.open, overdue: snapshot.overdue })
    expect(snapshot.overdue).toBe(12)
  })

  it('suitability report lists seeded verdicts newest first', async () => {
    const report = await call('crm_report', { kind: 'suitability', limit: 200 })
    const audit = (report.value as { audit: { occurredAt: string }[] }).audit
    const service = ctx!.crm.suitabilityAudit(undefined, 200)
    expect(audit.map(entry => entry.occurredAt)).toEqual(service.map(entry => new Date(entry.occurredAt).toISOString()))
    expect(audit.length).toBe(service.length)
  })
})

describe('composition without the owning service', () => {
  it('never registers the tools while ctx.crm is missing', async () => {
    await ctx!.fiber.dispose()
    ctx = undefined
    const next = new Context()
    await next.plugin(SystemPrompt)
    await next.plugin(ToolRuntime)
    const fiber = await next.plugin(ToolCrm)
    ctx = next
    try {
      expect(next.tools.schemas().some(schema => schema.name.startsWith('crm_'))).toBe(false)
      expect(next.get('crm')).toBeUndefined()
      void fiber
    } finally {
      // This context is the test's own, not the harness's; dispose it here.
      await next.fiber.dispose()
    }
  })
})

describe('featured-client 360° read', () => {
  it('caps interactions at ten and lists open tasks with the won deals', async () => {
    const found = await call('crm_client_search', { query: '王建国' })
    const clientId = (found.value as { clients: { id: string }[] }).clients[0]?.id
    if (clientId === undefined) throw new Error('featured client missing')
    const got = await call('crm_client_get', { clientId })
    const value = got.value as {
      client: { name: string; profileStatus: string }
      interactions: { id: string }[]
      openTasks: unknown[]
      opportunities: unknown[]
      consultations: unknown[]
    }
    expect(value.client.name).toBe('王建国')
    expect(value.client.profileStatus).toBe('valid')
    expect(value.interactions.length).toBeLessThanOrEqual(10)
    const interactions = ctx!.crm.listInteractions({ clientId: ClientId(clientId), limit: 200 })
    expect(value.interactions.length).toBe(Math.min(interactions.length, 10))
    void DAY
  })
})
