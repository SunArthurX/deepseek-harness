// Direct serializer coverage: every wire serializer runs against one fully
// populated record and one minimal record, so every optional-field branch
// executes both ways without depending on tool-pipeline fixtures.
import { describe, expect, it } from 'vitest'
import type {
  AdvisorRecord,
  ClientRecord,
  ConsultationRecord,
  InteractionRecord,
  OpportunityRecord,
  TaskRecord,
} from '@deepseek-ai/dsh-crm/types'
import {
  wireAdvisor,
  wireBook,
  wireClient,
  wireClientSummary,
  wireConsultation,
  wireInteraction,
  wireOpportunity,
  wirePipeline,
  wireTask,
  wireTaskLoad,
} from '../src/wire.ts'
import type { ClientSummary } from '@deepseek-ai/dsh-crm/types'

const NOW = Date.UTC(2026, 8, 1, 8)

const fullAdvisor: AdvisorRecord = {
  id: 'a1' as AdvisorRecord['id'],
  name: '张伟明',
  team: '财富管理一部',
  licenseNo: 'S14400002001',
  specialties: ['asset_allocation', 'tax'],
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
}

const minimalAdvisor: AdvisorRecord = {
  id: 'a2' as AdvisorRecord['id'],
  name: '林晓芳',
  specialties: [],
  active: false,
  createdAt: NOW,
  updatedAt: NOW,
}

const fullClient: ClientRecord = {
  id: 'c1' as ClientRecord['id'],
  name: '王建国',
  kind: 'individual',
  lifecycle: 'active',
  contact: { phone: '13900001111', email: 'wgj@example.com', wechat: 'wgj_wx', region: '上海' },
  riskProfile: { tolerance: 'C3', score: 62, assessedAt: NOW, expiresAt: NOW + 90 * 86_400_000 },
  financial: { totalAum: 3_800_000, annualIncome: 850_000, liquidAssets: 1_500_000, currency: 'CNY' },
  advisorId: 'a1' as AdvisorRecord['id'],
  tags: ['私行客户'],
  notes: '重点客户',
  createdAt: NOW,
  updatedAt: NOW,
}

const minimalClient: ClientRecord = {
  id: 'c2' as ClientRecord['id'],
  name: '冯丽娜',
  kind: 'institution',
  lifecycle: 'lead',
  contact: { region: '杭州' },
  tags: [],
  createdAt: NOW,
  updatedAt: NOW,
}

const fullSummary: ClientSummary = {
  id: 'c1' as ClientRecord['id'],
  name: '王建国',
  kind: 'individual',
  lifecycle: 'active',
  tolerance: 'C3',
  totalAum: 3_800_000,
  advisorId: 'a1' as AdvisorRecord['id'],
  tags: ['私行客户'],
  profileStatus: 'valid',
}

const minimalSummary: ClientSummary = {
  id: 'c2' as ClientRecord['id'],
  name: '冯丽娜',
  kind: 'individual',
  lifecycle: 'lead',
  tolerance: null,
  totalAum: null,
  tags: [],
  profileStatus: 'missing',
}

const fullInteraction: InteractionRecord = {
  id: 'i1' as InteractionRecord['id'],
  clientId: 'c1' as ClientRecord['id'],
  advisorId: 'a1' as AdvisorRecord['id'],
  kind: 'meeting',
  occurredAt: NOW,
  durationMin: 45,
  summary: '面谈回顾持仓',
  sentiment: 'positive',
  topics: ['asset_allocation'],
  nextStep: '下周电话跟进',
  sessionId: 'sess-1',
  createdAt: NOW,
}

const minimalInteraction: InteractionRecord = {
  id: 'i2' as InteractionRecord['id'],
  clientId: 'c1' as ClientRecord['id'],
  advisorId: 'a1' as AdvisorRecord['id'],
  kind: 'call',
  occurredAt: NOW,
  summary: '电话沟通',
  topics: [],
  createdAt: NOW,
}

const fullConsultation: ConsultationRecord = {
  id: 'k1' as ConsultationRecord['id'],
  clientId: 'c1' as ClientRecord['id'],
  advisorId: 'a1' as AdvisorRecord['id'],
  interactionId: 'i1' as InteractionRecord['id'],
  occurredAt: NOW,
  topics: ['retirement'],
  products: [{
    product: { name: '稳健添利债券基金C', kind: 'fund', riskLevel: 'R2' },
    verdict: 'matched',
    rationale: 'matches client tolerance C3',
  }],
  recommendations: ['按再平衡纪律分批建仓'],
  followUpRequired: true,
  summary: '年度回顾',
  sessionId: 'sess-1',
  createdAt: NOW,
}

const minimalConsultation: ConsultationRecord = {
  id: 'k2' as ConsultationRecord['id'],
  clientId: 'c1' as ClientRecord['id'],
  advisorId: 'a1' as AdvisorRecord['id'],
  occurredAt: NOW,
  topics: [],
  products: [],
  recommendations: [],
  followUpRequired: false,
  createdAt: NOW,
}

const fullOpportunity: OpportunityRecord = {
  id: 'o1' as OpportunityRecord['id'],
  clientId: 'c1' as ClientRecord['id'],
  advisorId: 'a1' as AdvisorRecord['id'],
  productKind: 'fund',
  productName: '中证红利低波ETF联接A',
  stage: 'won',
  amount: 100_000,
  currency: 'CNY',
  probability: 100,
  expectedCloseAt: NOW,
  closedAt: NOW,
  closeReason: '签约打款',
  notes: '转介绍成交',
  createdAt: NOW,
  updatedAt: NOW,
}

const minimalOpportunity: OpportunityRecord = {
  id: 'o2' as OpportunityRecord['id'],
  clientId: 'c1' as ClientRecord['id'],
  advisorId: 'a1' as AdvisorRecord['id'],
  productKind: 'fund',
  stage: 'new',
  amount: 10_000,
  currency: 'CNY',
  probability: 10,
  createdAt: NOW,
  updatedAt: NOW,
}

const fullTask: TaskRecord = {
  id: 't1' as TaskRecord['id'],
  clientId: 'c1' as ClientRecord['id'],
  opportunityId: 'o1' as OpportunityRecord['id'],
  advisorId: 'a1' as AdvisorRecord['id'],
  kind: 'follow_up',
  title: '电话跟进上次咨询结论',
  dueAt: NOW,
  status: 'done',
  priority: 'urgent',
  notes: '优先处理',
  completedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
}

const minimalTask: TaskRecord = {
  id: 't2' as TaskRecord['id'],
  advisorId: 'a1' as AdvisorRecord['id'],
  kind: 'client_care',
  title: '生日问候',
  dueAt: NOW,
  status: 'open',
  priority: 'low',
  createdAt: NOW,
  updatedAt: NOW,
}

const ISO = new Date(NOW).toISOString()

describe('wire serializers', () => {
  it('serializes advisors with and without optional identity fields', () => {
    expect(wireAdvisor(fullAdvisor)).toEqual({
      id: 'a1',
      name: '张伟明',
      team: '财富管理一部',
      licenseNo: 'S14400002001',
      specialties: ['asset_allocation', 'tax'],
      active: true,
      createdAt: ISO,
      updatedAt: ISO,
    })
    const minimal = wireAdvisor(minimalAdvisor)
    expect(minimal.team).toBeUndefined()
    expect(minimal.licenseNo).toBeUndefined()
  })

  it('serializes clients with and without contact, profile, financial, advisor, and notes', () => {
    const full = wireClient(fullClient, NOW)
    expect(full).toMatchObject({
      id: 'c1',
      name: '王建国',
      kind: 'individual',
      lifecycle: 'active',
      tags: ['私行客户'],
      profileStatus: 'valid',
      createdAt: ISO,
      updatedAt: ISO,
    })
    expect(full.contact).toEqual({ phone: '13900001111', email: 'wgj@example.com', wechat: 'wgj_wx', region: '上海' })
    expect(full.riskProfile).toEqual({ tolerance: 'C3', score: 62, assessedAt: ISO, expiresAt: new Date(NOW + 90 * 86_400_000).toISOString() })
    expect(full.financial).toEqual({ totalAum: 3_800_000, annualIncome: 850_000, liquidAssets: 1_500_000, currency: 'CNY' })
    const minimal = wireClient(minimalClient, NOW)
    expect(minimal.contact).toEqual({ region: '杭州' })
    expect(minimal.riskProfile).toBeUndefined()
    expect(minimal.financial).toBeUndefined()
    expect(minimal.advisorId).toBeUndefined()
    expect(minimal.notes).toBeUndefined()
    expect(minimal.profileStatus).toBe('missing')
  })

  it('serializes search rows with null tolerance and AUM for unassessed clients', () => {
    expect(wireClientSummary(fullSummary).advisorId).toBe('a1')
    const minimal = wireClientSummary(minimalSummary)
    expect(minimal.tolerance).toBeNull()
    expect(minimal.totalAum).toBeNull()
    expect('advisorId' in minimal).toBe(false)
  })

  it('serializes interactions with and without duration, sentiment, next step, and session', () => {
    const full = wireInteraction(fullInteraction)
    expect(full).toMatchObject({ durationMin: 45, sentiment: 'positive', nextStep: '下周电话跟进', sessionId: 'sess-1' })
    const minimal = wireInteraction(minimalInteraction)
    expect(minimal.durationMin).toBeUndefined()
    const partialContact = wireClient({ ...fullClient, contact: { wechat: 'only_wx' } }, NOW)
    expect(partialContact.contact).toEqual({ wechat: 'only_wx' })
    expect(minimal.sentiment).toBeUndefined()
    expect(minimal.nextStep).toBeUndefined()
    expect(minimal.sessionId).toBeUndefined()
  })

  it('serializes consultations with and without interaction, summary, and session links', () => {
    const full = wireConsultation(fullConsultation)
    expect(full.products).toEqual([{
      name: '稳健添利债券基金C',
      kind: 'fund',
      riskLevel: 'R2',
      verdict: 'matched',
      rationale: 'matches client tolerance C3',
    }])
    expect(full.interactionId).toBe('i1')
    expect(full.summary).toBe('年度回顾')
    expect(full.sessionId).toBe('sess-1')
    const minimal = wireConsultation(minimalConsultation)
    expect(minimal.interactionId).toBeUndefined()
    expect(minimal.summary).toBeUndefined()
    expect(minimal.sessionId).toBeUndefined()
  })

  it('serializes opportunities with and without product name, dates, reason, and notes', () => {
    const full = wireOpportunity(fullOpportunity)
    expect(full).toMatchObject({
      productName: '中证红利低波ETF联接A',
      expectedCloseAt: ISO,
      closedAt: ISO,
      closeReason: '签约打款',
      notes: '转介绍成交',
    })
    const minimal = wireOpportunity(minimalOpportunity)
    expect(minimal.productName).toBeUndefined()
    expect(minimal.expectedCloseAt).toBeUndefined()
    expect(minimal.closedAt).toBeUndefined()
    expect(minimal.closeReason).toBeUndefined()
    expect(minimal.notes).toBeUndefined()
  })

  it('serializes tasks with and without scope refs, notes, and completion, deriving overdue', () => {
    const full = wireTask(fullTask, NOW)
    expect(full).toMatchObject({ clientId: 'c1', opportunityId: 'o1', notes: '优先处理', completedAt: ISO, overdue: false })
    const minimalOpen = wireTask(minimalTask, NOW)
    expect('clientId' in minimalOpen).toBe(false)
    expect('opportunityId' in minimalOpen).toBe(false)
    expect(minimalOpen.notes).toBeUndefined()
    expect(minimalOpen.completedAt).toBeUndefined()
    expect(wireTask({ ...minimalTask, dueAt: NOW - 1 }, NOW).overdue).toBe(true)
  })

  it('serializes pipeline, book, and task-load snapshots with and without advisor scoping', () => {
    const pipeline = wirePipeline({
      stages: [{ stage: 'new', count: 1, amount: 100, weighted: 10 }],
      openCount: 1,
      openAmount: 100,
      weightedForecast: 10,
      wonCount: 0,
      wonAmount: 0,
      lostCount: 0,
      winRate: null,
    })
    expect('advisorId' in pipeline).toBe(false)
    expect(wirePipeline({
      advisorId: 'a1' as AdvisorRecord['id'],
      stages: [],
      openCount: 0,
      openAmount: 0,
      weightedForecast: 0,
      wonCount: 1,
      wonAmount: 5,
      lostCount: 1,
      winRate: 50,
    }).advisorId).toBe('a1')

    const book = wireBook({
      totalClients: 2,
      byLifecycle: [{ lifecycle: 'active', count: 2 }],
      byTolerance: [
        { tolerance: 'C3', count: 1, aum: 100 },
        { tolerance: null, count: 1, aum: 0 },
      ],
      totalAum: 100,
      expiringProfiles: [{ clientId: 'c1' as ClientRecord['id'], name: '王建国', expiresAt: NOW }],
      expiredProfiles: [],
    })
    expect('advisorId' in book).toBe(false)
    expect(book.byTolerance[1]?.tolerance).toBeNull()
    expect(book.expiringProfiles[0]?.expiresAt).toBe(ISO)
    expect(wireBook({
      advisorId: 'a1' as AdvisorRecord['id'],
      totalClients: 0,
      byLifecycle: [],
      byTolerance: [],
      totalAum: 0,
      expiringProfiles: [],
      expiredProfiles: [{ clientId: 'c2' as ClientRecord['id'], name: '冯丽娜', expiresAt: NOW }],
    }).advisorId).toBe('a1')

    const load = wireTaskLoad({
      at: NOW,
      open: 2,
      overdue: 1,
      byPriority: [{ priority: 'urgent', count: 1 }, { priority: 'normal', count: 1 }],
      dueSoon: [{
        id: 't1' as TaskRecord['id'],
        title: '跟进',
        dueAt: NOW - 1,
        clientId: 'c1' as ClientRecord['id'],
        priority: 'urgent',
        overdue: true,
      }, {
        id: 't2' as TaskRecord['id'],
        title: '问候',
        dueAt: NOW + 1,
        priority: 'normal',
        overdue: false,
      }],
    })
    expect('advisorId' in load).toBe(false)
    expect(load.dueSoon[0]).toMatchObject({ clientId: 'c1', overdue: true })
    expect('clientId' in (load.dueSoon[1] as object)).toBe(false)
    expect(wireTaskLoad({
      advisorId: 'a1' as AdvisorRecord['id'],
      at: NOW,
      open: 0,
      overdue: 0,
      byPriority: [],
      dueSoon: [],
    }).advisorId).toBe('a1')
  })
})
