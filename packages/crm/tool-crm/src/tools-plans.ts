/**
 * Advisory-plan crm_* tools over `ctx.crm`: create/list the three plan kinds,
 * transition the lifecycle, and produce the kind-specific review (allocation
 * drift against the rebalance band, recurring accrual, protection-gap cover).
 * @module @deepseek-ai/dsh-tool-crm/src/tools-plans
 */

import type { Context } from '@deepseek-ai/cordis'
import { ClientId, AdvisorId } from '@deepseek-ai/dsh-crm'
import type { RecurringInvestmentPlan } from '@deepseek-ai/dsh-crm/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { planReviewWireSchema, planWireSchema } from './schemas.ts'
import {
  PLAN_KINDS,
  PLAN_STATUSES,
  PRODUCT_KINDS,
  TOLERANCES,
  TOPICS,
  listPreview,
  parseWhen,
  wirePlan,
  wirePlanReview,
} from './wire.ts'

/** The `{ plan }` result wrapper shared by create and transition. */
const planOutputSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: { plan: { ...planWireSchema, required: true as const } },
} as const

/**
 * Require one number argument for the plan kind being created.
 * @param source - Flat tool arguments.
 * @param field - Argument name.
 * @param requirement - What the plan kind needs it for, in error text.
 * @returns the value.
 */
function requireNum(source: Record<string, unknown>, field: string, requirement: string): number {
  const value = source[field]
  if (typeof value !== 'number') throw new Error(`crm: ${requirement} require ${field}`)
  return value
}

/**
 * Require one string argument for the plan kind being created.
 * @param source - Flat tool arguments.
 * @param field - Argument name.
 * @param requirement - What the plan kind needs it for, in error text.
 * @returns the value.
 */
function requireStr(source: Record<string, unknown>, field: string, requirement: string): string {
  const value = source[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`crm: ${requirement} require ${field}`)
  return value
}

/**
 * Register the advisory-plan tools on `ctx.tools`.
 * @param ctx - Registrant context carrying the tool registry and `ctx.crm`.
 */
export function registerPlanTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'crm_plan_create',
    description:
      'Create one advisory plan for a client in draft status. Exactly one kind and its payload: '
      + 'recurring-investment (定投) needs monthlyAmount/deductionDay/productName; allocation needs '
      + 'sleeves summing to 100 plus rebalanceBand; protection-gap needs annualIncome/incomeYears and '
      + 'existing cover. Plans start as draft; activate with crm_plan_transition.',
    parameters: {
      clientId: { type: 'string', required: true, description: 'Client the plan advises.' },
      kind: { type: 'string', required: true, enum: [...PLAN_KINDS], description: 'Plan kind; the payload fields must match it.' },
      advisorId: { type: 'string', description: 'Owning advisor; defaults to the client\'s owner.' },
      topics: { type: 'array', items: { type: 'string', enum: [...TOPICS] }, description: 'Advisory topics the plan touches.' },
      tolerance: { type: 'string', enum: [...TOLERANCES], description: 'Risk tolerance recorded at creation; defaults to the client\'s current profile.' },
      notes: { type: 'string', description: 'Free-text notes.' },
      monthlyAmount: { type: 'number', description: 'recurring-investment: monthly amount in CNY, positive.' },
      deductionDay: { type: 'integer', description: 'recurring-investment: deduction day of month, 1–28.' },
      productName: { type: 'string', description: 'recurring-investment: product the recurring buys target.' },
      productKind: { type: 'string', enum: [...PRODUCT_KINDS], description: 'recurring-investment: product category; defaults to fund.' },
      endsAt: { type: 'string', description: 'recurring-investment: optional end of the plan, ISO 8601.' },
      sleeves: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Sleeve label, e.g. 固收/权益/现金.' },
            kind: { type: 'string', enum: [...PRODUCT_KINDS], required: true, description: 'Product category the sleeve invests in.' },
            targetPercent: { type: 'integer', required: true, description: 'Target percent, 0–100; all sleeves must sum to 100.' },
          },
        },
        description: 'allocation: at least one sleeve; target percents must sum to 100.',
      },
      rebalanceBand: { type: 'integer', description: 'allocation: drift band in percentage points, 1–50; beyond it review flags rebalance.' },
      annualIncome: { type: 'number', description: 'protection-gap: annual family income in CNY.' },
      incomeYears: { type: 'integer', description: 'protection-gap: years of income to protect, 1–30.' },
      existingLifeCover: { type: 'number', description: 'protection-gap: existing life-cover sum assured; defaults to 0.' },
      existingCriticalIllnessCover: { type: 'number', description: 'protection-gap: existing critical-illness cover; defaults to 0.' },
    },
    output: {
      schema: planOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Created ${value.plan.kind} plan ${value.plan.id} for client ${value.plan.clientId} in draft status.`,
      }],
    },
    execute(args) {
      const flat = args as unknown as Record<string, unknown>
      const base = {
        clientId: ClientId(args.clientId),
        kind: args.kind,
        ...(args.advisorId === undefined ? {} : { advisorId: AdvisorId(args.advisorId) }),
        ...(args.topics === undefined ? {} : { topics: args.topics }),
        ...(args.tolerance === undefined ? {} : { tolerance: args.tolerance }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      }
      if (args.kind === 'recurring-investment') {
        const deductionDay = requireNum(flat, 'deductionDay', 'recurring-investment plans') as RecurringInvestmentPlan['deductionDay']
        if (deductionDay !== Math.trunc(deductionDay) || deductionDay < 1 || deductionDay > 28) {
          throw new Error(`crm: deductionDay must be an integer 1–28, got ${String(deductionDay)}`)
        }
        return ctx.crm.createPlan({
          ...base, kind: 'recurring-investment',
          recurring: {
            monthlyAmount: requireNum(flat, 'monthlyAmount', 'recurring-investment plans'),
            deductionDay,
            productName: requireStr(flat, 'productName', 'recurring-investment plans'),
            productKind: args.productKind ?? 'fund',
            ...(args.endsAt === undefined ? {} : { endsAt: parseWhen(args.endsAt, 'endsAt') }),
          },
        }).then(record => ({ plan: wirePlan(record) }))
      }
      if (args.kind === 'allocation') {
        if (args.sleeves === undefined) throw new Error('crm: allocation plans require sleeves')
        if (args.rebalanceBand === undefined) throw new Error('crm: allocation plans require rebalanceBand')
        return ctx.crm.createPlan({
          ...base, kind: 'allocation',
          allocation: { sleeves: args.sleeves, rebalanceBand: args.rebalanceBand },
        }).then(record => ({ plan: wirePlan(record) }))
      }
      return ctx.crm.createPlan({
        ...base, kind: 'protection-gap',
        protectionGap: {
          annualIncome: requireNum(flat, 'annualIncome', 'protection-gap plans'),
          incomeYears: requireNum(flat, 'incomeYears', 'protection-gap plans'),
          existingLifeCover: args.existingLifeCover ?? 0,
          existingCriticalIllnessCover: args.existingCriticalIllnessCover ?? 0,
          recommendedLifeCover: 0,
          recommendedCriticalIllnessCover: 0,
        },
      }).then(record => ({ plan: wirePlan(record) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Create CRM advisory plan', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_plan_list',
    description: 'List advisory plans, newest-updated first, optionally per client or status.',
    parameters: {
      clientId: { type: 'string', description: 'Restrict to one client.' },
      status: { type: 'string', enum: [...PLAN_STATUSES], description: 'Restrict to one lifecycle status.' },
      limit: { type: 'integer', description: 'Maximum rows (default 20, max 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plans: { type: 'array', items: planWireSchema, required: true },
          returned: { type: 'integer', required: true, description: 'Rows in this response.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.plans.length === 0
          ? 'No matching plans.'
          : `${value.plans.length} plans: ${listPreview(value.plans.map(plan => `${plan.kind}/${plan.status} for client ${plan.clientId}`))}.`,
      }],
    },
    execute(args) {
      const records = ctx.crm.listPlans(
        args.clientId === undefined ? undefined : ClientId(args.clientId),
        args.status,
      )
      const limited = args.limit === undefined ? records : records.slice(0, args.limit)
      return Promise.resolve({ plans: limited.map(wirePlan), returned: limited.length })
    },
    presentCall: args => ({ card: 'generic', title: 'List CRM advisory plans', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_plan_review',
    description:
      'Evaluate one advisory plan. Allocation plans compute per-sleeve drift against the band from '
      + 'currentValues (current portfolio percent per sleeve name); recurring plans report months '
      + 'elapsed and invested-to-date; protection-gap plans echo the recommended cover.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Plan to evaluate.' },
      currentValues: {
        type: 'object',
        additionalProperties: true,
        description: 'allocation only: current portfolio percent keyed by sleeve name.',
      },
    },
    output: {
      schema: planReviewWireSchema,
      render: (_args, value) => [{
        type: 'text',
        text: value.allocation !== undefined
          ? `Allocation review: ${value.allocation.needsRebalance ? 'rebalance needed' : 'within band'}, max drift ${value.allocation.maxDrift} points.`
          : value.investedToDate !== undefined
            ? `Recurring review: ${value.monthsElapsed} months elapsed, ${value.investedToDate} invested to date.`
            : 'Protection-gap review: recommended cover attached.',
      }],
    },
    execute(args) {
      const review = ctx.crm.reviewPlan(
        args.planId,
        args.currentValues as Readonly<Record<string, number>> | undefined,
      )
      return Promise.resolve(wirePlanReview(review))
    },
    presentCall: args => ({ card: 'generic', title: 'Review CRM advisory plan', kind: 'execute', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_plan_transition',
    description:
      'Move one advisory plan through its lifecycle: draft→active, active↔paused, active→completed, '
      + 'and any non-terminal status→cancelled. Terminal statuses (completed, cancelled) are final.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Plan to transition.' },
      to: { type: 'string', required: true, enum: [...PLAN_STATUSES], description: 'Target status.' },
    },
    output: {
      schema: planOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Plan ${value.plan.id} is now ${value.plan.status}.`,
      }],
    },
    execute(args) {
      return ctx.crm.transitionPlan(args.planId, args.to).then(record => ({ plan: wirePlan(record) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Transition CRM advisory plan', kind: 'move', rawInput: args }),
  }))
}
