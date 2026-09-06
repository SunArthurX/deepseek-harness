import { describe, expect, it } from 'vitest'
import {
  advisorRecordSchema,
  clientRecordSchema,
  consultationRecordSchema,
  interactionRecordSchema,
  opportunityRecordSchema,
  taskRecordSchema,
} from '../src/spec.ts'
import type {
  AdvisorRecord,
  ClientRecord,
  ConsultationRecord,
  InteractionRecord,
  OpportunityRecord,
  TaskRecord,
} from '../src/types.ts'

const NOW = 1_700_000_000_000

const advisor: AdvisorRecord = {
  id: 'a1' as AdvisorRecord['id'],
  name: '张伟明',
  team: '财富管理一部',
  licenseNo: 'S14400002001',
  specialties: ['asset_allocation'],
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
}

const client: ClientRecord = {
  id: 'c1' as ClientRecord['id'],
  name: '王建国',
  kind: 'individual',
  lifecycle: 'active',
  contact: { phone: '13900001111', region: '上海' },
  riskProfile: { tolerance: 'C3', score: 62, assessedAt: NOW, expiresAt: NOW + 86_400_000 },
  financial: { totalAum: 3_800_000, annualIncome: 850_000, currency: 'CNY' },
  advisorId: 'a1' as AdvisorRecord['id'],
  tags: ['私行客户'],
  notes: '重点客户',
  createdAt: NOW,
  updatedAt: NOW,
}

const interaction: InteractionRecord = {
  id: 'i1' as InteractionRecord['id'],
  clientId: client.id,
  advisorId: advisor.id,
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

const consultation: ConsultationRecord = {
  id: 'k1' as ConsultationRecord['id'],
  clientId: client.id,
  advisorId: advisor.id,
  interactionId: interaction.id,
  occurredAt: NOW,
  topics: ['retirement'],
  products: [{
    product: { name: '稳健添利债券基金C', kind: 'fund', riskLevel: 'R2' },
    verdict: 'matched',
    rationale: 'product 稳健添利债券基金C (risk R2) matches client tolerance C3',
  }],
  recommendations: ['按再平衡纪律分批建仓'],
  followUpRequired: true,
  summary: '年度回顾',
  sessionId: 'sess-1',
  createdAt: NOW,
}

const opportunity: OpportunityRecord = {
  id: 'o1' as OpportunityRecord['id'],
  clientId: client.id,
  advisorId: advisor.id,
  productKind: 'fund',
  productName: '中证红利低波ETF联接A',
  stage: 'new',
  amount: 100_000,
  currency: 'CNY',
  probability: 10,
  expectedCloseAt: NOW + 30 * 86_400_000,
  createdAt: NOW,
  updatedAt: NOW,
}

const task: TaskRecord = {
  id: 't1' as TaskRecord['id'],
  clientId: client.id,
  opportunityId: opportunity.id,
  advisorId: advisor.id,
  kind: 'follow_up',
  title: '电话跟进上次咨询结论',
  dueAt: NOW + 86_400_000,
  status: 'open',
  priority: 'high',
  notes: '确认风险测评时间',
  createdAt: NOW,
  updatedAt: NOW,
}

describe('crm record schemas at the durable boundary', () => {
  it('round-trips every full record', () => {
    expect(advisorRecordSchema.parse(advisor)).toEqual(advisor)
    expect(clientRecordSchema.parse(client)).toEqual(client)
    expect(interactionRecordSchema.parse(interaction)).toEqual(interaction)
    expect(consultationRecordSchema.parse(consultation)).toEqual(consultation)
    expect(opportunityRecordSchema.parse(opportunity)).toEqual(opportunity)
    expect(taskRecordSchema.parse(task)).toEqual(task)
  })

  it('rejects a malformed currency code', () => {
    expect(() => opportunityRecordSchema.parse({ ...opportunity, currency: 'cny' })).toThrow(/currency/)
  })

  it('rejects a risk profile whose expiry precedes its assessment', () => {
    expect(() => clientRecordSchema.parse({
      ...client,
      riskProfile: { tolerance: 'C3', assessedAt: NOW, expiresAt: NOW - 1 },
    })).toThrow(/expiresAt/)
  })

  it('accepts zero annual income and liquid assets but rejects negatives', () => {
    expect(clientRecordSchema.parse({
      ...client,
      financial: { totalAum: 0, annualIncome: 0, liquidAssets: 0, currency: 'CNY' },
    }).financial).toEqual({ totalAum: 0, annualIncome: 0, liquidAssets: 0, currency: 'CNY' })
    expect(() => clientRecordSchema.parse({
      ...client,
      financial: { totalAum: 0, annualIncome: -1, currency: 'CNY' },
    })).toThrow()
  })

  it('rejects a questionnaire score outside 1–100', () => {
    expect(() => clientRecordSchema.parse({
      ...client,
      riskProfile: { tolerance: 'C3', score: 101, assessedAt: NOW, expiresAt: NOW },
    })).toThrow()
  })

  it('rejects a non-positive deal amount and an out-of-range probability', () => {
    expect(() => opportunityRecordSchema.parse({ ...opportunity, amount: 0 })).toThrow()
    expect(() => opportunityRecordSchema.parse({ ...opportunity, probability: 101 })).toThrow()
  })

  it('rejects a close time outside a terminal stage and a lost deal without a close reason', () => {
    expect(() => opportunityRecordSchema.parse({ ...opportunity, stage: 'negotiation', closedAt: NOW }))
      .toThrow(/closedAt/)
    expect(() => opportunityRecordSchema.parse({ ...opportunity, stage: 'lost', closeReason: undefined }))
      .toThrow(/closeReason/)
    expect(opportunityRecordSchema.parse({
      ...opportunity,
      stage: 'lost',
      probability: 0,
      closedAt: NOW,
      closeReason: '选择了竞对方案',
    })).toBeTruthy()
  })

  it('rejects a completion time on a non-done task', () => {
    expect(() => taskRecordSchema.parse({ ...task, status: 'open', completedAt: NOW })).toThrow(/completedAt/)
    expect(taskRecordSchema.parse({ ...task, status: 'done', completedAt: NOW })).toBeTruthy()
  })

  it('strips unknown keys rather than failing, mirroring zod object defaults', () => {
    const parsed = clientRecordSchema.parse({ ...client, extra: 'unknown' })
    expect('extra' in parsed).toBe(false)
  })
})
