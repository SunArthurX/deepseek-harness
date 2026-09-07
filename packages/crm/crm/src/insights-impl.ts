/**
 * Implementation of the enterprise read-models in `./insights.ts`. Pure
 * functions over the service's query surface — no I/O, no clock beyond the
 * injected `now`, so every result is deterministic and testable.
 * @module @deepseek-ai/dsh-crm/src/insights-impl
 */

import type CrmService from './index.ts'
import { SEGMENTS } from './insights.ts'
import type { OpportunityStage, TaskRecord as TaskRecordOf } from './types.ts'
import type { ClientSegment, ConversionFunnel, CsvExport, FunnelStage, RfmAnalysis, RfmRow, RfmRow as RfmTier, SegmentRow } from './insights.ts'

/** Stage order for the conversion funnel. */
const FUNNEL_STAGES: readonly OpportunityStage[] = [
  'new', 'qualified', 'proposal', 'negotiation', 'won',
]

/** How many days since the last interaction still rate recency 5. */
const RECENCY_FRESH_DAYS = 30
/** AUM at/above which monetary rates 5. */
const MONETARY_TOP = 5_000_000
/** AUM at/above which monetary rates 4. */
const MONETARY_HIGH = 1_000_000

/** Map an RFM triplet to its operator-facing tier. */
function tierOf(recency: RfmTier['recency'], frequency: RfmTier['frequency'], monetary: RfmTier['monetary']): RfmTier['tier'] {
  if (recency >= 4 && frequency >= 4 && monetary >= 4) return 'champion'
  if (recency >= 3 && frequency >= 3) return 'loyal'
  if (recency >= 4) return 'promising'
  if (monetary >= 4) return 'needs-attention'
  if (recency <= 2) return 'at-risk'
  return 'dormant'
}

/** Round a share to whole percent; null when the base is zero. */
function share(part: number, base: number): number | null {
  return base === 0 ? null : Math.round(100 * part / base)
}

/** Build one segment row from the service's own query surface. */
function segmentRow(service: CrmService, client: import('./types.ts').ClientSummary): SegmentRow {
  const book = service.clientBook(client.id)
  const last = book.interactions[0]
  return {
    id: client.id,
    name: client.name,
    kind: client.kind,
    lifecycle: client.lifecycle,
    ...(client.advisorId === undefined ? {} : { advisorId: client.advisorId }),
    tolerance: client.tolerance,
    profileStatus: client.profileStatus,
    totalAum: client.totalAum,
    tags: client.tags,
    lastInteractionAt: last === undefined ? null : last.occurredAt,
    openDeals: book.opportunities.filter(deal => deal.stage !== 'won' && deal.stage !== 'lost' && deal.stage !== 'abandoned').length,
    openTasks: book.openTasks.length,
    consultations: book.consultations.length,
  }
}

/** One segment definition: identity copy plus its current rows. */
interface SegmentDef {
  readonly key: string
  readonly label: string
  readonly description: string
  readonly rows: readonly SegmentRow[]
}

/**
 * Build the named client segments over the current book. Every segment lists
 * full rows so a console can render and a CSV can export from one call.
 * @param service - The CRM service.
 * @returns one entry per known segment key, in SEGMENTS order.
 */
export function buildSegments(service: CrmService): ClientSegment[] {
  const all = service.searchClients({ limit: 100 })
  const full = all.map(client => ({ ...client, row: segmentRow(service, client) }))
  const select = (predicate: (row: SegmentRow) => boolean): ClientSegment['rows'] =>
    full.filter(client => predicate(client.row)).map(client => client.row)
  const sumAum = (rows: readonly SegmentRow[]): number =>
    rows.reduce((sum, row) => sum + (row.totalAum ?? 0), 0)

  const defs: readonly SegmentDef[] = [
    { key: 'vip', label: '高净值客户', description: 'AUM ≥ 500 万的个人客户', rows: select(row => row.kind === 'individual' && (row.totalAum ?? 0) >= 5_000_000) },
    { key: 'institution', label: '机构客户', description: '全部机构客户', rows: select(row => row.kind === 'institution') },
    {
      key: 'expiring-assessment',
      label: '测评即将到期',
      description: '风险测评 30 天内到期的客户',
      rows: select(row => row.profileStatus === 'expiring'),
    },
    { key: 'expired-assessment', label: '测评已过期', description: '风险测评已过期、需复评的客户', rows: select(row => row.profileStatus === 'expired') },
    { key: 'unassessed', label: '未测评客户', description: '尚无风险测评的客户', rows: select(row => row.profileStatus === 'missing') },
    { key: 'dormant', label: '沉睡客户', description: '生命周期处于沉睡的客户', rows: select(row => row.lifecycle === 'dormant') },
    { key: 'no-followup', label: '无跟进中任务', description: '当前没有未完成任务的活跃客户', rows: select(row => row.lifecycle === 'active' && row.openTasks === 0) },
  ]
  return defs.map(def => ({ ...def, count: def.rows.length, totalAum: sumAum(def.rows) }))
}

/**
 * Score the whole book on RFM: recency from the last interaction, frequency
 * from the interaction count, monetary from AUM. Scores are absolute against
 * advisory-operations thresholds (not book-relative quintiles) so the same
 * client keeps the same tier as the book grows.
 * @param service - The CRM service.
 * @param now - Reference time for recency.
 * @returns per-client rows plus the tier histogram.
 */
export function buildRfm(service: CrmService, now: number): RfmAnalysis {
  const rows: RfmRow[] = []
  for (const client of service.searchClients({ limit: 100 })) {
    const interactions = service.listInteractions({ clientId: client.id, limit: 200 })
    const last = interactions[0]
    const daysSince = last === undefined ? null : Math.floor((now - last.occurredAt) / 86_400_000)
    const recency: RfmRow['recency'] | 1 = daysSince === null
      ? 1
      : daysSince <= RECENCY_FRESH_DAYS
        ? 5
        : daysSince <= RECENCY_FRESH_DAYS * 2
          ? 4
          : daysSince <= RECENCY_FRESH_DAYS * 4
            ? 3
            : daysSince <= RECENCY_FRESH_DAYS * 6
              ? 2
              : 1
    const frequency = Math.min(5, 1 + Math.floor(interactions.length / 2)) as RfmRow['frequency']
    const aum = client.totalAum ?? 0
    const monetary: RfmRow['monetary'] = aum >= MONETARY_TOP ? 5 : aum >= MONETARY_HIGH ? 4 : aum >= 100_000 ? 3 : aum > 0 ? 2 : 1
    const score = `${recency}${frequency}${monetary}`
    rows.push({
      id: client.id,
      name: client.name,
      recency,
      frequency,
      monetary,
      score,
      tier: tierOf(recency, frequency, monetary),
      lastInteractionAt: last === undefined ? null : last.occurredAt,
      totalAum: client.totalAum,
      interactions: interactions.length,
    })
  }
  const tierOrder: readonly RfmRow['tier'][] = ['champion', 'loyal', 'promising', 'needs-attention', 'at-risk', 'dormant']
  const tiers = tierOrder.map(tier => ({ tier, count: rows.filter(row => row.tier === tier).length }))
  return { at: now, rows, tiers }
}

/**
 * Lead-to-win conversion funnel: open stages count the deals currently in
 * them; `won` counts closed-won. Step conversions are shares of the previous
 * stage's count.
 * @param service - The CRM service.
 * @param advisorId - Restrict to one advisor when provided.
 * @returns the funnel with entering, settled counts, and the win rate.
 */
export function buildConversionFunnel(service: CrmService, advisorId?: import('./types.ts').AdvisorId): ConversionFunnel {
  const deals = service.listOpportunities({ ...(advisorId === undefined ? {} : { advisorId }), limit: 500 })
  // Seed every stage key so the per-deal tally is total (no undefined reads);
  // won/lost/abandoned count through the same record.
  const counts: Record<OpportunityStage, number> = {
    new: 0, qualified: 0, proposal: 0, negotiation: 0, won: 0, lost: 0, abandoned: 0,
  }
  for (const deal of deals) counts[deal.stage] += 1
  let previous: number | null = null
  const stages: FunnelStage[] = FUNNEL_STAGES.map((stage) => {
    const count = counts[stage]
    const conversionFromPrevious = previous === null ? (count === 0 ? null : 100) : share(count, previous)
    previous = count
    return { stage, count, conversionFromPrevious }
  })
  const won = counts.won
  const settled = won + counts.lost
  return {
    stages,
    entering: deals.filter(deal => deal.stage !== 'lost' && deal.stage !== 'abandoned').length,
    won,
    lost: counts.lost,
    abandoned: counts.abandoned,
    winRate: settled === 0 ? null : Math.round(100 * won / settled),
  }
}

/** CSV-escape one cell: quote when it contains a comma, quote, or newline. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** Join one CSV row (header or data) with CRLF. */
function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(',')
}


/** Export interactions as CSV: one row per touchpoint with channel/topics. */
/**
 * Export interactions as Excel-friendly CSV (BOM + CRLF).
 * @param service - The CRM service.
 * @returns the CSV document with its suggested filename.
 */
export function exportInteractionsCsv(service: CrmService): CsvExport {
  const lines: string[] = [csvRow(['互动ID', '客户ID', '渠道', '日期', '摘要', '情绪', '主题'])]
  let count = 0
  for (const record of service.listInteractions({ limit: 500 })) {
    lines.push(csvRow([
      record.id,
      record.clientId,
      record.kind,
      new Date(record.occurredAt).toISOString().slice(0, 10),
      record.summary,
      record.sentiment ?? '',
      record.topics.join('、'),
    ]))
    count += 1
  }
  return {
    filename: 'crm-interactions.csv',
    contentType: 'text/csv; charset=utf-8',
    content: `\uFEFF${lines.join('\r\n')}\r\n`,
    rowCount: count,
  }
}

/** Export deals as CSV: one row per pipeline deal with stage/amount/close facts. */
/**
 * Export deals as Excel-friendly CSV (BOM + CRLF).
 * @param service - The CRM service.
 * @returns the CSV document with its suggested filename.
 */
export function exportDealsCsv(service: CrmService): CsvExport {
  const lines: string[] = [csvRow(['商机ID', '客户ID', '产品类别', '产品名称', '阶段', '金额', '概率', '收尾时间', '收尾原因'])]
  let count = 0
  for (const deal of service.listOpportunities({ limit: 500 })) {
    lines.push(csvRow([
      deal.id,
      deal.clientId,
      deal.productKind,
      deal.productName ?? '',
      deal.stage,
      String(deal.amount),
      String(deal.probability),
      deal.closedAt === undefined ? '' : new Date(deal.closedAt).toISOString().slice(0, 10),
      deal.closeReason ?? '',
    ]))
    count += 1
  }
  return {
    filename: 'crm-deals.csv',
    contentType: 'text/csv; charset=utf-8',
    content: `\uFEFF${lines.join('\r\n')}\r\n`,
    rowCount: count,
  }
}

/** Export tasks as CSV: one row per task with status/due/priority facts. */
/**
 * Export tasks as Excel-friendly CSV (BOM + CRLF).
 * @param service - The CRM service.
 * @returns the CSV document with its suggested filename.
 */
export function exportTasksCsv(service: CrmService): CsvExport {
  const lines: string[] = [csvRow(['任务ID', '标题', '类别', '状态', '优先级', '到期', '完成时间'])]
  let count = 0
  const tasks: TaskRecordOf[] = [
    ...service.listTasks({ status: 'open', limit: 500 }),
    ...service.listTasks({ status: 'done', limit: 500 }),
    ...service.listTasks({ status: 'cancelled', limit: 500 }),
  ].sort((left, right) => right.createdAt - left.createdAt)
  for (const task of tasks) {
    lines.push(csvRow([
      task.id,
      task.title,
      task.kind,
      task.status,
      task.priority,
      new Date(task.dueAt).toISOString().slice(0, 10),
      task.completedAt === undefined ? '' : new Date(task.completedAt).toISOString().slice(0, 10),
    ]))
    count += 1
  }
  return {
    filename: 'crm-tasks.csv',
    contentType: 'text/csv; charset=utf-8',
    content: `\uFEFF${lines.join('\r\n')}\r\n`,
    rowCount: count,
  }
}

/** Export the suitability audit trail as CSV: one row per product verdict. */
/**
 * Export audit as Excel-friendly CSV (BOM + CRLF).
 * @param service - The CRM service.
 * @returns the CSV document with its suggested filename.
 */
export function exportAuditCsv(service: CrmService): CsvExport {
  const lines: string[] = [csvRow(['客户ID', '客户姓名', '咨询ID', '日期', '产品', '风险等级', '判定', '依据'])]
  let count = 0
  for (const entry of service.suitabilityAudit(undefined, 500)) {
    lines.push(csvRow([
      entry.clientId,
      entry.clientName,
      entry.consultationId,
      new Date(entry.occurredAt).toISOString().slice(0, 10),
      entry.product.name,
      entry.product.riskLevel,
      entry.verdict,
      entry.rationale,
    ]))
    count += 1
  }
  return {
    filename: 'crm-suitability-audit.csv',
    contentType: 'text/csv; charset=utf-8',
    content: `\uFEFF${lines.join('\r\n')}\r\n`,
    rowCount: count,
  }
}

/** Export the client book as Excel-friendly CSV: UTF-8 BOM, CRLF rows, one row
 * per client with the profile facts an operator would hand to BI.
 * @param service - The CRM service.
 * @param now - Reference time for the derived profile status.
 * @returns the CSV document with its suggested filename.
 */
export function exportClientsCsv(service: CrmService, now: number): CsvExport {
  const header = ['客户ID', '姓名', '类型', '生命周期', '风险容忍度', '测评状态', '资产规模', '标签', '最近互动', '未完成商机', '未完成任务', '建档时间']
  const lines: string[] = [csvRow(header)]
  let count = 0
  for (const client of service.searchClients({ limit: 100 })) {
    const book = service.clientBook(client.id)
    const last = book.interactions[0]
    lines.push(csvRow([
      client.id,
      client.name,
      client.kind === 'institution' ? '机构' : '个人',
      client.lifecycle,
      client.tolerance ?? '',
      client.profileStatus,
      String(client.totalAum ?? 0),
      client.tags.join('、'),
      last === undefined ? '' : new Date(last.occurredAt).toISOString().slice(0, 10),
      String(book.opportunities.filter(deal => deal.stage !== 'won' && deal.stage !== 'lost' && deal.stage !== 'abandoned').length),
      String(book.openTasks.length),
      new Date(service.clientBook(client.id).client.updatedAt).toISOString().slice(0, 10),
    ]))
    count += 1
  }
  return {
    filename: `crm-clients-${new Date(now).toISOString().slice(0, 10)}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: `\uFEFF${lines.join('\r\n')}\r\n`,
    rowCount: count,
  }
}

export { SEGMENTS }
