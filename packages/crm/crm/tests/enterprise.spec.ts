// Enterprise-soundness rounds: referential integrity over the whole seed,
// terminal-close ordering guarantees, mutation-chain race-freedom under
// concurrent callers, and end-to-end seed determinism.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CrmAdvisorRequiredError,
  CrmDuplicateLicenseError,
  CrmStageTransitionError,
  CrmTaskStateError,
  CrmUnknownAdvisorError,
  CrmUnknownClientError,
  CrmUnknownOpportunityError,
  CrmUnknownTaskError,
} from '../src/index.ts'
import { SEED_NOW, seedCrm } from './helpers/seed.ts'
import type { SeedResult } from './helpers/seed.ts'
import { crmHarness } from './helpers/harness.ts'

const DAY = 86_400_000

let harness: Awaited<ReturnType<typeof crmHarness>> | undefined
let seed: SeedResult | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: SEED_NOW })
  harness = await crmHarness()
  seed = await seedCrm(harness.service, ms => vi.setSystemTime(ms))
})

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  seed = undefined
  vi.useRealTimers()
})

describe('seed referential integrity', () => {
  it('every advisor-scoped row references a seeded client and advisor', () => {
    const { service } = harness!
    const clientIds = new Set(seed!.clients.map(client => client.id))
    const advisorIds = new Set(seed!.advisors.map(advisor => advisor.id))
    for (const record of seed!.interactions) {
      expect(clientIds.has(record.clientId)).toBe(true)
      expect(advisorIds.has(record.advisorId)).toBe(true)
    }
    for (const record of seed!.consultations) {
      expect(clientIds.has(record.clientId)).toBe(true)
      expect(advisorIds.has(record.advisorId)).toBe(true)
    }
    for (const record of seed!.opportunities) {
      expect(clientIds.has(record.clientId)).toBe(true)
      expect(advisorIds.has(record.advisorId)).toBe(true)
    }
    for (const record of seed!.tasks) {
      expect(record.clientId === undefined || clientIds.has(record.clientId)).toBe(true)
      expect(advisorIds.has(record.advisorId)).toBe(true)
    }
    // The durable store agrees with the returned records: nothing was lost.
    expect(service.listAdvisors()).toHaveLength(4)
    expect(service.searchClients({ limit: 100 })).toHaveLength(60)
    expect(service.listInteractions({ limit: 200 }).length).toBe(seed!.interactions.length)
    expect(service.listConsultations(undefined, 200)).toHaveLength(25)
    expect(service.listOpportunities({ limit: 200 })).toHaveLength(40)
    expect(service.listTasks({ status: 'open', limit: 200 })).toHaveLength(30)
  })

  it('serves audit names through the per-call cache for repeated clients', async () => {
    const { service } = harness!
    // Seed consultations give each client one record; a second consultation for
    // an already-audited client walks the name-cache hit path.
    const first = seed!.consultations[0]
    if (first === undefined) throw new Error('seed consultation missing')
    await service.recordConsultation({
      clientId: first.clientId,
      occurredAt: SEED_NOW - DAY,
      products: [{ name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' }],
    })
    const audit = service.suitabilityAudit(undefined, 200)
    const byClient = new Map<string, number>()
    for (const entry of audit) byClient.set(entry.clientId, (byClient.get(entry.clientId) ?? 0) + 1)
    expect(Math.max(...byClient.values())).toBe(2)
    expect(audit.filter(entry => entry.clientId === first.clientId)).toHaveLength(2)
  })

  it('every consultation verdict comes from the closed set with a rationale', () => {
    const verdicts = new Set(['matched', 'product-exceeds-profile', 'assessment-expired', 'missing-profile'])
    for (const record of seed!.consultations) {
      for (const assessment of record.products) {
        expect(verdicts.has(assessment.verdict)).toBe(true)
        expect(assessment.rationale.length).toBeGreaterThan(0)
      }
    }
    const all = seed!.consultations.flatMap(record => record.products.map(p => p.verdict))
    expect(new Set(all).has('matched')).toBe(true)
  })

  it('terminal deals close at or after creation with forced probabilities', () => {
    for (const deal of seed!.opportunities) {
      if (deal.stage !== 'won' && deal.stage !== 'lost' && deal.stage !== 'abandoned') continue
      expect(deal.closedAt).toBeDefined()
      expect(deal.closedAt!).toBeGreaterThanOrEqual(deal.createdAt)
      expect(deal.probability).toBe(deal.stage === 'won' ? 100 : 0)
      if (deal.stage !== 'won') expect(deal.closeReason).toBeDefined()
    }
  })
})

describe('typed error fields', () => {
  it('carries the addressed id and decision fields on every error class', async () => {
    const { service } = harness!
    const advisor = seed!.advisors[0]
    if (advisor === undefined) throw new Error('seed advisor missing')
    const client = seed!.clients[0]
    if (client === undefined) throw new Error('seed client missing')
    const deal = seed!.opportunities.find(d => d.stage === 'new')
    if (deal === undefined) throw new Error('seed deal missing')
    const task = seed!.tasks[0]
    if (task === undefined) throw new Error('seed task missing')

    expect(new CrmUnknownClientError(client.id).clientId).toBe(client.id)
    expect(new CrmUnknownAdvisorError(advisor.id).advisorId).toBe(advisor.id)
    expect(new CrmUnknownOpportunityError(deal.id).opportunityId).toBe(deal.id)
    expect(new CrmUnknownTaskError(task.id).taskId).toBe(task.id)
    expect(new CrmAdvisorRequiredError('testing').what).toBe('testing')
    const stage = new CrmStageTransitionError(deal.id, 'new', 'lost', 'requires a closeReason')
    expect(stage).toMatchObject({ opportunityId: deal.id, from: 'new', to: 'lost' })
    expect(new CrmTaskStateError(task.id, 'complete', 'done').status).toBe('done')
    expect(new CrmDuplicateLicenseError('S1', advisor.id)).toMatchObject({ licenseNo: 'S1', advisorId: advisor.id })
    await expect(service.completeTask(task.id)).resolves.toMatchObject({ status: 'done' })
    await expect(service.completeTask(task.id)).rejects.toBeInstanceOf(CrmTaskStateError)
  })
})

describe('mutation-chain race-freedom', () => {
  it('admits exactly one of two concurrent same-license advisor registrations', async () => {
    const { service } = harness!
    const results = await Promise.allSettled([
      service.registerAdvisor({ name: '甲', licenseNo: 'S14400009999' }),
      service.registerAdvisor({ name: '乙', licenseNo: 'S14400009999' }),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CrmDuplicateLicenseError)
    expect(service.listAdvisors().filter(advisor => advisor.licenseNo === 'S14400009999')).toHaveLength(1)
  })

  it('admits exactly one of two concurrent moves of one deal to the same stage', async () => {
    const { service } = harness!
    const client = seed!.clients[0]
    if (client === undefined) throw new Error('seed client missing')
    const deal = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 10 })
    const results = await Promise.allSettled([
      service.moveOpportunity({ opportunityId: deal.id, to: 'qualified' }),
      service.moveOpportunity({ opportunityId: deal.id, to: 'qualified' }),
    ])
    const rejected = results.filter(result => result.status === 'rejected')
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CrmStageTransitionError)
    expect(service.getOpportunity(deal.id)?.stage).toBe('qualified')
  })

  it('lands every write from twenty concurrent client creations', async () => {
    const { service } = harness!
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) => service.createClient({ name: `并发客户${String(i)}`, kind: 'individual' })),
    )
    expect(new Set(created.map(client => client.id)).size).toBe(20)
    expect(service.searchClients({ limit: 100 })).toHaveLength(80)
  })
})

describe('seed determinism', () => {
  it('reproduces an identical book from the same fixed seed', async () => {
    const second = await crmHarness()
    vi.setSystemTime(SEED_NOW)
    const again = await seedCrm(second.service, ms => vi.setSystemTime(ms))
    try {
      expect(again.clients.map(client => client.name)).toEqual(seed!.clients.map(client => client.name))
      expect(again.opportunities.map(deal => deal.amount)).toEqual(seed!.opportunities.map(deal => deal.amount))
      expect(again.interactions.map(record => record.occurredAt)).toEqual(seed!.interactions.map(record => record.occurredAt))
      expect(again.tasks.map(task => task.dueAt)).toEqual(seed!.tasks.map(task => task.dueAt))
      // Record ids are fresh UUIDs per seed; compare the id-independent faces.
      const bookFace = (snapshot: import('../src/types.ts').BookSnapshot) => ({
        totalClients: snapshot.totalClients,
        totalAum: snapshot.totalAum,
        byLifecycle: snapshot.byLifecycle,
        byTolerance: snapshot.byTolerance,
        expiring: snapshot.expiringProfiles.map(row => [row.name, row.expiresAt]),
        expired: snapshot.expiredProfiles.map(row => [row.name, row.expiresAt]),
      })
      expect(bookFace(second.service.bookSnapshot())).toEqual(bookFace(harness!.service.bookSnapshot()))
      expect(second.service.pipelineSnapshot()).toMatchObject(harness!.service.pipelineSnapshot())
    } finally {
      await second.dispose()
    }
  })
})

describe('persistence round-trip of the full book', () => {
  it('serves identical snapshots after a reopen over the same medium', async () => {
    const before = {
      pipeline: harness!.service.pipelineSnapshot(),
      book: harness!.service.bookSnapshot(),
      load: harness!.service.taskLoad(),
    }
    await harness!.dispose()
    const reopened = await crmHarness({ pool: harness!.pool })
    try {
      expect(reopened.service.pipelineSnapshot()).toEqual(before.pipeline)
      expect(reopened.service.bookSnapshot()).toEqual(before.book)
      expect(reopened.service.taskLoad()).toEqual(before.load)
    } finally {
      await reopened.dispose()
    }
  })
})

describe('value boundaries', () => {
  it('accepts probability 0 and 100, score 1 and 100, and the minimal positive amount', async () => {
    const { service, dispose } = await crmHarness()
    const advisor = await service.registerAdvisor({ name: '张伟明' })
    const client = await service.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C1', score: 1 },
    })
    expect(client.riskProfile?.score).toBe(1)
    const reassessed = await service.updateClient(client.id, { riskProfile: { tolerance: 'C5', score: 100 } })
    expect(reassessed.riskProfile?.score).toBe(100)
    const floor = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 0.01, probability: 0 })
    expect(floor).toMatchObject({ amount: 0.01, probability: 0 })
    const ceiling = await service.createOpportunity({
      clientId: client.id,
      productKind: 'fund',
      amount: 1,
      probability: 100,
    })
    expect(ceiling.probability).toBe(100)
    await dispose()
  })

  it('clamps caller limits to the protocol bounds on the full seed', () => {
    const { service } = harness!
    expect(service.searchClients({ limit: 999 })).toHaveLength(60)
    expect(service.listInteractions({ limit: 99_999 }).length).toBe(seed!.interactions.length)
    expect(service.listConsultations(undefined, 99_999)).toHaveLength(25)
    expect(service.listOpportunities({ limit: 99_999 })).toHaveLength(40)
    expect(service.listTasks({ status: 'open', limit: 99_999 })).toHaveLength(30)
  })

  it('treats inclusive boundaries as included for since and dueBefore', async () => {
    const { service, dispose } = await crmHarness()
    const advisor = await service.registerAdvisor({ name: '张伟明' })
    const client = await service.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const at = SEED_NOW - 5 * DAY
    await service.logInteraction({ clientId: client.id, summary: '边界互动', occurredAt: at })
    expect(service.listInteractions({ since: at })).toHaveLength(1)
    expect(service.listInteractions({ since: at + 1 })).toHaveLength(0)
    const task = await service.createTask({ advisorId: advisor.id, title: '边界任务', dueAt: at })
    expect(service.listTasks({ dueBefore: at })).toHaveLength(1)
    expect(service.listTasks({ dueBefore: at - 1 })).toHaveLength(0)
    await service.cancelTask(task.id)
    await dispose()
  })
})

describe('assessment-window boundaries', () => {
  it('treats the exact expiry instant as expired and backdates re-assessment', async () => {
    const { service, dispose } = await crmHarness({ riskProfileValidityDays: 100 })
    const advisor = await service.registerAdvisor({ name: '张伟明' })
    const client = await service.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C3' },
    })
    const expiry = SEED_NOW + 100 * DAY
    // One ms before expiry is unexpired (inside the 30-day warning window,
    // so 'expiring'); the instant itself is expired.
    vi.setSystemTime(expiry - 1)
    expect(service.clientBook(client.id).profileStatus).toBe('expiring')
    vi.setSystemTime(expiry)
    expect(service.clientBook(client.id).profileStatus).toBe('expired')
    // A backdated re-assessment restarts the window from its own time.
    const backdated = SEED_NOW - 50 * DAY
    const reassessed = await service.updateClient(client.id, {
      riskProfile: { tolerance: 'C2', assessedAt: backdated },
    })
    expect(reassessed.riskProfile?.expiresAt).toBe(backdated + 100 * DAY)
    await dispose()
  })

  it('blocks suitability at the exact expiry instant during a consultation', async () => {
    const { service, dispose } = await crmHarness({ riskProfileValidityDays: 10 })
    const advisor = await service.registerAdvisor({ name: '张伟明' })
    const client = await service.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C5' },
    })
    const occurredAt = SEED_NOW + 10 * DAY
    const record = await service.recordConsultation({
      clientId: client.id,
      occurredAt,
      products: [{ name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' }],
    })
    expect(record.products[0]?.verdict).toBe('assessment-expired')
    await dispose()
  })

  it('adopts the stage-default probability table for every open stage', async () => {
    const { service, dispose } = await crmHarness()
    const advisor = await service.registerAdvisor({ name: '张伟明' })
    const client = await service.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const defaults: readonly [string, number][] = [['new', 10], ['qualified', 30], ['proposal', 55], ['negotiation', 75]]
    for (const [stage, probability] of defaults) {
      const deal = await service.createOpportunity({
        clientId: client.id,
        productKind: 'fund',
        amount: 100,
        stage: stage as 'new' | 'qualified' | 'proposal' | 'negotiation',
      })
      expect(deal.probability).toBe(probability)
    }
    await dispose()
  })
})
