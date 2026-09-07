/**
 * Reusable output-schema fragments for the crm_* tools: one fragment per
 * canonical wire record, kept in lockstep with the serializers in wire.ts
 * (`additionalProperties: false` everywhere and `required: true` on every
 * always-present field, so the frozen canonical value must match exactly).
 * @module @deepseek-ai/dsh-tool-crm/src/schemas
 */

import { INTERACTION_KINDS, LIFECYCLES, PLAN_KINDS, PLAN_STATUSES, PRIORITIES, PRODUCT_KINDS, PRODUCT_RISKS, SENTIMENTS, STAGES, TASK_KINDS, TASK_STATUSES, TOLERANCES, TOPICS } from './wire.ts'

// One shared value array per vocabulary: every fragment spreads these instead
// of allocating its own copy at module initialization.
const TOLERANCE_VALUES = [...TOLERANCES]
const LIFECYCLE_VALUES = [...LIFECYCLES]
const TOPIC_VALUES = [...TOPICS]
const PRODUCT_KIND_VALUES = [...PRODUCT_KINDS]
const PRODUCT_RISK_VALUES = [...PRODUCT_RISKS]
const STAGE_VALUES = [...STAGES]
const TASK_KIND_VALUES = [...TASK_KINDS]
const PRIORITY_VALUES = [...PRIORITIES]
const INTERACTION_KIND_VALUES = [...INTERACTION_KINDS]
const SENTIMENT_VALUES = [...SENTIMENTS]
const TASK_STATUS_VALUES = [...TASK_STATUSES]
const PLAN_KIND_VALUES = [...PLAN_KINDS]
const PLAN_STATUS_VALUES = [...PLAN_STATUSES]

/** Timestamps serialize as ISO 8601 strings. */
const iso = { type: 'string' as const, required: true as const, description: 'ISO 8601 timestamp.' }

/** Optional ISO 8601 timestamp field. */
const isoOptional = { type: 'string' as const, description: 'ISO 8601 timestamp.' }

/** Tolerance as a plain required string field. */
const toleranceValue = { type: 'string' as const, enum: TOLERANCE_VALUES }

/** A tolerance or an explicit null (unassessed). */
const nullableTolerance = { oneOf: [toleranceValue, { type: 'null' as const }] as const }

/** A suitability verdict value. */
const verdictValue = {
  type: 'string' as const,
  enum: ['matched', 'product-exceeds-profile', 'assessment-expired', 'missing-profile'] as const,
}

const contactSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    phone: { type: 'string' as const },
    email: { type: 'string' as const },
    wechat: { type: 'string' as const },
    region: { type: 'string' as const },
  },
}

const riskProfileSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    tolerance: { ...toleranceValue, required: true as const },
    score: { type: 'integer' as const },
    assessedAt: iso,
    expiresAt: iso,
  },
}

const financialSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    totalAum: { type: 'number' as const, required: true as const },
    annualIncome: { type: 'number' as const },
    liquidAssets: { type: 'number' as const },
    currency: { type: 'string' as const, required: true as const },
  },
}

/** One full client record as returned by create, get, and update. */
export const clientWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    name: { type: 'string' as const, required: true as const },
    kind: { type: 'string' as const, enum: ['individual', 'institution'] as const, required: true as const },
    lifecycle: { type: 'string' as const, enum: LIFECYCLE_VALUES, required: true as const },
    tags: { type: 'array' as const, items: { type: 'string' as const }, required: true as const },
    contact: contactSchema,
    riskProfile: riskProfileSchema,
    financial: financialSchema,
    advisorId: { type: 'string' as const },
    notes: { type: 'string' as const },
    profileStatus: { type: 'string' as const, enum: ['valid', 'expiring', 'expired', 'missing'] as const, required: true as const },
    createdAt: iso,
    updatedAt: iso,
  },
}

/** One compact client row as returned by search. */
export const clientSummaryWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    name: { type: 'string' as const, required: true as const },
    kind: { type: 'string' as const, enum: ['individual', 'institution'] as const, required: true as const },
    lifecycle: { type: 'string' as const, enum: LIFECYCLE_VALUES, required: true as const },
    tolerance: { ...nullableTolerance, required: true as const },
    totalAum: { oneOf: [{ type: 'number' as const }, { type: 'null' as const }] as const, required: true as const },
    advisorId: { type: 'string' as const },
    tags: { type: 'array' as const, items: { type: 'string' as const }, required: true as const },
    profileStatus: { type: 'string' as const, enum: ['valid', 'expiring', 'expired', 'missing'] as const, required: true as const },
  },
}

/** One interaction record. */
export const interactionWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    clientId: { type: 'string' as const, required: true as const },
    advisorId: { type: 'string' as const, required: true as const },
    kind: { type: 'string' as const, enum: INTERACTION_KIND_VALUES, required: true as const },
    occurredAt: iso,
    durationMin: { type: 'integer' as const },
    summary: { type: 'string' as const, required: true as const },
    sentiment: { type: 'string' as const, enum: SENTIMENT_VALUES },
    topics: { type: 'array' as const, items: { type: 'string' as const, enum: TOPIC_VALUES }, required: true as const },
    nextStep: { type: 'string' as const },
    sessionId: { type: 'string' as const },
    createdAt: iso,
  },
}

/** One discussed product without its verdict (the audit rows repeat it). */
const productDiscussionSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    name: { type: 'string' as const, required: true as const },
    kind: { type: 'string' as const, enum: PRODUCT_KIND_VALUES, required: true as const },
    riskLevel: { type: 'string' as const, enum: PRODUCT_RISK_VALUES, required: true as const },
  },
}

/** One suitability-assessed product inside a consultation. */
const assessedProductSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    ...productDiscussionSchema.properties,
    verdict: { ...verdictValue, required: true as const },
    rationale: { type: 'string' as const, required: true as const },
  },
}

/** One consultation record. */
export const consultationWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    clientId: { type: 'string' as const, required: true as const },
    advisorId: { type: 'string' as const, required: true as const },
    interactionId: { type: 'string' as const },
    occurredAt: iso,
    topics: { type: 'array' as const, items: { type: 'string' as const, enum: TOPIC_VALUES }, required: true as const },
    products: { type: 'array' as const, items: assessedProductSchema, required: true as const },
    recommendations: { type: 'array' as const, items: { type: 'string' as const }, required: true as const },
    followUpRequired: { type: 'boolean' as const, required: true as const },
    summary: { type: 'string' as const },
    sessionId: { type: 'string' as const },
    createdAt: iso,
  },
}

/** One opportunity record. */
export const opportunityWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    clientId: { type: 'string' as const, required: true as const },
    advisorId: { type: 'string' as const, required: true as const },
    productKind: { type: 'string' as const, enum: PRODUCT_KIND_VALUES, required: true as const },
    productName: { type: 'string' as const },
    stage: { type: 'string' as const, enum: STAGE_VALUES, required: true as const },
    amount: { type: 'number' as const, required: true as const },
    currency: { type: 'string' as const, required: true as const },
    probability: { type: 'integer' as const, required: true as const },
    expectedCloseAt: isoOptional,
    closedAt: isoOptional,
    closeReason: { type: 'string' as const },
    notes: { type: 'string' as const },
    createdAt: iso,
    updatedAt: iso,
  },
}

/** One task record with the derived overdue flag. */
export const taskWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    clientId: { type: 'string' as const },
    opportunityId: { type: 'string' as const },
    advisorId: { type: 'string' as const, required: true as const },
    kind: { type: 'string' as const, enum: TASK_KIND_VALUES, required: true as const },
    title: { type: 'string' as const, required: true as const },
    dueAt: iso,
    status: { type: 'string' as const, enum: TASK_STATUS_VALUES, required: true as const },
    priority: { type: 'string' as const, enum: PRIORITY_VALUES, required: true as const },
    notes: { type: 'string' as const },
    completedAt: isoOptional,
    overdue: { type: 'boolean' as const, required: true as const },
    createdAt: iso,
    updatedAt: iso,
  },
}

/** One allocation sleeve inside an allocation plan. */
const allocationSleeveSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    name: { type: 'string' as const, required: true as const },
    kind: { type: 'string' as const, enum: PRODUCT_KIND_VALUES, required: true as const },
    targetPercent: { type: 'integer' as const, required: true as const },
  },
}

/** One advisory plan record; exactly one kind payload is present. */
export const planWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    clientId: { type: 'string' as const, required: true as const },
    advisorId: { type: 'string' as const, required: true as const },
    kind: { type: 'string' as const, enum: PLAN_KIND_VALUES, required: true as const },
    status: { type: 'string' as const, enum: PLAN_STATUS_VALUES, required: true as const },
    topics: { type: 'array' as const, items: { type: 'string' as const, enum: TOPIC_VALUES }, required: true as const },
    tolerance: toleranceValue,
    notes: { type: 'string' as const },
    recurring: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        monthlyAmount: { type: 'number' as const, required: true as const },
        deductionDay: { type: 'integer' as const, required: true as const },
        productName: { type: 'string' as const, required: true as const },
        productKind: { type: 'string' as const, enum: PRODUCT_KIND_VALUES, required: true as const },
        endsAt: isoOptional,
      },
    },
    allocation: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        sleeves: { type: 'array' as const, items: allocationSleeveSchema, required: true as const },
        rebalanceBand: { type: 'integer' as const, required: true as const },
      },
    },
    protectionGap: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        annualIncome: { type: 'number' as const, required: true as const },
        incomeYears: { type: 'integer' as const, required: true as const },
        existingLifeCover: { type: 'number' as const, required: true as const },
        recommendedLifeCover: { type: 'number' as const, required: true as const },
        existingCriticalIllnessCover: { type: 'number' as const, required: true as const },
        recommendedCriticalIllnessCover: { type: 'number' as const, required: true as const },
      },
    },
    createdAt: iso,
    updatedAt: iso,
  },
}

/** One plan review value: the plan plus its kind-specific evaluation. */
export const planReviewWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    plan: { ...planWireSchema, required: true as const },
    allocation: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        sleeves: {
          type: 'array' as const,
          required: true as const,
          items: {
            type: 'object' as const,
            additionalProperties: false as const,
            properties: {
              name: { type: 'string' as const, required: true as const },
              targetPercent: { type: 'integer' as const, required: true as const },
              currentPercent: { type: 'integer' as const, required: true as const },
              driftPercent: { type: 'integer' as const, required: true as const },
              breached: { type: 'boolean' as const, required: true as const },
            },
          },
        },
        needsRebalance: { type: 'boolean' as const, required: true as const },
        maxDrift: { type: 'integer' as const, required: true as const },
      },
    },
    monthsElapsed: { type: 'integer' as const },
    investedToDate: { type: 'number' as const },
    protection: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: planWireSchema.properties.protectionGap.properties,
    },
  },
}

/** One advisor record. */
export const advisorWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: { type: 'string' as const, required: true as const },
    name: { type: 'string' as const, required: true as const },
    team: { type: 'string' as const },
    licenseNo: { type: 'string' as const },
    specialties: { type: 'array' as const, items: { type: 'string' as const, enum: TOPIC_VALUES }, required: true as const },
    active: { type: 'boolean' as const, required: true as const },
    createdAt: iso,
    updatedAt: iso,
  },
}

/** One flattened suitability audit entry. */
export const suitabilityAuditWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    clientId: { type: 'string' as const, required: true as const },
    clientName: { type: 'string' as const, required: true as const },
    consultationId: { type: 'string' as const, required: true as const },
    occurredAt: iso,
    product: productDiscussionSchema,
    verdict: { ...verdictValue, required: true as const },
    rationale: { type: 'string' as const, required: true as const },
  },
}

/** One pipeline stage row. */
export const stageSummaryWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    stage: { type: 'string' as const, enum: STAGE_VALUES, required: true as const },
    count: { type: 'integer' as const, required: true as const },
    amount: { type: 'number' as const, required: true as const },
    weighted: { type: 'number' as const, required: true as const },
  },
}

/** One pipeline report value. */
export const pipelineReportWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    advisorId: { type: 'string' as const },
    stages: { type: 'array' as const, items: stageSummaryWireSchema, required: true as const },
    openCount: { type: 'integer' as const, required: true as const },
    openAmount: { type: 'number' as const, required: true as const },
    weightedForecast: { type: 'number' as const, required: true as const },
    wonCount: { type: 'integer' as const, required: true as const },
    wonAmount: { type: 'number' as const, required: true as const },
    lostCount: { type: 'integer' as const, required: true as const },
    winRate: { oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const, required: true as const },
  },
}

/** One book report value. */
export const bookReportWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    advisorId: { type: 'string' as const },
    totalClients: { type: 'integer' as const, required: true as const },
    byLifecycle: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          lifecycle: { type: 'string' as const, enum: LIFECYCLE_VALUES, required: true as const },
          count: { type: 'integer' as const, required: true as const },
        },
      },
    },
    byTolerance: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          tolerance: { ...nullableTolerance, required: true as const },
          count: { type: 'integer' as const, required: true as const },
          aum: { type: 'number' as const, required: true as const },
        },
      },
    },
    totalAum: { type: 'number' as const, required: true as const },
    expiringProfiles: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          clientId: { type: 'string' as const, required: true as const },
          name: { type: 'string' as const, required: true as const },
          expiresAt: iso,
        },
      },
    },
    expiredProfiles: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          clientId: { type: 'string' as const, required: true as const },
          name: { type: 'string' as const, required: true as const },
          expiresAt: iso,
        },
      },
    },
  },
}

/** One task-load report value. */
export const taskLoadReportWireSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    advisorId: { type: 'string' as const },
    at: iso,
    open: { type: 'integer' as const, required: true as const },
    overdue: { type: 'integer' as const, required: true as const },
    byPriority: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          priority: { type: 'string' as const, enum: PRIORITY_VALUES, required: true as const },
          count: { type: 'integer' as const, required: true as const },
        },
      },
    },
    dueSoon: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          id: { type: 'string' as const, required: true as const },
          title: { type: 'string' as const, required: true as const },
          dueAt: iso,
          clientId: { type: 'string' as const },
          priority: { type: 'string' as const, enum: PRIORITY_VALUES, required: true as const },
          overdue: { type: 'boolean' as const, required: true as const },
        },
      },
    },
  },
}
