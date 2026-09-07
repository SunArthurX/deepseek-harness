/**
 * Durable storage-domain declaration for the CRM: zod record schemas and the
 * single domain spec. The schemas validate every record at the durable
 * read/write boundary; in-process callers rely on the static types.
 * @module @deepseek-ai/dsh-crm/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  AdvisorId,
  AdvisorRecord,
  ClientId,
  ClientRecord,
  ConsultationId,
  ConsultationRecord,
  InteractionId,
  InteractionRecord,
  OpportunityId,
  OpportunityRecord,
  TaskId,
  TaskRecord,
} from './types.ts'
import type { PlanRecord } from './plan-types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

const advisorId = z.string().min(1).transform(value => value as AdvisorId)
const clientId = z.string().min(1).transform(value => value as ClientId)
const interactionId = z.string().min(1).transform(value => value as InteractionId)
const consultationId = z.string().min(1).transform(value => value as ConsultationId)
const opportunityId = z.string().min(1).transform(value => value as OpportunityId)
const taskId = z.string().min(1).transform(value => value as TaskId)

const tolerance = z.enum(['C1', 'C2', 'C3', 'C4', 'C5'])
const productRiskLevel = z.enum(['R1', 'R2', 'R3', 'R4', 'R5'])
const advisoryTopic = z.enum([
  'asset_allocation',
  'retirement',
  'tax',
  'insurance',
  'education',
  'market_outlook',
  'product_review',
  'portfolio_rebalance',
  'other',
])
const currency = z.string().regex(/^[A-Z]{3}$/, 'currency must be an upper-case ISO 4217 code')

const riskProfile = z.object({
  tolerance,
  score: z.number().int().min(1).max(100).optional(),
  assessedAt: nonNegativeSafeInteger,
  expiresAt: nonNegativeSafeInteger,
}).refine(profile => profile.expiresAt >= profile.assessedAt, {
  path: ['expiresAt'],
  message: 'risk profile expiresAt must not precede assessedAt',
})

const financialProfile = z.object({
  // Zero is a legitimate value ("no income", fully illiquid); only negative
  // amounts are impossible, matching totalAum.
  annualIncome: nonNegativeSafeInteger.optional(),
  liquidAssets: nonNegativeSafeInteger.optional(),
  totalAum: nonNegativeSafeInteger,
  currency,
})

const contactInfo = z.object({
  phone: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  wechat: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
})

/** Runtime schema validating one durable advisor record. */
export const advisorRecordSchema = z.object({
  id: advisorId,
  name: z.string().min(1),
  team: z.string().min(1).optional(),
  licenseNo: z.string().min(1).optional(),
  specialties: z.array(advisoryTopic),
  active: z.boolean(),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
}) as unknown as z.ZodType<AdvisorRecord>

/** Runtime schema validating one durable client record. */
export const clientRecordSchema = z.object({
  id: clientId,
  name: z.string().min(1),
  kind: z.enum(['individual', 'institution']),
  lifecycle: z.enum(['lead', 'prospect', 'onboarding', 'active', 'dormant', 'lost']),
  contact: contactInfo.optional(),
  riskProfile: riskProfile.optional(),
  financial: financialProfile.optional(),
  advisorId: advisorId.optional(),
  tags: z.array(z.string().min(1)),
  notes: z.string().min(1).optional(),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
}) as unknown as z.ZodType<ClientRecord>

/** Runtime schema validating one durable interaction record. */
export const interactionRecordSchema = z.object({
  id: interactionId,
  clientId,
  advisorId,
  kind: z.enum(['consultation', 'call', 'wechat', 'meeting', 'email', 'report_review']),
  occurredAt: nonNegativeSafeInteger,
  durationMin: positiveSafeInteger.optional(),
  summary: z.string().min(1),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  topics: z.array(advisoryTopic),
  nextStep: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  createdAt: nonNegativeSafeInteger,
}) as unknown as z.ZodType<InteractionRecord>

const productDiscussion = z.object({
  name: z.string().min(1),
  kind: z.enum(['fund', 'insurance', 'structured', 'retirement', 'education', 'tax', 'advisory_fee']),
  riskLevel: productRiskLevel,
})

const suitabilityAssessment = z.object({
  product: productDiscussion,
  verdict: z.enum(['matched', 'product-exceeds-profile', 'assessment-expired', 'missing-profile']),
  rationale: z.string().min(1),
})

/** Runtime schema validating one durable consultation record. */
export const consultationRecordSchema = z.object({
  id: consultationId,
  clientId,
  advisorId,
  interactionId: interactionId.optional(),
  occurredAt: nonNegativeSafeInteger,
  topics: z.array(advisoryTopic),
  products: z.array(suitabilityAssessment),
  recommendations: z.array(z.string().min(1)),
  followUpRequired: z.boolean(),
  summary: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  createdAt: nonNegativeSafeInteger,
}) as unknown as z.ZodType<ConsultationRecord>

/** Runtime schema validating one durable opportunity record. */
export const opportunityRecordSchema = z.object({
  id: opportunityId,
  clientId,
  advisorId,
  productKind: z.enum(['fund', 'insurance', 'structured', 'retirement', 'education', 'tax', 'advisory_fee']),
  productName: z.string().min(1).optional(),
  stage: z.enum(['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'abandoned']),
  amount: positiveSafeInteger,
  currency,
  probability: z.number().int().min(0).max(100),
  expectedCloseAt: nonNegativeSafeInteger.optional(),
  closedAt: nonNegativeSafeInteger.optional(),
  closeReason: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
}).refine(deal => deal.closedAt === undefined || deal.stage === 'won' || deal.stage === 'lost' || deal.stage === 'abandoned', {
  path: ['closedAt'],
  message: 'opportunity closedAt is set only in a terminal stage',
}).refine(deal => (deal.stage === 'lost' || deal.stage === 'abandoned') ? deal.closeReason !== undefined : true, {
  path: ['closeReason'],
  message: 'opportunity closeReason is required entering lost or abandoned',
}) as unknown as z.ZodType<OpportunityRecord>

/** Runtime schema validating one durable task record. */
export const taskRecordSchema = z.object({
  id: taskId,
  clientId: clientId.optional(),
  opportunityId: opportunityId.optional(),
  advisorId,
  kind: z.enum([
    'follow_up',
    'meeting_prep',
    'risk_review',
    'compliance_check',
    'document_delivery',
    'report_delivery',
    'client_care',
  ]),
  title: z.string().min(1),
  dueAt: nonNegativeSafeInteger,
  status: z.enum(['open', 'done', 'cancelled']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  notes: z.string().min(1).optional(),
  completedAt: nonNegativeSafeInteger.optional(),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
}).refine(task => task.completedAt === undefined || task.status === 'done', {
  path: ['completedAt'],
  message: 'task completedAt is set only on done tasks',
}) as unknown as z.ZodType<TaskRecord>

/** The CRM durable domain: one table per record kind, no global singleton. */

const planKind = z.enum(['recurring-investment', 'allocation', 'protection-gap'])
const planStatus = z.enum(['draft', 'active', 'paused', 'completed', 'cancelled'])
const planSleeve = z.object({
  name: z.string().min(1),
  kind: z.enum(['fund', 'insurance', 'structured', 'retirement', 'education', 'tax', 'advisory_fee']),
  targetPercent: z.number().int().min(0).max(100),
})
const planRecurring = z.object({
  monthlyAmount: positiveSafeInteger,
  deductionDay: z.number().int().min(1).max(28),
  productName: z.string().min(1),
  productKind: z.enum(['fund', 'insurance', 'structured', 'retirement', 'education', 'tax', 'advisory_fee']),
  endsAt: nonNegativeSafeInteger.optional(),
})
const planAllocation = z.object({
  sleeves: z.array(planSleeve).min(1),
  rebalanceBand: z.number().int().min(1).max(50),
})
const planProtectionGap = z.object({
  annualIncome: positiveSafeInteger,
  incomeYears: z.number().int().min(1).max(30),
  existingLifeCover: nonNegativeSafeInteger,
  recommendedLifeCover: nonNegativeSafeInteger,
  existingCriticalIllnessCover: nonNegativeSafeInteger,
  recommendedCriticalIllnessCover: nonNegativeSafeInteger,
})

/** One persisted advisory plan; exactly one kind payload is present. */
export const planRecordSchema = z.object({
  id: z.string().min(1),
  clientId,
  advisorId,
  kind: planKind,
  status: planStatus,
  topics: z.array(advisoryTopic),
  tolerance: tolerance.optional(),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
  notes: z.string().min(1).optional(),
  recurring: planRecurring.optional(),
  allocation: planAllocation.optional(),
  protectionGap: planProtectionGap.optional(),
}).refine(
  plan => (plan.kind === 'recurring-investment') === (plan.recurring !== undefined)
    && (plan.kind === 'allocation') === (plan.allocation !== undefined)
    && (plan.kind === 'protection-gap') === (plan.protectionGap !== undefined),
  { message: 'plan kind and payload must match exactly' },
) as unknown as z.ZodType<PlanRecord>

/**
 * The CRM durable domain: one table per record kind — advisors, advisory
 * plans, clients, interactions, consultations, opportunities, tasks — under
 * domain version 1 (plans joined at version 1).
 */
export const crmDomainSpec = defineDomain({
  name: 'crm',
  version: 1,
  tables: {
    advisors: domainTable<AdvisorId, AdvisorRecord>(advisorRecordSchema),
    plans: domainTable<string, PlanRecord>(planRecordSchema),
    clients: domainTable<ClientId, ClientRecord>(clientRecordSchema),
    interactions: domainTable<InteractionId, InteractionRecord>(interactionRecordSchema),
    consultations: domainTable<ConsultationId, ConsultationRecord>(consultationRecordSchema),
    opportunities: domainTable<OpportunityId, OpportunityRecord>(opportunityRecordSchema),
    tasks: domainTable<TaskId, TaskRecord>(taskRecordSchema),
  },
})
