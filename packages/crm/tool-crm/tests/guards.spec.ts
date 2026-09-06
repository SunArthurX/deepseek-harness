// Guards for the wire vocabulary and single-pass aggregation work: the enum
// arrays the tools publish must match the service unions exactly (compile-time
// drift guard), and the seeded aggregations must stay comfortably fast.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClientLifecycle,
  InteractionKind,
  InteractionSentiment,
  OpportunityStage,
  ProductKind,
  ProductRiskLevel,
  RiskTolerance,
  TaskKind,
  TaskPriority,
  TaskStatus,
} from '@deepseek-ai/dsh-crm/types'
import {
  INTERACTION_KINDS,
  LIFECYCLES,
  PRIORITIES,
  PRODUCT_KINDS,
  PRODUCT_RISKS,
  SENTIMENTS,
  STAGES,
  TASK_KINDS,
  TASK_STATUSES,
  TOLERANCES,
  TOPICS,
} from '../src/wire.ts'
import type { AdvisoryTopic } from '@deepseek-ai/dsh-crm/types'
import { SEED_NOW, seedCrm } from '../../crm/tests/helpers/seed.ts'
import { crmHarness } from '../../crm/tests/helpers/harness.ts'

let harness: Awaited<ReturnType<typeof crmHarness>> | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: SEED_NOW })
  harness = await crmHarness()
})

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  vi.useRealTimers()
})

describe('wire vocabulary drift guards', () => {
  it('keeps every published enum exactly equal to its service union members', () => {
    // Compile-time guard: each array must be assignable to the union array and
    // cover it exhaustively; runtime equality pins the exact published order.
    const toleranceCheck: readonly RiskTolerance[] = TOLERANCES
    const riskCheck: readonly ProductRiskLevel[] = PRODUCT_RISKS
    const lifecycleCheck: readonly ClientLifecycle[] = LIFECYCLES
    const interactionCheck: readonly InteractionKind[] = INTERACTION_KINDS
    const sentimentCheck: readonly InteractionSentiment[] = SENTIMENTS
    const topicCheck: readonly AdvisoryTopic[] = TOPICS
    const productKindCheck: readonly ProductKind[] = PRODUCT_KINDS
    const stageCheck: readonly OpportunityStage[] = STAGES
    const taskKindCheck: readonly TaskKind[] = TASK_KINDS
    const taskStatusCheck: readonly TaskStatus[] = TASK_STATUSES
    const priorityCheck: readonly TaskPriority[] = PRIORITIES
    expect(toleranceCheck).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])
    expect(riskCheck).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'])
    expect(lifecycleCheck).toEqual(['lead', 'prospect', 'onboarding', 'active', 'dormant', 'lost'])
    expect(interactionCheck).toEqual(['consultation', 'call', 'wechat', 'meeting', 'email', 'report_review'])
    expect(sentimentCheck).toEqual(['positive', 'neutral', 'negative'])
    expect(topicCheck).toEqual([
      'asset_allocation', 'retirement', 'tax', 'insurance', 'education',
      'market_outlook', 'product_review', 'portfolio_rebalance', 'other',
    ])
    expect(productKindCheck).toEqual(['fund', 'insurance', 'structured', 'retirement', 'education', 'tax', 'advisory_fee'])
    expect(stageCheck).toEqual(['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'abandoned'])
    expect(taskKindCheck).toEqual([
      'follow_up', 'meeting_prep', 'risk_review', 'compliance_check',
      'document_delivery', 'report_delivery', 'client_care',
    ])
    expect(taskStatusCheck).toEqual(['open', 'done', 'cancelled'])
    expect(priorityCheck).toEqual(['low', 'normal', 'high', 'urgent'])
  })
})

describe('aggregation performance guards', () => {
  it('answers every seeded aggregation well inside the interactive budget', async () => {
    const seeded = await seedCrm(harness!.service, ms => vi.setSystemTime(ms))
    const budgetMs = 250
    const runs: readonly [string, () => unknown][] = [
      ['pipelineSnapshot', () => harness!.service.pipelineSnapshot()],
      ['bookSnapshot', () => harness!.service.bookSnapshot()],
      ['taskLoad', () => harness!.service.taskLoad()],
      ['clientBook', () => harness!.service.clientBook(seeded.clients[0]!.id)],
      ['suitabilityAudit', () => harness!.service.suitabilityAudit(undefined, 200)],
      ['searchClients', () => harness!.service.searchClients({})],
      ['searchClients+query', () => harness!.service.searchClients({ query: '客户' })],
      ['listTasks', () => harness!.service.listTasks({})],
      ['listInteractions', () => harness!.service.listInteractions({})],
    ]
    for (const [name, run] of runs) {
      const started = performance.now()
      const outcome = run()
      const elapsed = performance.now() - started
      expect(outcome, name).toBeDefined()
      expect(elapsed, `${name} took ${elapsed}ms`).toBeLessThan(budgetMs)
    }
  })
})
