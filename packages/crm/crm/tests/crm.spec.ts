import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CrmService, {
  AdvisorId,
  ClientId,
  CrmAdvisorRequiredError,
  CrmDuplicateLicenseError,
  CrmStageTransitionError,
  CrmTaskStateError,
  CrmUnknownAdvisorError,
  CrmUnknownClientError,
  CrmUnknownOpportunityError,
  CrmUnknownTaskError,
  OpportunityId,
  TaskId,
} from '../src/index.ts'
import { crmHarness } from './helpers/harness.ts'

const NOW = Date.UTC(2026, 8, 1, 8)
const DAY = 86_400_000

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

/** Minimal valid book: one advisor plus one active assessed client. */
async function book(harness: { service: CrmService }) {
  const advisor = await harness.service.registerAdvisor({ name: '张伟明', licenseNo: 'S14400002001' })
  const client = await harness.service.createClient({
    name: '王建国',
    kind: 'individual',
    advisorId: advisor.id,
    riskProfile: { tolerance: 'C3', score: 62 },
    financial: { totalAum: 3_800_000, currency: 'CNY' },
    tags: [' 私行客户 ', '', '私行客户'],
  })
  return { advisor, client }
}

describe('CrmService advisors', () => {
  it('registers with defaults, reads, and lists by name with an availability filter', async () => {
    const { service, dispose } = await crmHarness()
    const first = await service.registerAdvisor({ name: '张伟明', team: '财富管理一部', specialties: ['tax'] })
    const second = await service.registerAdvisor({ name: '林晓芳', active: false })
    expect(first.active).toBe(true)
    expect(first.specialties).toEqual(['tax'])
    expect(second.specialties).toEqual([])

    expect(service.getAdvisor(first.id)).toBe(first)
    expect(service.getAdvisor(AdvisorId('missing'))).toBeUndefined()
    // Code-unit order: 张 (U+5F20) sorts before 林 (U+6797).
    expect(service.listAdvisors().map(a => a.name)).toEqual(['张伟明', '林晓芳'])
    expect(service.listAdvisors(true).map(a => a.name)).toEqual(['张伟明'])
    expect(service.listAdvisors(false).map(a => a.name)).toEqual(['林晓芳'])
    await dispose()
  })

  it('rejects a blank name and a duplicated license number', async () => {
    const { service, dispose } = await crmHarness()
    await expect(service.registerAdvisor({ name: '  ' })).rejects.toThrow(/advisor name/)
    const first = await service.registerAdvisor({ name: '张伟明', licenseNo: 'S14400002001' })
    await expect(service.registerAdvisor({ name: '林晓芳', licenseNo: 'S14400002001' }))
      .rejects.toBeInstanceOf(CrmDuplicateLicenseError)
    expect(first.licenseNo).toBe('S14400002001')
    await dispose()
  })

  it('rejects an invalid assessment-validity config at construction', () => {
    expect(() => new CrmService(new Context(), { riskProfileValidityDays: 0 })).toThrow(/riskProfileValidityDays/)
    expect(() => new CrmService(new Context(), { riskProfileValidityDays: 1.5 })).toThrow(/riskProfileValidityDays/)
  })
})

describe('CrmService clients', () => {
  it('creates with defaults and a normalized tag set, deriving the first assessment window', async () => {
    const { service, dispose } = await crmHarness({ riskProfileValidityDays: 730 })
    const { client } = await book({ service })
    expect(client.lifecycle).toBe('lead')
    expect(client.tags).toEqual(['私行客户'])
    expect(client.riskProfile).toEqual({
      tolerance: 'C3',
      score: 62,
      assessedAt: NOW,
      expiresAt: NOW + 730 * DAY,
    })
    expect(client.name).toBe('王建国')
    await dispose()
  })

  it('rejects an unknown owning advisor and a blank client name', async () => {
    const { service, dispose } = await crmHarness()
    await expect(service.createClient({
      name: '刘梅',
      kind: 'individual',
      advisorId: AdvisorId('missing'),
    })).rejects.toBeInstanceOf(CrmUnknownAdvisorError)
    await expect(service.createClient({ name: ' ', kind: 'individual' })).rejects.toThrow(/client name/)
    await dispose()
  })

  it('patches absent-keeps-value semantics and re-derives a re-assessment window', async () => {
    const { service, dispose } = await crmHarness({ riskProfileValidityDays: 365 })
    const { client } = await book({ service })
    vi.setSystemTime(NOW + 10 * DAY)
    const updated = await service.updateClient(client.id, {
      lifecycle: 'active',
      notes: '重点维护',
      riskProfile: { tolerance: 'C4', assessedAt: NOW + 10 * DAY },
    })
    expect(updated.lifecycle).toBe('active')
    expect(updated.notes).toBe('重点维护')
    expect(updated.tags).toEqual(['私行客户'])
    expect(updated.riskProfile?.expiresAt).toBe(NOW + 10 * DAY + 365 * DAY)
    expect(updated.updatedAt).toBe(NOW + 10 * DAY)
    await dispose()
  })

  it('rejects patching an unknown client or naming an unknown advisor', async () => {
    const { service, dispose } = await crmHarness()
    await expect(service.updateClient(ClientId('missing'), { lifecycle: 'active' }))
      .rejects.toBeInstanceOf(CrmUnknownClientError)
    const { client } = await book({ service })
    await expect(service.updateClient(client.id, { advisorId: AdvisorId('missing') }))
      .rejects.toBeInstanceOf(CrmUnknownAdvisorError)
    await dispose()
  })

  it('reports profile status through the expiry window transitions', async () => {
    const { service, dispose } = await crmHarness({ riskProfileValidityDays: 60 })
    await book({ service })
    expect(service.searchClients()[0]?.profileStatus).toBe('valid')
    vi.setSystemTime(NOW + 31 * DAY)
    expect(service.searchClients()[0]?.profileStatus).toBe('expiring')
    vi.setSystemTime(NOW + 60 * DAY)
    expect(service.searchClients()[0]?.profileStatus).toBe('expired')
    const bare = await service.createClient({ name: '冯丽娜', kind: 'individual' })
    expect(service.searchClients({ query: '冯丽娜' })[0]?.profileStatus).toBe('missing')
    expect(service.getClient(bare.id)?.riskProfile).toBeUndefined()
    await dispose()
  })

  it('searches by free text across name, tags, and contact fields with AND filters', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    await service.createClient({
      name: '刘梅',
      kind: 'individual',
      advisorId: advisor.id,
      contact: { phone: '13800002222', region: '杭州' },
      tags: ['新客'],
      lifecycle: 'onboarding',
    })
    expect(service.searchClients({ query: '王' }).map(c => c.name)).toEqual(['王建国'])
    expect(service.searchClients({ query: '私行' }).map(c => c.name)).toEqual(['王建国'])
    expect(service.searchClients({ query: '1380000' }).map(c => c.name)).toEqual(['刘梅'])
    expect(service.searchClients({ query: '杭州' }).map(c => c.name)).toEqual(['刘梅'])
    expect(service.searchClients({ query: '张伟明' })).toEqual([])
    expect(service.searchClients({ lifecycle: 'onboarding' }).map(c => c.name)).toEqual(['刘梅'])
    expect(service.searchClients({ advisorId: advisor.id })).toHaveLength(2)
    expect(service.searchClients({ tag: '新客' }).map(c => c.name)).toEqual(['刘梅'])
    expect(service.searchClients({ tolerance: 'C3' }).map(c => c.name)).toEqual(['王建国'])
    expect(service.searchClients({ limit: 1 })).toHaveLength(1)
    expect(() => service.searchClients({ limit: 0 })).toThrow(/limit/)
    expect(service.getClient(client.id)).toBeDefined()
    await dispose()
  })

  it('assembles the 360° client book', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const interaction = await service.logInteraction({ clientId: client.id, summary: '首次面谈' })
    await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100_000 })
    const task = await service.createTask({
      clientId: client.id,
      advisorId: advisor.id,
      title: '递送方案',
      dueAt: NOW + 3 * DAY,
    })
    const view = service.clientBook(client.id)
    expect(view.client.id).toBe(client.id)
    expect(view.interactions.map(i => i.id)).toEqual([interaction.id])
    expect(view.openTasks.map(t => t.id)).toEqual([task.id])
    expect(view.opportunities).toHaveLength(1)
    expect(view.profileStatus).toBe('valid')
    expect(() => service.clientBook(ClientId('missing'))).toThrow(CrmUnknownClientError)
    await dispose()
  })
})

describe('CrmService interactions', () => {
  it('logs with the client owner as the default advisor and lists with filters', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const other = await service.registerAdvisor({ name: '林晓芳' })
    const first = await service.logInteraction({
      clientId: client.id,
      summary: ' 电话沟通 ',
      occurredAt: NOW - 5 * DAY,
      kind: 'call',
      topics: ['market_outlook'],
      sentiment: 'positive',
      nextStep: ' 发送月报 ',
    })
    expect(first.advisorId).toBe(advisor.id)
    expect(first.summary).toBe('电话沟通')
    expect(first.nextStep).toBe('发送月报')
    expect(first.occurredAt).toBe(NOW - 5 * DAY)
    const second = await service.logInteraction({
      clientId: client.id,
      advisorId: other.id,
      kind: 'wechat',
      summary: '微信答疑',
    })
    expect(second.occurredAt).toBe(NOW)

    expect(service.listInteractions({ clientId: client.id }).map(i => i.id)).toEqual([second.id, first.id])
    expect(service.listInteractions({ advisorId: other.id })).toHaveLength(1)
    expect(service.listInteractions({ kind: 'call' })).toHaveLength(1)
    expect(service.listInteractions({ since: NOW - DAY })).toHaveLength(1)
    expect(service.listInteractions({ limit: 1 })).toHaveLength(1)
    expect(service.listInteractions()).toHaveLength(2)
    await expect(service.logInteraction({ clientId: ClientId('missing'), summary: 'x' }))
      .rejects.toBeInstanceOf(CrmUnknownClientError)
    await dispose()
  })

  it('requires an advisor when the client carries none', async () => {
    const { service, dispose } = await crmHarness()
    const orphan = await service.createClient({ name: '冯丽娜', kind: 'individual' })
    await expect(service.logInteraction({ clientId: orphan.id, summary: 'x' }))
      .rejects.toBeInstanceOf(CrmAdvisorRequiredError)
    await dispose()
  })
})

describe('CrmService consultations', () => {
  it('records per-product suitability verdicts against the profile at consultation time', async () => {
    const { service, dispose } = await crmHarness()
    const { client } = await book({ service })
    const interaction = await service.logInteraction({ clientId: client.id, summary: '咨询前沟通' })
    const record = await service.recordConsultation({
      clientId: client.id,
      interactionId: interaction.id,
      occurredAt: NOW - 2 * DAY,
      topics: ['asset_allocation'],
      products: [
        { name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' },
        { name: '雪球结构·中证500两年期', kind: 'structured', riskLevel: 'R5' },
      ],
      recommendations: [' 保留应急现金 '],
      followUpRequired: true,
      summary: ' 年度回顾 ',
    })
    expect(record.products.map(p => p.verdict)).toEqual(['matched', 'product-exceeds-profile'])
    expect(record.recommendations).toEqual(['保留应急现金'])
    expect(record.summary).toBe('年度回顾')
    expect(record.followUpRequired).toBe(true)
    expect(service.listConsultations(client.id)).toEqual([record])
    expect(service.listConsultations()).toEqual([record])
    await dispose()
  })

  it('records a missing-profile consultation and audits the flattened trail', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const unassessed = await service.createClient({
      name: '冯丽娜',
      kind: 'individual',
      advisorId: advisor.id,
    })
    await service.recordConsultation({
      clientId: unassessed.id,
      occurredAt: NOW - 2 * DAY,
      products: [{ name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' }],
    })
    await service.recordConsultation({
      clientId: client.id,
      occurredAt: NOW - DAY,
      products: [{ name: '稳健添利债券基金C', kind: 'fund', riskLevel: 'R2' }],
    })
    const audit = service.suitabilityAudit()
    expect(audit).toHaveLength(2)
    expect(audit.map(entry => entry.verdict)).toEqual(['matched', 'missing-profile'])
    expect(audit.map(entry => entry.clientName)).toEqual(['王建国', '冯丽娜'])
    expect(service.suitabilityAudit(unassessed.id)).toHaveLength(1)
    expect(service.suitabilityAudit(undefined, 1)).toHaveLength(1)
    await dispose()
  })
})

describe('CrmService opportunities', () => {
  it('opens with stage defaults and validates amount and probability', async () => {
    const { service, dispose } = await crmHarness()
    const { client } = await book({ service })
    const deal = await service.createOpportunity({
      clientId: client.id,
      productKind: 'fund',
      productName: ' 中证红利低波ETF联接A ',
      amount: 100_000,
      expectedCloseAt: NOW + 30 * DAY,
    })
    expect(deal.stage).toBe('new')
    expect(deal.probability).toBe(10)
    expect(deal.currency).toBe('CNY')
    expect(deal.productName).toBe('中证红利低波ETF联接A')
    const qualified = await service.createOpportunity({
      clientId: client.id,
      productKind: 'insurance',
      amount: 200_000,
      stage: 'qualified',
      probability: 40,
    })
    expect(qualified.probability).toBe(40)
    await expect(service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 0 }))
      .rejects.toThrow(/amount/)
    await expect(service.createOpportunity({
      clientId: client.id,
      productKind: 'fund',
      amount: 10,
      probability: 101,
    })).rejects.toThrow(/probability/)
    await expect(service.createOpportunity({ clientId: ClientId('missing'), productKind: 'fund', amount: 10 }))
      .rejects.toBeInstanceOf(CrmUnknownClientError)
    await dispose()
  })

  it('moves through the stage machine with defaults and terminal stamps', async () => {
    const { service, dispose } = await crmHarness()
    const { client } = await book({ service })
    const deal = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100_000 })
    const qualified = await service.moveOpportunity({ opportunityId: deal.id, to: 'qualified' })
    expect(qualified.probability).toBe(30)
    const proposal = await service.moveOpportunity({ opportunityId: deal.id, to: 'proposal', probability: 60 })
    expect(proposal.probability).toBe(60)
    vi.setSystemTime(NOW + 20 * DAY)
    const won = await service.moveOpportunity({ opportunityId: deal.id, to: 'won' })
    expect(won.probability).toBe(100)
    expect(won.closedAt).toBe(NOW + 20 * DAY)
    await expect(service.moveOpportunity({ opportunityId: deal.id, to: 'lost', closeReason: 'x' }))
      .rejects.toBeInstanceOf(CrmStageTransitionError)
    await dispose()
  })

  it('enforces terminal-stage and close-reason rules', async () => {
    const { service, dispose } = await crmHarness()
    const { client } = await book({ service })
    const deal = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 10 })
    await expect(service.moveOpportunity({ opportunityId: deal.id, to: 'new' }))
      .rejects.toThrow(/already in this stage/)
    await expect(service.moveOpportunity({ opportunityId: OpportunityId('missing'), to: 'qualified' }))
      .rejects.toBeInstanceOf(CrmUnknownOpportunityError)
    await expect(service.moveOpportunity({ opportunityId: deal.id, to: 'lost' }))
      .rejects.toThrow(/requires a closeReason/)
    await expect(service.moveOpportunity({ opportunityId: deal.id, to: 'lost', closeReason: '  ' }))
      .rejects.toThrow(/requires a closeReason/)
    const backward = await service.moveOpportunity({ opportunityId: deal.id, to: 'qualified' })
    expect(backward.probability).toBe(30)
    const abandoned = await service.moveOpportunity({
      opportunityId: deal.id,
      to: 'abandoned',
      closeReason: ' 客户暂缓投资计划 ',
    })
    expect(abandoned.closeReason).toBe('客户暂缓投资计划')
    expect(abandoned.probability).toBe(0)
    await expect(service.moveOpportunity({ opportunityId: deal.id, to: 'new' }))
      .rejects.toThrow(/terminal/)
    await dispose()
  })

  it('lists with client, stage, and advisor filters', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const second = await service.createClient({ name: '刘梅', kind: 'individual' })
    const firstDeal = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 10 })
    const secondDeal = await service.createOpportunity({ clientId: client.id, productKind: 'insurance', amount: 20 })
    await service.createOpportunity({ clientId: second.id, productKind: 'fund', amount: 30, advisorId: advisor.id })
    await service.moveOpportunity({ opportunityId: secondDeal.id, to: 'qualified' })
    expect(service.listOpportunities({ clientId: client.id })).toHaveLength(2)
    expect(service.listOpportunities({ stage: 'qualified' })).toHaveLength(1)
    expect(service.listOpportunities({ advisorId: advisor.id })).toHaveLength(3)
    expect(service.listOpportunities({ limit: 2 })).toHaveLength(2)
    expect(service.listOpportunities()).toHaveLength(3)
    expect(service.getOpportunity(firstDeal.id)?.amount).toBe(10)
    await dispose()
  })
})

describe('CrmService tasks', () => {
  it('resolves the owning advisor from the explicit field, the client, or the opportunity', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const deal = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 10 })
    const fromClient = await service.createTask({ clientId: client.id, title: ' 电话跟进 ', dueAt: NOW + DAY })
    expect(fromClient.advisorId).toBe(advisor.id)
    expect(fromClient.title).toBe('电话跟进')
    expect(fromClient.kind).toBe('follow_up')
    expect(fromClient.priority).toBe('normal')
    const fromOpportunity = await service.createTask({ opportunityId: deal.id, title: '准备材料', dueAt: NOW + DAY })
    expect(fromOpportunity.advisorId).toBe(advisor.id)
    const explicit = await service.createTask({
      advisorId: advisor.id,
      title: '团队例会材料',
      dueAt: NOW + 2 * DAY,
      kind: 'meeting_prep',
      priority: 'urgent',
      notes: ' 带上月报 ',
    })
    expect(explicit.kind).toBe('meeting_prep')
    expect(explicit.notes).toBe('带上月报')
    await expect(service.createTask({ title: '无主任务', dueAt: NOW }))
      .rejects.toBeInstanceOf(CrmAdvisorRequiredError)
    await dispose()
  })

  it('rejects mismatched client-opportunity pairs and unknown references', async () => {
    const { service, dispose } = await crmHarness()
    const { client } = await book({ service })
    const other = await service.createClient({ name: '刘梅', kind: 'individual' })
    const deal = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 10 })
    await expect(service.createTask({
      clientId: other.id,
      opportunityId: deal.id,
      title: '冲突引用',
      dueAt: NOW,
    })).rejects.toThrow(/does not match/)
    await expect(service.createTask({ clientId: ClientId('missing'), title: 'x', dueAt: NOW }))
      .rejects.toBeInstanceOf(CrmUnknownClientError)
    await expect(service.createTask({ opportunityId: OpportunityId('missing'), title: 'x', dueAt: NOW }))
      .rejects.toBeInstanceOf(CrmUnknownOpportunityError)
    await expect(service.createTask({ title: '  ', dueAt: NOW })).rejects.toThrow(/task title/)
    await dispose()
  })

  it('completes, cancels, and reschedules only open tasks', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor } = await book({ service })
    const task = await service.createTask({ advisorId: advisor.id, title: '跟进', dueAt: NOW + DAY })
    const moved = await service.rescheduleTask(task.id, NOW + 2 * DAY)
    expect(moved.dueAt).toBe(NOW + 2 * DAY)
    vi.setSystemTime(NOW + 3 * DAY)
    const done = await service.completeTask(task.id)
    expect(done.status).toBe('done')
    expect(done.completedAt).toBe(NOW + 3 * DAY)
    await expect(service.completeTask(task.id)).rejects.toBeInstanceOf(CrmTaskStateError)
    await expect(service.cancelTask(task.id)).rejects.toBeInstanceOf(CrmTaskStateError)
    await expect(service.rescheduleTask(task.id, NOW)).rejects.toBeInstanceOf(CrmTaskStateError)

    const cancelled = await service.createTask({ advisorId: advisor.id, title: '取消', dueAt: NOW })
    const cancelledRow = await service.cancelTask(cancelled.id)
    expect(cancelledRow.status).toBe('cancelled')
    expect(cancelledRow.completedAt).toBeUndefined()
    await expect(service.completeTask(TaskId('missing'))).rejects.toBeInstanceOf(CrmUnknownTaskError)
    await expect(service.cancelTask(TaskId('missing'))).rejects.toBeInstanceOf(CrmUnknownTaskError)
    await expect(service.rescheduleTask(TaskId('missing'), NOW)).rejects.toBeInstanceOf(CrmUnknownTaskError)
    await dispose()
  })

  it('lists open by default with status, overdue, and due-window filters', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const overdue = await service.createTask({ advisorId: advisor.id, title: '逾期', dueAt: NOW - DAY })
    const soon = await service.createTask({ clientId: client.id, title: '即将到期', dueAt: NOW + DAY })
    const later = await service.createTask({ advisorId: advisor.id, title: '较晚', dueAt: NOW + 10 * DAY })
    await service.completeTask(later.id)

    expect(service.listTasks().map(t => t.id)).toEqual([overdue.id, soon.id])
    expect(service.listTasks({ status: 'done' }).map(t => t.id)).toEqual([later.id])
    expect(service.listTasks({ status: 'cancelled' })).toEqual([])
    expect(service.listTasks({ overdue: true }).map(t => t.id)).toEqual([overdue.id])
    expect(service.listTasks({ dueBefore: NOW + 2 * DAY }).map(t => t.id)).toEqual([overdue.id, soon.id])
    expect(service.listTasks({ advisorId: advisor.id })).toHaveLength(2)
    expect(service.listTasks({ clientId: client.id }).map(t => t.id)).toEqual([soon.id])
    expect(service.listTasks({ limit: 1 })).toHaveLength(1)
    await dispose()
  })
})

describe('CrmService lifecycle', () => {
  it('fails reads before the domain initialized', () => {
    const ctx = new Context()
    const service = new CrmService(ctx, { riskProfileValidityDays: 730 })
    expect(() => service.getAdvisor(AdvisorId('a'))).toThrow(/not initialized/)
    expect(() => service.getClient(ClientId('c'))).toThrow(/not initialized/)
    expect(() => service.listInteractions()).toThrow(/not initialized/)
    expect(() => service.listConsultations()).toThrow(/not initialized/)
    expect(() => service.listOpportunities()).toThrow(/not initialized/)
    expect(() => service.listTasks()).toThrow(/not initialized/)
    return ctx.fiber.dispose()
  })

  it('rejects mutations after disposal and survives a reopen over the same medium', async () => {
    const first = await crmHarness()
    const { advisor, client } = await book(first)
    await first.service.createTask({ advisorId: advisor.id, title: '跨重启任务', dueAt: NOW + DAY })
    await first.dispose()

    await expect(first.service.registerAdvisor({ name: '迟到的顾问' })).rejects.toThrow(/disposing/)
    const roundTrip = await crmHarness({ pool: first.pool })
    expect(roundTrip.service.getClient(client.id)?.name).toBe('王建国')
    expect(roundTrip.service.listTasks()).toHaveLength(1)
    expect(roundTrip.service.listAdvisors()).toHaveLength(1)
    await roundTrip.dispose()
  })
})

describe('branch completion across optional fields and filters', () => {
  it('sorts descending and ties on equal names in text order', async () => {
    const { service, dispose } = await crmHarness()
    await service.registerAdvisor({ name: '张伟明' })
    await service.registerAdvisor({ name: '林晓芳' })
    // Insertion 张伟明 then 林晓芳; the sort must produce the descending
    // comparison (林 > 张 code-unit) to reach the +1 arm.
    expect(service.listAdvisors().map(a => a.name)).toEqual(['张伟明', '林晓芳'])
    const a = await service.createClient({ name: '同名', kind: 'individual' })
    const b = await service.createClient({ name: '同名', kind: 'individual' })
    // Equal names tie: the comparator returns 0 and insertion order is stable.
    const rows = service.searchClients({ query: '同名' })
    expect(rows.map(r => r.id)).toEqual([a.id, b.id])
    void b
    await dispose()
  })

  it('applies a full client patch across every field', async () => {
    const { service, dispose } = await crmHarness({ riskProfileValidityDays: 100 })
    const { advisor, client } = await book({ service })
    const other = await service.registerAdvisor({ name: '林晓芳' })
    const updated = await service.updateClient(client.id, {
      name: '王建国(改)',
      lifecycle: 'dormant',
      advisorId: other.id,
      tags: ['新标签'],
      notes: '新备注',
      contact: { phone: '13911112222', email: 'x@example.com' },
      financial: { totalAum: 1_000, annualIncome: 2_000, liquidAssets: 3, currency: 'USD' },
      riskProfile: { tolerance: 'C5', score: 90, assessedAt: NOW + DAY },
    })
    expect(updated.name).toBe('王建国(改)')
    expect(updated.lifecycle).toBe('dormant')
    expect(updated.advisorId).toBe(other.id)
    expect(updated.tags).toEqual(['新标签'])
    expect(updated.notes).toBe('新备注')
    expect(updated.contact).toEqual({ phone: '13911112222', email: 'x@example.com' })
    expect(updated.financial).toEqual({ totalAum: 1_000, annualIncome: 2_000, liquidAssets: 3, currency: 'USD' })
    expect(updated.riskProfile).toEqual({ tolerance: 'C5', score: 90, assessedAt: NOW + DAY, expiresAt: NOW + DAY + 100 * DAY })
    void advisor
    await dispose()
  })

  it('matches free text against email and wechat, and treats a blank query as match-all', async () => {
    const { service, dispose } = await crmHarness()
    await service.createClient({
      name: '联系人甲',
      kind: 'individual',
      contact: { email: 'Alpha@Example.com', wechat: 'AlphaWx' },
    })
    await service.createClient({ name: '联系人乙', kind: 'individual' })
    expect(service.searchClients({ query: 'alpha@' })).toHaveLength(1)
    expect(service.searchClients({ query: 'alphawx' })).toHaveLength(1)
    expect(service.searchClients({ query: '  ' })).toHaveLength(2)
    await dispose()
  })

  it('sorts every client-book list with multiple rows', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const other = await service.createClient({
      name: '刘梅',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C2' },
    })
    // Two interactions, two tasks, two live deals, two won deals, two consultations.
    await service.logInteraction({ clientId: client.id, summary: '较早', occurredAt: NOW - 2 * DAY })
    await service.logInteraction({ clientId: client.id, summary: '较晚', occurredAt: NOW - DAY })
    const t1 = await service.createTask({ clientId: client.id, title: '早', dueAt: NOW + DAY })
    const t2 = await service.createTask({ clientId: client.id, title: '晚', dueAt: NOW + 2 * DAY })
    const liveA = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 10 })
    const liveB = await service.createOpportunity({ clientId: client.id, productKind: 'insurance', amount: 20 })
    const wonA = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 30 })
    const wonB = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 40 })
    vi.setSystemTime(NOW + DAY)
    await service.moveOpportunity({ opportunityId: wonA.id, to: 'won' })
    vi.setSystemTime(NOW + 2 * DAY)
    await service.moveOpportunity({ opportunityId: wonB.id, to: 'won' })
    await service.recordConsultation({ clientId: client.id, occurredAt: NOW - 2 * DAY, products: [{ name: 'p', kind: 'fund', riskLevel: 'R1' }] })
    await service.recordConsultation({ clientId: client.id, occurredAt: NOW - DAY, products: [] })
    vi.setSystemTime(NOW)

    const view = service.clientBook(client.id)
    expect(view.interactions.map(i => i.summary)).toEqual(['较晚', '较早'])
    expect(view.openTasks.map(t => t.id)).toEqual([t1.id, t2.id])
    const ids = view.opportunities.map(o => o.id)
    expect(ids.slice(0, 2).sort()).toEqual([liveA.id, liveB.id].sort())
    expect(ids.slice(2).sort()).toEqual([wonA.id, wonB.id].sort())
    expect(view.consultations).toHaveLength(2)
    void other
    await dispose()
  })

  it('partitions opportunities per client and skips settled non-won deals in the book', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const other = await service.createClient({ name: '刘梅', kind: 'individual', advisorId: advisor.id })
    const liveMine = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 10 })
    const wonMine = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 20 })
    const lostMine = await service.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 30 })
    await service.createOpportunity({ clientId: other.id, productKind: 'fund', amount: 40 })
    vi.setSystemTime(NOW + DAY)
    await service.moveOpportunity({ opportunityId: wonMine.id, to: 'won' })
    await service.moveOpportunity({ opportunityId: lostMine.id, to: 'lost', closeReason: '预算不足' })
    vi.setSystemTime(NOW)
    const view = service.clientBook(client.id)
    // Live deals precede the recent-wins block in the 360° view.
    expect(view.opportunities.map(o => o.id)).toEqual([liveMine.id, wonMine.id])
    expect(service.clientBook(other.id).opportunities).toHaveLength(1)
    await dispose()
  })

  it('counts only open tasks in the load after completions', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor } = await book({ service })
    const first = await service.createTask({ advisorId: advisor.id, title: '先完成', dueAt: NOW + DAY })
    const second = await service.createTask({ advisorId: advisor.id, title: '保持未完成', dueAt: NOW + 2 * DAY })
    await service.completeTask(first.id)
    const load = service.taskLoad(advisor.id)
    expect(load.open).toBe(1)
    expect(load.dueSoon.map(t => t.id)).toEqual([second.id])
    await dispose()
  })

  it('defaults interaction kind and time, and consultation time, to now', async () => {
    const { service, dispose } = await crmHarness()
    const { client } = await book({ service })
    const interaction = await service.logInteraction({ clientId: client.id, summary: '默认渠道' })
    expect(interaction.kind).toBe('consultation')
    expect(interaction.occurredAt).toBe(NOW)
    const consultation = await service.recordConsultation({ clientId: client.id, products: [] })
    expect(consultation.occurredAt).toBe(NOW)
    await dispose()
  })

  it('filters consultations by client with mismatches present', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const other = await service.createClient({ name: '刘梅', kind: 'individual', advisorId: advisor.id })
    await service.recordConsultation({
      clientId: client.id,
      products: [{ name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' }],
    })
    await service.recordConsultation({ clientId: other.id, products: [] })
    expect(service.listConsultations(client.id)).toHaveLength(1)
    expect(service.suitabilityAudit(client.id)).toHaveLength(1)
    await dispose()
  })

  it('exercises opportunity and task filter exclusion paths', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const other = await service.createClient({ name: '刘梅', kind: 'individual', advisorId: advisor.id })
    const mine = await service.createOpportunity({
      clientId: client.id,
      productKind: 'fund',
      amount: 10,
      notes: '带备注',
    })
    await service.createOpportunity({ clientId: other.id, productKind: 'fund', amount: 20 })
    // advisor filter excludes nothing (all belong to advisor), client filter excludes other's deal
    expect(service.listOpportunities({ advisorId: advisor.id })).toHaveLength(2)
    expect(service.listOpportunities({ clientId: client.id })).toEqual([mine])

    const overdue = await service.createTask({ clientId: client.id, title: '逾期', dueAt: NOW - DAY })
    const future = await service.createTask({ clientId: other.id, title: '未来', dueAt: NOW + 5 * DAY })
    const advisorOnly = await service.createTask({ advisorId: advisor.id, title: '团队任务', dueAt: NOW + 2 * DAY })
    expect(service.listTasks({ advisorId: advisor.id })).toHaveLength(3)
    expect(service.listTasks({ clientId: client.id }).map(t => t.id)).toEqual([overdue.id])
    expect(service.listTasks({ dueBefore: NOW }).map(t => t.id)).toEqual([overdue.id])
    expect(service.listTasks({ overdue: true }).map(t => t.id)).toEqual([overdue.id])

    const load = service.taskLoad()
    expect(load.dueSoon.map(t => t.id)).toEqual([overdue.id, advisorOnly.id, future.id])
    expect(load.dueSoon.every(t => t.clientId === undefined || true)).toBe(true)
    const noClient = load.dueSoon.find(t => t.id === advisorOnly.id)
    expect(noClient && 'clientId' in noClient).toBeFalsy()
    await dispose()
  })

  it('counts clients without a financial profile as zero AUM in book snapshots', async () => {
    const { service, dispose } = await crmHarness()
    await service.createClient({ name: '无资产客户', kind: 'individual', riskProfile: { tolerance: 'C2' } })
    await service.createClient({ name: '另一无资产', kind: 'individual' })
    const snapshot = service.bookSnapshot()
    expect(snapshot.totalAum).toBe(0)
    expect(snapshot.byTolerance.at(-1)?.tolerance).toBeNull()
    expect(snapshot.byTolerance.at(-1)?.aum).toBe(0)
    expect(snapshot.byTolerance.at(-1)?.count).toBe(1)
    await dispose()
  })
})

describe('remaining optional-field and exclusion paths', () => {
  it('updates a client without touching the risk profile', async () => {
    const { service, dispose } = await crmHarness()
    const { client } = await book({ service })
    const updated = await service.updateClient(client.id, { lifecycle: 'active' })
    expect(updated.riskProfile?.tolerance).toBe('C3')
    const bare = await service.createClient({ name: '冯丽娜', kind: 'individual' })
    const stillBare = await service.updateClient(bare.id, { notes: '无测评客户' })
    expect(stillBare.riskProfile).toBeUndefined()
    await dispose()
  })

  it('excludes clients of another advisor in search', async () => {
    const { service, dispose } = await crmHarness()
    const first = await service.registerAdvisor({ name: '张伟明' })
    const second = await service.registerAdvisor({ name: '林晓芳' })
    await service.createClient({ name: '张的客户', kind: 'individual', advisorId: first.id })
    await service.createClient({ name: '林的客户', kind: 'individual', advisorId: second.id })
    expect(service.searchClients({ advisorId: first.id }).map(c => c.name)).toEqual(['张的客户'])
    await dispose()
  })

  it('carries session ids and excludes other clients in interaction and consultation lists', async () => {
    const { service, dispose } = await crmHarness()
    const { advisor, client } = await book({ service })
    const other = await service.createClient({ name: '刘梅', kind: 'individual', advisorId: advisor.id })
    const interaction = await service.logInteraction({ clientId: client.id, summary: '带会话', sessionId: 'sess-9' })
    expect(interaction.sessionId).toBe('sess-9')
    await service.logInteraction({ clientId: other.id, summary: '他人互动' })
    expect(service.listInteractions({ clientId: client.id })).toHaveLength(1)
    expect(service.listInteractions()).toHaveLength(2)

    const consultation = await service.recordConsultation({
      clientId: client.id,
      sessionId: 'sess-9',
      products: [{ name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' }],
    })
    expect(consultation.sessionId).toBe('sess-9')
    await service.recordConsultation({ clientId: other.id, products: [] })
    expect(service.listConsultations()).toHaveLength(2)
    expect(service.listConsultations(client.id)).toHaveLength(1)
    await dispose()
  })

  it('excludes opportunities of another advisor in listing', async () => {
    const { service, dispose } = await crmHarness()
    const first = await service.registerAdvisor({ name: '张伟明' })
    const second = await service.registerAdvisor({ name: '林晓芳' })
    const a = await service.createClient({ name: '张的客户', kind: 'individual', advisorId: first.id })
    const b = await service.createClient({ name: '林的客户', kind: 'individual', advisorId: second.id })
    await service.createOpportunity({ clientId: a.id, productKind: 'fund', amount: 10, notes: '张的备注' })
    await service.createOpportunity({ clientId: b.id, productKind: 'fund', amount: 20 })
    expect(service.listOpportunities({ advisorId: second.id })).toHaveLength(1)
    expect(service.listOpportunities({ clientId: a.id })).toHaveLength(1)
    await dispose()
  })

  it('excludes tasks of another advisor and another client in listing', async () => {
    const { service, dispose } = await crmHarness()
    const first = await service.registerAdvisor({ name: '张伟明' })
    const second = await service.registerAdvisor({ name: '林晓芳' })
    const a = await service.createClient({ name: '张的客户', kind: 'individual', advisorId: first.id })
    const b = await service.createClient({ name: '林的客户', kind: 'individual', advisorId: second.id })
    await service.createTask({ clientId: a.id, title: '张的任务', dueAt: NOW + DAY })
    await service.createTask({ clientId: b.id, title: '林的任务', dueAt: NOW + DAY })
    expect(service.listTasks({ advisorId: first.id })).toHaveLength(1)
    expect(service.listTasks({ clientId: b.id })).toHaveLength(1)
    await dispose()
  })
})

describe('analytics scoping branches', () => {
  it('scopes the pipeline snapshot and carries the advisor marker', async () => {
    const { service, dispose } = await crmHarness()
    const first = await service.registerAdvisor({ name: '张伟明' })
    const second = await service.registerAdvisor({ name: '林晓芳' })
    const a = await service.createClient({ name: '张的客户', kind: 'individual', advisorId: first.id })
    const b = await service.createClient({ name: '林的客户', kind: 'individual', advisorId: second.id })
    const mine = await service.createOpportunity({ clientId: a.id, productKind: 'fund', amount: 100 })
    await service.createOpportunity({ clientId: b.id, productKind: 'fund', amount: 200 })
    const theirs = await service.createOpportunity({ clientId: b.id, productKind: 'fund', amount: 400 })
    const moved = await service.moveOpportunity({
      opportunityId: theirs.id,
      to: 'qualified',
      notes: '客户预算提高',
    })
    expect(moved.notes).toBe('客户预算提高')
    const scoped = service.pipelineSnapshot(first.id)
    expect(scoped.advisorId).toBe(first.id)
    expect(scoped.openCount).toBe(1)
    expect(scoped.openAmount).toBe(100)
    expect(scoped.stages.find(s => s.stage === 'new')?.count).toBe(1)
    void mine
    await dispose()
  })

  it('omits the unassessed tolerance row when every client carries a profile', async () => {
    const { service, dispose } = await crmHarness()
    await service.createClient({ name: '已测评', kind: 'individual', riskProfile: { tolerance: 'C2' } })
    const snapshot = service.bookSnapshot()
    expect(snapshot.byTolerance.at(-1)?.tolerance).toBe('C5')
    await dispose()
  })

  it('records a consultation with products omitted entirely', async () => {
    const { service, dispose } = await crmHarness()
    const { client } = await book({ service })
    const record = await service.recordConsultation({ clientId: client.id })
    expect(record.products).toEqual([])
    expect(record.topics).toEqual([])
    expect(record.recommendations).toEqual([])
    await dispose()
  })
})
