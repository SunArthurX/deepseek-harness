// Contract tests for presentation modes and the windowed book: PTC-only
// guidance for unparented calls, the ten-row book windows, and time-of-record
// suitability evaluation (profile at occurrence, not at read).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { SEED_NOW } from '../../crm/tests/helpers/seed.ts'
import { toolHarness } from './helpers/tool-harness.ts'

const DAY = 86_400_000

let ctx: Context | undefined
let active: Awaited<ReturnType<typeof toolHarness>> | undefined

async function boot(mode: 'native' | 'ptc'): Promise<void> {
  active = await toolHarness({ mode, seed: false })
  ctx = active.ctx
}

beforeEach(async () => {
  vi.useFakeTimers({ now: SEED_NOW })
})

afterEach(async () => {
  vi.useRealTimers()
  await active?.dispose()
  active = undefined
  ctx = undefined
})

describe('PTC presentation contract', () => {
  it('keeps the tools registered under mode: ptc', async () => {
    await boot('ptc')
    const names = ctx!.tools.schemas().filter(schema => schema.name.startsWith('crm_'))
    expect(names).toHaveLength(22)
  })
})

describe('windowed 360° book', () => {
  it('returns the ten soonest-due open tasks and ten latest interactions', async () => {
    await boot('native')
    const advisor = await ctx!.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx!.crm.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C3' },
    })
    for (let i = 1; i <= 12; i += 1) {
      await ctx!.crm.logInteraction({
        clientId: client.id,
        summary: `互动${String(i)}`,
        occurredAt: SEED_NOW - i * DAY,
      })
      await ctx!.crm.createTask({
        clientId: client.id,
        advisorId: advisor.id,
        title: `任务${String(i)}`,
        dueAt: SEED_NOW + i * DAY,
      })
    }
    const view = ctx!.crm.clientBook(client.id)
    expect(view.interactions).toHaveLength(10)
    expect(view.interactions[0]?.summary).toBe('互动1')
    expect(view.interactions.at(-1)?.summary).toBe('互动10')
    expect(view.openTasks).toHaveLength(10)
    expect(view.openTasks[0]?.title).toBe('任务1')
    expect(view.openTasks.at(-1)?.title).toBe('任务10')
    const full = view.consultations
    expect(full).toHaveLength(0)
  })
})

describe('time-of-record suitability', () => {
  it('evaluates against the profile as of the consultation time, not read time', async () => {
    await boot('native')
    const advisor = await ctx!.crm.registerAdvisor({ name: '张伟明' })
    // Assessment taken 100 days before NOW with a 730-day window.
    const client = await ctx!.crm.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C4' },
    })
    // A consultation 700 days in the future still sees a live profile (30 days
    // left), while one at day 740 sees it expired.
    const beforeExpiry = SEED_NOW + 700 * DAY
    const afterExpiry = SEED_NOW + 740 * DAY
    const early = await ctx!.crm.recordConsultation({
      clientId: client.id,
      occurredAt: beforeExpiry,
      products: [{ name: '全球医药生物混合基金', kind: 'fund', riskLevel: 'R4' }],
    })
    const late = await ctx!.crm.recordConsultation({
      clientId: client.id,
      occurredAt: afterExpiry,
      products: [{ name: '全球医药生物混合基金', kind: 'fund', riskLevel: 'R4' }],
    })
    expect(early.products[0]?.verdict).toBe('matched')
    expect(late.products[0]?.verdict).toBe('assessment-expired')
  })

  it('preserves every unrelated field through a reschedule', async () => {
    await boot('native')
    const advisor = await ctx!.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx!.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const deal = await ctx!.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100 })
    const task = await ctx!.crm.createTask({
      clientId: client.id,
      opportunityId: deal.id,
      advisorId: advisor.id,
      kind: 'compliance_check',
      title: '核对适当性材料',
      dueAt: SEED_NOW + DAY,
      priority: 'urgent',
      notes: '双录文件',
    })
    const moved = await ctx!.crm.rescheduleTask(task.id, SEED_NOW + 2 * DAY)
    expect(moved).toMatchObject({
      id: task.id,
      clientId: client.id,
      opportunityId: deal.id,
      advisorId: advisor.id,
      kind: 'compliance_check',
      title: '核对适当性材料',
      priority: 'urgent',
      notes: '双录文件',
      status: 'open',
      dueAt: SEED_NOW + 2 * DAY,
    })
  })

  it('walks a deal backwards and forwards across non-terminal stages', async () => {
    await boot('native')
    const advisor = await ctx!.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx!.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const deal = await ctx!.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100 })
    const forward = await ctx!.crm.moveOpportunity({ opportunityId: deal.id, to: 'negotiation' })
    expect(forward.probability).toBe(75)
    const back = await ctx!.crm.moveOpportunity({ opportunityId: deal.id, to: 'qualified', probability: 45 })
    expect(back).toMatchObject({ stage: 'qualified', probability: 45 })
    const again = await ctx!.crm.moveOpportunity({ opportunityId: deal.id, to: 'proposal' })
    expect(again.probability).toBe(55)
  })
})

describe('typed-error pass-through', () => {
  it('surfaces the exact service failure message through the pipeline', async () => {
    await boot('native')
    const advisor = await ctx!.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx!.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const deal = await ctx!.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100 })
    await ctx!.crm.moveOpportunity({ opportunityId: deal.id, to: 'won' })
    const result = await ctx!.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('err-1'),
      name: 'crm_opportunity_move',
      arguments: { opportunityId: deal.id, to: 'lost', closeReason: 'x' },
    })
    expect(result.isError).toBe(true)
    const text = result.content.filter(block => block.type === 'text').map(block => 'text' in block ? block.text : '').join('')
    expect(text).toContain(`cannot move opportunity '${deal.id}' from 'won' to 'lost': 'won' is terminal`)
  })
})
