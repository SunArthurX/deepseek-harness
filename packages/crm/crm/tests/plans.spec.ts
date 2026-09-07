// Advisory-plan lifecycle, evaluation, and boundary tests: creation of all
// three kinds, status machine, drift review, protection-gap math, recurring
// accrual, and the console HTTP surface.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAY } from './helpers/seed.ts'
import { crmHarness } from './helpers/harness.ts'
import type CrmService from '../src/index.ts'
import {
  CrmAdvisorRequiredError,
  CrmPlanStateError,
  CrmUnknownClientError,
  CrmUnknownPlanError,
} from '../src/index.ts'

const NOW = Date.UTC(2026, 8, 7, 9)

let harness: Awaited<ReturnType<typeof crmHarness>> | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW })
  harness = await crmHarness()
})

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  vi.useRealTimers()
})

function current(): CrmService {
  const service = harness?.service
  if (service === undefined) throw new Error('harness not booted')
  return service
}

/** The single seeded client's id; tests below boot exactly one client. */
function firstClientId(): import('../src/types.ts').ClientId {
  const found = current().searchClients()[0]
  if (found === undefined) throw new Error('no clients in book')
  return found.id
}

async function baseClient() {
  const service = current()
  const advisor = await service.registerAdvisor({ name: '张伟明' })
  const client = await service.createClient({
    name: '王建国', kind: 'individual', advisorId: advisor.id,
    riskProfile: { tolerance: 'C3', score: 62 },
    financial: { totalAum: 3_800_000, currency: 'CNY' },
  })
  return { advisor, client }
}

/** Minimal protection-gap payload for guard tests; the service derives the recommended cover. */
const BARE_GAP = {
  annualIncome: 100_000,
  incomeYears: 5,
  existingLifeCover: 0,
  existingCriticalIllnessCover: 0,
  recommendedLifeCover: 0,
  recommendedCriticalIllnessCover: 0,
}

describe('plan creation', () => {
  it('creates a recurring-investment plan with the monthly payload', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(),
      kind: 'recurring-investment',
      topics: ['asset_allocation'],
      tolerance: 'C3',
      recurring: { monthlyAmount: 5_000, deductionDay: 15, productName: '中证红利低波ETF联接A', productKind: 'fund' },
    })
    expect(plan.status).toBe('draft')
    expect(plan.recurring).toMatchObject({ monthlyAmount: 5_000, deductionDay: 15 })
    expect(plan.tolerance).toBe('C3')
    expect(current().listPlans()[0]?.id).toBe(plan.id)
  })

  it('creates an allocation plan with sleeves summing to 100', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(),
      kind: 'allocation',
      allocation: {
        sleeves: [
          { name: '固收', kind: 'fund', targetPercent: 60 },
          { name: '权益', kind: 'fund', targetPercent: 30 },
          { name: '现金', kind: 'fund', targetPercent: 10 },
        ],
        rebalanceBand: 5,
      },
    })
    expect(plan.allocation?.sleeves).toHaveLength(3)
    expect(plan.allocation?.rebalanceBand).toBe(5)
  })

  it('creates a plan with an explicit advisor instead of the client owner', async () => {
    const { advisor } = await baseClient()
    const other = await current().registerAdvisor({ name: '林晓芳' })
    const plan = await current().createPlan({
      clientId: firstClientId(),
      advisorId: other.id,
      kind: 'protection-gap',
      protectionGap: { ...BARE_GAP, annualIncome: 200_000, incomeYears: 8 },
    })
    expect(plan.advisorId).toBe(other.id)
    expect(plan.advisorId).not.toBe(advisor.id)
    await expect(current().createPlan({
      clientId: firstClientId(), advisorId: 'missing-advisor', kind: 'protection-gap', protectionGap: BARE_GAP,
    })).rejects.toThrow(/unknown CRM advisor/)
  })

  it('rejects an allocation plan missing its payload and a protection-gap plan missing its analysis', async () => {
    await baseClient()
    await expect(current().createPlan({
      clientId: firstClientId(), kind: 'allocation',
    })).rejects.toThrow(/require an allocation payload/)
    await expect(current().createPlan({
      clientId: firstClientId(), kind: 'protection-gap',
    })).rejects.toThrow(/require a protectionGap payload/)
  })

  it('computes protection-gap recommendations at creation', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(),
      kind: 'protection-gap',
      protectionGap: {
        annualIncome: 500_000, incomeYears: 10,
        existingLifeCover: 1_000_000, existingCriticalIllnessCover: 200_000,
        recommendedLifeCover: 0, recommendedCriticalIllnessCover: 0,
      },
    })
    // Life: 500k×10 − 1M = 4M. CI: 500k/2 − 200k = 50k.
    expect(plan.protectionGap?.recommendedLifeCover).toBe(4_000_000)
    expect(plan.protectionGap?.recommendedCriticalIllnessCover).toBe(50_000)
  })

  it('rejects payload/kind mismatches and sleeve sums ≠ 100', async () => {
    await baseClient()
    const clientId = firstClientId()
    await expect(current().createPlan({
      clientId, kind: 'recurring-investment',
      allocation: { sleeves: [{ name: '固收', kind: 'fund', targetPercent: 100 }], rebalanceBand: 5 },
    })).rejects.toThrow(/require a recurring payload/)
    await expect(current().createPlan({
      clientId, kind: 'allocation',
      allocation: {
        sleeves: [
          { name: '固收', kind: 'fund', targetPercent: 60 },
          { name: '权益', kind: 'fund', targetPercent: 30 },
        ],
        rebalanceBand: 5,
      },
    })).rejects.toThrow(/must sum to 100/)
  })

  it('requires an advisor (explicit or on the client) and an existing client', async () => {
    const orphan = await current().createClient({ name: '无顾问客户', kind: 'individual' })
    await expect(current().createPlan({
      clientId: orphan.id, kind: 'protection-gap',
      protectionGap: BARE_GAP,
    })).rejects.toBeInstanceOf(CrmAdvisorRequiredError)
    await expect(current().createPlan({
      clientId: 'missing-client', kind: 'protection-gap',
      protectionGap: BARE_GAP,
    })).rejects.toBeInstanceOf(CrmUnknownClientError)
  })
})

describe('plan status machine', () => {
  it('walks draft → active → completed and blocks illegal jumps', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(), kind: 'protection-gap',
      protectionGap: BARE_GAP,
    })
    const active = await current().transitionPlan(plan.id, 'active')
    expect(active.status).toBe('active')
    await expect(current().transitionPlan(plan.id, 'draft')).rejects.toBeInstanceOf(CrmPlanStateError)
    const completed = await current().transitionPlan(plan.id, 'completed')
    expect(completed.status).toBe('completed')
    // Terminal: no further transitions.
    await expect(current().transitionPlan(plan.id, 'active')).rejects.toBeInstanceOf(CrmPlanStateError)
  })

  it('supports active ↔ paused and cancel from non-terminal states', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(), kind: 'recurring-investment',
      recurring: { monthlyAmount: 2_000, deductionDay: 10, productName: '稳健添利债券基金C', productKind: 'fund' },
    })
    await current().transitionPlan(plan.id, 'active')
    const paused = await current().transitionPlan(plan.id, 'paused')
    expect(paused.status).toBe('paused')
    const resumed = await current().transitionPlan(plan.id, 'active')
    expect(resumed.status).toBe('active')
    const cancelled = await current().transitionPlan(plan.id, 'cancelled')
    expect(cancelled.status).toBe('cancelled')
    await expect(current().transitionPlan(plan.id, 'active')).rejects.toBeInstanceOf(CrmPlanStateError)
  })

  it('rejects same-status transitions and unknown plans', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(), kind: 'allocation',
      allocation: {
        sleeves: [{ name: '固收', kind: 'fund', targetPercent: 100 }], rebalanceBand: 10,
      },
    })
    await expect(current().transitionPlan(plan.id, 'draft')).rejects.toThrow(/already in this status/)
    await expect(current().transitionPlan('missing-plan', 'active')).rejects.toBeInstanceOf(CrmUnknownPlanError)
  })
})

describe('plan review', () => {
  it('flags drift beyond the band and reports max drift', async () => {
    await baseClient()
    const client = current().searchClients()[0]
    if (client === undefined) throw new Error('no clients in book')
    const plan = await current().createPlan({
      clientId: client.id, kind: 'allocation',
      allocation: {
        sleeves: [
          { name: '固收', kind: 'fund', targetPercent: 60 },
          { name: '权益', kind: 'fund', targetPercent: 30 },
          { name: '现金', kind: 'fund', targetPercent: 10 },
        ],
        rebalanceBand: 5,
      },
    })
    // Current: 固收 50% (−10, breached), 权益 35% (+5, at band, not breached),
    // 现金 15% (+5, at band).
    const review = current().reviewPlan(plan.id, { 固收: 50, 权益: 35, 现金: 15 })
    expect(review.allocation?.needsRebalance).toBe(true)
    expect(review.allocation?.maxDrift).toBe(10)
    const sleeves = new Map(review.allocation?.sleeves.map(s => [s.name, s]))
    expect(sleeves.get('固收')).toMatchObject({ currentPercent: 50, driftPercent: 10, breached: true })
    expect(sleeves.get('权益')).toMatchObject({ currentPercent: 35, driftPercent: -5, breached: false })
  })

  it('reports no rebalance when all sleeves are within the band', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(), kind: 'allocation',
      allocation: {
        sleeves: [
          { name: '固收', kind: 'fund', targetPercent: 50 },
          { name: '权益', kind: 'fund', targetPercent: 50 },
        ],
        rebalanceBand: 10,
      },
    })
    const review = current().reviewPlan(plan.id, { 固收: 45, 权益: 55 })
    expect(review.allocation?.needsRebalance).toBe(false)
    expect(review.allocation?.maxDrift).toBe(5)
  })

  it('reads a sleeve absent from currentValues as zero percent', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(), kind: 'allocation',
      allocation: {
        sleeves: [
          { name: '固收', kind: 'fund', targetPercent: 50 },
          { name: '权益', kind: 'fund', targetPercent: 50 },
        ],
        rebalanceBand: 10,
      },
    })
    // Only 固收 reports a value; 权益 is absent, so it reads as 0% (fully
    // drifted) while the tracked total stays 50.
    const review = current().reviewPlan(plan.id, { 固收: 50 })
    const sleeves = new Map(review.allocation?.sleeves.map(s => [s.name, s]))
    expect(sleeves.get('固收')).toMatchObject({ currentPercent: 100, driftPercent: -50, breached: true })
    expect(sleeves.get('权益')).toMatchObject({ currentPercent: 0, driftPercent: 50, breached: true })
  })

  it('accrues recurring investment by months elapsed since creation', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(), kind: 'recurring-investment',
      recurring: { monthlyAmount: 3_000, deductionDay: 10, productName: '稳健添利债券基金C', productKind: 'fund' },
    })
    vi.setSystemTime(NOW + 5 * 30 * DAY)
    const review = current().reviewPlan(plan.id)
    expect(review.monthsElapsed).toBe(5)
    expect(review.investedToDate).toBe(15_000)
  })

  it('echoes protection-gap recommendations on review', async () => {
    await baseClient()
    const plan = await current().createPlan({
      clientId: firstClientId(), kind: 'protection-gap',
      protectionGap: {
        annualIncome: 300_000, incomeYears: 8,
        existingLifeCover: 500_000, existingCriticalIllnessCover: 0,
        recommendedLifeCover: 0, recommendedCriticalIllnessCover: 0,
      },
    })
    const review = current().reviewPlan(plan.id)
    expect(review.protection).toMatchObject({
      recommendedLifeCover: 1_900_000,
      recommendedCriticalIllnessCover: 150_000,
    })
  })

  it('throws for an unknown plan id', () => {
    expect(() => current().reviewPlan('missing-plan')).toThrow(CrmUnknownPlanError)
  })
})
