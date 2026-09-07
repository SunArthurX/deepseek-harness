// Fifth sweep: the new filter surfaces (client kind, interaction topic, task
// kind, advisor-scoped audit) verified end-to-end over the seed and through
// the tools, plus console-page content and HTTP filter passthroughs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEED_NOW } from '../../crm/tests/helpers/seed.ts'
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

function seeded(): NonNullable<ToolHarness['seed']> {
  const seed = current().seed
  if (seed === undefined) throw new Error('seed missing')
  return seed
}

describe('client kind filter', () => {
  it('splits the seeded book into individuals and institutions exactly', () => {
    const { ctx } = current()
    const seed = seeded()
    const expectedIndividuals = seed.clients.filter(client => client.kind === 'individual').length
    const expectedInstitutions = seed.clients.filter(client => client.kind === 'institution').length
    const individuals = ctx.crm.searchClients({ kind: 'individual', limit: 100 })
    const institutions = ctx.crm.searchClients({ kind: 'institution', limit: 100 })
    expect(individuals).toHaveLength(expectedIndividuals)
    expect(institutions).toHaveLength(expectedInstitutions)
    expect(expectedIndividuals + expectedInstitutions).toBe(60)
    // Combines with other filters by AND.
    expect(ctx.crm.searchClients({ kind: 'institution', lifecycle: 'active', limit: 100 }))
      .toHaveLength(seed.clients.filter(client => client.kind === 'institution' && client.lifecycle === 'active').length)
  })

  it('flows through the tool and rejects an unknown kind at the schema boundary', async () => {
    const tool = await current().call('crm_client_search', { kind: 'institution', limit: 100 })
    expect(tool.isError).toBe(false)
    expect((tool.value as { clients: { kind: string }[] }).clients.every(row => row.kind === 'institution')).toBe(true)
    const bad = await current().call('crm_client_search', { kind: 'corp' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/kind/)
  })
})

describe('interaction topic filter', () => {
  it('recomputes per-topic counts against the seed', () => {
    const { ctx } = current()
    const seed = seeded()
    for (const topic of ['asset_allocation', 'retirement', 'market_outlook'] as const) {
      expect(ctx.crm.listInteractions({ topic, limit: 200 }))
        .toHaveLength(seed.interactions.filter(record => record.topics.includes(topic)).length)
    }
    expect(ctx.crm.listInteractions({ topic: 'tax', limit: 200 }).length)
      .toBe(seed.interactions.filter(record => record.topics.includes('tax')).length)
  })

  it('combines with channel and flows through the tool', async () => {
    const { ctx } = current()
    const meetings = ctx.crm.listInteractions({ kind: 'meeting', topic: 'asset_allocation', limit: 200 })
    for (const record of meetings) {
      expect(record.kind).toBe('meeting')
      expect(record.topics).toContain('asset_allocation')
    }
    const tool = await current().call('crm_interaction_list', { topic: 'retirement', limit: 200 })
    expect(tool.isError).toBe(false)
    const rows = (tool.value as { interactions: { topics: string[] }[] }).interactions
    expect(rows.every(row => row.topics.includes('retirement'))).toBe(true)
  })
})

describe('task kind filter', () => {
  it('recomputes per-category counts and combines with status', () => {
    const { ctx } = current()
    const seed = seeded()
    for (const kind of ['follow_up', 'risk_review', 'client_care'] as const) {
      expect(ctx.crm.listTasks({ kind, limit: 200 }))
        .toHaveLength(seed.tasks.filter(task => task.kind === kind).length)
    }
    const done = ctx.crm.listTasks({ status: 'done', kind: 'follow_up', limit: 200 })
    expect(done.every(task => task.status === 'done' && task.kind === 'follow_up')).toBe(true)
  })

  it('flows through the tool', async () => {
    const tool = await current().call('crm_task_list', { kind: 'risk_review', limit: 200 })
    expect(tool.isError).toBe(false)
    expect((tool.value as { tasks: { kind: string }[] }).tasks.every(task => task.kind === 'risk_review')).toBe(true)
  })
})

describe('advisor-scoped suitability audit', () => {
  it('scopes audit entries to one advisor over the seed', () => {
    const { ctx } = current()
    const seed = seeded()
    const advisor = seed.advisors[0]
    if (advisor === undefined) throw new Error('seed advisor missing')
    const scoped = ctx.crm.suitabilityAudit(undefined, 200, advisor.id)
    const expected = seed.consultations
      .filter(record => record.advisorId === advisor.id)
      .reduce((sum, record) => sum + record.products.length, 0)
    expect(scoped).toHaveLength(expected)
    expect(scoped.every(entry => entry.consultationId !== undefined)).toBe(true)
    // Unscoped returns at least the scoped count.
    expect(ctx.crm.suitabilityAudit(undefined, 200).length).toBeGreaterThanOrEqual(expected)
  })

  it('flows through the report tool with the advisorId parameter', async () => {
    const { ctx } = current()
    const seed = seeded()
    const advisor = seed.advisors[1]
    if (advisor === undefined) throw new Error('seed advisor missing')
    const report = await current().call('crm_report', { kind: 'suitability', advisorId: advisor.id, limit: 200 })
    expect(report.isError).toBe(false)
    const serviceCount = ctx.crm.suitabilityAudit(undefined, 200, advisor.id).length
    expect((report.value as { audit: unknown[] }).audit).toHaveLength(serviceCount)
  })
})

describe('client book single-pass equivalence', () => {
  it('matches independent recomputation for every window after the collect rewrite', () => {
    const { ctx } = current()
    const seed = seeded()
    for (const client of seed.clients.slice(0, 8)) {
      const book = ctx.crm.clientBook(client.id)
      const interactions = seed.interactions
        .filter(record => record.clientId === client.id)
        .sort((l, r) => r.occurredAt - l.occurredAt).slice(0, 10)
      expect(book.interactions.map(r => r.id)).toEqual(interactions.map(r => r.id))
      const tasks = seed.tasks
        .filter(task => task.clientId === client.id && task.status === 'open')
        .sort((l, r) => l.dueAt - r.dueAt).slice(0, 10)
      expect(book.openTasks.map(t => t.id)).toEqual(tasks.map(t => t.id))
      const consultations = seed.consultations
        .filter(record => record.clientId === client.id)
        .sort((l, r) => r.occurredAt - l.occurredAt).slice(0, 10)
      expect(book.consultations.map(r => r.id)).toEqual(consultations.map(r => r.id))
    }
  })
})

describe('console page content', () => {
  it('serves the upgraded page with favicon, advisor selector, and the three new dialogs', async () => {
    const { CONSOLE_PAGE } = await import('../../crm-console/src/page.ts')
    expect(CONSOLE_PAGE).toContain('rel="icon"')
    expect(CONSOLE_PAGE).toContain('nc-advisor')
    expect(CONSOLE_PAGE).toContain('dlg-deal')
    expect(CONSOLE_PAGE).toContain('dlg-interaction')
    expect(CONSOLE_PAGE).toContain('dlg-task')
    expect(CONSOLE_PAGE).toContain('client-kind')
  })
})
