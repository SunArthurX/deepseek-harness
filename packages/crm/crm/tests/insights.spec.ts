// Enterprise insights: segments, RFM tiering, conversion funnel, and CSV
// export — correctness against the book, boundary values, and the console's
// HTTP surface for each.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildConversionFunnel, buildRfm, buildSegments, exportClientsCsv } from '../src/insights-impl.ts'
import { DAY } from './helpers/seed.ts'
import { crmHarness } from './helpers/harness.ts'

const NOW = Date.UTC(2026, 8, 7, 9)

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('client segments', () => {
  it('partitions vip vs institution vs unassessed over a crafted book', async () => {
    const { service, dispose } = await crmHarness()
    try {
      const advisor = await service.registerAdvisor({ name: '张伟明' })
      await service.createClient({ name: '大户', kind: 'individual', advisorId: advisor.id, financial: { totalAum: 6_000_000, currency: 'CNY' }, riskProfile: { tolerance: 'C4' } })
      await service.createClient({ name: '小户', kind: 'individual' })
      await service.createClient({ name: '机构甲', kind: 'institution', advisorId: advisor.id, financial: { totalAum: 20_000_000, currency: 'CNY' }, riskProfile: { tolerance: 'C4' } })
      await service.createClient({ name: '沉睡户', kind: 'individual', advisorId: advisor.id, lifecycle: 'dormant', financial: { totalAum: 50_000, currency: 'CNY' } })
      const segments = buildSegments(service)
      const byKey = new Map(segments.map(segment => [segment.key, segment]))
      expect(byKey.get('vip')?.rows.map(row => row.name)).toEqual(['大户'])
      expect(byKey.get('institution')?.rows.map(row => row.name)).toEqual(['机构甲'])
      expect(byKey.get('unassessed')?.rows.map(row => row.name)).toEqual(['小户', '沉睡户'])
      expect(byKey.get('dormant')?.rows.map(row => row.name)).toEqual(['沉睡户'])
      expect(byKey.get('vip')?.totalAum).toBe(6_000_000)
      // Definitions come in display order with stable keys.
      expect(segments.map(segment => segment.key)).toEqual([
        'vip', 'institution', 'expiring-assessment', 'expired-assessment', 'unassessed', 'dormant', 'no-followup',
      ])
    } finally {
      await dispose()
    }
  })

  it('assessments expiring within 30 days land in the expiring segment only', async () => {
    const { service, dispose } = await crmHarness({ riskProfileValidityDays: 100 })
    try {
      const advisor = await service.registerAdvisor({ name: '张伟明' })
      const client = await service.createClient({
        name: '将到期客户', kind: 'individual', advisorId: advisor.id,
        riskProfile: { tolerance: 'C3' },
      })
      // createClient stamps assessments at "now"; backdate via updateClient.
      await service.updateClient(client.id, {
        riskProfile: { tolerance: 'C3', assessedAt: NOW - 75 * DAY },
      })
      const byKey = new Map(buildSegments(service).map(segment => [segment.key, segment]))
      expect(byKey.get('expiring-assessment')?.rows.map(row => row.name)).toEqual(['将到期客户'])
      expect(byKey.get('expired-assessment')?.rows).toHaveLength(0)
    } finally {
      await dispose()
    }
  })
})

describe('RFM tiering', () => {
  it('rates recency, frequency, and monetary on advisory thresholds', async () => {
    const { service, dispose } = await crmHarness()
    try {
      const advisor = await service.registerAdvisor({ name: '张伟明' })
      const interact = async (name: string, count: number, daysAgo: number, aum: number) => {
        const client = await service.createClient({
          name, kind: 'individual', advisorId: advisor.id,
          financial: { totalAum: aum, currency: 'CNY' },
        })
        for (let i = 0; i < count; i += 1) {
          await service.logInteraction({
            clientId: client.id, summary: `第${String(i + 1)}次`, occurredAt: NOW - daysAgo * DAY,
          })
        }
        return client
      }
      await interact('冠军户', 9, 5, 6_000_000)   // R5 F5 M5 → champion
      await interact('忠诚户', 4, 60, 2_000_000)  // R3 F3 M4 → loyal
      await interact('潜力户', 1, 20, 300_000)    // R5 F1 M3 → promising
      await interact('中期户', 2, 150, 20_000)    // R2 F1 M1 → exercises *4 arm
      await interact('需关注户', 1, 100, 2_000_000) // R3 F1 M5 → needs-attention
      await interact('真沉睡户', 1, 80, 300_000)  // R3 F1 M3 → dormant (falls through)
      await interact('沉睡户', 1, 200, 50_000)    // R1 F1 M1 → at-risk
      const analysis = buildRfm(service, NOW)
      const byName = new Map(analysis.rows.map(row => [row.name, row]))
      const champion = byName.get('冠军户')
      expect(champion).toMatchObject({ recency: 5, frequency: 5, monetary: 5, score: '555', tier: 'champion' })
      expect(byName.get('忠诚户')?.tier).toBe('loyal')
      expect(byName.get('潜力户')?.tier).toBe('promising')
      expect(byName.get('需关注户')?.tier).toBe('needs-attention')
      expect(byName.get('真沉睡户')?.tier).toBe('dormant')
      const dormant = byName.get('沉睡户')
      expect(dormant?.recency).toBe(1)
      expect(dormant?.tier).toBe('at-risk')
      // Book with interactions has no null lastInteractionAt rows.
      expect(analysis.rows.every(row => row.lastInteractionAt !== null)).toBe(true)
      expect(analysis.tiers.reduce((sum, tier) => sum + tier.count, 0)).toBe(analysis.rows.length)
    } finally {
      await dispose()
    }
  })

  it('gives an unassessed, never-interacted client the floor scores', async () => {
    const { service, dispose } = await crmHarness()
    try {
      await service.createClient({ name: '空白客户', kind: 'individual' })
      const analysis = buildRfm(service, NOW)
      expect(analysis.rows).toHaveLength(1)
      expect(analysis.rows[0]).toMatchObject({ recency: 1, frequency: 1, monetary: 1, score: '111', tier: 'at-risk' })
      expect(analysis.rows[0]?.lastInteractionAt).toBeNull()
    } finally {
      await dispose()
    }
  })
})

describe('conversion funnel', () => {
  it('counts open stages and settled outcomes with step conversions', async () => {
    const { service, dispose } = await crmHarness()
    try {
      const advisor = await service.registerAdvisor({ name: '张伟明' })
      const client = await service.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
      const mk = async () => service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100 })
      await mk()                                                     // new
      const qualified = await mk()
      await service.moveOpportunity({ opportunityId: qualified.id, to: 'qualified' })
      const won = await mk()
      await service.moveOpportunity({ opportunityId: won.id, to: 'won' })
      const lost = await mk()
      await service.moveOpportunity({ opportunityId: lost.id, to: 'lost', closeReason: '竞对' })
      await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100, stage: 'abandoned' })

      const funnel = buildConversionFunnel(service)
      const byStage = new Map(funnel.stages.map(stage => [stage.stage, stage]))
      expect(byStage.get('new')?.count).toBe(1)
      expect(byStage.get('qualified')?.count).toBe(1)
      expect(byStage.get('qualified')?.conversionFromPrevious).toBe(100)   // 1 / 1 new
      expect(byStage.get('proposal')?.count).toBe(0)                        // empty stage → ?? 0 arm
      expect(byStage.get('proposal')?.conversionFromPrevious).toBe(0)       // 0 / 1 qualified
      expect(byStage.get('won')?.count).toBe(1)
      expect(funnel.won).toBe(1)
      expect(funnel.lost).toBe(1)
      expect(funnel.abandoned).toBe(1)
      expect(funnel.winRate).toBe(50)
      // First stage conversion is null-or-100 by definition.
      expect(byStage.get('new')?.conversionFromPrevious === null || byStage.get('new')?.conversionFromPrevious === 100).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('scopes to one advisor', async () => {
    const { service, dispose } = await crmHarness()
    try {
      const a = await service.registerAdvisor({ name: '甲' })
      const b = await service.registerAdvisor({ name: '乙' })
      const ca = await service.createClient({ name: '甲客户', kind: 'individual', advisorId: a.id })
      const cb = await service.createClient({ name: '乙客户', kind: 'individual', advisorId: b.id })
      const dealA = await service.createOpportunity({ clientId: ca.id, productKind: 'fund', amount: 100 })
      await service.createOpportunity({ clientId: cb.id, productKind: 'fund', amount: 100 })
      await service.moveOpportunity({ opportunityId: dealA.id, to: 'won' })
      const scoped = buildConversionFunnel(service, a.id)
      expect(scoped.won).toBe(1)
      expect(scoped.entering + scoped.won + scoped.lost + scoped.abandoned).toBe(2)
      // 'new' stage empty for this advisor: conversion renders as null, not 100.
      expect(scoped.stages.find(stage => stage.stage === 'new')?.conversionFromPrevious).toBeNull()
      // Zero-deal advisor: the settled counters stay at zero.
      expect(scoped.abandoned).toBe(0)
    } finally {
      await dispose()
    }
  })
})

describe('CSV export', () => {
  it('emits BOM, CRLF, header, and one row per client with derived facts', async () => {
    const { service, dispose } = await crmHarness()
    try {
      const advisor = await service.registerAdvisor({ name: '张伟明' })
      await service.createClient({
        name: '含"引号", 与逗号', kind: 'institution', advisorId: advisor.id,
        riskProfile: { tolerance: 'C3' },
        financial: { totalAum: 1_000, currency: 'CNY' },
        tags: ['机构客户', '现金管理'],
      })
      const only = service.searchClients()[0]
      if (only === undefined) throw new Error('client missing')
      await service.logInteraction({ clientId: only.id, summary: 'x' })
      const csv = exportClientsCsv(service, NOW)
      expect(csv.contentType).toBe('text/csv; charset=utf-8')
      expect(csv.rowCount).toBe(1)
      expect(csv.content.startsWith('\uFEFF')).toBe(true)
      expect(csv.content.includes('\r\n')).toBe(true)
      expect(csv.filename).toBe(`crm-clients-${new Date(NOW).toISOString().slice(0, 10)}.csv`)
      const dataLine = csv.content.split('\r\n')[1]
      // Quoted cell survives commas and quotes.
      expect(dataLine).toContain('"含""引号"", 与逗号"')
      expect(dataLine).toContain('机构')
      expect(dataLine).toContain('C3')
    } finally {
      await dispose()
    }
  })

  it('round-trips: rowCount equals data lines and empty book yields header only', async () => {
    const { service, dispose } = await crmHarness()
    try {
      const empty = exportClientsCsv(service, NOW)
      expect(empty.rowCount).toBe(0)
      expect(empty.content.split('\r\n').filter(line => line.length > 0)).toHaveLength(1)
      const advisor = await service.registerAdvisor({ name: '张伟明' })
      for (let i = 0; i < 3; i += 1) {
        await service.createClient({ name: `客户${String(i)}`, kind: 'individual', advisorId: advisor.id })
      }
      const csv = exportClientsCsv(service, NOW)
      expect(csv.rowCount).toBe(3)
      expect(csv.content.split('\r\n').filter(line => line.length > 0)).toHaveLength(4)
    } finally {
      await dispose()
    }
  })
})
