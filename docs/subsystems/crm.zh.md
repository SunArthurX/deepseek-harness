# CRM

[English](crm.md) | 中文

由 [`@deepseek-ai/dsh-crm`](../../packages/crm/crm/README.zh.md) 拥有、经 [`@deepseek-ai/dsh-tool-crm`](../../packages/crm/tool-crm/README.zh.md) 暴露给模型的投资顾问 CRM 能力。服务在 `ctx.crm` 之后维护持久客户簿、顾问名册、互动历史、适当性审计咨询、商机管线与跟进任务；工具拥有线上词汇。行为、配置与不变式见[服务 README](../../packages/crm/crm/README.zh.md) 与[工具 README](../../packages/crm/tool-crm/README.zh.md)。

Source: [`packages/crm/crm/src/index.ts`](../../packages/crm/crm/src/index.ts)

## Service surface

`ctx.crm` 提供顾问（`registerAdvisor`、`getAdvisor`、`listAdvisors`）、客户（`createClient`、`updateClient`、`getClient`、`searchClients`、`clientBook`）、互动（`logInteraction`、`listInteractions`）、咨询（`recordConsultation`、`listConsultations`、`suitabilityAudit`）、商机（`createOpportunity`、`moveOpportunity`、`getOpportunity`、`listOpportunities`）、任务（`createTask`、`completeTask`、`cancelTask`、`rescheduleTask`、`listTasks`）以及读模型聚合（`pipelineSnapshot`、`bookSnapshot`、`taskLoad`）。每个变更都运行在一条服务级链上，并在持久写入之前校验引用。

## Domain rules

- **适当性。** 每个讨论产品在咨询时对照客户风险档案评估：容忍度等级（C1–C5）必须覆盖产品风险等级（R1–R5）且测评未过期（`riskProfileValidityDays` 配置）。判定连同依据一起存储——审计轨迹也记录不利结论。
- **商机阶段状态机。** `won`、`lost`、`abandoned` 为终态；进入 `lost` 或 `abandoned` 需要收尾原因；进入终态盖章收尾时间并强制该阶段概率。
- **派生时间事实。** 任务逾期与档案有效性（valid、固定 30 天窗口内 expiring、expired、missing）在读取时计算，绝不落盘。

## Durable layout and invariant

`crm` 存储域持有六张表（顾问、客户、互动、咨询、商机、任务），记录经 Zod 校验；后端经 `ctx.storageDomain` 接入。包的不变式伴随插件断言每条落库行的跨表引用完整性。不涉及会话事件，持久化目录没有 CRM 行。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcrm--crmservice"></a>

### `ctx.crm` — `CrmService`

Durable investment-advisory CRM. Writes serialize on one service-level chain so each read-validate-write mutation observes the previous one's landed state; reads are synchronous snapshots of the domain's memory.

```ts cordis-catalog
/**
 * Register one advisor.
 * @param request - Name plus optional team, license, specialties, and availability.
 * @returns the committed record.
 */
registerAdvisor(request: CreateAdvisorRequest): Promise<AdvisorRecord>

/**
 * Read one advisor.
 * @param advisorId - Advisor to read.
 * @returns the record, or undefined when absent.
 */
getAdvisor(advisorId: AdvisorId): AdvisorRecord | undefined

/**
 * List advisors.
 * @param active - Restrict to this availability when provided.
 * @returns records sorted by name.
 */
listAdvisors(active?: boolean): AdvisorRecord[]

/**
 * Load the built-in demo book (advisors, clients across every profile
 * status, interactions, suitability-varied consultations, pipeline deals,
 * one overdue task) through the real mutation rules. Refuses when the client
 * book is non-empty, so it is a one-time onboarding action.
 * @param now - Reference time the demo stages around; defaults to the clock.
 * @returns committed record counts.
 */
loadDemoData(now: number = Date.now()): Promise<DemoDataSummary>

/**
 * Create one client. An initial risk assessment, when given, expires after
 * the configured validity window.
 * @param request - Name, kind, and optional profile fields.
 * @returns the committed record.
 */
createClient(request: CreateClientRequest): Promise<ClientRecord>

/**
 * Patch one client. Absent fields keep their values; a risk-profile patch
 * re-assesses at `assessedAt` (default now) and re-derives the expiry.
 * @param clientId - Client to update.
 * @param patch - Fields to replace.
 * @returns the committed record.
 */
updateClient(clientId: ClientId, patch: ClientPatch): Promise<ClientRecord>

/**
 * Read one client.
 * @param clientId - Client to read.
 * @returns the record, or undefined when absent.
 */
getClient(clientId: ClientId): ClientRecord | undefined

/**
 * Search clients. Filters combine with AND; the free-text `query` matches
 * name, tags, and contact fields case-insensitively.
 * @param query - Filters plus an optional result limit (default 20, max 100).
 * @returns summaries sorted by last update, newest first.
 */
searchClients(query: ClientSearchQuery = {}): ClientSummary[]

/**
 * Assemble the 360° view of one client: the ten most recent interactions,
 * the ten soonest-due open tasks, live and recent-won opportunities, the
 * ten most recent consultations, and the current risk-assessment status.
 * @param clientId - Client to assemble around.
 * @returns the book view.
 */
clientBook(clientId: ClientId): ClientBook

/**
 * Log one interaction.
 * @param request - Client, summary, and channel details.
 * @returns the committed record.
 */
logInteraction(request: LogInteractionRequest): Promise<InteractionRecord>

/**
 * List interactions.
 * @param query - Client, advisor, channel, and since filters plus a limit (default 20, max 200).
 * @returns records sorted by occurrence, newest first.
 */
listInteractions(query: InteractionListQuery = {}): InteractionRecord[]

/**
 * Record one consultation. Every discussed product gets a suitability
 * verdict evaluated against the client's profile at consultation time and
 * stored with the record for audit.
 * @param request - Client, topics, products, and recommendations.
 * @returns the committed record including the suitability assessments.
 */
recordConsultation(request: RecordConsultationRequest): Promise<ConsultationRecord>

/**
 * List consultations.
 * @param clientId - Restrict to one client when provided.
 * @param limit - Maximum rows (default 20, max 200).
 * @returns records sorted by occurrence, newest first.
 */
listConsultations(clientId?: ClientId, limit?: number): ConsultationRecord[]

/**
 * Flatten the suitability audit trail: one entry per discussed product.
 * @param clientId - Restrict to one client when provided.
 * @param limit - Maximum entries (default 50, max 200).
 * @param advisorId - Restrict to one advising advisor when provided.
 * @returns entries sorted by consultation time, newest first.
 */
suitabilityAudit(clientId?: ClientId, limit?: number, advisorId?: AdvisorId): SuitabilityAuditEntry[]

/**
 * Open one opportunity in the pipeline.
 * @param request - Client, product, amount, and stage details.
 * @returns the committed record.
 */
createOpportunity(request: CreateOpportunityRequest): Promise<OpportunityRecord>

/**
 * Move one opportunity through the pipeline. Terminal targets stamp the
 * close time; lost and abandoned require a close reason; entering won,
 * lost, or abandoned forces the stage's probability.
 * @param request - Target stage plus optional probability, reason, and notes.
 * @returns the committed record.
 */
moveOpportunity(request: MoveOpportunityRequest): Promise<OpportunityRecord>

/**
 * Read one opportunity.
 * @param opportunityId - Opportunity to read.
 * @returns the record, or undefined when absent.
 */
getOpportunity(opportunityId: OpportunityId): OpportunityRecord | undefined

/**
 * List opportunities.
 * @param query - Client, stage, and advisor filters plus a limit (default 20, max 200).
 * @returns records sorted by last update, newest first.
 */
listOpportunities(query: OpportunityListQuery = {}): OpportunityRecord[]

/**
 * Schedule one task. The owning advisor resolves from the explicit field,
 * else the named client's owner, else the named opportunity's owner.
 * @param request - Title, due time, and scope references.
 * @returns the committed record.
 */
createTask(request: CreateTaskRequest): Promise<TaskRecord>

/**
 * Complete one open task.
 * @param taskId - Task to complete.
 * @returns the committed record.
 */
completeTask(taskId: TaskId): Promise<TaskRecord>

/**
 * Cancel one open task.
 * @param taskId - Task to cancel.
 * @returns the committed record.
 */
cancelTask(taskId: TaskId): Promise<TaskRecord>

/**
 * Reschedule one open task.
 * @param taskId - Task to reschedule.
 * @param dueAt - New due time in epoch ms.
 * @returns the committed record.
 */
rescheduleTask(taskId: TaskId, dueAt: number): Promise<TaskRecord>

/**
 * List tasks. Without `status` only open tasks are returned; `overdue`
 * selects open tasks due strictly before now.
 * @param query - Advisor, client, status, due-window, and overdue filters plus a limit (default 20, max 200).
 * @returns records sorted by due time, soonest first.
 */
listTasks(query: TaskListQuery = {}): TaskRecord[]

/**
 * Aggregate the pipeline at one point in time.
 * @param advisorId - Restrict to one advisor's deals when provided.
 * @returns per-stage summaries plus open, forecast, and outcome totals.
 */
pipelineSnapshot(advisorId?: AdvisorId): PipelineSnapshot

/**
 * Aggregate the client book at one point in time.
 * @param advisorId - Restrict to one advisor's clients when provided.
 * @returns lifecycle and tolerance distributions, AUM, and assessment-expiry notices.
 */
bookSnapshot(advisorId?: AdvisorId): BookSnapshot

/**
 * Aggregate the open-task load at one point in time.
 * @param advisorId - Restrict to one advisor's tasks when provided.
 * @returns open and overdue counts, per-priority counts, and the next due tasks.
 */
taskLoad(advisorId?: AdvisorId): TaskLoadSnapshot
```

Source: [`packages/crm/crm/src/index.ts`](../../packages/crm/crm/src/index.ts)
<!-- END GENERATED cordis-surface -->
