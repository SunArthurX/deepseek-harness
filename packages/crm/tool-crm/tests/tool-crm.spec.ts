// Integration through the REAL tool pipeline: every crm_* tool executes via
// ctx.tools.execute over the real CRM service on the real storage stack.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CrmService from '@deepseek-ai/dsh-crm'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as ToolCrm from '../src/index.ts'

const NOW = Date.UTC(2026, 8, 1, 8)
const DAY = 86_400_000

interface ToolHarness {
  ctx: Context
  call: (name: string, args: unknown) => Promise<{ isError: boolean; value?: unknown; text: string }>
  dispose: () => Promise<void>
}

async function toolHarness(): Promise<ToolHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(CrmService, { riskProfileValidityDays: 730 })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(ToolCrm)
  let counter = 0
  return {
    ctx,
    call: async (name, args) => {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`call-${++counter}`),
        name,
        arguments: args,
      })
      return {
        isError: result.isError,
        ...(result.isError ? {} : { value: result.value }),
        text: result.content.filter(block => block.type === 'text').map(block => 'text' in block ? block.text : '').join(''),
      }
    },
    dispose: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

let harness: ToolHarness | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW })
  harness = await toolHarness()
})

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  vi.useRealTimers()
})

/** One advisor plus one assessed client, the base most tools need. */
async function baseBook(): Promise<{ advisorId: string; clientId: string }> {
  const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明', licenseNo: 'S14400002001' })
  const client = await harness!.ctx.crm.createClient({
    name: '王建国',
    kind: 'individual',
    advisorId: advisor.id,
    riskProfile: { tolerance: 'C3', score: 62 },
    financial: { totalAum: 3_800_000, currency: 'CNY' },
  })
  return { advisorId: advisor.id, clientId: client.id }
}

describe('crm tool registration and export shape', () => {
  it('registers all 18 crm_* tools and exports no default', async () => {
    expect('default' in ToolCrm).toBe(false)
    const names = harness!.ctx.tools.schemas().map(s => s.name)
    const expected = [
      'crm_advisor_list', 'crm_advisor_register',
      'crm_client_create', 'crm_client_search', 'crm_client_get', 'crm_client_update',
      'crm_consultation_record',
      'crm_interaction_log', 'crm_interaction_list',
      'crm_opportunity_create', 'crm_opportunity_move', 'crm_opportunity_list',
      'crm_task_create', 'crm_task_list', 'crm_task_complete', 'crm_task_cancel', 'crm_task_reschedule',
      'crm_report',
    ]
    expect(names).toEqual(expect.arrayContaining(expected))
    expect(names.filter(name => name.startsWith('crm_'))).toHaveLength(expected.length)
  })

  it('unregisters every tool when the plugin fiber disposes', async () => {
    const before = harness!.ctx.tools.schemas().some(s => s.name === 'crm_client_create')
    expect(before).toBe(true)
    await harness!.dispose()
    harness = undefined
    // A fresh context proves the registration was the plugin fiber's effect.
    const fresh = await toolHarness()
    expect(fresh.ctx.tools.schemas().some(s => s.name === 'crm_client_create')).toBe(true)
    await fresh.dispose()
  })
})

describe('crm advisor and client tools', () => {
  it('registers, lists, creates, searches, reads, and updates', async () => {
    const { call } = harness!
    const registered = await call('crm_advisor_register', {
      name: '张伟明',
      team: '财富管理一部',
      licenseNo: 'S14400002001',
      specialties: ['asset_allocation', 'retirement'],
    })
    expect(registered.isError).toBe(false)
    const advisorId = (registered.value as { advisor: { id: string } }).advisor.id

    const listed = await call('crm_advisor_list', { active: true })
    expect((listed.value as { advisors: unknown[] }).advisors).toHaveLength(1)

    const created = await call('crm_client_create', {
      name: '王建国',
      kind: 'individual',
      advisorId,
      tolerance: 'C3',
      score: 62,
      phone: '13900001111',
      region: '上海',
      totalAum: 3_800_000,
      tags: ['私行客户'],
    })
    expect(created.isError).toBe(false)
    const clientId = (created.value as { client: { id: string } }).client.id
    expect(created.text).toContain('王建国')

    const searched = await call('crm_client_search', { query: '王建国', tolerance: 'C3' })
    expect((searched.value as { clients: { id: string }[] }).clients.map(c => c.id)).toEqual([clientId])

    const got = await call('crm_client_get', { clientId })
    const book = got.value as { client: { riskProfile?: { tolerance: string } }; interactions: unknown[] }
    expect(book.client.riskProfile?.tolerance).toBe('C3')

    const updated = await call('crm_client_update', {
      clientId,
      lifecycle: 'active',
      wechat: 'wgj_c3',
      tolerance: 'C4',
    })
    const client = (updated.value as {
      client: { lifecycle: string; contact?: { wechat?: string }; riskProfile?: { tolerance: string } }
    }).client
    expect(client.lifecycle).toBe('active')
    expect(client.contact?.wechat).toBe('wgj_c3')
    expect(client.contact).toMatchObject({ phone: '13900001111', region: '上海' })
    expect(client.riskProfile?.tolerance).toBe('C4')
  })

  it('fails unknown-client and invalid-enum inputs through the pipeline', async () => {
    const { call } = harness!
    const unknown = await call('crm_client_get', { clientId: 'missing' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain("unknown CRM client 'missing'")
    const badEnum = await call('crm_client_create', { name: 'x', kind: 'person' })
    expect(badEnum.isError).toBe(true)
  })
})

describe('crm engagement tools', () => {
  it('logs and lists interactions with ISO timestamps both ways', async () => {
    const { clientId } = await baseBook()
    const { call } = harness!
    const logged = await call('crm_interaction_log', {
      clientId,
      kind: 'meeting',
      summary: '面谈回顾持仓',
      occurredAt: '2026-08-20T09:30:00.000Z',
      durationMin: 45,
      sentiment: 'positive',
      topics: ['asset_allocation'],
      nextStep: '下周电话跟进',
    })
    expect(logged.isError).toBe(false)
    const interaction = (logged.value as { interaction: { occurredAt: string } }).interaction
    expect(interaction.occurredAt).toBe('2026-08-20T09:30:00.000Z')

    const listed = await call('crm_interaction_list', { clientId, since: '2026-08-01T00:00:00.000Z' })
    expect((listed.value as { interactions: unknown[] }).interactions).toHaveLength(1)

    const badTime = await call('crm_interaction_log', { clientId, summary: 'x', occurredAt: 'yesterday' })
    expect(badTime.isError).toBe(true)
    expect(badTime.text).toContain('ISO 8601')
  })

  it('records a consultation with suitability verdicts and counts', async () => {
    const { clientId } = await baseBook()
    const { call } = harness!
    const result = await call('crm_consultation_record', {
      clientId,
      topics: ['asset_allocation'],
      products: [
        { name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' },
        { name: '雪球结构·中证500两年期', kind: 'structured', riskLevel: 'R5' },
      ],
      recommendations: ['保留应急现金'],
      followUpRequired: true,
    })
    expect(result.isError).toBe(false)
    const value = result.value as {
      consultation: { products: { verdict: string }[] }
      suitability: { matched: number; blocked: number }
    }
    expect(value.consultation.products.map(p => p.verdict)).toEqual(['matched', 'product-exceeds-profile'])
    expect(value.suitability).toEqual({ matched: 1, blocked: 1 })
    expect(result.text).toContain('1 product(s) matched, 1 blocked')
  })

  it('records a consultation with no products as an empty audit', async () => {
    const { clientId } = await baseBook()
    const { call } = harness!
    const result = await call('crm_consultation_record', { clientId, summary: '纯咨询' })
    const value = result.value as { consultation: { products: unknown[] }; suitability: { matched: number; blocked: number } }
    expect(value.consultation.products).toEqual([])
    expect(value.suitability).toEqual({ matched: 0, blocked: 0 })
  })
})

describe('crm pipeline tools', () => {
  it('opens, moves, and lists opportunities through the pipeline', async () => {
    const { clientId } = await baseBook()
    const { call } = harness!
    const opened = await call('crm_opportunity_create', {
      clientId,
      productKind: 'fund',
      productName: '中证红利低波ETF联接A',
      amount: 100_000,
      expectedCloseAt: '2026-10-01T00:00:00.000Z',
    })
    const opportunity = (opened.value as {
      opportunity: { id: string; stage: string; probability: number; currency: string }
    }).opportunity
    const opportunityId = opportunity.id
    expect((opened.value as { opportunity: { stage: string; probability: number } }).opportunity).toMatchObject({ stage: 'new', probability: 10, currency: 'CNY' })

    const moved = await call('crm_opportunity_move', { opportunityId, to: 'qualified' })
    expect((moved.value as { opportunity: { stage: string; probability: number } }).opportunity).toMatchObject({ stage: 'qualified', probability: 30 })

    vi.setSystemTime(NOW + 20 * DAY)
    const won = await call('crm_opportunity_move', { opportunityId, to: 'won' })
    const deal = (won.value as { opportunity: { stage: string; probability: number; closedAt: string } }).opportunity
    expect(deal.probability).toBe(100)
    expect(deal.closedAt).toBe(new Date(NOW + 20 * DAY).toISOString())

    const listed = await call('crm_opportunity_list', { clientId, stage: 'won' })
    expect((listed.value as { opportunities: unknown[] }).opportunities).toHaveLength(1)

    const invalidMove = await call('crm_opportunity_move', { opportunityId, to: 'lost', closeReason: '太迟了' })
    expect(invalidMove.isError).toBe(true)
    expect(invalidMove.text).toContain('terminal')
  })

  it('schedules, lists, completes, cancels, and reschedules tasks', async () => {
    const { clientId, advisorId } = await baseBook()
    const { call } = harness!
    const task = await call('crm_task_create', {
      title: '电话跟进上次咨询结论',
      dueAt: '2026-09-05T09:00:00.000Z',
      clientId,
      priority: 'high',
      kind: 'follow_up',
    })
    const taskId = (task.value as { task: { id: string; advisorId: string } }).task.id
    expect((task.value as { task: { advisorId: string } }).task.advisorId).toBe(advisorId)

    const overdueTask = await call('crm_task_create', {
      title: '补交风险测评',
      dueAt: '2026-08-01T09:00:00.000Z',
      clientId,
    })

    const open = await call('crm_task_list', { clientId })
    expect((open.value as { tasks: unknown[] }).tasks).toHaveLength(2)

    const overdue = await call('crm_task_list', { overdue: true })
    const overdueRows = (overdue.value as { tasks: { id: string; overdue: boolean }[] }).tasks
    expect(overdueRows.map(t => t.id)).toEqual([(overdueTask.value as { task: { id: string } }).task.id])
    expect(overdueRows[0]?.overdue).toBe(true)

    const rescheduled = await call('crm_task_reschedule', { taskId, dueAt: '2026-09-10T09:00:00.000Z' })
    expect((rescheduled.value as { task: { dueAt: string } }).task.dueAt).toBe('2026-09-10T09:00:00.000Z')

    const completed = await call('crm_task_complete', { taskId })
    expect((completed.value as { task: { status: string } }).task.status).toBe('done')

    const again = await call('crm_task_complete', { taskId })
    expect(again.isError).toBe(true)

    const cancelled = await call('crm_task_cancel', { taskId: (overdueTask.value as { task: { id: string } }).task.id })
    expect((cancelled.value as { task: { status: string; completedAt?: string } }).task.status).toBe('cancelled')
    expect((cancelled.value as { task: { completedAt?: string } }).task.completedAt).toBeUndefined()
  })
})

describe('crm report tool', () => {
  it('runs the pipeline, book, tasks, and suitability reports', async () => {
    const { clientId } = await baseBook()
    const { call } = harness!
    await call('crm_opportunity_create', { clientId, productKind: 'fund', amount: 100_000 })
    await call('crm_opportunity_create', { clientId, productKind: 'insurance', amount: 200_000 })
    await call('crm_task_create', { clientId, title: '跟进', dueAt: '2026-09-05T00:00:00.000Z' })
    await call('crm_consultation_record', {
      clientId,
      products: [{ name: '稳健添利债券基金C', kind: 'fund', riskLevel: 'R2' }],
    })

    const pipeline = await call('crm_report', { kind: 'pipeline' })
    const pipelineValue = (pipeline.value as {
      pipeline: { openCount: number; openAmount: number; wonCount: number; winRate: number | null }
    }).pipeline
    expect(pipelineValue.openCount).toBe(2)
    expect(pipelineValue.openAmount).toBe(300_000)
    expect(pipelineValue.winRate).toBeNull()
    expect(pipeline.text).toContain('2 open deals')

    const book = await call('crm_report', { kind: 'book' })
    const bookValue = (book.value as { book: { totalClients: number; totalAum: number; expiringProfiles: unknown[] } }).book
    expect(bookValue.totalClients).toBe(1)
    expect(bookValue.totalAum).toBe(3_800_000)
    expect(book.text).toContain('1 clients')

    const tasks = await call('crm_report', { kind: 'tasks' })
    expect((tasks.value as { tasks: { open: number; overdue: number } }).tasks).toMatchObject({ open: 1, overdue: 0 })
    expect(tasks.text).toContain('1 open, 0 overdue')

    const suitability = await call('crm_report', { kind: 'suitability' })
    const audit = (suitability.value as { audit: { verdict: string }[] }).audit
    expect(audit.map(entry => entry.verdict)).toEqual(['matched'])
    expect(suitability.text).toContain('0 with a blocking verdict')

    const advisorScoped = await call('crm_report', { kind: 'pipeline', advisorId: 'none' })
    const scoped = (advisorScoped.value as { pipeline: { openCount: number } }).pipeline
    expect(scoped.openCount).toBe(0)
  })
})
