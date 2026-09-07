/**
 * Enterprise read-models for the investment-advisory CRM: client segments,
 * RFM tiering, conversion funnel, and CSV export. All pure projections over
 * the service's own query surface — no rules live here, only aggregation and
 * shaping for operators and BI.
 * @module @deepseek-ai/dsh-crm/src/insights
 */

import type { AdvisoryTopic, ClientLifecycle, OpportunityStage, ProductKind, RiskTolerance } from './types.ts'

/** One client row in a segment listing. */
export interface SegmentRow {
  readonly id: string
  readonly name: string
  readonly kind: 'individual' | 'institution'
  readonly lifecycle: ClientLifecycle
  readonly advisorId?: string
  readonly tolerance: RiskTolerance | null
  readonly profileStatus: 'valid' | 'expiring' | 'expired' | 'missing'
  readonly totalAum: number | null
  readonly tags: readonly string[]
  readonly lastInteractionAt: number | null
  readonly openDeals: number
  readonly openTasks: number
  readonly consultations: number
}

/** One named segment: a filter recipe plus the rows currently matching it. */
export interface ClientSegment {
  /** Segment identity, stable across calls. */
  readonly key: string
  /** Human label for console display. */
  readonly label: string
  /** What the segment selects, for operators. */
  readonly description: string
  readonly count: number
  readonly totalAum: number
  readonly rows: readonly SegmentRow[]
}

/** RFM dimension ratings for one client. */
export interface RfmRow {
  readonly id: string
  readonly name: string
  /** Recency 1–5: 5 = interacted within the last 30 days. */
  readonly recency: 1 | 2 | 3 | 4 | 5
  /** Frequency 1–5: 5 = most interactions within the window. */
  readonly frequency: 1 | 2 | 3 | 4 | 5
  /** Monetary 1–5: 5 = highest AUM quintile. */
  readonly monetary: 1 | 2 | 3 | 4 | 5
  /** Composite RFM triplet as digits, e.g. `545`. */
  readonly score: string
  /** Marketing/service segment the triplet maps to. */
  readonly tier: 'champion' | 'loyal' | 'promising' | 'needs-attention' | 'at-risk' | 'dormant'
  readonly lastInteractionAt: number | null
  readonly totalAum: number | null
  readonly interactions: number
}

/** Whole-book RFM aggregation. */
export interface RfmAnalysis {
  /** Reference time the scores were computed at. */
  readonly at: number
  /** Books without any interactions cannot score recency/frequency. */
  readonly rows: readonly RfmRow[]
  /** Count per tier, in funnel order. */
  readonly tiers: readonly { readonly tier: RfmRow['tier']; readonly count: number }[]
}

/** One funnel stage with its conversion rate from the previous stage. */
export interface FunnelStage {
  readonly stage: OpportunityStage
  /** Deals currently in this stage (open) or that closed into it (terminal). */
  readonly count: number
  /** Share of the previous stage's count, percent rounded; 100 for the first. */
  readonly conversionFromPrevious: number | null
}

/** Lead-to-win conversion funnel over the pipeline. */
export interface ConversionFunnel {
  /** Stages in pipeline order with their counts and step conversions. */
  readonly stages: readonly FunnelStage[]
  /** Deals entering the funnel: everything not yet terminal. */
  readonly entering: number
  readonly won: number
  readonly lost: number
  readonly abandoned: number
  /** won / (won + lost), percent rounded; null before any settled deal. */
  readonly winRate: number | null
}

/** Named segments the console offers out of the box (definition order = display order). */
export const SEGMENTS: readonly { readonly key: string; readonly label: string; readonly description: string }[] = [
  { key: 'vip', label: '高净值客户', description: 'AUM ≥ 500 万的个人客户' },
  { key: 'institution', label: '机构客户', description: '全部机构客户' },
  { key: 'expiring-assessment', label: '测评即将到期', description: '风险测评 30 天内到期的客户' },
  { key: 'expired-assessment', label: '测评已过期', description: '风险测评已过期、需复评的客户' },
  { key: 'unassessed', label: '未测评客户', description: '尚无风险测评的客户' },
  { key: 'dormant', label: '沉睡客户', description: '生命周期处于沉睡的客户' },
  { key: 'no-followup', label: '无跟进中任务', description: '当前没有未完成任务的活跃客户' },
]

/** One CSV export line, header + rows as plain strings. */
export interface CsvExport {
  readonly filename: string
  readonly contentType: 'text/csv; charset=utf-8'
  /** UTF-8 BOM + CRLF rows, Excel-friendly. */
  readonly content: string
  readonly rowCount: number
}

export type { AdvisoryTopic, ProductKind }
