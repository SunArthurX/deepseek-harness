/**
 * Pure suitability engine: matches one client risk profile against one
 * product's documented risk level at one point in time. No I/O, no clock —
 * callers pass `now`, so the outcome is deterministic and replayable.
 * @module @deepseek-ai/dsh-crm/src/suitability
 */

import type {
  ProductDiscussion,
  ProductRiskLevel,
  RiskProfile,
  RiskTolerance,
  SuitabilityOutcome,
  SuitabilityVerdict,
} from './types.ts'

/** Numeric weight of each tolerance level, conservative C1 = 1 to aggressive C5 = 5. */
export const TOLERANCE_LEVEL: Readonly<Record<RiskTolerance, number>> = {
  C1: 1,
  C2: 2,
  C3: 3,
  C4: 4,
  C5: 5,
}

/** Numeric weight of each product risk level, low R1 = 1 to high R5 = 5. */
export const RISK_LEVEL: Readonly<Record<ProductRiskLevel, number>> = {
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
  R5: 5,
} satisfies Readonly<Record<ProductRiskLevel, number>>

/**
 * Evaluate whether `product` is suitable for the client behind `profile`.
 *
 * Order of checks: a missing profile can never match; an expired assessment
 * blocks everything until re-assessed; otherwise the tolerance level must be
 * at least the product risk level.
 * @param profile - The client's current risk profile, or null/undefined when none exists.
 * @param product - The product discussed, carrying its documented R1–R5 level.
 * @param now - Evaluation time in epoch ms.
 * @returns the verdict and a rationale naming the deciding levels or dates.
 */
export function evaluateSuitability(
  profile: RiskProfile | null | undefined,
  product: ProductDiscussion,
  now: number,
): SuitabilityOutcome {
  if (profile === null || profile === undefined) {
    return {
      verdict: 'missing-profile',
      rationale: `client has no risk assessment on file; complete one before discussing ${product.name} (risk ${product.riskLevel})`,
    }
  }
  if (profile.expiresAt <= now) {
    return {
      verdict: 'assessment-expired',
      rationale: `risk assessment (tolerance ${profile.tolerance}) expired at ${new Date(profile.expiresAt).toISOString()}; re-assess before discussing ${product.name} (risk ${product.riskLevel})`,
    }
  }
  if (TOLERANCE_LEVEL[profile.tolerance] < RISK_LEVEL[product.riskLevel]) {
    return {
      verdict: 'product-exceeds-profile',
      rationale: `product ${product.name} (risk ${product.riskLevel}) exceeds client tolerance ${profile.tolerance}`,
    }
  }
  return {
    verdict: 'matched',
    rationale: `product ${product.name} (risk ${product.riskLevel}) matches client tolerance ${profile.tolerance}`,
  }
}

/** Every verdict, for exhaustive iteration in tests and audits. */
export const ALL_SUITABILITY_VERDICTS: readonly SuitabilityVerdict[] = [
  'matched',
  'product-exceeds-profile',
  'assessment-expired',
  'missing-profile',
]

/**
 * Whether one verdict blocks a recommendation (every outcome except a match).
 * @param verdict - The recorded verdict.
 * @returns true unless the verdict is `matched`.
 */
export function isBlockingVerdict(verdict: SuitabilityVerdict): boolean {
  return verdict !== 'matched'
}
