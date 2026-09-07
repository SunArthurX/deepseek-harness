/**
 * Engagement-facing crm_* tools: advisor roster, interaction log and list,
 * and the suitability-audited consultation record.
 * @module @deepseek-ai/dsh-tool-crm/src/tools-engagement
 */

import type { Context } from '@deepseek-ai/cordis'
import { AdvisorId, ClientId, InteractionId, isBlockingVerdict } from '@deepseek-ai/dsh-crm'
import type { ProductDiscussion } from '@deepseek-ai/dsh-crm/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { advisorWireSchema, consultationWireSchema, interactionWireSchema } from './schemas.ts'
import {
  INTERACTION_KINDS,
  listPreview,
  PRODUCT_KINDS,
  PRODUCT_RISK_DESCRIPTION,
  PRODUCT_RISKS,
  SENTIMENTS,
  TOPICS,
  parseWhen,
  wireAdvisor,
  wireConsultation,
  wireInteraction,
} from './wire.ts'

/** The `{ interaction }` result wrapper shared by log. */
const interactionOutputSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: { interaction: { ...interactionWireSchema, required: true as const } },
} as const

/** Products parameter shared by the consultation tool. */
const PRODUCTS_PARAM = {
  type: 'array',
  description: 'Products discussed, each with its documented risk level R1–R5. Every entry gets a suitability verdict against the client\'s current risk profile.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true, description: 'Product display name.' },
      kind: { type: 'string', required: true, enum: [...PRODUCT_KINDS], description: 'Product category.' },
      riskLevel: { type: 'string', required: true, enum: [...PRODUCT_RISKS], description: PRODUCT_RISK_DESCRIPTION },
    },
  },
} as const

/**
 * Register the engagement tools on `ctx.tools`.
 * @param ctx - Registrant context carrying the tool registry and `ctx.crm`.
 */
export function registerEngagementTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'crm_advisor_list',
    description:
      'List the advisory team. Use it to resolve advisorId values for client assignment, interactions, '
      + 'and tasks.',
    parameters: {
      active: { type: 'boolean', description: 'Restrict to this availability when provided.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          advisors: { type: 'array', items: advisorWireSchema, required: true },
          returned: { type: 'integer', required: true, description: 'Rows in this response.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.advisors.length === 0
          ? 'No advisors registered.'
          : `Advisors: ${listPreview(value.advisors.map(advisor => `${advisor.name} (${advisor.id}${advisor.team === undefined ? '' : `, ${advisor.team}`})`))}.`,
      }],
    },
    execute(args) {
      const advisors = ctx.crm.listAdvisors(args.active)
      return Promise.resolve({ advisors: advisors.map(wireAdvisor), returned: advisors.length })
    },
    presentCall: args => ({ card: 'generic', title: 'List CRM advisors', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_advisor_register',
    description:
      'Register one advisor on the team. A practicing license number, when provided, must be unique.',
    parameters: {
      name: { type: 'string', required: true, description: 'Advisor display name.' },
      team: { type: 'string', description: 'Team name.' },
      licenseNo: { type: 'string', description: 'Practicing license number (执业编号); unique among advisors.' },
      specialties: { type: 'array', items: { type: 'string', enum: [...TOPICS] }, description: 'Advisory topics covered.' },
      active: { type: 'boolean', description: 'Whether the advisor takes new assignments; defaults to true.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { advisor: { ...advisorWireSchema, required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: `Registered advisor ${value.advisor.name} (${value.advisor.id}).`,
      }],
    },
    execute(args) {
      return ctx.crm.registerAdvisor({
        name: args.name,
        ...(args.team === undefined ? {} : { team: args.team }),
        ...(args.licenseNo === undefined ? {} : { licenseNo: args.licenseNo }),
        ...(args.specialties === undefined ? {} : { specialties: args.specialties }),
        ...(args.active === undefined ? {} : { active: args.active }),
      }).then(advisor => ({ advisor: wireAdvisor(advisor) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Register CRM advisor', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_interaction_log',
    description:
      'Log one client touchpoint (call, wechat, meeting, email, report review, or consultation) right '
      + 'after it happens. The advisor defaults to the client\'s owner.',
    parameters: {
      clientId: { type: 'string', required: true, description: 'Client touched.' },
      kind: { type: 'string', enum: [...INTERACTION_KINDS], description: 'Channel; defaults to consultation.' },
      summary: { type: 'string', required: true, description: 'One concise line about what was discussed.' },
      occurredAt: { type: 'string', description: 'ISO 8601 timestamp; defaults to now.' },
      advisorId: { type: 'string', description: 'Handling advisor; defaults to the client\'s owner.' },
      durationMin: { type: 'integer', description: 'Duration in minutes when known.' },
      sentiment: { type: 'string', enum: [...SENTIMENTS], description: 'Recorded client tone.' },
      topics: { type: 'array', items: { type: 'string', enum: [...TOPICS] }, description: 'Advisory topics covered.' },
      nextStep: { type: 'string', description: 'Agreed next step, when one was set.' },
      sessionId: { type: 'string', description: 'Owning harness session when this agent mediated the interaction.' },
    },
    output: {
      schema: interactionOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Logged ${value.interaction.kind} with client ${value.interaction.clientId}: ${value.interaction.summary}`,
      }],
    },
    execute(args) {
      return ctx.crm.logInteraction({
        clientId: ClientId(args.clientId),
        summary: args.summary,
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.occurredAt === undefined ? {} : { occurredAt: parseWhen(args.occurredAt, 'occurredAt') }),
        ...(args.advisorId === undefined ? {} : { advisorId: AdvisorId(args.advisorId) }),
        ...(args.durationMin === undefined ? {} : { durationMin: args.durationMin }),
        ...(args.sentiment === undefined ? {} : { sentiment: args.sentiment }),
        ...(args.topics === undefined ? {} : { topics: args.topics }),
        ...(args.nextStep === undefined ? {} : { nextStep: args.nextStep }),
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      }).then(record => ({ interaction: wireInteraction(record) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Log CRM interaction', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_interaction_list',
    description: 'List client interactions, newest first.',
    parameters: {
      clientId: { type: 'string', description: 'Restrict to one client.' },
      advisorId: { type: 'string', description: 'Restrict to one advisor.' },
      kind: { type: 'string', enum: [...INTERACTION_KINDS], description: 'Restrict to one channel.' },
      topic: { type: 'string', enum: [...TOPICS], description: 'Restrict to interactions covering one advisory topic.' },
      since: { type: 'string', description: 'Only interactions at or after this ISO 8601 timestamp.' },
      limit: { type: 'integer', description: 'Maximum rows (default 20, max 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          interactions: { type: 'array', items: interactionWireSchema, required: true },
          returned: { type: 'integer', required: true, description: 'Rows in this response.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.interactions.length === 0
          ? 'No matching interactions.'
          : `${value.interactions.length} interactions, newest first: ${listPreview(value.interactions.map(record => `${record.occurredAt.slice(0, 10)} ${record.kind} — ${record.summary}`))}.`,
      }],
    },
    execute(args) {
      const records = ctx.crm.listInteractions({
        ...(args.clientId === undefined ? {} : { clientId: ClientId(args.clientId) }),
        ...(args.advisorId === undefined ? {} : { advisorId: AdvisorId(args.advisorId) }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.topic === undefined ? {} : { topic: args.topic }),
        ...(args.since === undefined ? {} : { since: parseWhen(args.since, 'since') }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return Promise.resolve({ interactions: records.map(wireInteraction), returned: records.length })
    },
    presentCall: args => ({ card: 'generic', title: 'List CRM interactions', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_consultation_record',
    description:
      'Record one formal advisory consultation with its suitability audit. Every discussed product is '
      + 'evaluated against the client\'s current risk profile (tolerance level ≥ product risk and '
      + 'unexpired assessment) and the verdict is stored with the record. Record the consultation even '
      + 'when a verdict is unfavorable — the audit trail must be complete; surface blocked verdicts to '
      + 'the client instead of recommending.',
    parameters: {
      clientId: { type: 'string', required: true, description: 'Client advised.' },
      topics: { type: 'array', items: { type: 'string', enum: [...TOPICS] }, description: 'Advisory topics covered.' },
      products: PRODUCTS_PARAM,
      recommendations: { type: 'array', items: { type: 'string' }, description: 'Recommendations given.' },
      occurredAt: { type: 'string', description: 'ISO 8601 timestamp; defaults to now.' },
      advisorId: { type: 'string', description: 'Advising advisor; defaults to the client\'s owner.' },
      interactionId: { type: 'string', description: 'The interaction this consultation extends, when it extends one.' },
      followUpRequired: { type: 'boolean', description: 'Whether a follow-up is required; defaults to false.' },
      summary: { type: 'string', description: 'Free-text summary.' },
      sessionId: { type: 'string', description: 'Owning harness session when this agent mediated the consultation.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          consultation: { ...consultationWireSchema, required: true },
          suitability: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              matched: { type: 'integer', required: true, description: 'Products matching the profile.' },
              blocked: { type: 'integer', required: true, description: 'Products that must not be recommended (exceeds profile, expired, or missing assessment).' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recorded consultation ${value.consultation.id} for client ${value.consultation.clientId}: `
          + `${value.suitability.matched} product(s) matched, ${value.suitability.blocked} blocked. `
          + listPreview(value.consultation.products.map(p => `${p.name}=${p.verdict}`)),
      }],
    },
    execute(args) {
      const products: ProductDiscussion[] = (args.products ?? []).map(product => ({
        name: product.name,
        kind: product.kind,
        riskLevel: product.riskLevel,
      }))
      return ctx.crm.recordConsultation({
        clientId: ClientId(args.clientId),
        ...(args.topics === undefined ? {} : { topics: args.topics }),
        ...(args.recommendations === undefined ? {} : { recommendations: args.recommendations }),
        ...(args.occurredAt === undefined ? {} : { occurredAt: parseWhen(args.occurredAt, 'occurredAt') }),
        ...(args.advisorId === undefined ? {} : { advisorId: AdvisorId(args.advisorId) }),
        ...(args.interactionId === undefined ? {} : { interactionId: InteractionId(args.interactionId) }),
        ...(args.followUpRequired === undefined ? {} : { followUpRequired: args.followUpRequired }),
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        ...(products.length === 0 ? {} : { products }),
      }).then((record) => {
        const blocked = record.products.filter(assessment => isBlockingVerdict(assessment.verdict)).length
        return {
          consultation: wireConsultation(record),
          suitability: { matched: record.products.length - blocked, blocked },
        }
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Record CRM consultation', kind: 'other', rawInput: args }),
  }))
}
