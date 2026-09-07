// Demo-data onboarding: one load through the real service rules; every screen
// the console shows then has meaningful data; a second press refuses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAY } from './helpers/seed.ts'
import { crmHarness } from './helpers/harness.ts'

const NOW = Date.UTC(2026, 8, 7, 9)

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('loadDemoData', () => {
  it('loads the full demo book with every teaching case present', async () => {
    const { service, dispose } = await crmHarness()
    try {
      const summary = await service.loadDemoData()
      expect(summary.advisors).toBe(2)
      expect(summary.clients).toBe(24)
      expect(summary.interactions).toBe(28)
      expect(summary.consultations).toBe(21)
      expect(summary.opportunities).toBe(21)
      expect(summary.tasks).toBe(27)
      // Every tolerance ladder rung the console can filter on.
      const tolerances = new Set(service.searchClients({ limit: 100 }).map(row => String(row.tolerance)))
      for (const level of ['C2', 'C3', 'C4', 'C5']) expect(tolerances.has(level)).toBe(true)
      // Profile-status stories: expiring (陈志强), missing (冯丽娜), valid (王建国).
      const status = (name: string) => service.searchClients({ query: name })[0]?.profileStatus
      expect(status('陈志强')).toBe('expiring')
      expect(status('冯丽娜')).toBe('missing')
      expect(status('王建国')).toBe('valid')
      // Suitability verdicts: a match, a profile exceedance, and a missing profile.
      const verdicts = service.suitabilityAudit(undefined, 50).map(entry => entry.verdict)
      expect(verdicts).toContain('matched')
      expect(verdicts).toContain('product-exceeds-profile')
      expect(verdicts).toContain('missing-profile')
      // Pipeline has live, won (stamped), and lost (reasoned) deals.
      const pipeline = service.pipelineSnapshot()
      expect(pipeline.wonCount).toBe(2)
      expect(pipeline.lostCount).toBe(1)
      // Every page shows 20+ rows in varied states: the board aggregates all
      // stages (16 open + 1 won + 1 lost + 1 abandoned = 19+ … assert totals).
      expect(pipeline.openCount).toBeGreaterThanOrEqual(16)
      const totalDeals = pipeline.stages.reduce((sum, row) => sum + row.count, 0)
      expect(totalDeals).toBe(21)
      // The abandoned stage carries its reasoned terminal rows.
      expect(pipeline.stages.find(row => row.stage === 'abandoned')?.count).toBeGreaterThanOrEqual(1)
      // Overdue tasks exist and the agenda covers 20+ open rows.
      const load = service.taskLoad()
      // 7 arc tasks + 20 extras; 2 of the extras are cancelled/completed in
      // other suites, here all 27 minus none — but two arc tasks complete in
      // the console flow only. Open agenda: 25 (7 arc − 2 settle-later + 20).
      expect(load.open).toBe(25)
      expect(load.overdue).toBeGreaterThanOrEqual(3)
      // Institution client round-trips its kind.
      const yunqi = service.searchClients({ query: '云启' })[0]
      expect(yunqi?.kind).toBe('institution')
    } finally {
      await dispose()
    }
  })

  it('refuses to load into a non-empty book', async () => {
    const { service, dispose } = await crmHarness()
    try {
      await service.createClient({ name: '先来的客户', kind: 'individual' })
      await expect(service.loadDemoData()).rejects.toThrow(/not empty/)
      expect(service.searchClients({ limit: 100 })).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('stages expiry relative to the passed clock, not load time', async () => {
    const { service, dispose } = await crmHarness()
    try {
      await service.loadDemoData(NOW)
      const chen = service.searchClients({ query: '陈志强' })[0]
      const full = service.getClient(chen!.id)
      // Assessed 723 days back with 730-day validity: exactly 7 days remain.
      expect(full?.riskProfile?.expiresAt).toBe(NOW - 723 * DAY + 730 * DAY)
    } finally {
      await dispose()
    }
  })
})
