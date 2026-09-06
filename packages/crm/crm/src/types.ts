/**
 * Pure CRM domain types: branded record ids, closed vocabularies, durable
 * record interfaces, and read-model projections. Free of runtime code so
 * every face (host service, tools, client) can project it without pulling
 * value dependencies.
 *
 * Vocabularies follow the Chinese securities suitability standard: client
 * risk tolerance C1 (保守型 conservative) to C5 (进取型 aggressive), product
 * risk R1 (low) to R5 (high).
 *
 * @module @deepseek-ai/dsh-crm/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Id of one advisor record. */
export type AdvisorId = Branded<'crm-advisor'>
/** Id of one client record. */
export type ClientId = Branded<'crm-client'>
/** Id of one interaction record. */
export type InteractionId = Branded<'crm-interaction'>
/** Id of one consultation record. */
export type ConsultationId = Branded<'crm-consultation'>
/** Id of one opportunity record. */
export type OpportunityId = Branded<'crm-opportunity'>
/** Id of one task record. */
export type TaskId = Branded<'crm-task'>

/** Whether a client is a retail individual or an institution. */
export type ClientKind = 'individual' | 'institution'

/** Client lifecycle stages of the advisory funnel. */
export type ClientLifecycle = 'lead' | 'prospect' | 'onboarding' | 'active' | 'dormant' | 'lost'

/** Client risk tolerance per the suitability standard, conservative C1 to aggressive C5. */
export type RiskTolerance = 'C1' | 'C2' | 'C3' | 'C4' | 'C5'

/** Product risk level per the suitability standard, low R1 to high R5. */
export type ProductRiskLevel = 'R1' | 'R2' | 'R3' | 'R4' | 'R5'

/** Channel through which one interaction happened. */
export type InteractionKind = 'consultation' | 'call' | 'wechat' | 'meeting' | 'email' | 'report_review'

/** Tone the advisor recorded for one interaction. */
export type InteractionSentiment = 'positive' | 'neutral' | 'negative'

/** Advisory topics one interaction or consultation can cover. */
export type AdvisoryTopic
  = | 'asset_allocation'
    | 'retirement'
    | 'tax'
    | 'insurance'
    | 'education'
    | 'market_outlook'
    | 'product_review'
    | 'portfolio_rebalance'
    | 'other'

/** Product categories the advisory business sells. */
export type ProductKind
  = | 'fund'
    | 'insurance'
    | 'structured'
    | 'retirement'
    | 'education'
    | 'tax'
    | 'advisory_fee'

/** Opportunity pipeline stages; won, lost, and abandoned are terminal. */
export type OpportunityStage
  = | 'new'
    | 'qualified'
    | 'proposal'
    | 'negotiation'
    | 'won'
    | 'lost'
    | 'abandoned'

/** Follow-up task categories. */
export type TaskKind
  = | 'follow_up'
    | 'meeting_prep'
    | 'risk_review'
    | 'compliance_check'
    | 'document_delivery'
    | 'report_delivery'
    | 'client_care'

/** Task lifecycle; only open tasks can be completed, cancelled, or rescheduled. */
export type TaskStatus = 'open' | 'done' | 'cancelled'

/** Task urgency. */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

/** Outcome of matching one client profile against one product's risk level. */
export type SuitabilityVerdict
  = | 'matched'
    | 'product-exceeds-profile'
    | 'assessment-expired'
    | 'missing-profile'

/** Validity of a client's risk assessment at one point in time. */
export type ProfileStatus = 'valid' | 'expiring' | 'expired' | 'missing'

/** Result of one suitability evaluation: the verdict and its human-readable basis. */
export interface SuitabilityOutcome {
  /** The verdict for the (profile, product) pair at evaluation time. */
  readonly verdict: SuitabilityVerdict
  /** Why: names the levels or dates that decided it, for audit display. */
  readonly rationale: string
}

/** Client risk assessment: tolerance level, optional questionnaire score, and validity window. */
export interface RiskProfile {
  /** Tolerance level C1–C5. */
  readonly tolerance: RiskTolerance
  /** Questionnaire score, 1–100 when recorded. */
  readonly score?: number
  /** Epoch ms when the assessment was taken. */
  readonly assessedAt: number
  /** Epoch ms after which the assessment no longer satisfies suitability. */
  readonly expiresAt: number
}

/** Client contact details; every field optional because sources arrive partial. */
export interface ContactInfo {
  /** Mobile phone number. */
  readonly phone?: string
  /** Email address. */
  readonly email?: string
  /** WeChat handle. */
  readonly wechat?: string
  /** Region or city. */
  readonly region?: string
}

/** Client financial standing used for allocation advice. */
export interface FinancialProfile {
  /** Annual income in the book currency. */
  readonly annualIncome?: number
  /** Liquid assets in the book currency. */
  readonly liquidAssets?: number
  /** Assets under management in `currency`. */
  readonly totalAum: number
  /** ISO 4217 upper-case currency code of the monetary fields. */
  readonly currency: string
}

/** One advisory-team member who owns client relationships. */
export interface AdvisorRecord {
  /** Record id. */
  readonly id: AdvisorId
  /** Display name. */
  readonly name: string
  /** Team name. */
  readonly team?: string
  /** 执业编号 (practicing license number) for compliance display. */
  readonly licenseNo?: string
  /** Advisory topics this advisor covers. */
  readonly specialties: readonly AdvisoryTopic[]
  /** Whether the advisor currently takes new assignments. */
  readonly active: boolean
  /** Epoch ms of creation. */
  readonly createdAt: number
  /** Epoch ms of last update. */
  readonly updatedAt: number
}

/** One client of the advisory business at a point in time. */
export interface ClientRecord {
  /** Record id. */
  readonly id: ClientId
  /** Display name (individual or institution). */
  readonly name: string
  /** Individual or institution. */
  readonly kind: ClientKind
  /** Funnel stage. */
  readonly lifecycle: ClientLifecycle
  /** Contact details. */
  readonly contact?: ContactInfo
  /** Current risk assessment, absent before the first one. */
  readonly riskProfile?: RiskProfile
  /** Financial standing. */
  readonly financial?: FinancialProfile
  /** Owning advisor. */
  readonly advisorId?: AdvisorId
  /** Free-form segmentation tags. */
  readonly tags: readonly string[]
  /** Free-text notes. */
  readonly notes?: string
  /** Epoch ms of creation. */
  readonly createdAt: number
  /** Epoch ms of last update. */
  readonly updatedAt: number
}

/** One dated touchpoint with a client. */
export interface InteractionRecord {
  /** Record id. */
  readonly id: InteractionId
  /** The client touched. */
  readonly clientId: ClientId
  /** The advisor who handled it. */
  readonly advisorId: AdvisorId
  /** Channel of the touchpoint. */
  readonly kind: InteractionKind
  /** Epoch ms when it happened. */
  readonly occurredAt: number
  /** Duration in minutes when known. */
  readonly durationMin?: number
  /** What was discussed, one concise summary line. */
  readonly summary: string
  /** Recorded tone. */
  readonly sentiment?: InteractionSentiment
  /** Advisory topics covered. */
  readonly topics: readonly AdvisoryTopic[]
  /** Agreed next step, when one was set. */
  readonly nextStep?: string
  /** Owning harness session when an agent mediated the interaction. */
  readonly sessionId?: string
  /** Epoch ms of creation. */
  readonly createdAt: number
}

/** One product discussed in a consultation, at its documented risk level. */
export interface ProductDiscussion {
  /** Product display name. */
  readonly name: string
  /** Product category. */
  readonly kind: ProductKind
  /** Documented product risk R1–R5. */
  readonly riskLevel: ProductRiskLevel
}

/** Per-product suitability result attached to a consultation record. */
export interface SuitabilityAssessment {
  /** The product evaluated. */
  readonly product: ProductDiscussion
  /** The verdict at consultation time. */
  readonly verdict: SuitabilityVerdict
  /** Why the verdict holds, naming levels or dates. */
  readonly rationale: string
}

/** One formal advisory consultation with suitability audit weight. */
export interface ConsultationRecord {
  /** Record id. */
  readonly id: ConsultationId
  /** The client advised. */
  readonly clientId: ClientId
  /** The advising advisor. */
  readonly advisorId: AdvisorId
  /** The interaction this consultation extends, when it extends one. */
  readonly interactionId?: InteractionId
  /** Epoch ms when it happened. */
  readonly occurredAt: number
  /** Advisory topics covered. */
  readonly topics: readonly AdvisoryTopic[]
  /** Products discussed with their suitability verdicts. */
  readonly products: readonly SuitabilityAssessment[]
  /** Recommendations given. */
  readonly recommendations: readonly string[]
  /** Whether a follow-up is required. */
  readonly followUpRequired: boolean
  /** Free-text summary. */
  readonly summary?: string
  /** Owning harness session when an agent mediated the consultation. */
  readonly sessionId?: string
  /** Epoch ms of creation. */
  readonly createdAt: number
}

/** One tracked deal in the pipeline. */
export interface OpportunityRecord {
  /** Record id. */
  readonly id: OpportunityId
  /** The client pursued. */
  readonly clientId: ClientId
  /** The advisor owning the deal. */
  readonly advisorId: AdvisorId
  /** Product category. */
  readonly productKind: ProductKind
  /** Specific product name when known. */
  readonly productName?: string
  /** Current stage. */
  readonly stage: OpportunityStage
  /** Deal value in `currency`. */
  readonly amount: number
  /** ISO 4217 upper-case currency code. */
  readonly currency: string
  /** Win probability percent 0–100. */
  readonly probability: number
  /** Epoch ms of expected close, when planned. */
  readonly expectedCloseAt?: number
  /** Epoch ms of actual close; set when the stage becomes terminal. */
  readonly closedAt?: number
  /** Why the deal closed or was abandoned; required entering lost or abandoned. */
  readonly closeReason?: string
  /** Free-text notes. */
  readonly notes?: string
  /** Epoch ms of creation. */
  readonly createdAt: number
  /** Epoch ms of last update. */
  readonly updatedAt: number
}

/** One scheduled follow-up item. */
export interface TaskRecord {
  /** Record id. */
  readonly id: TaskId
  /** The client concerned, when task-specific. */
  readonly clientId?: ClientId
  /** The opportunity concerned, when deal-specific. */
  readonly opportunityId?: OpportunityId
  /** The advisor who owes the work. */
  readonly advisorId: AdvisorId
  /** Task category. */
  readonly kind: TaskKind
  /** One-line description. */
  readonly title: string
  /** Epoch ms when due. */
  readonly dueAt: number
  /** Lifecycle state. */
  readonly status: TaskStatus
  /** Urgency. */
  readonly priority: TaskPriority
  /** Free-text notes. */
  readonly notes?: string
  /** Epoch ms of completion; set when status becomes done. */
  readonly completedAt?: number
  /** Epoch ms of creation. */
  readonly createdAt: number
  /** Epoch ms of last update. */
  readonly updatedAt: number
}

/** Filter fields of a client search; every field optional, combined with AND. */
export interface ClientSearchQuery {
  /** Substring matched against name, tags, and contact fields, case-insensitive. */
  readonly query?: string
  /** Exact individual/institution filter. */
  readonly kind?: ClientKind
  /** Exact lifecycle filter. */
  readonly lifecycle?: ClientLifecycle
  /** Exact tolerance filter on the current risk profile. */
  readonly tolerance?: RiskTolerance
  /** Exact owning-advisor filter. */
  readonly advisorId?: AdvisorId
  /** Exact tag filter. */
  readonly tag?: string
  /** Maximum rows returned; the service clamps it to its protocol bound. */
  readonly limit?: number
}

/** Compact client row for list results; the full record comes from `getClient`. */
export interface ClientSummary {
  /** Record id. */
  readonly id: ClientId
  /** Display name. */
  readonly name: string
  /** Individual or institution. */
  readonly kind: ClientKind
  /** Funnel stage. */
  readonly lifecycle: ClientLifecycle
  /** Current tolerance, or null before the first assessment. */
  readonly tolerance: RiskTolerance | null
  /** AUM in the book currency, or null when unknown. */
  readonly totalAum: number | null
  /** Owning advisor. */
  readonly advisorId?: AdvisorId
  /** Segmentation tags. */
  readonly tags: readonly string[]
  /** Risk-assessment validity at query time. */
  readonly profileStatus: ProfileStatus
}

/** The 360° view of one client assembled from every table. */
export interface ClientBook {
  /** The client record. */
  readonly client: ClientRecord
  /** Newest-first interactions, most recent 10. */
  readonly interactions: readonly InteractionRecord[]
  /** Open tasks sorted by dueAt ascending. */
  readonly openTasks: readonly TaskRecord[]
  /** Opportunities: non-terminal newest-updated first, plus the 5 most recent won. */
  readonly opportunities: readonly OpportunityRecord[]
  /** Newest-first consultations, most recent 10. */
  readonly consultations: readonly ConsultationRecord[]
  /** Risk-assessment validity at assembly time. */
  readonly profileStatus: ProfileStatus
}

/** Filters for interaction listing; every field optional, combined with AND. */
export interface InteractionListQuery {
  /** Restrict to one client. */
  readonly clientId?: ClientId
  /** Restrict to one advisor. */
  readonly advisorId?: AdvisorId
  /** Restrict to one channel. */
  readonly kind?: InteractionKind
  /** Restrict to interactions covering one advisory topic. */
  readonly topic?: AdvisoryTopic
  /** Only interactions at or after this epoch ms. */
  readonly since?: number
  /** Maximum rows returned; the service clamps it to its protocol bound. */
  readonly limit?: number
}

/** Filters for opportunity listing; every field optional, combined with AND. */
export interface OpportunityListQuery {
  /** Restrict to one client. */
  readonly clientId?: ClientId
  /** Restrict to one stage. */
  readonly stage?: OpportunityStage
  /** Restrict to one advisor. */
  readonly advisorId?: AdvisorId
  /** Maximum rows returned; the service clamps it to its protocol bound. */
  readonly limit?: number
}

/** Filters for task listing; every field optional, combined with AND. */
export interface TaskListQuery {
  /** Restrict to one advisor. */
  readonly advisorId?: AdvisorId
  /** Restrict to one client. */
  readonly clientId?: ClientId
  /** Restrict to one task category. */
  readonly kind?: TaskKind
  /** Lifecycle filter; omitting it lists open tasks only. */
  readonly status?: TaskStatus
  /** Only tasks due at or before this epoch ms. */
  readonly dueBefore?: number
  /** Only open tasks whose dueAt is before this epoch ms (overrides status to open). */
  readonly overdue?: boolean
  /** Maximum rows returned; the service clamps it to its protocol bound. */
  readonly limit?: number
}

/** Per-stage pipeline aggregation. */
export interface StageSummary {
  /** The stage. */
  readonly stage: OpportunityStage
  /** Deals in the stage. */
  readonly count: number
  /** Sum of deal amounts in the stage's currency-independent raw value. */
  readonly amount: number
  /** Sum of amount × probability / 100 for non-terminal stages. */
  readonly weighted: number
}

/** Whole-pipeline aggregation at one point in time. */
export interface PipelineSnapshot {
  /** Restricting advisor, when the snapshot was scoped. */
  readonly advisorId?: AdvisorId
  /** One row per stage in pipeline order. */
  readonly stages: readonly StageSummary[]
  /** Count of deals in non-terminal stages. */
  readonly openCount: number
  /** Sum of amounts in non-terminal stages. */
  readonly openAmount: number
  /** Sum of weighted amounts over non-terminal stages. */
  readonly weightedForecast: number
  /** Count of won deals. */
  readonly wonCount: number
  /** Sum of won amounts. */
  readonly wonAmount: number
  /** Count of lost deals. */
  readonly lostCount: number
  /** Won / (won + lost) in percent, or null before the first terminal deal. */
  readonly winRate: number | null
}

/** Clients counted per lifecycle stage. */
export interface LifecycleCount {
  /** The lifecycle stage. */
  readonly lifecycle: ClientLifecycle
  /** Clients in it. */
  readonly count: number
}

/** Clients and AUM per tolerance level. */
export interface ToleranceAum {
  /** The tolerance level, or null for clients without an assessment. */
  readonly tolerance: RiskTolerance | null
  /** Clients at that level. */
  readonly count: number
  /** Their summed AUM. */
  readonly aum: number
}

/** One client whose assessment falls inside the warning window or has lapsed. */
export interface ProfileExpiryNotice {
  /** Client id. */
  readonly clientId: ClientId
  /** Client name. */
  readonly name: string
  /** When the assessment expires. */
  readonly expiresAt: number
}

/** Whole-book aggregation at one point in time. */
export interface BookSnapshot {
  /** Restricting advisor, when the snapshot was scoped. */
  readonly advisorId?: AdvisorId
  /** Total clients in scope. */
  readonly totalClients: number
  /** Clients per lifecycle stage, in lifecycle order. */
  readonly byLifecycle: readonly LifecycleCount[]
  /** Clients and AUM per tolerance level. */
  readonly byTolerance: readonly ToleranceAum[]
  /** Summed AUM over clients with a known financial profile. */
  readonly totalAum: number
  /** Assessments expiring within the warning window, soonest first. */
  readonly expiringProfiles: readonly ProfileExpiryNotice[]
  /** Assessments already expired, latest expiry first. */
  readonly expiredProfiles: readonly ProfileExpiryNotice[]
}

/** One summarized task row inside a task-load snapshot. */
export interface DueTaskSummary {
  /** Task id. */
  readonly id: TaskId
  /** One-line description. */
  readonly title: string
  /** Epoch ms when due. */
  readonly dueAt: number
  /** The client concerned, when task-specific. */
  readonly clientId?: ClientId
  /** Urgency. */
  readonly priority: TaskPriority
  /** Whether the open task is past due at the snapshot time. */
  readonly overdue: boolean
}

/** Open-task load of one advisor (or the whole team) at one point in time. */
export interface TaskLoadSnapshot {
  /** Restricting advisor, when the snapshot was scoped. */
  readonly advisorId?: AdvisorId
  /** Snapshot time. */
  readonly at: number
  /** Open tasks in scope. */
  readonly open: number
  /** Open tasks past due. */
  readonly overdue: number
  /** Open tasks per priority, in priority order. */
  readonly byPriority: readonly { readonly priority: TaskPriority; readonly count: number }[]
  /** The next open tasks by dueAt, at most 5. */
  readonly dueSoon: readonly DueTaskSummary[]
}

/** One flattened suitability verdict from the consultation audit trail. */
export interface SuitabilityAuditEntry {
  /** The client advised. */
  readonly clientId: ClientId
  /** Client name at audit time. */
  readonly clientName: string
  /** The consultation that recorded it. */
  readonly consultationId: ConsultationId
  /** When the consultation happened. */
  readonly occurredAt: number
  /** The product evaluated. */
  readonly product: ProductDiscussion
  /** The recorded verdict. */
  readonly verdict: SuitabilityVerdict
  /** The recorded rationale. */
  readonly rationale: string
}

/** Patchable fields of one client update; absent fields keep their values. */
export interface ClientPatch {
  /** New display name. */
  readonly name?: string
  /** New funnel stage. */
  readonly lifecycle?: ClientLifecycle
  /** Replacement contact details. */
  readonly contact?: ContactInfo
  /** Replacement financial standing. */
  readonly financial?: FinancialProfile
  /** Replacement free-text notes. */
  readonly notes?: string
  /** Replacement owning advisor. */
  readonly advisorId?: AdvisorId
  /** Replacement tag set. */
  readonly tags?: readonly string[]
  /** Re-assessment: level plus optional score and assessment time. */
  readonly riskProfile?: {
    readonly tolerance: RiskTolerance
    readonly score?: number
    readonly assessedAt?: number
  }
}
