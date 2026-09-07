// Full-surface coverage for the advisory-plan crm_* tools: every kind payload,
// every presence-error path, both allocation-drift outcomes, the recurring
// accrual, lifecycle transitions including the rejected ones, presenters, and
// the five-row list preview. Completes the per-file coverage gate for
// tools-plans.ts alongside the sibling full-surface spec.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolHarness } from './helpers/tool-harness.ts'
import type { ToolHarness } from './helpers/tool-harness.ts'

const NOW = Date.UTC(2026, 8, 1, 8)

let harness: ToolHarness | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW })
  harness = await toolHarness({ seed: false })
})

afterEach(async () => {
  vi.useRealTimers()
  await harness?.dispose()
  harness = undefined
})

/** Execute one tool call through the shared harness. */
function call(name: string, args: unknown) {
  return harness!.call(name, args)
}

/** Resolve a tool definition for direct presenter invocation. */
function def(name: string) {
  return harness!.def(name)
}

async function createClient(name: string): Promise<string> {
  const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
  const created = await harness!.ctx.crm.createClient({ name, kind: 'individual', advisorId: advisor.id })
  return created.id
}

describe('advisory plan tools full surface', () => {
  it('creates a recurring-investment plan with every optional field', async () => {
    const clientId = await createClient('王建国')
    const other = await harness!.ctx.crm.registerAdvisor({ name: '林晓芳' })
    const created = await call('crm_plan_create', {
      clientId,
      kind: 'recurring-investment',
      advisorId: other.id,
      topics: ['retirement'],
      tolerance: 'C3',
      notes: '养老定投',
      monthlyAmount: 2000,
      deductionDay: 15,
      productName: '中证红利低波ETF联接A',
      productKind: 'fund',
      endsAt: '2028-09-01',
    })
    expect(created.isError).toBe(false)
    const plan = (created.value as { plan: Record<string, unknown> }).plan
    expect(plan.recurring).toEqual({
      monthlyAmount: 2000,
      deductionDay: 15,
      productName: '中证红利低波ETF联接A',
      productKind: 'fund',
      endsAt: '2028-09-01T00:00:00.000Z',
    })
    expect(plan.status).toBe('draft')
    expect(plan.advisorId).toBe(other.id)
    expect(created.text).toContain('draft status')
  })

  it('rejects recurring plans missing payload fields or carrying a bad deduction day', async () => {
    const clientId = await createClient('王建国')
    const noAmount = await call('crm_plan_create', { clientId, kind: 'recurring-investment', deductionDay: 15, productName: 'x' })
    expect(noAmount.text).toContain('require monthlyAmount')
    const noDay = await call('crm_plan_create', { clientId, kind: 'recurring-investment', monthlyAmount: 100, productName: 'x' })
    expect(noDay.text).toContain('require deductionDay')
    const badDay = await call('crm_plan_create', {
      clientId, kind: 'recurring-investment', monthlyAmount: 100, deductionDay: 29, productName: 'x',
    })
    expect(badDay.text).toContain('deductionDay must be an integer 1–28')
    const noName = await call('crm_plan_create', { clientId, kind: 'recurring-investment', monthlyAmount: 100, deductionDay: 15 })
    expect(noName.text).toContain('require productName')
    const badEndsAt = await call('crm_plan_create', {
      clientId, kind: 'recurring-investment', monthlyAmount: 100, deductionDay: 15, productName: 'x', endsAt: 'next year',
    })
    expect(badEndsAt.text).toContain('endsAt must be an ISO 8601 timestamp')
  })

  it('creates an allocation plan and rejects missing sleeves or band', async () => {
    const clientId = await createClient('王建国')
    const created = await call('crm_plan_create', {
      clientId,
      kind: 'allocation',
      sleeves: [
        { name: '固收', kind: 'fund', targetPercent: 60 },
        { name: '权益', kind: 'fund', targetPercent: 30 },
        { name: '现金', kind: 'fund', targetPercent: 10 },
      ],
      rebalanceBand: 5,
    })
    expect(created.isError).toBe(false)
    const plan = (created.value as { plan: Record<string, unknown> }).plan
    expect(plan.allocation).toMatchObject({ rebalanceBand: 5 })
    expect(plan.tolerance).toBeUndefined()
    const noSleeves = await call('crm_plan_create', { clientId, kind: 'allocation', rebalanceBand: 5 })
    expect(noSleeves.text).toContain('allocation plans require sleeves')
    const noBand = await call('crm_plan_create', {
      clientId, kind: 'allocation', sleeves: [{ name: '固收', kind: 'fund', targetPercent: 100 }],
    })
    expect(noBand.text).toContain('allocation plans require rebalanceBand')
  })

  it('creates a protection-gap plan with and without existing cover and rejects missing inputs', async () => {
    const clientId = await createClient('王建国')
    const withCover = await call('crm_plan_create', {
      clientId,
      kind: 'protection-gap',
      annualIncome: 500_000,
      incomeYears: 10,
      existingLifeCover: 1_000_000,
      existingCriticalIllnessCover: 200_000,
    })
    expect(withCover.isError).toBe(false)
    const plan = (withCover.value as { plan: { protectionGap: Record<string, number> } }).plan
    expect(plan.protectionGap).toEqual({
      annualIncome: 500_000,
      incomeYears: 10,
      existingLifeCover: 1_000_000,
      recommendedLifeCover: 4_000_000,
      existingCriticalIllnessCover: 200_000,
      recommendedCriticalIllnessCover: 50_000,
    })
    const defaults = await call('crm_plan_create', { clientId, kind: 'protection-gap', annualIncome: 100_000, incomeYears: 5 })
    const barePlan = (defaults.value as { plan: { protectionGap: Record<string, number> } }).plan
    expect(barePlan.protectionGap.existingLifeCover).toBe(0)
    expect(barePlan.protectionGap.recommendedLifeCover).toBe(500_000)
    const noIncome = await call('crm_plan_create', { clientId, kind: 'protection-gap', incomeYears: 5 })
    expect(noIncome.text).toContain('require annualIncome')
    const noYears = await call('crm_plan_create', { clientId, kind: 'protection-gap', annualIncome: 100_000 })
    expect(noYears.text).toContain('require incomeYears')
  })

  it('rejects creation for an unknown client', async () => {
    const missing = await call('crm_plan_create', { clientId: 'missing', kind: 'allocation', sleeves: [{ name: '固收', kind: 'fund', targetPercent: 100 }], rebalanceBand: 5 })
    expect(missing.isError).toBe(true)
    const badKind = await call('crm_plan_create', { clientId: 'missing', kind: 'estate-plan' })
    expect(badKind.isError).toBe(true)
  })

  it('reviews allocation drift in and out of the band, including the no-values reading', async () => {
    const clientId = await createClient('王建国')
    const created = await call('crm_plan_create', {
      clientId,
      kind: 'allocation',
      sleeves: [
        { name: '固收', kind: 'fund', targetPercent: 60 },
        { name: '权益', kind: 'fund', targetPercent: 40 },
      ],
      rebalanceBand: 5,
    })
    const planId = (created.value as { plan: { id: string } }).plan.id

    const breached = await call('crm_plan_review', { planId, currentValues: { 固收: 40, 权益: 60 } })
    expect(breached.isError).toBe(false)
    const breachReview = breached.value as { allocation: { needsRebalance: boolean; maxDrift: number; sleeves: { breached: boolean }[] } }
    expect(breachReview.allocation.needsRebalance).toBe(true)
    expect(breachReview.allocation.maxDrift).toBe(20)
    expect(breached.text).toContain('rebalance needed')

    const calm = await call('crm_plan_review', { planId, currentValues: { 固收: 58, 权益: 42 } })
    expect((calm.value as { allocation: { needsRebalance: boolean } }).allocation.needsRebalance).toBe(false)
    expect(calm.text).toContain('within band')

    const unmeasured = await call('crm_plan_review', { planId })
    const zeroed = (unmeasured.value as { allocation: { sleeves: { currentPercent: number; breached: boolean }[] } }).allocation
    expect(zeroed.sleeves.every(sleeve => sleeve.currentPercent === 0)).toBe(true)
    expect(zeroed.sleeves.some(sleeve => sleeve.breached)).toBe(true)
  })

  it('reviews a recurring plan with accrued months after the clock advances', async () => {
    const clientId = await createClient('王建国')
    const created = await call('crm_plan_create', {
      clientId, kind: 'recurring-investment', monthlyAmount: 2000, deductionDay: 15, productName: '中证红利低波ETF联接A',
    })
    const planId = (created.value as { plan: { id: string } }).plan.id
    const atCreation = await call('crm_plan_review', { planId })
    expect(atCreation.value).toMatchObject({ monthsElapsed: 0, investedToDate: 0 })
    vi.setSystemTime(NOW + 95 * 86_400_000)
    const later = await call('crm_plan_review', { planId })
    expect(later.value).toMatchObject({ monthsElapsed: 3, investedToDate: 6000 })
    expect(later.text).toContain('3 months elapsed')
  })

  it('reviews a protection-gap plan and rejects an unknown plan', async () => {
    const clientId = await createClient('王建国')
    const created = await call('crm_plan_create', { clientId, kind: 'protection-gap', annualIncome: 500_000, incomeYears: 10 })
    const planId = (created.value as { plan: { id: string } }).plan.id
    const review = await call('crm_plan_review', { planId })
    expect(review.text).toContain('Protection-gap review')
    const missing = await call('crm_plan_review', { planId: 'missing' })
    expect(missing.isError).toBe(true)
  })

  it('transitions through the full lifecycle and rejects illegal moves', async () => {
    const clientId = await createClient('王建国')
    const created = await call('crm_plan_create', {
      clientId, kind: 'protection-gap', annualIncome: 500_000, incomeYears: 10,
    })
    const planId = (created.value as { plan: { id: string } }).plan.id
    const active = await call('crm_plan_transition', { planId, to: 'active' })
    expect((active.value as { plan: { status: string } }).plan.status).toBe('active')
    const paused = await call('crm_plan_transition', { planId, to: 'paused' })
    expect((paused.value as { plan: { status: string } }).plan.status).toBe('paused')
    const resumed = await call('crm_plan_transition', { planId, to: 'active' })
    expect((resumed.value as { plan: { status: string } }).plan.status).toBe('active')
    const done = await call('crm_plan_transition', { planId, to: 'completed' })
    expect(done.text).toContain('is now completed')
    const afterTerminal = await call('crm_plan_transition', { planId, to: 'active' })
    expect(afterTerminal.isError).toBe(true)
    const same = await call('crm_plan_transition', { planId, to: 'completed' })
    expect(same.isError).toBe(true)

    const second = await call('crm_plan_create', { clientId, kind: 'protection-gap', annualIncome: 1, incomeYears: 1 })
    const secondId = (second.value as { plan: { id: string } }).plan.id
    const cancelled = await call('crm_plan_transition', { planId: secondId, to: 'cancelled' })
    expect((cancelled.value as { plan: { status: string } }).plan.status).toBe('cancelled')
    const unknown = await call('crm_plan_transition', { planId: 'missing', to: 'active' })
    expect(unknown.isError).toBe(true)
  })

  it('lists plans with filters, limits, and the five-row preview cap', async () => {
    const clientId = await createClient('王建国')
    const otherId = await createClient('林晓芳')
    const ids: string[] = []
    for (let i = 0; i < 6; i += 1) {
      const created = await call('crm_plan_create', {
        clientId, kind: 'protection-gap', annualIncome: 100_000 + i, incomeYears: 5,
      })
      ids.push((created.value as { plan: { id: string } }).plan.id)
    }
    await call('crm_plan_create', { clientId: otherId, kind: 'protection-gap', annualIncome: 1, incomeYears: 1 })

    const all = await call('crm_plan_list', {})
    expect((all.value as { returned: number }).returned).toBe(7)
    expect(all.text).toContain('7 plans')
    expect(all.text).toContain('… and 2 more')

    const perClient = await call('crm_plan_list', { clientId, limit: 4 })
    expect((perClient.value as { returned: number }).returned).toBe(4)

    const cancelled = await call('crm_plan_transition', { planId: ids[0]!, to: 'cancelled' })
    expect(cancelled.isError).toBe(false)
    const byStatus = await call('crm_plan_list', { clientId, status: 'cancelled' })
    expect((byStatus.value as { plans: { status: string }[] }).plans).toHaveLength(1)

    const empty = await call('crm_plan_list', { status: 'completed' })
    expect(empty.text).toContain('No matching plans')
  })

  it('presents every plan call through the generic presenter', () => {
    expect(def('crm_plan_create').presentCall?.({ clientId: 'x', kind: 'allocation' })).toMatchObject({ card: 'generic' })
    expect(def('crm_plan_list').presentCall?.({})).toMatchObject({ card: 'generic' })
    expect(def('crm_plan_review').presentCall?.({ planId: 'x' })).toMatchObject({ card: 'generic' })
    expect(def('crm_plan_transition').presentCall?.({ planId: 'x', to: 'active' })).toMatchObject({ card: 'generic' })
  })
})
