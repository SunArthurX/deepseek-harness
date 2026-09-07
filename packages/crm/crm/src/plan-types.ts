/**
 * Advisory-plan types: recurring investment plans (定投), asset-allocation
 * models, and protection-gap analyses — the three deeper advisory-planning
 * artifacts layered on top of consultations and opportunities.
 * @module @deepseek-ai/dsh-crm/src/plan-types
 */

import type { AdvisoryTopic, ProductKind, RiskTolerance } from './types.ts'

/** Id of one advisory plan. */
export type PlanId = string

/** Plan kinds the advisory workflow supports. */
export type PlanKind = 'recurring-investment' | 'allocation' | 'protection-gap'

/** Lifecycle of a plan. */
export type PlanStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'

/** One allocation sleeve inside an allocation plan. */
export interface AllocationSleeve {
  /** Sleeve label, e.g. 固收 / 权益 / 现金. */
  readonly name: string
  /** Product kind the sleeve invests in. */
  readonly kind: ProductKind
  /** Target percent of the portfolio, 0–100; sleeves should sum to 100. */
  readonly targetPercent: number
}

/** A drift evaluation for one sleeve at review time. */
export interface AllocationDrift {
  readonly name: string
  readonly targetPercent: number
  /** Current percent of the portfolio (of the tracked total). */
  readonly currentPercent: number
  /** target − current, positive = underweight. */
  readonly driftPercent: number
  /** Whether the drift exceeds the plan's tolerance band. */
  readonly breached: boolean
}

/** Result of evaluating one allocation plan against current values. */
export interface AllocationReview {
  readonly sleeves: readonly AllocationDrift[]
  /** Whether any sleeve breached the band. */
  readonly needsRebalance: boolean
  /** Largest absolute drift across sleeves. */
  readonly maxDrift: number
}

/** Day of month a recurring buy draws from, capped at 28 so February never skips. */
export type DeductionDay =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7
  | 8 | 9 | 10 | 11 | 12 | 13 | 14
  | 15 | 16 | 17 | 18 | 19 | 20 | 21
  | 22 | 23 | 24 | 25 | 26 | 27 | 28

/** A recurring-investment (定投) plan row. */
export interface RecurringInvestmentPlan {
  /** Monthly amount in CNY. */
  readonly monthlyAmount: number
  /** Deduction day of month, 1–28. */
  readonly deductionDay: DeductionDay
  /** Product the recurring buys target. */
  readonly productName: string
  readonly productKind: ProductKind
  /** Epoch ms the plan ends, when bounded. */
  readonly endsAt?: number
}

/** A protection-gap (保障缺口) analysis row. */
export interface ProtectionGapPlan {
  /** Annual family income the analysis is based on, CNY. */
  readonly annualIncome: number
  /** Years of income to protect (遗属需要年限). */
  readonly incomeYears: number
  /** Existing life-cover sum assured, CNY. */
  readonly existingLifeCover: number
  /** Recommended life cover = annualIncome × incomeYears − existingLifeCover, floored at 0. */
  readonly recommendedLifeCover: number
  readonly existingCriticalIllnessCover: number
  /** Recommended CI cover, floored at 0. */
  readonly recommendedCriticalIllnessCover: number
}

/** Base fields every plan row carries. */
export interface PlanBase {
  readonly id: PlanId
  readonly clientId: string
  readonly advisorId: string
  readonly kind: PlanKind
  readonly status: PlanStatus
  /** Advisory topics the plan touches. */
  readonly topics: readonly AdvisoryTopic[]
  /** Risk tolerance recorded at plan creation. */
  readonly tolerance?: RiskTolerance
  readonly createdAt: number
  readonly updatedAt: number
  readonly notes?: string
}

/** The full plan row as stored. Exactly one of the kind payloads is present. */
export type PlanRecord = PlanBase & {
  readonly recurring?: RecurringInvestmentPlan
  readonly allocation?: {
    readonly sleeves: readonly AllocationSleeve[]
    /** Drift band in percentage points; drift beyond it triggers rebalance. */
    readonly rebalanceBand: number
  }
  readonly protectionGap?: ProtectionGapPlan
}

/** Request to create a plan. */
export interface CreatePlanRequest {
  readonly clientId: string
  readonly advisorId?: string
  readonly kind: PlanKind
  readonly topics?: readonly AdvisoryTopic[]
  readonly tolerance?: RiskTolerance
  readonly notes?: string
  readonly recurring?: RecurringInvestmentPlan
  readonly allocation?: {
    readonly sleeves: readonly AllocationSleeve[]
    readonly rebalanceBand: number
  }
  readonly protectionGap?: ProtectionGapPlan
}

/** Review result for one plan, including the plan row. */
export interface PlanReview {
  readonly plan: PlanRecord
  readonly allocation?: AllocationReview
  /** For recurring plans: months elapsed since creation. */
  readonly monthsElapsed?: number
  /** For recurring plans: amount invested to date (monthsElapsed × monthly). */
  readonly investedToDate?: number
  /** For protection-gap plans: the recommended cover numbers. */
  readonly protection?: ProtectionGapPlan
}
