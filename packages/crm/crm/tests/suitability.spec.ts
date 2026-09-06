import { describe, expect, it } from 'vitest'
import { ALL_SUITABILITY_VERDICTS, TOLERANCE_LEVEL, evaluateSuitability } from '../src/suitability.ts'
import type { ProductDiscussion, RiskProfile } from '../src/types.ts'

const NOW = Date.UTC(2026, 8, 1)
const DAY = 86_400_000

const product = (riskLevel: ProductDiscussion['riskLevel']): ProductDiscussion => ({
  name: '雪球结构·中证500两年期',
  kind: 'structured',
  riskLevel,
})

const profile = (tolerance: RiskProfile['tolerance'], expiresInDays: number): RiskProfile => ({
  tolerance,
  assessedAt: NOW - 30 * DAY,
  expiresAt: NOW + expiresInDays * DAY,
})

describe('evaluateSuitability', () => {
  it('matches when the tolerance level covers the product risk', () => {
    expect(evaluateSuitability(profile('C3', 100), product('R1'), NOW)).toEqual({
      verdict: 'matched',
      rationale: 'product 雪球结构·中证500两年期 (risk R1) matches client tolerance C3',
    })
    expect(evaluateSuitability(profile('C5', 100), product('R5'), NOW).verdict).toBe('matched')
  })

  it('rejects a product whose risk exceeds the tolerance at the exact boundary', () => {
    const outcome = evaluateSuitability(profile('C3', 100), product('R4'), NOW)
    expect(outcome.verdict).toBe('product-exceeds-profile')
    expect(outcome.rationale).toContain('exceeds client tolerance C3')
  })

  it('blocks everything on an expired assessment, including the expiry instant', () => {
    expect(evaluateSuitability(profile('C5', 1), product('R1'), NOW).verdict).toBe('matched')
    const boundary = evaluateSuitability(profile('C5', 0), product('R1'), NOW)
    expect(boundary.verdict).toBe('assessment-expired')
    expect(boundary.rationale).toContain('expired at')
    expect(evaluateSuitability(profile('C5', -10), product('R1'), NOW).verdict).toBe('assessment-expired')
  })

  it('reports a missing profile before any level comparison', () => {
    for (const absent of [null, undefined]) {
      const outcome = evaluateSuitability(absent, product('R1'), NOW)
      expect(outcome.verdict).toBe('missing-profile')
      expect(outcome.rationale).toContain('no risk assessment on file')
    }
  })

  it('exports the closed verdict list and tolerance weights', () => {
    expect(ALL_SUITABILITY_VERDICTS).toEqual([
      'matched',
      'product-exceeds-profile',
      'assessment-expired',
      'missing-profile',
    ])
    expect(TOLERANCE_LEVEL).toEqual({ C1: 1, C2: 2, C3: 3, C4: 4, C5: 5 })
  })
})
