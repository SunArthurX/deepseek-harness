// Enterprise-scale assertions over the deterministic seed: every analytics
// number is recomputed from the seed's own records, never hand-copied.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type CrmService from '../src/index.ts'
import { DAY, SEED_NOW, seedCrm } from './helpers/seed.ts'
import type { SeedResult } from './helpers/seed.ts'
import { crmHarness } from './helpers/harness.ts'

let seeded: { service: CrmService; seed: SeedResult; dispose: () => Promise<void> } | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: SEED_NOW })
  const harness = await crmHarness()
  const seed = await seedCrm(harness.service, ms => vi.setSystemTime(ms))
  seeded = { service: harness.service, seed, dispose: harness.dispose }
})

afterEach(async () => {
  await seeded?.dispose()
  seeded = undefined
  vi.useRealTimers()
})

const TERMINAL = new Set(['won', 'lost', 'abandoned'])

describe('seed integrity', () => {
  it('commits the full enterprise book', () => {
    const { seed } = seeded!
    expect(seed.advisors).toHaveLength(4)
    expect(seed.clients).toHaveLength(60)
    expect(seed.interactions.length).toBeGreaterThanOrEqual(170)
    expect(seed.consultations).toHaveLength(25)
    expect(seed.opportunities).toHaveLength(40)
    expect(seed.tasks).toHaveLength(30)
  })

  it('pins the featured clients to every profile status at the reference time', () => {
    const { service } = seeded!
    const status = (name: string) => service.searchClients({ query: name })[0]?.profileStatus
    expect(status('王建国')).toBe('valid')
    expect(status('李秀英')).toBe('expiring')
    expect(status('陈志强')).toBe('expired')
    // 刘梅's assessment defaults to her creation time (200–600 days back), so
    // with 730-day validity she is always still valid; 冯丽娜 is unassessed.
    expect(status('刘梅')).toBe('valid')
    expect(status('冯丽娜')).toBe('missing')
  })

  it('closes terminal opportunities through the real stage machine', () => {
    const { seed } = seeded!
    const terminal = seed.opportunities.filter(deal => TERMINAL.has(deal.stage))
    expect(terminal).toHaveLength(14)
    for (const deal of terminal) {
      expect(deal.closedAt).toBeDefined()
      if (deal.stage !== 'won') expect(deal.closeReason).toBeDefined()
      expect(deal.probability).toBe(deal.stage === 'won' ? 100 : 0)
    }
  })
})

describe('book snapshot analytics', () => {
  it('aggregates lifecycle and tolerance distributions and AUM from the seed', () => {
    const { service, seed } = seeded!
    const snapshot = service.bookSnapshot()
    expect(snapshot.totalClients).toBe(seed.clients.length)
    expect(snapshot.totalAum).toBe(seed.clients.reduce((sum, c) => sum + (c.financial?.totalAum ?? 0), 0))
    for (const row of snapshot.byLifecycle) {
      expect(row.count).toBe(seed.clients.filter(c => c.lifecycle === row.lifecycle).length)
    }
    const expectedTolerances = new Set(['C1', 'C2', 'C3', 'C4', 'C5'])
    for (const row of snapshot.byTolerance) {
      if (row.tolerance !== null) expectedTolerances.delete(row.tolerance)
      const atLevel = row.tolerance === null
        ? seed.clients.filter(c => c.riskProfile === undefined)
        : seed.clients.filter(c => c.riskProfile?.tolerance === row.tolerance)
      expect(row.count).toBe(atLevel.length)
      expect(row.aum).toBe(atLevel.reduce((sum, c) => sum + (c.financial?.totalAum ?? 0), 0))
    }
    expect(expectedTolerances.size).toBe(0)
  })

  it('lists expiring and expired assessments ordered by expiry', () => {
    const { service, seed } = seeded!
    const snapshot = service.bookSnapshot()
    const withProfile = seed.clients.filter(c => c.riskProfile !== undefined)
    expect(snapshot.expiredProfiles.map(row => row.clientId)).toEqual(
      withProfile
        .filter(c => c.riskProfile!.expiresAt <= SEED_NOW)
        .sort((l, r) => r.riskProfile!.expiresAt - l.riskProfile!.expiresAt)
        .map(c => c.id),
    )
    expect(snapshot.expiringProfiles.map(row => row.clientId)).toEqual(
      withProfile
        .filter(c => SEED_NOW < c.riskProfile!.expiresAt && c.riskProfile!.expiresAt - SEED_NOW <= 30 * DAY)
        .sort((l, r) => l.riskProfile!.expiresAt - r.riskProfile!.expiresAt)
        .map(c => c.id),
    )
    expect(snapshot.expiringProfiles.length + snapshot.expiredProfiles.length).toBeGreaterThan(0)
  })

  it('scopes the snapshot to one advisor', () => {
    const { service, seed } = seeded!
    const advisor = seed.advisors[0]
    if (advisor === undefined) throw new Error('seed advisor 0 missing')
    const snapshot = service.bookSnapshot(advisor.id)
    const owned = seed.clients.filter(c => c.advisorId === advisor.id)
    expect(snapshot.advisorId).toBe(advisor.id)
    expect(snapshot.totalClients).toBe(owned.length)
    expect(snapshot.totalAum).toBe(owned.reduce((sum, c) => sum + (c.financial?.totalAum ?? 0), 0))
  })
})

describe('pipeline snapshot analytics', () => {
  it('recomputes every stage row, the forecast, and the win rate from the seed', () => {
    const { service, seed } = seeded!
    const snapshot = service.pipelineSnapshot()
    const STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'abandoned'] as const
    expect(snapshot.stages.map(s => s.stage)).toEqual([...STAGES])
    for (const row of snapshot.stages) {
      const inStage = seed.opportunities.filter(d => d.stage === row.stage)
      expect(row.count).toBe(inStage.length)
      expect(row.amount).toBe(inStage.reduce((sum, d) => sum + d.amount, 0))
      expect(row.weighted).toBe(TERMINAL.has(row.stage)
        ? 0
        : inStage.reduce((sum, d) => sum + d.amount * d.probability / 100, 0))
    }
    const open = seed.opportunities.filter(d => !TERMINAL.has(d.stage))
    expect(snapshot.openCount).toBe(open.length)
    expect(snapshot.openAmount).toBe(open.reduce((sum, d) => sum + d.amount, 0))
    expect(snapshot.weightedForecast).toBe(open.reduce((sum, d) => sum + d.amount * d.probability / 100, 0))
    const won = seed.opportunities.filter(d => d.stage === 'won')
    const lost = seed.opportunities.filter(d => d.stage === 'lost')
    expect(snapshot.wonCount).toBe(won.length)
    expect(snapshot.wonAmount).toBe(won.reduce((sum, d) => sum + d.amount, 0))
    expect(snapshot.lostCount).toBe(lost.length)
    expect(snapshot.winRate).toBe(Math.round(100 * won.length / (won.length + lost.length)))
  })

  it('returns a null win rate before any settled deal', async () => {
    const { service } = seeded!
    expect(service.pipelineSnapshot().winRate).not.toBeNull()
    const empty = await crmHarness()
    expect(empty.service.pipelineSnapshot().winRate).toBeNull()
    expect(empty.service.pipelineSnapshot().stages.map(s => s.count)).toEqual([0, 0, 0, 0, 0, 0, 0])
    await empty.dispose()
  })
})

describe('task load analytics', () => {
  it('recomputes open, overdue, per-priority, and due-soon from the seed', () => {
    const { service, seed } = seeded!
    const load = service.taskLoad()
    expect(load.at).toBe(SEED_NOW)
    expect(load.open).toBe(seed.tasks.length)
    const overdue = seed.tasks.filter(t => t.dueAt < SEED_NOW)
    expect(overdue.length).toBe(12)
    expect(load.overdue).toBe(overdue.length)
    for (const row of load.byPriority) {
      expect(row.count).toBe(seed.tasks.filter(t => t.priority === row.priority).length)
    }
    const soonest = [...seed.tasks].sort((l, r) => l.dueAt - r.dueAt).slice(0, 5)
    expect(load.dueSoon.map(t => t.id)).toEqual(soonest.map(t => t.id))
    expect(load.dueSoon.every(t => t.overdue === (t.dueAt < SEED_NOW))).toBe(true)
  })

  it('scopes the load to one advisor', () => {
    const { service, seed } = seeded!
    const advisor = seed.advisors[1]
    if (advisor === undefined) throw new Error('seed advisor 1 missing')
    const load = service.taskLoad(advisor.id)
    const owned = seed.tasks.filter(t => t.advisorId === advisor.id)
    expect(load.open).toBe(owned.length)
    expect(load.overdue).toBe(owned.filter(t => t.dueAt < SEED_NOW).length)
  })
})

describe('seed-driven search', () => {
  it('finds featured clients by name and tag against the full book', () => {
    const { service, seed } = seeded!
    expect(service.searchClients({ query: '王建国' }).map(c => c.id))
      .toEqual(seed.clients.filter(c => c.name === '王建国').map(c => c.id))
    const expected = seed.clients.filter(c => c.tags.includes('私行客户')).map(c => c.id)
    expect(new Set(service.searchClients({ tag: '私行客户' }).map(c => c.id)))
      .toEqual(new Set(expected))
  })
})
