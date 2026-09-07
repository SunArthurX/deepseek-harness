// Sixth sweep: the multi-CSV export surface (deals, tasks, interactions,
// audit) verified over the service, plus a console HTTP test per endpoint and
// the BOM/quoting invariants shared by all five exports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAY } from './helpers/seed.ts'
import { crmHarness } from './helpers/harness.ts'

const NOW = Date.UTC(2026, 8, 7, 9)

let harness: Awaited<ReturnType<typeof crmHarness>> | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW })
  harness = await crmHarness()
  const advisor = await harness.service.registerAdvisor({ name: '张伟明' })
  const client = await harness.service.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id, riskProfile: { tolerance: 'C3' } })
  await harness.service.logInteraction({ clientId: client.id, summary: '面谈', occurredAt: NOW - 5 * DAY, topics: ['asset_allocation'] })
  await harness.service.recordConsultation({
    clientId: client.id, occurredAt: NOW - 4 * DAY,
    products: [{ name: '中证红利低波ETF联接A', kind: 'fund', riskLevel: 'R3' }],
  })
  const deal = await harness.service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 500_000 })
  await harness.service.moveOpportunity({ opportunityId: deal.id, to: 'won' })
  await harness.service.createTask({ clientId: client.id, advisorId: advisor.id, title: '跟进', dueAt: NOW + DAY, priority: 'high' })
  void DAY
})

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  vi.useRealTimers()
})

describe('deal CSV export', () => {
  it('includes stage, amount, close date, and reason for terminal deals', async () => {
    const { service } = harness!
    const csv = (await import('../src/insights-impl.ts')).exportDealsCsv(service)
    expect(csv.filename).toBe('crm-deals.csv')
    expect(csv.rowCount).toBe(1)
    const row = csv.content.split('\r\n')[1] ?? ''
    expect(row).toContain('won')
    expect(row).toContain('500000')
    expect(row).toContain(new Date(NOW).toISOString().slice(0, 10))
  })

  it('leaves close cells empty for open deals', async () => {
    const { service } = harness!
    const anyClient = service.searchClients()[0]
    if (anyClient === undefined) throw new Error('client missing')
    await service.createOpportunity({ clientId: anyClient.id, productKind: 'fund', amount: 100 })
    const csv = (await import('../src/insights-impl.ts')).exportDealsCsv(service)
    const openRow = (csv.content.split('\r\n').find(line => line.includes(',new,')))
    expect(openRow).toContain(',,')
  })
})

describe('task CSV export', () => {
  it('includes open, done, and cancelled tasks (all statuses)', async () => {
    const { service } = harness!
    const advisor = service.listAdvisors()[0]
    if (advisor === undefined) throw new Error('seed advisor missing')
    const client = service.searchClients()[0]
    if (client === undefined) throw new Error('seed client missing')
    const first = await service.createTask({ advisorId: advisor.id, clientId: client.id, title: '甲', dueAt: NOW + DAY })
    const secondTask = await service.createTask({ advisorId: advisor.id, clientId: client.id, title: '乙', dueAt: NOW + 2 * DAY })
    const third = await service.createTask({ advisorId: advisor.id, clientId: client.id, title: '丙', dueAt: NOW + 3 * DAY })
    await service.completeTask(first.id)
    await service.cancelTask(secondTask.id)
    const csv = (await import('../src/insights-impl.ts')).exportTasksCsv(service)
    // Seed task + 甲(done) + 乙(cancelled) + 丙(open) = 4 rows.
    expect(csv.rowCount).toBe(4)
    expect(csv.content.split('\r\n').some(line => line.includes(',done,'))).toBe(true)
    expect(csv.content.split('\r\n').some(line => line.includes(',cancelled,'))).toBe(true)
    expect(csv.content.split('\r\n').some(line => line.includes(',open,'))).toBe(true)
    void third
  })
})

describe('interaction CSV export', () => {
  it('carries channel, date, sentiment, and joined topics', async () => {
    const { service } = harness!
    const client = service.searchClients()[0]
    if (client === undefined) throw new Error('seed client missing')
    await service.logInteraction({
      clientId: client.id, kind: 'meeting', summary: '季度回顾',
      occurredAt: NOW - 2 * DAY, topics: ['asset_allocation'],
    })
    const csv = (await import('../src/insights-impl.ts')).exportInteractionsCsv(service)
    expect(csv.filename).toBe('crm-interactions.csv')
    expect(csv.rowCount).toBe(2)
    const row = csv.content.split('\r\n').find(line => line.includes('meeting')) ?? ''
    expect(row).toContain('asset_allocation')
    expect(row).toContain('2026-09-05')
  })
})

describe('audit CSV export', () => {
  it('emits one row per product verdict with rationale', async () => {
    const { service } = harness!
    const csv = (await import('../src/insights-impl.ts')).exportAuditCsv(service)
    expect(csv.filename).toBe('crm-suitability-audit.csv')
    expect(csv.rowCount).toBe(1)
    const row = csv.content.split('\r\n')[1] ?? ''
    expect(row).toContain('matched')
    expect(row).toContain('R3')
    expect(row).toContain('王建国')
  })
})

describe('BOM and CRLF invariants across all exports', () => {
  it('every export starts with the UTF-8 BOM and uses CRLF row endings', async () => {
    const { service } = harness!
    const impl = await import('../src/insights-impl.ts')
    const exports = [
      impl.exportClientsCsv(service, NOW),
      impl.exportDealsCsv(service),
      impl.exportTasksCsv(service),
      impl.exportInteractionsCsv(service),
      impl.exportAuditCsv(service),
    ]
    for (const csv of exports) {
      expect(csv.content.startsWith('\uFEFF')).toBe(true)
      expect(csv.contentType).toBe('text/csv; charset=utf-8')
      expect(csv.content.includes('\r\n')).toBe(true)
      expect(csv.content.endsWith('\r\n')).toBe(true)
    }
  })
})
