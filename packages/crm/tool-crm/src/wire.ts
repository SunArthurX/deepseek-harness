/**
 * Wire vocabulary shared by the crm_* tools: closed enum lists, timestamp
 * conversion, and pure serializers from durable records to canonical tool
 * values. Durable time fields are epoch ms; the tool boundary speaks ISO
 * 8601, and conversion happens here — the model/tool JSON boundary is a
 * validation boundary.
 * @module @deepseek-ai/dsh-tool-crm/src/wire
 */

import type {
  AdvisorRecord,
  BookSnapshot,
  ClientRecord,
  ClientSummary,
  ConsultationRecord,
  InteractionRecord,
  OpportunityRecord,
  PipelineSnapshot,
  TaskRecord,
  TaskLoadSnapshot,
} from '@deepseek-ai/dsh-crm/types'
import { PROFILE_EXPIRY_WARNING_MS } from '@deepseek-ai/dsh-crm'
import type { ProfileStatus } from '@deepseek-ai/dsh-crm/types'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import type {
  advisorWireSchema,
  clientSummaryWireSchema,
  clientWireSchema,
  consultationWireSchema,
  interactionWireSchema,
  opportunityWireSchema,
  taskWireSchema,
} from './schemas.ts'

/** Every client risk tolerance the model may name. */
export const TOLERANCES = ['C1', 'C2', 'C3', 'C4', 'C5'] as const

/** Every product risk level the model may name. */
export const PRODUCT_RISKS = ['R1', 'R2', 'R3', 'R4', 'R5'] as const

/** Every client lifecycle stage the model may name. */
export const LIFECYCLES = ['lead', 'prospect', 'onboarding', 'active', 'dormant', 'lost'] as const

/** Every interaction channel the model may name. */
export const INTERACTION_KINDS = ['consultation', 'call', 'wechat', 'meeting', 'email', 'report_review'] as const

/** Every advisory topic the model may name. */
export const TOPICS = [
  'asset_allocation',
  'retirement',
  'tax',
  'insurance',
  'education',
  'market_outlook',
  'product_review',
  'portfolio_rebalance',
  'other',
] as const

/** Every sentiment the model may name. */
export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const

/** Every product category the model may name. */
export const PRODUCT_KINDS = ['fund', 'insurance', 'structured', 'retirement', 'education', 'tax', 'advisory_fee'] as const

/** Every pipeline stage the model may name. */
export const STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'abandoned'] as const

/** Non-terminal pipeline stages, for opportunity creation. */
export const OPEN_STAGES = ['new', 'qualified', 'proposal', 'negotiation'] as const

/** Every task category the model may name. */
export const TASK_KINDS = [
  'follow_up',
  'meeting_prep',
  'risk_review',
  'compliance_check',
  'document_delivery',
  'report_delivery',
  'client_care',
] as const

/** Every task priority the model may name. */
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/** Every task status the model may name. */
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const

/** Tolerance description shared by every parameter that takes one. */
export const TOLERANCE_DESCRIPTION = 'Client risk tolerance: C1 conservative, C2 steady, C3 balanced, C4 growth, C5 aggressive.'

/** Product-risk description shared by every parameter that takes one. */
export const PRODUCT_RISK_DESCRIPTION = 'Product risk level: R1 low, R2 medium-low, R3 medium, R4 medium-high, R5 high.'

/**
 * Render one monetary figure for prose: raw when integral, otherwise at most
 * two fractional digits, so weighted forecasts read as amounts not float noise.
 * @param value - The figure to render.
 * @returns the prose form.
 */
export function fmtAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

/** Maximum rows a render listing spells out before folding to an overflow count. */
const RENDER_PREVIEW_ROWS = 5

/**
 * Spell out the first rows and fold the rest into a count, keeping result
 * prose bounded no matter how large the returned page is.
 * @param rows - Already-rendered row summaries.
 * @returns the joined preview with an overflow tail when rows exceed the cap.
 */
export function listPreview(rows: readonly string[]): string {
  if (rows.length <= RENDER_PREVIEW_ROWS) return rows.join('; ')
  const shown = rows.slice(0, RENDER_PREVIEW_ROWS).join('; ')
  return `${shown}; … and ${rows.length - RENDER_PREVIEW_ROWS} more`
}

/**
 * ISO 8601 date shape: `Date.parse` also accepts locale forms like `8/15/2026`,
 * which the ISO-preferring contract should reject rather than silently reinterpret.
 */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}([T ]|$)/

/**
 * Parse one model-supplied timestamp.
 * @param value - ISO 8601 string (calendar date prefix required).
 * @param what - Field name for the failure message.
 * @returns epoch ms.
 */
export function parseWhen(value: string, what: string): number {
  if (!ISO_DATE_PREFIX.test(value)) {
    throw new Error(`crm: ${what} must be an ISO 8601 timestamp, got '${value}'`)
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) throw new Error(`crm: ${what} must be an ISO 8601 timestamp, got '${value}'`)
  return ms
}

/**
 * Render one epoch-ms timestamp for the model.
 * @param ms - Epoch ms.
 * @returns ISO 8601 string.
 */
export function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * Risk-assessment validity of one client at `now`; mirrors the service's window rule.
 * @param client - The client whose profile is evaluated.
 * @param now - Read time in epoch ms.
 * @returns the profile status at `now`.
 */
export function profileStatusOf(client: ClientRecord, now: number): ProfileStatus {
  const profile = client.riskProfile
  if (profile === undefined) return 'missing'
  if (profile.expiresAt <= now) return 'expired'
  if (profile.expiresAt - now <= PROFILE_EXPIRY_WARNING_MS) return 'expiring'
  return 'valid'
}

/**
 * Canonical wire form of one advisor record.
 * @param advisor - The durable advisor record.
 * @returns the wire object for tool results.
 */
export function wireAdvisor(advisor: AdvisorRecord): InferValue<typeof advisorWireSchema> {
  return {
    id: advisor.id,
    name: advisor.name,
    ...(advisor.team === undefined ? {} : { team: advisor.team }),
    ...(advisor.licenseNo === undefined ? {} : { licenseNo: advisor.licenseNo }),
    specialties: [...advisor.specialties],
    active: advisor.active,
    createdAt: toIso(advisor.createdAt),
    updatedAt: toIso(advisor.updatedAt),
  }
}

/**
 * Canonical wire form of one client record.
 * @param client - The durable client record.
 * @param now - Read time for the derived profile status.
 * @returns the wire object for tool results.
 */
export function wireClient(client: ClientRecord, now: number): InferValue<typeof clientWireSchema> {
  return {
    id: client.id,
    name: client.name,
    kind: client.kind,
    lifecycle: client.lifecycle,
    tags: [...client.tags],
    ...(client.contact === undefined ? {} : {
      contact: {
        ...(client.contact.phone === undefined ? {} : { phone: client.contact.phone }),
        ...(client.contact.email === undefined ? {} : { email: client.contact.email }),
        ...(client.contact.wechat === undefined ? {} : { wechat: client.contact.wechat }),
        ...(client.contact.region === undefined ? {} : { region: client.contact.region }),
      },
    }),
    ...(client.riskProfile === undefined ? {} : {
      riskProfile: {
        tolerance: client.riskProfile.tolerance,
        ...(client.riskProfile.score === undefined ? {} : { score: client.riskProfile.score }),
        assessedAt: toIso(client.riskProfile.assessedAt),
        expiresAt: toIso(client.riskProfile.expiresAt),
      },
    }),
    ...(client.financial === undefined ? {} : {
      financial: {
        totalAum: client.financial.totalAum,
        ...(client.financial.annualIncome === undefined ? {} : { annualIncome: client.financial.annualIncome }),
        ...(client.financial.liquidAssets === undefined ? {} : { liquidAssets: client.financial.liquidAssets }),
        currency: client.financial.currency,
      },
    }),
    ...(client.advisorId === undefined ? {} : { advisorId: client.advisorId }),
    ...(client.notes === undefined ? {} : { notes: client.notes }),
    profileStatus: profileStatusOf(client, now),
    createdAt: toIso(client.createdAt),
    updatedAt: toIso(client.updatedAt),
  }
}

/**
 * Canonical wire form of one client search row.
 * @param row - The service-produced summary row.
 * @returns the wire object for tool results.
 */
export function wireClientSummary(row: ClientSummary): InferValue<typeof clientSummaryWireSchema> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    lifecycle: row.lifecycle,
    tolerance: row.tolerance,
    totalAum: row.totalAum,
    ...(row.advisorId === undefined ? {} : { advisorId: row.advisorId }),
    tags: [...row.tags],
    profileStatus: row.profileStatus,
  }
}

/**
 * Canonical wire form of one interaction record.
 * @param record - The durable interaction record.
 * @returns the wire object for tool results.
 */
export function wireInteraction(record: InteractionRecord): InferValue<typeof interactionWireSchema> {
  return {
    id: record.id,
    clientId: record.clientId,
    advisorId: record.advisorId,
    kind: record.kind,
    occurredAt: toIso(record.occurredAt),
    ...(record.durationMin === undefined ? {} : { durationMin: record.durationMin }),
    summary: record.summary,
    ...(record.sentiment === undefined ? {} : { sentiment: record.sentiment }),
    topics: [...record.topics],
    ...(record.nextStep === undefined ? {} : { nextStep: record.nextStep }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    createdAt: toIso(record.createdAt),
  }
}

/**
 * Canonical wire form of one consultation record.
 * @param record - The durable consultation record.
 * @returns the wire object for tool results.
 */
export function wireConsultation(record: ConsultationRecord): InferValue<typeof consultationWireSchema> {
  return {
    id: record.id,
    clientId: record.clientId,
    advisorId: record.advisorId,
    ...(record.interactionId === undefined ? {} : { interactionId: record.interactionId }),
    occurredAt: toIso(record.occurredAt),
    topics: [...record.topics],
    products: record.products.map(assessment => ({
      name: assessment.product.name,
      kind: assessment.product.kind,
      riskLevel: assessment.product.riskLevel,
      verdict: assessment.verdict,
      rationale: assessment.rationale,
    })),
    recommendations: [...record.recommendations],
    followUpRequired: record.followUpRequired,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    createdAt: toIso(record.createdAt),
  }
}

/**
 * Canonical wire form of one opportunity record.
 * @param record - The durable opportunity record.
 * @returns the wire object for tool results.
 */
export function wireOpportunity(record: OpportunityRecord): InferValue<typeof opportunityWireSchema> {
  return {
    id: record.id,
    clientId: record.clientId,
    advisorId: record.advisorId,
    productKind: record.productKind,
    ...(record.productName === undefined ? {} : { productName: record.productName }),
    stage: record.stage,
    amount: record.amount,
    currency: record.currency,
    probability: record.probability,
    ...(record.expectedCloseAt === undefined ? {} : { expectedCloseAt: toIso(record.expectedCloseAt) }),
    ...(record.closedAt === undefined ? {} : { closedAt: toIso(record.closedAt) }),
    ...(record.closeReason === undefined ? {} : { closeReason: record.closeReason }),
    ...(record.notes === undefined ? {} : { notes: record.notes }),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  }
}

/**
 * Canonical wire form of one task record, with the derived overdue flag.
 * @param record - The durable task record.
 * @param now - Read time for the derived overdue flag.
 * @returns the wire object for tool results.
 */
export function wireTask(record: TaskRecord, now: number): InferValue<typeof taskWireSchema> {
  return {
    id: record.id,
    ...(record.clientId === undefined ? {} : { clientId: record.clientId }),
    ...(record.opportunityId === undefined ? {} : { opportunityId: record.opportunityId }),
    advisorId: record.advisorId,
    kind: record.kind,
    title: record.title,
    dueAt: toIso(record.dueAt),
    status: record.status,
    priority: record.priority,
    ...(record.notes === undefined ? {} : { notes: record.notes }),
    ...(record.completedAt === undefined ? {} : { completedAt: toIso(record.completedAt) }),
    overdue: record.status === 'open' && record.dueAt < now,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  }
}

/** Wire form of one pipeline snapshot row set. */
export interface PipelineReportWire {
  readonly advisorId?: string
  readonly stages: { readonly stage: PipelineSnapshot['stages'][number]['stage']; readonly count: number; readonly amount: number; readonly weighted: number }[]
  readonly openCount: number
  readonly openAmount: number
  readonly weightedForecast: number
  readonly wonCount: number
  readonly wonAmount: number
  readonly lostCount: number
  readonly winRate: number | null
}

/**
 * Canonical wire form of one pipeline snapshot.
 * @param snapshot - The service-produced pipeline aggregation.
 * @returns the wire object for tool results.
 */
export function wirePipeline(snapshot: PipelineSnapshot): PipelineReportWire {
  return {
    ...(snapshot.advisorId === undefined ? {} : { advisorId: snapshot.advisorId }),
    stages: snapshot.stages.map(stage => ({
      stage: stage.stage,
      count: stage.count,
      amount: stage.amount,
      weighted: stage.weighted,
    })),
    openCount: snapshot.openCount,
    openAmount: snapshot.openAmount,
    weightedForecast: snapshot.weightedForecast,
    wonCount: snapshot.wonCount,
    wonAmount: snapshot.wonAmount,
    lostCount: snapshot.lostCount,
    winRate: snapshot.winRate,
  }
}

/** Wire form of one book snapshot. */
export interface BookReportWire {
  readonly advisorId?: string
  readonly totalClients: number
  readonly byLifecycle: { readonly lifecycle: BookSnapshot['byLifecycle'][number]['lifecycle']; readonly count: number }[]
  readonly byTolerance: { readonly tolerance: BookSnapshot['byTolerance'][number]['tolerance']; readonly count: number; readonly aum: number }[]
  readonly totalAum: number
  readonly expiringProfiles: { readonly clientId: string; readonly name: string; readonly expiresAt: string }[]
  readonly expiredProfiles: { readonly clientId: string; readonly name: string; readonly expiresAt: string }[]
}

/**
 * Canonical wire form of one book snapshot.
 * @param snapshot - The service-produced book aggregation.
 * @returns the wire object for tool results.
 */
export function wireBook(snapshot: BookSnapshot): BookReportWire {
  return {
    ...(snapshot.advisorId === undefined ? {} : { advisorId: snapshot.advisorId }),
    totalClients: snapshot.totalClients,
    byLifecycle: snapshot.byLifecycle.map(row => ({ lifecycle: row.lifecycle, count: row.count })),
    byTolerance: snapshot.byTolerance.map(row => ({ tolerance: row.tolerance, count: row.count, aum: row.aum })),
    totalAum: snapshot.totalAum,
    expiringProfiles: snapshot.expiringProfiles.map(row => ({
      clientId: row.clientId,
      name: row.name,
      expiresAt: toIso(row.expiresAt),
    })),
    expiredProfiles: snapshot.expiredProfiles.map(row => ({
      clientId: row.clientId,
      name: row.name,
      expiresAt: toIso(row.expiresAt),
    })),
  }
}

/** Wire form of one task-load snapshot. */
export interface TaskLoadReportWire {
  readonly advisorId?: string
  readonly at: string
  readonly open: number
  readonly overdue: number
  readonly byPriority: { readonly priority: TaskLoadSnapshot['byPriority'][number]['priority']; readonly count: number }[]
  readonly dueSoon: {
    readonly id: string
    readonly title: string
    readonly dueAt: string
    readonly clientId?: string
    readonly priority: TaskLoadSnapshot['dueSoon'][number]['priority']
    readonly overdue: boolean
  }[]
}

/**
 * Canonical wire form of one task-load snapshot.
 * @param snapshot - The service-produced task-load aggregation.
 * @returns the wire object for tool results.
 */
export function wireTaskLoad(snapshot: TaskLoadSnapshot): TaskLoadReportWire {
  return {
    ...(snapshot.advisorId === undefined ? {} : { advisorId: snapshot.advisorId }),
    at: toIso(snapshot.at),
    open: snapshot.open,
    overdue: snapshot.overdue,
    byPriority: snapshot.byPriority.map(row => ({ priority: row.priority, count: row.count })),
    dueSoon: snapshot.dueSoon.map(task => ({
      id: task.id,
      title: task.title,
      dueAt: toIso(task.dueAt),
      ...(task.clientId === undefined ? {} : { clientId: task.clientId }),
      priority: task.priority,
      overdue: task.overdue,
    })),
  }
}
