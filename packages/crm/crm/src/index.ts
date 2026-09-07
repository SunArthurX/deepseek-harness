/**
 * Investment-advisory CRM capability (`ctx.crm`): the durable client book,
 * advisor roster, interaction and consultation records with suitability
 * audit, the opportunity pipeline, follow-up tasks, and read-model analytics.
 * Records live in one `crm` storage domain; every mutation validates its
 * references and lands through the domain's durable write chain.
 * @module @deepseek-ai/dsh-crm
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { evaluateSuitability } from './suitability.ts'
import { loadDemoData } from './demo-data.ts'
import type { CreatePlanRequest, PlanRecord } from './plan-types.ts'
import type { DemoDataSummary } from './demo-data.ts'
import { crmDomainSpec } from './spec.ts'
import type {
  AdvisorId,
  AdvisorRecord,
  AdvisoryTopic,
  BookSnapshot,
  ClientBook,
  ClientId,
  ClientLifecycle,
  ClientPatch,
  ClientRecord,
  ClientSearchQuery,
  ClientSummary,
  ConsultationId,
  ConsultationRecord,
  DueTaskSummary,
  FinancialProfile,
  InteractionId,
  InteractionKind,
  InteractionListQuery,
  InteractionRecord,
  InteractionSentiment,
  OpportunityId,
  OpportunityListQuery,
  OpportunityRecord,
  OpportunityStage,
  PipelineSnapshot,
  ProductDiscussion,
  ProfileExpiryNotice,
  ProfileStatus,
  RiskTolerance,
  StageSummary,
  SuitabilityAssessment,
  SuitabilityAuditEntry,
  TaskId,
  TaskKind,
  TaskListQuery,
  TaskLoadSnapshot,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  ToleranceAum,
} from './types.ts'

export type * from './types.ts'
export { crmDomainSpec } from './spec.ts'
export { loadDemoData } from './demo-data.ts'
export { SEGMENTS, buildConversionFunnel, buildRfm, buildSegments, exportAuditCsv, exportClientsCsv, exportDealsCsv, exportInteractionsCsv, exportTasksCsv } from './insights-impl.ts'
export type { ClientSegment, ConversionFunnel, CsvExport, FunnelStage, RfmAnalysis, RfmRow, SegmentRow } from './insights.ts'
export type { AdvisoryTopic, ProductKind } from './insights.ts'
export type { DemoDataSummary } from './demo-data.ts'
export {
  advisorRecordSchema,
  clientRecordSchema,
  consultationRecordSchema,
  interactionRecordSchema,
  opportunityRecordSchema,
  taskRecordSchema,
} from './spec.ts'
export { ALL_SUITABILITY_VERDICTS, evaluateSuitability, isBlockingVerdict, RISK_LEVEL, TOLERANCE_LEVEL } from './suitability.ts'

/**
 * Brand a string as an {@link AdvisorId}.
 * @param id - Raw advisor id string.
 * @returns the same string, branded at compile time.
 */
export function AdvisorId(id: string): AdvisorId {
  return id as AdvisorId
}

/**
 * Brand a string as a {@link ClientId}.
 * @param id - Raw client id string.
 * @returns the same string, branded at compile time.
 */
export function ClientId(id: string): ClientId {
  return id as ClientId
}

/**
 * Brand a string as an {@link InteractionId}.
 * @param id - Raw interaction id string.
 * @returns the same string, branded at compile time.
 */
export function InteractionId(id: string): InteractionId {
  return id as InteractionId
}

/**
 * Brand a string as a {@link ConsultationId}.
 * @param id - Raw consultation id string.
 * @returns the same string, branded at compile time.
 */
export function ConsultationId(id: string): ConsultationId {
  return id as ConsultationId
}

/**
 * Brand a string as an {@link OpportunityId}.
 * @param id - Raw opportunity id string.
 * @returns the same string, branded at compile time.
 */
export function OpportunityId(id: string): OpportunityId {
  return id as OpportunityId
}

/**
 * Brand a string as a {@link TaskId}.
 * @param id - Raw task id string.
 * @returns the same string, branded at compile time.
 */
export function TaskId(id: string): TaskId {
  return id as TaskId
}

/** A request named a client no durable record holds. */
export class CrmUnknownClientError extends Error {
  /**
   * @param clientId - The unknown client id.
   */
  constructor(readonly clientId: ClientId) {
    super(`unknown CRM client '${clientId}'`)
    this.name = 'CrmUnknownClientError'
  }
}

/** A request named an advisor no durable record holds. */
export class CrmUnknownAdvisorError extends Error {
  /**
   * @param advisorId - The unknown advisor id.
   */
  constructor(readonly advisorId: AdvisorId) {
    super(`unknown CRM advisor '${advisorId}'`)
    this.name = 'CrmUnknownAdvisorError'
  }
}

/** A request named an opportunity no durable record holds. */
export class CrmUnknownOpportunityError extends Error {
  /**
   * @param opportunityId - The unknown opportunity id.
   */
  constructor(readonly opportunityId: OpportunityId) {
    super(`unknown CRM opportunity '${opportunityId}'`)
    this.name = 'CrmUnknownOpportunityError'
  }
}

/** A request named a task no durable record holds. */
export class CrmUnknownTaskError extends Error {
  /**
   * @param taskId - The unknown task id.
   */
  constructor(readonly taskId: TaskId) {
    super(`unknown CRM task '${taskId}'`)
    this.name = 'CrmUnknownTaskError'
  }
}

/** An operation needs an owning advisor and neither an explicit one nor the client carries one. */
export class CrmAdvisorRequiredError extends Error {
  /**
   * @param what - The operation that needs an advisor.
   */
  constructor(readonly what: string) {
    super(`${what} requires an advisor: pass one or assign the client an advisor first`)
    this.name = 'CrmAdvisorRequiredError'
  }
}

/** A pipeline move would leave the stage machine or its audit fields inconsistent. */
export class CrmStageTransitionError extends Error {
  /**
   * @param opportunityId - The deal being moved.
   * @param from - The stage it is in.
   * @param to - The stage it was asked to enter.
   * @param reason - Why the move is rejected.
   */
  constructor(
    readonly opportunityId: OpportunityId,
    readonly from: OpportunityStage,
    readonly to: OpportunityStage,
    readonly reason: string,
  ) {
    super(`cannot move opportunity '${opportunityId}' from '${from}' to '${to}': ${reason}`)
    this.name = 'CrmStageTransitionError'
  }
}

/** A task action requires the task to be open and it is not. */
export class CrmTaskStateError extends Error {
  /**
   * @param taskId - The task addressed.
   * @param action - The action attempted.
   * @param status - The task's actual status.
   */
  constructor(readonly taskId: TaskId, readonly action: string, readonly status: TaskStatus) {
    super(`cannot ${action} task '${taskId}': it is '${status}', not 'open'`)
    this.name = 'CrmTaskStateError'
  }
}

/** A request named a plan no durable record holds. */
export class CrmUnknownPlanError extends Error {
  /**
   * @param planId - The unknown plan id.
   */
  constructor(readonly planId: string) {
    super(`unknown CRM plan '${planId}'`)
    this.name = 'CrmUnknownPlanError'
  }
}

/** A plan status transition violates the lifecycle. */
export class CrmPlanStateError extends Error {
  /**
   * @param planId - The plan addressed.
   * @param from - The current status.
   * @param to - The attempted status.
   * @param reason - Why the transition is rejected.
   */
  constructor(readonly planId: string, readonly from: string, readonly to: string, readonly reason: string) {
    super(`cannot move plan '${planId}' from '${from}' to '${to}': ${reason}`)
    this.name = 'CrmPlanStateError'
  }
}

/** Two active advisors share one practicing license number. */
export class CrmDuplicateLicenseError extends Error {
  /**
   * @param licenseNo - The duplicated license number.
   * @param advisorId - The advisor already holding it.
   */
  constructor(readonly licenseNo: string, readonly advisorId: AdvisorId) {
    super(`advisor license number '${licenseNo}' already belongs to advisor '${advisorId}'`)
    this.name = 'CrmDuplicateLicenseError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    crm: CrmService
  }
}

/** Required deployment policy for the CRM domain. */
export interface Config {
  /**
   * How many days one risk assessment stays valid; re-assessment resets the
   * window and suitability treats an expired assessment as blocking.
   */
  readonly riskProfileValidityDays: number
}

/** Pipeline stage order used by listings and snapshots. */
const STAGE_ORDER: readonly OpportunityStage[] = [
  'new',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
  'abandoned',
]

/** Terminal stages: once entered, no further move is accepted. */
const TERMINAL_STAGES: ReadonlySet<OpportunityStage> = new Set(['won', 'lost', 'abandoned'])

/**
 * Default win probability per stage, in percent. Entering a terminal stage
 * forces its default (won 100, lost/abandoned 0); a non-terminal move adopts
 * the caller's value or the target stage's default.
 */
const STAGE_DEFAULT_PROBABILITY: Readonly<Record<OpportunityStage, number>> = {
  new: 10,
  qualified: 30,
  proposal: 55,
  negotiation: 75,
  won: 100,
  lost: 0,
  abandoned: 0,
}

/** Client lifecycle order used by book snapshots. */
const LIFECYCLE_ORDER: readonly ClientLifecycle[] = [
  'lead',
  'prospect',
  'onboarding',
  'active',
  'dormant',
  'lost',
]

/** Tolerance order used by book snapshots. */
const TOLERANCE_ORDER: readonly RiskTolerance[] = ['C1', 'C2', 'C3', 'C4', 'C5']

/** Task priority order used by task-load snapshots. */
const PRIORITY_ORDER: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent']

/**
 * Risk assessments expiring within this window surface as `expiring` in
 * summaries and book snapshots. A fixed advisory-operations constant, not a
 * deployment tunable.
 */
export const PROFILE_EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000

/** Protocol bound on any list or audit result; callers' larger limits clamp to it. */
export const MAX_LIST_LIMIT = 200

/** Protocol bound on client search results. */
export const MAX_SEARCH_LIMIT = 100

/** Default rows for client search. */
const DEFAULT_SEARCH_LIMIT = 20

/** Default rows for list and audit reads. */
const DEFAULT_LIST_LIMIT = 20

/** Default rows for the suitability audit. */
const DEFAULT_AUDIT_LIMIT = 50

/** How many rows a task-load snapshot reports under `dueSoon`. */
const DUE_SOON_COUNT = 5

/** Rows per list window in the 360° client book (interactions, tasks, consultations). */
const BOOK_WINDOW = 10

/** Request to register one advisor. */
export interface CreateAdvisorRequest {
  /** Display name. */
  readonly name: string
  /** Team name. */
  readonly team?: string
  /** Practicing license number; unique among advisors when provided. */
  readonly licenseNo?: string
  /** Advisory topics covered; defaults to none. */
  readonly specialties?: readonly AdvisoryTopic[]
  /** Whether the advisor takes new assignments; defaults to true. */
  readonly active?: boolean
}

/** Request to create one client. */
export interface CreateClientRequest {
  /** Display name. */
  readonly name: string
  /** Individual or institution. */
  readonly kind: ClientRecord['kind']
  /** Funnel stage; defaults to lead. */
  readonly lifecycle?: ClientLifecycle
  /** Contact details. */
  readonly contact?: ClientRecord['contact']
  /** Financial standing. */
  readonly financial?: FinancialProfile
  /** Owning advisor. */
  readonly advisorId?: AdvisorId
  /** Segmentation tags. */
  readonly tags?: readonly string[]
  /** Free-text notes. */
  readonly notes?: string
  /** First risk assessment: tolerance plus optional 1–100 score. */
  readonly riskProfile?: {
    readonly tolerance: RiskTolerance
    readonly score?: number
  }
}

/** Request to log one interaction. */
export interface LogInteractionRequest {
  /** The client touched. */
  readonly clientId: ClientId
  /** Handling advisor; defaults to the client's owner. */
  readonly advisorId?: AdvisorId
  /** Channel; defaults to consultation. */
  readonly kind?: InteractionKind
  /** Epoch ms when it happened; defaults to now. */
  readonly occurredAt?: number
  /** Duration in minutes. */
  readonly durationMin?: number
  /** One concise summary line. */
  readonly summary: string
  /** Recorded tone. */
  readonly sentiment?: InteractionSentiment
  /** Advisory topics covered. */
  readonly topics?: readonly AdvisoryTopic[]
  /** Agreed next step. */
  readonly nextStep?: string
  /** Owning harness session when agent-mediated. */
  readonly sessionId?: string
}

/** Request to record one consultation. */
export interface RecordConsultationRequest {
  /** The client advised. */
  readonly clientId: ClientId
  /** Advising advisor; defaults to the client's owner. */
  readonly advisorId?: AdvisorId
  /** The interaction this consultation extends. */
  readonly interactionId?: InteractionId
  /** Epoch ms when it happened; defaults to now. */
  readonly occurredAt?: number
  /** Advisory topics covered. */
  readonly topics?: readonly AdvisoryTopic[]
  /** Products discussed, each with its documented R1–R5 level. */
  readonly products?: readonly ProductDiscussion[]
  /** Recommendations given. */
  readonly recommendations?: readonly string[]
  /** Whether a follow-up is required; defaults to false. */
  readonly followUpRequired?: boolean
  /** Free-text summary. */
  readonly summary?: string
  /** Owning harness session when agent-mediated. */
  readonly sessionId?: string
}

/** Request to open one opportunity. */
export interface CreateOpportunityRequest {
  /** The client pursued. */
  readonly clientId: ClientId
  /** Owning advisor; defaults to the client's owner. */
  readonly advisorId?: AdvisorId
  /** Product category. */
  readonly productKind: OpportunityRecord['productKind']
  /** Specific product name. */
  readonly productName?: string
  /** Stage; defaults to new. */
  readonly stage?: OpportunityStage
  /** Deal value in `currency`; must be positive. */
  readonly amount: number
  /** ISO 4217 code; defaults to CNY. */
  readonly currency?: string
  /** Win probability 0–100; defaults to the stage's value. */
  readonly probability?: number
  /** Planned close time in epoch ms. */
  readonly expectedCloseAt?: number
  /** Free-text notes. */
  readonly notes?: string
}

/** Request to move one opportunity through the pipeline. */
export interface MoveOpportunityRequest {
  /** The deal to move. */
  readonly opportunityId: OpportunityId
  /** Target stage. */
  readonly to: OpportunityStage
  /** Win probability 0–100; ignored entering a terminal stage. */
  readonly probability?: number
  /** Why the deal closed or was abandoned; required entering lost or abandoned. */
  readonly closeReason?: string
  /** Notes update. */
  readonly notes?: string
}

/** Request to schedule one task. */
export interface CreateTaskRequest {
  /** The advisor who owes the work; resolved from client or opportunity when omitted. */
  readonly advisorId?: AdvisorId
  /** The client concerned. */
  readonly clientId?: ClientId
  /** The opportunity concerned. */
  readonly opportunityId?: OpportunityId
  /** Task category; defaults to follow_up. */
  readonly kind?: TaskKind
  /** One-line description. */
  readonly title: string
  /** Epoch ms when due. */
  readonly dueAt: number
  /** Urgency; defaults to normal. */
  readonly priority?: TaskPriority
  /** Free-text notes. */
  readonly notes?: string
}

/** Validation for one deployment-varying policy field. */
function resolveValidityMs(days: number): number {
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new TypeError(`crm: riskProfileValidityDays must be a positive safe integer, got ${String(days)}`)
  }
  return days * 24 * 60 * 60 * 1000
}

/** Trim a required one-line text field and fail loud when it would be empty. */
function trimmedLine(value: string, what: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`crm: ${what} must be a non-empty string`)
  return trimmed
}

/** Locale-independent text order (UTF-16 code units): deterministic on every ICU build. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Normalize a tag set: trim, drop empties, dedupe, freeze. */
function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) return Object.freeze([])
  const seen = new Set<string>()
  for (const raw of tags) {
    const tag = raw.trim()
    if (tag.length > 0) seen.add(tag)
  }
  return Object.freeze([...seen])
}

/** Clamp a caller limit into the protocol bound with its default. */
function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  const value = limit ?? fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`crm: limit must be a positive integer, got ${String(limit)}`)
  }
  return Math.min(value, max)
}

/** Range-check a win probability. */
function requireProbability(probability: number, what: string): void {
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
    throw new Error(`crm: ${what} must be an integer between 0 and 100, got ${String(probability)}`)
  }
}

/** Range-check a monetary amount. */
function requireAmount(amount: number, what: string): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`crm: ${what} must be a positive finite number, got ${String(amount)}`)
  }
}

/**
 * Durable investment-advisory CRM. Writes serialize on one service-level
 * chain so each read-validate-write mutation observes the previous one's
 * landed state; reads are synchronous snapshots of the domain's memory.
 */
export class CrmService extends Service {
  static inject = ['storageDomain']

  /** Loader validation for the required assessment-validity policy. */
  static Config: s<Config> = s.object({
    riskProfileValidityDays: s.number().step(1).min(1).required(),
  })

  private readonly validityMs: number
  private advisorsTable?: KvTable<AdvisorId, AdvisorRecord>
  private clientsTable?: KvTable<ClientId, ClientRecord>
  private interactionsTable?: KvTable<InteractionId, InteractionRecord>
  private consultationsTable?: KvTable<ConsultationId, ConsultationRecord>
  private opportunitiesTable?: KvTable<OpportunityId, OpportunityRecord>
  private tasksTable?: KvTable<TaskId, TaskRecord>
  private plansTable?: KvTable<string, PlanRecord>
  private tail: Promise<void> = Promise.resolve()
  private admitting = true

  /**
   * @param ctx - Host context carrying the storage-domain form.
   * @param config - Required assessment-validity policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'crm')
    this.validityMs = resolveValidityMs(config.riskProfileValidityDays)
  }

  /** Open the one CRM domain, bind its tables, and own its closure. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(crmDomainSpec)
    this.ctx.effect(() => async () => {
      this.admitting = false
      await this.tail
      await domain.close()
    }, 'crm.domainClose')
    this.advisorsTable = domain.table('advisors')
    this.clientsTable = domain.table('clients')
    this.interactionsTable = domain.table('interactions')
    this.consultationsTable = domain.table('consultations')
    this.opportunitiesTable = domain.table('opportunities')
    this.tasksTable = domain.table('tasks')
    this.plansTable = domain.table('plans')
  }

  /** Queue one whole read-validate-write mutation behind every earlier one. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (!this.admitting) {
      return Promise.reject(new Error('crm: service is disposing'))
    }
    const result = this.tail.then(job)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private advisors(): KvTable<AdvisorId, AdvisorRecord> {
    if (this.advisorsTable === undefined) throw new Error('crm: durable domain is not initialized (advisors)')
    return this.advisorsTable
  }

  private clients(): KvTable<ClientId, ClientRecord> {
    if (this.clientsTable === undefined) throw new Error('crm: durable domain is not initialized (clients)')
    return this.clientsTable
  }

  private interactions(): KvTable<InteractionId, InteractionRecord> {
    if (this.interactionsTable === undefined) throw new Error('crm: durable domain is not initialized (interactions)')
    return this.interactionsTable
  }

  private consultations(): KvTable<ConsultationId, ConsultationRecord> {
    if (this.consultationsTable === undefined) throw new Error('crm: durable domain is not initialized (consultations)')
    return this.consultationsTable
  }

  private opportunities(): KvTable<OpportunityId, OpportunityRecord> {
    if (this.opportunitiesTable === undefined) throw new Error('crm: durable domain is not initialized (opportunities)')
    return this.opportunitiesTable
  }

  private plans(): KvTable<string, PlanRecord> {
    if (this.plansTable === undefined) throw new Error('crm: durable domain is not initialized (plans)')
    return this.plansTable
  }

  private tasks(): KvTable<TaskId, TaskRecord> {
    if (this.tasksTable === undefined) throw new Error('crm: durable domain is not initialized (tasks)')
    return this.tasksTable
  }

  /** All current records of one table, as a fresh array. */
  private values<K extends string, V>(table: KvTable<K, V>): V[] {
    const records: V[] = []
    for (const [, record] of table.entries()) records.push(record)
    return records
  }

  /** Stream every record of one table without materializing an array. */
  private each<K extends string, V>(table: KvTable<K, V>, visit: (record: V) => void): void {
    for (const [, record] of table.entries()) visit(record)
  }

  /** Collect the records of one table that pass `keep`, in one pass. */
  private collect<K extends string, V>(table: KvTable<K, V>, keep: (record: V) => boolean): V[] {
    const records: V[] = []
    for (const [, record] of table.entries()) {
      if (keep(record)) records.push(record)
    }
    return records
  }

  private requireClient(clientId: ClientId): ClientRecord {
    const client = this.clients().get(clientId)
    if (client === undefined) throw new CrmUnknownClientError(clientId)
    return client
  }

  private requireAdvisor(advisorId: AdvisorId): AdvisorRecord {
    const advisor = this.advisors().get(advisorId)
    if (advisor === undefined) throw new CrmUnknownAdvisorError(advisorId)
    return advisor
  }

  /** Resolve the advisor for a client-scoped operation: explicit wins, else the client's owner. */
  private resolveAdvisor(explicit: AdvisorId | undefined, client: ClientRecord, what: string): AdvisorId {
    const advisorId = explicit ?? client.advisorId
    if (advisorId === undefined) throw new CrmAdvisorRequiredError(what)
    this.requireAdvisor(advisorId)
    return advisorId
  }

  /** Suitability validity of one client's assessment at `now`. */
  private profileStatus(client: ClientRecord, now: number): ProfileStatus {
    const profile = client.riskProfile
    if (profile === undefined) return 'missing'
    if (profile.expiresAt <= now) return 'expired'
    if (profile.expiresAt - now <= PROFILE_EXPIRY_WARNING_MS) return 'expiring'
    return 'valid'
  }

  /**
   * Register one advisor.
   * @param request - Name plus optional team, license, specialties, and availability.
   * @returns the committed record.
   */
  registerAdvisor(request: CreateAdvisorRequest): Promise<AdvisorRecord> {
    return this.enqueue(async () => {
      const name = trimmedLine(request.name, 'advisor name')
      const licenseNo = request.licenseNo === undefined ? undefined : trimmedLine(request.licenseNo, 'licenseNo')
      const specialties = Object.freeze([...request.specialties ?? []])
      const active = request.active ?? true
      if (licenseNo !== undefined) {
        this.each(this.advisors(), (advisor) => {
          if (advisor.licenseNo === licenseNo) {
            throw new CrmDuplicateLicenseError(licenseNo, advisor.id)
          }
        })
      }
      const now = Date.now()
      const advisor: AdvisorRecord = Object.freeze({
        id: AdvisorId(randomUUID()),
        name,
        ...(request.team === undefined ? {} : { team: trimmedLine(request.team, 'team') }),
        ...(licenseNo === undefined ? {} : { licenseNo }),
        specialties,
        active,
        createdAt: now,
        updatedAt: now,
      })
      await this.advisors().put(advisor.id, advisor)
      return advisor
    })
  }

  /**
   * Read one advisor.
   * @param advisorId - Advisor to read.
   * @returns the record, or undefined when absent.
   */
  getAdvisor(advisorId: AdvisorId): AdvisorRecord | undefined {
    return this.advisors().get(advisorId)
  }

  /**
   * List advisors.
   * @param active - Restrict to this availability when provided.
   * @returns records sorted by name.
   */
  listAdvisors(active?: boolean): AdvisorRecord[] {
    return this.values(this.advisors())
      .filter(advisor => active === undefined || advisor.active === active)
      .sort((left, right) => compareText(left.name, right.name))
  }

  /**
   * Create one advisory plan. Exactly one kind payload (recurring, allocation,
   * or protection-gap) must be present and must match `kind`.
   * @param request - Plan creation fields.
   * @returns the committed plan record.
   */
  createPlan(request: CreatePlanRequest): Promise<PlanRecord> {
    const advisorId = request.advisorId === undefined ? undefined : AdvisorId(request.advisorId)
    return this.enqueue(async () => {
      const client = this.requireClient(ClientId(request.clientId))
      if (advisorId !== undefined) this.requireAdvisor(advisorId)
      const now = Date.now()
      const resolvedAdvisor = advisorId ?? client.advisorId
      if (resolvedAdvisor === undefined) throw new CrmAdvisorRequiredError('creating a plan')
      const payload: Record<string, unknown> = {
        id: randomUUID(),
        clientId: client.id,
        advisorId: resolvedAdvisor,
        kind: request.kind,
        status: 'draft',
        topics: Object.freeze([...request.topics ?? []]),
        ...(request.tolerance === undefined ? {} : { tolerance: request.tolerance }),
        ...(request.notes === undefined ? {} : { notes: trimmedLine(request.notes, 'notes') }),
        createdAt: now,
        updatedAt: now,
      }
      if (request.kind === 'recurring-investment') {
        if (request.recurring === undefined) throw new Error('crm: recurring-investment plans require a recurring payload')
        payload.recurring = Object.freeze({ ...request.recurring })
      } else if (request.kind === 'allocation') {
        if (request.allocation === undefined) throw new Error('crm: allocation plans require an allocation payload')
        const total = request.allocation.sleeves.reduce((sum, sleeve) => sum + sleeve.targetPercent, 0)
        if (total !== 100) throw new Error(`crm: allocation sleeves must sum to 100, got ${String(total)}`)
        payload.allocation = Object.freeze({
          sleeves: Object.freeze(request.allocation.sleeves.map(sleeve => Object.freeze({ ...sleeve }))),
          rebalanceBand: request.allocation.rebalanceBand,
        })
      } else {
        // The union narrows to 'protection-gap' here; an unknown kind cannot reach the service.
        if (request.protectionGap === undefined) throw new Error('crm: protection-gap plans require a protectionGap payload')
        const gap = request.protectionGap
        payload.protectionGap = Object.freeze({
          ...gap,
          recommendedLifeCover: Math.max(0, gap.annualIncome * gap.incomeYears - gap.existingLifeCover),
          recommendedCriticalIllnessCover: Math.max(0, Math.round(gap.annualIncome / 2) - gap.existingCriticalIllnessCover),
        })
      }
      const record = Object.freeze(payload as unknown as PlanRecord)
      await this.plans().put(record.id, record)
      return record
    })
  }

  /**
   * Read one plan.
   * @param planId - Plan to read.
   * @returns the record, or undefined when absent.
   */
  getPlan(planId: PlanRecord['id']): PlanRecord | undefined {
    for (const [, row] of this.plans().entries()) {
      if (row.id === planId) return row
    }
    return undefined
  }

  /**
   * List plans, optionally by client.
   * @param clientId - Restrict to one client when provided.
   * @param status - Restrict to one status when provided.
   * @returns records newest-update first.
   */
  listPlans(clientId?: import('./types.ts').ClientId, status?: PlanRecord['status']): PlanRecord[] {
    return this.collect(this.plans(), () => true)
      .filter(plan => (clientId === undefined || plan.clientId === clientId) && (status === undefined || plan.status === status))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * Transition one plan's status. Only draft→active, active↔paused,
   * active→completed, and anything-not-terminal→cancelled are accepted.
   * @param planId - Plan to transition.
   * @param to - Target status.
   * @returns the committed record.
   */
  async transitionPlan(planId: PlanRecord['id'], to: PlanRecord['status']): Promise<PlanRecord> {
    return this.enqueue(async () => {
      let current: PlanRecord | undefined
      for (const [, row] of this.plans().entries()) {
        if (row.id === planId) { current = row; break }
      }
      if (current === undefined) throw new CrmUnknownPlanError(planId)
      const from = current.status
      const allowed: Record<string, readonly string[]> = {
        draft: ['active', 'cancelled'],
        active: ['paused', 'completed', 'cancelled'],
        paused: ['active', 'cancelled'],
        completed: [],
        cancelled: [],
      }
      if (from === to) throw new CrmPlanStateError(planId, from, to, 'the plan is already in this status')
      if (!allowed[from]?.includes(to)) {
        throw new CrmPlanStateError(planId, from, to, `'${from}' cannot transition to '${to}'`)
      }
      const updated: PlanRecord = Object.freeze({ ...current, status: to, updatedAt: Math.max(Date.now(), current.updatedAt) })
      await this.plans().put(updated.id, updated)
      return updated
    })
  }

  /**
   * Evaluate one plan: allocation plans compute per-sleeve drift against the
   * band; recurring plans report months elapsed and invested-to-date;
   * protection-gap plans echo the recommended cover.
   * @param planId - Plan to review.
   * @param currentValues - Current portfolio percent per sleeve name (only
   * needed for allocation plans).
   * @returns the review with the plan row.
   */
  reviewPlan(planId: PlanRecord['id'], currentValues?: Readonly<Record<string, number>>): import('./plan-types.ts').PlanReview {
    const plan = this.getPlan(planId)
    if (plan === undefined) throw new CrmUnknownPlanError(planId)
    if (plan.kind === 'allocation' && plan.allocation !== undefined) {
      const allocation = plan.allocation
      const totalTracked = currentValues === undefined ? 0 : Object.values(currentValues).reduce((sum, value) => sum + value, 0)
      const sleeves = allocation.sleeves.map((sleeve) => {
        const currentPercent = totalTracked === 0 ? 0
          : Math.round(((currentValues?.[sleeve.name] ?? 0) / totalTracked) * 100)
        const driftPercent = sleeve.targetPercent - currentPercent
        return {
          name: sleeve.name,
          targetPercent: sleeve.targetPercent,
          currentPercent,
          driftPercent,
          breached: Math.abs(driftPercent) > allocation.rebalanceBand,
        }
      })
      const maxDrift = sleeves.reduce((max, sleeve) => Math.max(max, Math.abs(sleeve.driftPercent)), 0)
      return {
        plan,
        allocation: { sleeves, needsRebalance: sleeves.some(sleeve => sleeve.breached), maxDrift },
      }
    }
    if (plan.kind === 'recurring-investment' && plan.recurring !== undefined) {
      const monthsElapsed = Math.max(0, Math.floor((Date.now() - plan.createdAt) / (30 * 86_400_000)))
      return {
        plan,
        monthsElapsed,
        investedToDate: monthsElapsed * plan.recurring.monthlyAmount,
      }
    }
    // A landed row always pairs its kind with its payload, so the empty arm
    // of the spread cannot run for a real protection-gap plan.
    /* v8 ignore next */
    return { plan, ...(plan.protectionGap === undefined ? {} : { protection: plan.protectionGap }) }
  }

  /**
   * Load the built-in demo book (advisors, clients across every profile
   * status, interactions, suitability-varied consultations, pipeline deals,
   * one overdue task) through the real mutation rules. Refuses when the client
   * book is non-empty, so it is a one-time onboarding action.
   * @param now - Reference time the demo stages around; defaults to the clock.
   * @returns committed record counts.
   */
  loadDemoData(now: number = Date.now()): Promise<DemoDataSummary> {
    return loadDemoData(this, now)
  }

  /**
   * Create one client. An initial risk assessment, when given, expires after
   * the configured validity window.
   * @param request - Name, kind, and optional profile fields.
   * @returns the committed record.
   */
  createClient(request: CreateClientRequest): Promise<ClientRecord> {
    return this.enqueue(async () => {
      const name = trimmedLine(request.name, 'client name')
      const tags = normalizeTags(request.tags)
      if (request.advisorId !== undefined) this.requireAdvisor(request.advisorId)
      const now = Date.now()
      let riskProfile: ClientRecord['riskProfile'] | undefined
      if (request.riskProfile !== undefined) {
        riskProfile = Object.freeze({
          tolerance: request.riskProfile.tolerance,
          ...(request.riskProfile.score === undefined ? {} : { score: request.riskProfile.score }),
          assessedAt: now,
          expiresAt: now + this.validityMs,
        })
      }
      const client: ClientRecord = Object.freeze({
        id: ClientId(randomUUID()),
        name,
        kind: request.kind,
        lifecycle: request.lifecycle ?? 'lead',
        ...(request.contact === undefined ? {} : { contact: Object.freeze({ ...request.contact }) }),
        ...(riskProfile === undefined ? {} : { riskProfile }),
        ...(request.financial === undefined ? {} : { financial: Object.freeze({ ...request.financial }) }),
        ...(request.advisorId === undefined ? {} : { advisorId: request.advisorId }),
        tags,
        ...(request.notes === undefined ? {} : { notes: trimmedLine(request.notes, 'notes') }),
        createdAt: now,
        updatedAt: now,
      })
      await this.clients().put(client.id, client)
      return client
    })
  }

  /**
   * Patch one client. Absent fields keep their values; a risk-profile patch
   * re-assesses at `assessedAt` (default now) and re-derives the expiry.
   * @param clientId - Client to update.
   * @param patch - Fields to replace.
   * @returns the committed record.
   */
  updateClient(clientId: ClientId, patch: ClientPatch): Promise<ClientRecord> {
    return this.enqueue(async () => {
      const current = this.requireClient(clientId)
      if (patch.advisorId !== undefined) this.requireAdvisor(patch.advisorId)
      const now = Date.now()
      let riskProfile = current.riskProfile
      if (patch.riskProfile !== undefined) {
        const assessedAt = patch.riskProfile.assessedAt ?? now
        riskProfile = Object.freeze({
          tolerance: patch.riskProfile.tolerance,
          ...(patch.riskProfile.score === undefined ? {} : { score: patch.riskProfile.score }),
          assessedAt,
          expiresAt: assessedAt + this.validityMs,
        })
      }
      const next: ClientRecord = Object.freeze({
        ...current,
        ...(patch.name === undefined ? {} : { name: trimmedLine(patch.name, 'client name') }),
        ...(patch.lifecycle === undefined ? {} : { lifecycle: patch.lifecycle }),
        ...(patch.contact === undefined ? {} : { contact: Object.freeze({ ...patch.contact }) }),
        ...(patch.financial === undefined ? {} : { financial: Object.freeze({ ...patch.financial }) }),
        ...(patch.notes === undefined ? {} : { notes: trimmedLine(patch.notes, 'notes') }),
        ...(patch.advisorId === undefined ? {} : { advisorId: patch.advisorId }),
        ...(patch.tags === undefined ? {} : { tags: normalizeTags(patch.tags) }),
        ...(riskProfile === undefined ? {} : { riskProfile }),
        updatedAt: Math.max(now, current.updatedAt),
      })
      await this.clients().put(clientId, next)
      return next
    })
  }

  /**
   * Read one client.
   * @param clientId - Client to read.
   * @returns the record, or undefined when absent.
   */
  getClient(clientId: ClientId): ClientRecord | undefined {
    return this.clients().get(clientId)
  }

  /**
   * Search clients. Filters combine with AND; the free-text `query` matches
   * name, tags, and contact fields case-insensitively.
   * @param query - Filters plus an optional result limit (default 20, max 100).
   * @returns summaries sorted by last update, newest first.
   */
  searchClients(query: ClientSearchQuery = {}): ClientSummary[] {
    const limit = clampLimit(query.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
    const needle = query.query?.trim().toLowerCase()
    // A blank query matches everything; decide once instead of per row.
    const matchAll = needle === undefined || needle.length === 0
    const { lifecycle, advisorId, tag, tolerance } = query
    const kind = query.kind
    const byKind = kind === undefined ? undefined : (client: ClientRecord) => client.kind !== kind
    const byLifecycle = lifecycle === undefined ? undefined : (client: ClientRecord) => client.lifecycle !== lifecycle
    const byAdvisor = advisorId === undefined ? undefined : (client: ClientRecord) => client.advisorId !== advisorId
    const byTag = tag === undefined ? undefined : (client: ClientRecord) => !client.tags.includes(tag)
    const byTolerance = tolerance === undefined ? undefined : (client: ClientRecord) => client.riskProfile?.tolerance !== tolerance
    const now = Date.now()
    const keep = (client: ClientRecord): boolean =>
      !(byKind?.(client) ?? false)
      && !(byLifecycle?.(client) ?? false)
      && !(byAdvisor?.(client) ?? false)
      && !(byTag?.(client) ?? false)
      && !(byTolerance?.(client) ?? false)
      && (matchAll || this.matchesText(client, needle))
    return this.collect(this.clients(), keep)
      .sort((left, right) => right.updatedAt - left.updatedAt || compareText(left.name, right.name))
      .slice(0, limit)
      .map(client => ({
        id: client.id,
        name: client.name,
        kind: client.kind,
        lifecycle: client.lifecycle,
        tolerance: client.riskProfile?.tolerance ?? null,
        totalAum: client.financial?.totalAum ?? null,
        ...(client.advisorId === undefined ? {} : { advisorId: client.advisorId }),
        tags: client.tags,
        profileStatus: this.profileStatus(client, now),
      }))
  }

  /** Whether any searchable field of the client contains the already-lowercased needle. */
  private matchesText(client: ClientRecord, needle: string): boolean {
    if (client.name.toLowerCase().includes(needle)) return true
    if (client.tags.some(tag => tag.toLowerCase().includes(needle))) return true
    const contact = client.contact
    if (contact !== undefined) {
      if (contact.phone?.includes(needle)) return true
      if (contact.email?.toLowerCase().includes(needle)) return true
      if (contact.wechat?.toLowerCase().includes(needle)) return true
      if (contact.region?.toLowerCase().includes(needle)) return true
    }
    return false
  }

  /**
   * Assemble the 360° view of one client: the ten most recent interactions,
   * the ten soonest-due open tasks, live and recent-won opportunities, the
   * ten most recent consultations, and the current risk-assessment status.
   * @param clientId - Client to assemble around.
   * @returns the book view.
   */
  clientBook(clientId: ClientId): ClientBook {
    const client = this.requireClient(clientId)
    const now = Date.now()
    const recentInteractions = this.collect(this.interactions(), record => record.clientId === clientId)
      .sort((left, right) => right.occurredAt - left.occurredAt)
      .slice(0, BOOK_WINDOW)
    const soonestTasks = this.collect(this.tasks(), record => record.clientId === clientId && record.status === 'open')
      .sort((left, right) => left.dueAt - right.dueAt)
      .slice(0, BOOK_WINDOW)
    // One scan partitions live deals from the five most recent wins.
    const live: OpportunityRecord[] = []
    const won: OpportunityRecord[] = []
    this.each(this.opportunities(), (record) => {
      if (record.clientId !== clientId) return
      if (TERMINAL_STAGES.has(record.stage)) {
        if (record.stage === 'won') won.push(record)
      } else {
        live.push(record)
      }
    })
    live.sort((left, right) => right.updatedAt - left.updatedAt)
    won.sort((left, right) => right.updatedAt - left.updatedAt)
    const recentConsultations = this.collect(this.consultations(), record => record.clientId === clientId)
      .sort((left, right) => right.occurredAt - left.occurredAt)
      .slice(0, BOOK_WINDOW)
    return {
      client,
      interactions: recentInteractions,
      openTasks: soonestTasks,
      opportunities: [...live, ...won.slice(0, 5)],
      consultations: recentConsultations,
      profileStatus: this.profileStatus(client, now),
    }
  }

  /**
   * Log one interaction.
   * @param request - Client, summary, and channel details.
   * @returns the committed record.
   */
  logInteraction(request: LogInteractionRequest): Promise<InteractionRecord> {
    return this.enqueue(async () => {
      const summary = trimmedLine(request.summary, 'interaction summary')
      const nextStep = request.nextStep === undefined ? undefined : trimmedLine(request.nextStep, 'nextStep')
      const topics = Object.freeze([...request.topics ?? []])
      const client = this.requireClient(request.clientId)
      const advisorId = this.resolveAdvisor(request.advisorId, client, 'logging an interaction')
      const now = Date.now()
      const record: InteractionRecord = Object.freeze({
        id: InteractionId(randomUUID()),
        clientId: request.clientId,
        advisorId,
        kind: request.kind ?? 'consultation',
        occurredAt: request.occurredAt ?? now,
        ...(request.durationMin === undefined ? {} : { durationMin: request.durationMin }),
        summary,
        ...(request.sentiment === undefined ? {} : { sentiment: request.sentiment }),
        topics,
        ...(nextStep === undefined ? {} : { nextStep }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        createdAt: now,
      })
      await this.interactions().put(record.id, record)
      return record
    })
  }

  /**
   * List interactions.
   * @param query - Client, advisor, channel, and since filters plus a limit (default 20, max 200).
   * @returns records sorted by occurrence, newest first.
   */
  listInteractions(query: InteractionListQuery = {}): InteractionRecord[] {
    const limit = clampLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
    const { clientId, advisorId, kind, topic, since } = query
    const keep = (record: InteractionRecord): boolean =>
      (clientId === undefined || record.clientId === clientId)
      && (advisorId === undefined || record.advisorId === advisorId)
      && (kind === undefined || record.kind === kind)
      && (topic === undefined || record.topics.includes(topic))
      && (since === undefined || record.occurredAt >= since)
    return this.collect(this.interactions(), keep)
      .sort((left, right) => right.occurredAt - left.occurredAt)
      .slice(0, limit)
  }

  /**
   * Record one consultation. Every discussed product gets a suitability
   * verdict evaluated against the client's profile at consultation time and
   * stored with the record for audit.
   * @param request - Client, topics, products, and recommendations.
   * @returns the committed record including the suitability assessments.
   */
  recordConsultation(request: RecordConsultationRequest): Promise<ConsultationRecord> {
    return this.enqueue(async () => {
      const recommendations = Object.freeze(request.recommendations?.map(line => trimmedLine(line, 'recommendation')) ?? [])
      const summary = request.summary === undefined ? undefined : trimmedLine(request.summary, 'summary')
      const topics = Object.freeze([...request.topics ?? []])
      const products = Object.freeze([...request.products ?? []])
      const client = this.requireClient(request.clientId)
      const advisorId = this.resolveAdvisor(request.advisorId, client, 'recording a consultation')
      const now = Date.now()
      const occurredAt = request.occurredAt ?? now
      const assessments: SuitabilityAssessment[] = products.map((product) => {
        const outcome = evaluateSuitability(client.riskProfile, product, occurredAt)
        return Object.freeze({ product: Object.freeze({ ...product }), ...outcome })
      })
      const record: ConsultationRecord = Object.freeze({
        id: ConsultationId(randomUUID()),
        clientId: request.clientId,
        advisorId,
        ...(request.interactionId === undefined ? {} : { interactionId: request.interactionId }),
        occurredAt,
        topics,
        products: Object.freeze(assessments),
        recommendations,
        followUpRequired: request.followUpRequired ?? false,
        ...(summary === undefined ? {} : { summary }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        createdAt: now,
      })
      await this.consultations().put(record.id, record)
      return record
    })
  }

  /**
   * List consultations.
   * @param clientId - Restrict to one client when provided.
   * @param limit - Maximum rows (default 20, max 200).
   * @returns records sorted by occurrence, newest first.
   */
  listConsultations(clientId?: ClientId, limit?: number): ConsultationRecord[] {
    const bound = clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
    return this.collect(this.consultations(), record => clientId === undefined || record.clientId === clientId)
      .sort((left, right) => right.occurredAt - left.occurredAt)
      .slice(0, bound)
  }

  /**
   * Flatten the suitability audit trail: one entry per discussed product.
   * @param clientId - Restrict to one client when provided.
   * @param limit - Maximum entries (default 50, max 200).
   * @param advisorId - Restrict to one advising advisor when provided.
   * @returns entries sorted by consultation time, newest first.
   */
  suitabilityAudit(clientId?: ClientId, limit?: number, advisorId?: AdvisorId): SuitabilityAuditEntry[] {
    const bound = clampLimit(limit, DEFAULT_AUDIT_LIMIT, MAX_LIST_LIMIT)
    const names = new Map<ClientId, string>()
    const nameOf = (id: ClientId): string => {
      const cached = names.get(id)
      if (cached !== undefined) return cached
      const name = this.requireClient(id).name
      names.set(id, name)
      return name
    }
    const scoped = clientId
    const entries: SuitabilityAuditEntry[] = []
    this.each(this.consultations(), (record) => {
      if (scoped !== undefined && record.clientId !== scoped) return
      if (advisorId !== undefined && record.advisorId !== advisorId) return
      const name = nameOf(record.clientId)
      for (const assessment of record.products) {
        entries.push({
          clientId: record.clientId,
          clientName: name,
          consultationId: record.id,
          occurredAt: record.occurredAt,
          product: assessment.product,
          verdict: assessment.verdict,
          rationale: assessment.rationale,
        })
      }
    })
    return entries.sort((left, right) => right.occurredAt - left.occurredAt).slice(0, bound)
  }

  /**
   * Open one opportunity in the pipeline.
   * @param request - Client, product, amount, and stage details.
   * @returns the committed record.
   */
  createOpportunity(request: CreateOpportunityRequest): Promise<OpportunityRecord> {
    return this.enqueue(async () => {
      requireAmount(request.amount, 'opportunity amount')
      const stage = request.stage ?? 'new'
      const currency = request.currency ?? 'CNY'
      const probability = request.probability ?? STAGE_DEFAULT_PROBABILITY[stage]
      requireProbability(probability, 'opportunity probability')
      const client = this.requireClient(request.clientId)
      const advisorId = this.resolveAdvisor(request.advisorId, client, 'opening an opportunity')
      const now = Date.now()
      const record: OpportunityRecord = Object.freeze({
        id: OpportunityId(randomUUID()),
        clientId: request.clientId,
        advisorId,
        productKind: request.productKind,
        ...(request.productName === undefined ? {} : { productName: trimmedLine(request.productName, 'productName') }),
        stage,
        amount: request.amount,
        currency,
        probability,
        ...(request.expectedCloseAt === undefined ? {} : { expectedCloseAt: request.expectedCloseAt }),
        ...(request.notes === undefined ? {} : { notes: trimmedLine(request.notes, 'notes') }),
        createdAt: now,
        updatedAt: now,
      })
      await this.opportunities().put(record.id, record)
      return record
    })
  }

  /**
   * Move one opportunity through the pipeline. Terminal targets stamp the
   * close time; lost and abandoned require a close reason; entering won,
   * lost, or abandoned forces the stage's probability.
   * @param request - Target stage plus optional probability, reason, and notes.
   * @returns the committed record.
   */
  moveOpportunity(request: MoveOpportunityRequest): Promise<OpportunityRecord> {
    return this.enqueue(async () => {
      if (request.probability !== undefined) {
        requireProbability(request.probability, 'opportunity probability')
      }
      const current = this.opportunities().get(request.opportunityId)
      if (current === undefined) throw new CrmUnknownOpportunityError(request.opportunityId)
      const { to } = request
      if (to === current.stage) {
        throw new CrmStageTransitionError(request.opportunityId, current.stage, to, 'the deal is already in this stage')
      }
      if (TERMINAL_STAGES.has(current.stage)) {
        throw new CrmStageTransitionError(request.opportunityId, current.stage, to, `'${current.stage}' is terminal`)
      }
      const failing = to === 'lost' || to === 'abandoned'
      let closeReason: string | undefined
      if (failing) {
        const raw = request.closeReason?.trim() ?? ''
        if (raw.length === 0) {
          throw new CrmStageTransitionError(request.opportunityId, current.stage, to, `entering '${to}' requires a closeReason`)
        }
        closeReason = raw
      }
      // won/lost/abandoned close the deal; only lost/abandoned need a reason.
      const closing = to === 'won' || failing
      const now = Date.now()
      const probability = closing ? STAGE_DEFAULT_PROBABILITY[to] : request.probability ?? STAGE_DEFAULT_PROBABILITY[to]
      const next: OpportunityRecord = Object.freeze({
        ...current,
        stage: to,
        probability,
        ...(closing ? { closedAt: current.closedAt ?? now } : {}),
        ...(closeReason === undefined ? {} : { closeReason }),
        ...(request.notes === undefined ? {} : { notes: trimmedLine(request.notes, 'notes') }),
        updatedAt: Math.max(now, current.updatedAt),
      })
      await this.opportunities().put(request.opportunityId, next)
      return next
    })
  }

  /**
   * Read one opportunity.
   * @param opportunityId - Opportunity to read.
   * @returns the record, or undefined when absent.
   */
  getOpportunity(opportunityId: OpportunityId): OpportunityRecord | undefined {
    return this.opportunities().get(opportunityId)
  }

  /**
   * List opportunities.
   * @param query - Client, stage, and advisor filters plus a limit (default 20, max 200).
   * @returns records sorted by last update, newest first.
   */
  listOpportunities(query: OpportunityListQuery = {}): OpportunityRecord[] {
    const limit = clampLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
    const { clientId, stage, advisorId } = query
    const keep = (record: OpportunityRecord): boolean =>
      (clientId === undefined || record.clientId === clientId)
      && (stage === undefined || record.stage === stage)
      && (advisorId === undefined || record.advisorId === advisorId)
    return this.collect(this.opportunities(), keep)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
  }

  /**
   * Schedule one task. The owning advisor resolves from the explicit field,
   * else the named client's owner, else the named opportunity's owner.
   * @param request - Title, due time, and scope references.
   * @returns the committed record.
   */
  createTask(request: CreateTaskRequest): Promise<TaskRecord> {
    return this.enqueue(async () => {
      const title = trimmedLine(request.title, 'task title')
      const notes = request.notes === undefined ? undefined : trimmedLine(request.notes, 'notes')
      const client = request.clientId === undefined ? undefined : this.requireClient(request.clientId)
      let opportunity: OpportunityRecord | undefined
      if (request.opportunityId !== undefined) {
        const deal = this.opportunities().get(request.opportunityId)
        if (deal === undefined) throw new CrmUnknownOpportunityError(request.opportunityId)
        opportunity = deal
      }
      if (client !== undefined && opportunity !== undefined && opportunity.clientId !== client.id) {
        throw new Error(
          `crm: task's client '${client.id}' does not match opportunity '${opportunity.id}' (client '${opportunity.clientId}')`,
        )
      }
      const advisorId = request.advisorId ?? client?.advisorId ?? opportunity?.advisorId
      if (advisorId === undefined) throw new CrmAdvisorRequiredError('scheduling a task')
      this.requireAdvisor(advisorId)
      const now = Date.now()
      const record: TaskRecord = Object.freeze({
        id: TaskId(randomUUID()),
        ...(client === undefined ? {} : { clientId: client.id }),
        ...(opportunity === undefined ? {} : { opportunityId: opportunity.id }),
        advisorId,
        kind: request.kind ?? 'follow_up',
        title,
        dueAt: request.dueAt,
        status: 'open',
        priority: request.priority ?? 'normal',
        ...(notes === undefined ? {} : { notes }),
        createdAt: now,
        updatedAt: now,
      })
      await this.tasks().put(record.id, record)
      return record
    })
  }

  /**
   * Complete one open task.
   * @param taskId - Task to complete.
   * @returns the committed record.
   */
  completeTask(taskId: TaskId): Promise<TaskRecord> {
    return this.settleTask(taskId, 'done', 'complete')
  }

  /**
   * Cancel one open task.
   * @param taskId - Task to cancel.
   * @returns the committed record.
   */
  cancelTask(taskId: TaskId): Promise<TaskRecord> {
    return this.settleTask(taskId, 'cancelled', 'cancel')
  }

  /** Shared body of complete and cancel: only open tasks can settle. */
  private settleTask(taskId: TaskId, status: 'done' | 'cancelled', action: string): Promise<TaskRecord> {
    return this.enqueue(async () => {
      const current = this.tasks().get(taskId)
      if (current === undefined) throw new CrmUnknownTaskError(taskId)
      if (current.status !== 'open') throw new CrmTaskStateError(taskId, action, current.status)
      const now = Date.now()
      const next: TaskRecord = Object.freeze({
        ...current,
        status,
        ...(status === 'done' ? { completedAt: now } : {}),
        updatedAt: Math.max(now, current.updatedAt),
      })
      await this.tasks().put(taskId, next)
      return next
    })
  }

  /**
   * Reschedule one open task.
   * @param taskId - Task to reschedule.
   * @param dueAt - New due time in epoch ms.
   * @returns the committed record.
   */
  rescheduleTask(taskId: TaskId, dueAt: number): Promise<TaskRecord> {
    return this.enqueue(async () => {
      const current = this.tasks().get(taskId)
      if (current === undefined) throw new CrmUnknownTaskError(taskId)
      if (current.status !== 'open') throw new CrmTaskStateError(taskId, 'reschedule', current.status)
      const now = Date.now()
      const next: TaskRecord = Object.freeze({
        ...current,
        dueAt,
        updatedAt: Math.max(now, current.updatedAt),
      })
      await this.tasks().put(taskId, next)
      return next
    })
  }

  /**
   * List tasks. Without `status` only open tasks are returned; `overdue`
   * selects open tasks due strictly before now.
   * @param query - Advisor, client, status, due-window, and overdue filters plus a limit (default 20, max 200).
   * @returns records sorted by due time, soonest first.
   */
  listTasks(query: TaskListQuery = {}): TaskRecord[] {
    const limit = clampLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
    const now = Date.now()
    // Overdue selection is open-only by definition and overrides any status;
    // otherwise an omitted status means the open agenda.
    const status: TaskStatus = query.overdue === true ? 'open' : query.status ?? 'open'
    const { advisorId, clientId, kind, dueBefore } = query
    const keep = (record: TaskRecord): boolean =>
      status === record.status
      && (advisorId === undefined || record.advisorId === advisorId)
      && (clientId === undefined || record.clientId === clientId)
      && (kind === undefined || record.kind === kind)
      && (dueBefore === undefined || record.dueAt <= dueBefore)
      && (query.overdue !== true || record.dueAt < now)
    return this.collect(this.tasks(), keep)
      .sort((left, right) => left.dueAt - right.dueAt)
      .slice(0, limit)
  }

  /**
   * Aggregate the pipeline at one point in time.
   * @param advisorId - Restrict to one advisor's deals when provided.
   * @returns per-stage summaries plus open, forecast, and outcome totals.
   */
  pipelineSnapshot(advisorId?: AdvisorId): PipelineSnapshot {
    // Single pass: every stage row, the open/won/lost totals, and both
    // forecasts accumulate per deal instead of rescanning the table per stage.
    const rows = {} as Record<OpportunityStage, { count: number; amount: number; weighted: number }>
    for (const stage of STAGE_ORDER) rows[stage] = { count: 0, amount: 0, weighted: 0 }
    let openCount = 0
    let openAmount = 0
    let weightedForecast = 0
    let wonCount = 0
    let wonAmount = 0
    let lostCount = 0
    this.each(this.opportunities(), (deal) => {
      if (advisorId !== undefined && deal.advisorId !== advisorId) return
      const row = rows[deal.stage]
      row.count += 1
      row.amount += deal.amount
      if (TERMINAL_STAGES.has(deal.stage)) {
        if (deal.stage === 'won') {
          wonCount += 1
          wonAmount += deal.amount
        } else if (deal.stage === 'lost') {
          lostCount += 1
        }
        return
      }
      const weighted = deal.amount * deal.probability / 100
      row.weighted += weighted
      openCount += 1
      openAmount += deal.amount
      weightedForecast += weighted
    })
    const stages: StageSummary[] = STAGE_ORDER.map(stage => ({ stage, ...rows[stage] }))
    const settled = wonCount + lostCount
    return {
      ...(advisorId === undefined ? {} : { advisorId }),
      stages,
      openCount,
      openAmount,
      weightedForecast,
      wonCount,
      wonAmount,
      lostCount,
      winRate: settled === 0 ? null : Math.round(100 * wonCount / settled),
    }
  }

  /**
   * Aggregate the client book at one point in time.
   * @param advisorId - Restrict to one advisor's clients when provided.
   * @returns lifecycle and tolerance distributions, AUM, and assessment-expiry notices.
   */
  bookSnapshot(advisorId?: AdvisorId): BookSnapshot {
    // Single pass: lifecycle and tolerance distributions, AUM totals, and both
    // expiry notices accumulate per client instead of rescanning per bucket.
    const now = Date.now()
    const lifecycleCounts = {} as Record<ClientLifecycle, number>
    for (const lifecycle of LIFECYCLE_ORDER) lifecycleCounts[lifecycle] = 0
    const toleranceRows = {} as Record<RiskTolerance, { count: number; aum: number }>
    for (const tolerance of TOLERANCE_ORDER) toleranceRows[tolerance] = { count: 0, aum: 0 }
    let unassessedCount = 0
    let unassessedAum = 0
    let totalClients = 0
    let totalAum = 0
    const expiring: ProfileExpiryNotice[] = []
    const expired: ProfileExpiryNotice[] = []
    this.each(this.clients(), (client) => {
      if (advisorId !== undefined && client.advisorId !== advisorId) return
      totalClients += 1
      const aum = client.financial?.totalAum ?? 0
      totalAum += aum
      lifecycleCounts[client.lifecycle] += 1
      const profile = client.riskProfile
      if (profile === undefined) {
        unassessedCount += 1
        unassessedAum += aum
        return
      }
      const row = toleranceRows[profile.tolerance]
      row.count += 1
      row.aum += aum
      const notice = { clientId: client.id, name: client.name, expiresAt: profile.expiresAt }
      if (profile.expiresAt <= now) expired.push(notice)
      else if (profile.expiresAt - now <= PROFILE_EXPIRY_WARNING_MS) expiring.push(notice)
    })
    expiring.sort((left, right) => left.expiresAt - right.expiresAt)
    expired.sort((left, right) => right.expiresAt - left.expiresAt)
    const byTolerance: ToleranceAum[] = TOLERANCE_ORDER.map(tolerance => ({ tolerance, ...toleranceRows[tolerance] }))
    if (unassessedCount > 0) byTolerance.push({ tolerance: null, count: unassessedCount, aum: unassessedAum })
    return {
      ...(advisorId === undefined ? {} : { advisorId }),
      totalClients,
      byLifecycle: LIFECYCLE_ORDER.map(lifecycle => ({ lifecycle, count: lifecycleCounts[lifecycle] })),
      byTolerance,
      totalAum,
      expiringProfiles: expiring,
      expiredProfiles: expired,
    }
  }

  /**
   * Aggregate the open-task load at one point in time.
   * @param advisorId - Restrict to one advisor's tasks when provided.
   * @returns open and overdue counts, per-priority counts, and the next due tasks.
   */
  taskLoad(advisorId?: AdvisorId): TaskLoadSnapshot {
    // Single pass: open and overdue totals plus per-priority counts accumulate
    // per task; only the bounded dueSoon window needs a (stable) sort.
    const at = Date.now()
    const priorityCounts = {} as Record<TaskPriority, number>
    for (const priority of PRIORITY_ORDER) priorityCounts[priority] = 0
    const openTasks: TaskRecord[] = []
    let overdue = 0
    this.each(this.tasks(), (task) => {
      if (task.status !== 'open') return
      if (advisorId !== undefined && task.advisorId !== advisorId) return
      openTasks.push(task)
      priorityCounts[task.priority] += 1
      if (task.dueAt < at) overdue += 1
    })
    const byPriority = PRIORITY_ORDER.map(priority => ({ priority, count: priorityCounts[priority] }))
    // openTasks is call-local: sort it in place instead of copying first.
    openTasks.sort((left, right) => left.dueAt - right.dueAt)
    const dueSoon: DueTaskSummary[] = openTasks
      .slice(0, DUE_SOON_COUNT)
      .map(task => ({
        id: task.id,
        title: task.title,
        dueAt: task.dueAt,
        ...(task.clientId === undefined ? {} : { clientId: task.clientId }),
        priority: task.priority,
        overdue: task.dueAt < at,
      }))
    return {
      ...(advisorId === undefined ? {} : { advisorId }),
      at,
      open: openTasks.length,
      overdue,
      byPriority,
      dueSoon,
    }
  }
}

export default CrmService
