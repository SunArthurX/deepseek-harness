/**
 * Client-facing crm_* tools: create, search, 360° read, and patch.
 * @module @deepseek-ai/dsh-tool-crm/src/tools-client
 */

import type { Context } from '@deepseek-ai/cordis'
import { ClientId } from '@deepseek-ai/dsh-crm'
import type { AdvisorId, ClientPatch, ContactInfo, FinancialProfile } from '@deepseek-ai/dsh-crm/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  clientSummaryWireSchema,
  clientWireSchema,
  consultationWireSchema,
  interactionWireSchema,
  opportunityWireSchema,
  taskWireSchema,
} from './schemas.ts'
import {
  LIFECYCLES,
  listPreview,
  TOLERANCE_DESCRIPTION,
  TOLERANCES,
  wireClient,
  wireClientSummary,
  wireConsultation,
  wireInteraction,
  wireOpportunity,
  wireTask,
} from './wire.ts'

/** Contact fields a tool accepts as flat parameters. */
interface ContactParams {
  readonly phone?: string
  readonly email?: string
  readonly wechat?: string
  readonly region?: string
}

/** Financial fields a tool accepts as flat parameters. */
interface FinancialParams {
  readonly annualIncome?: number
  readonly liquidAssets?: number
  readonly totalAum?: number
  readonly currency?: string
}

/** The `{ client }` result wrapper shared by create, get, and update. */
const clientOutputSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: { client: { ...clientWireSchema, required: true as const } },
} as const

/** Shared contact parameters; all optional. */
const CONTACT_PARAMS = {
  phone: { type: 'string', description: 'Mobile phone number.' },
  email: { type: 'string', description: 'Email address.' },
  wechat: { type: 'string', description: 'WeChat handle.' },
  region: { type: 'string', description: 'Region or city.' },
} as const

/** Shared financial parameters; all optional. */
const FINANCIAL_PARAMS = {
  annualIncome: { type: 'number', description: 'Annual income in the book currency.' },
  liquidAssets: { type: 'number', description: 'Liquid assets in the book currency.' },
  totalAum: { type: 'number', description: 'Assets under management this client brings.' },
  currency: { type: 'string', description: 'ISO 4217 upper-case code of the monetary fields (default CNY).' },
} as const

/** Whether any contact parameter is present. */
function hasContactArgs(args: ContactParams): boolean {
  return args.phone !== undefined || args.email !== undefined || args.wechat !== undefined || args.region !== undefined
}

/** Whether any financial parameter is present. */
function hasFinancialArgs(args: FinancialParams): boolean {
  return args.totalAum !== undefined || args.annualIncome !== undefined
    || args.liquidAssets !== undefined || args.currency !== undefined
}

/** Collect the provided contact fields over `base`; undefined when neither has any. */
function pickContact(args: ContactParams, base?: ContactInfo): ContactInfo | undefined {
  const contact: ContactInfo = {
    ...(base?.phone === undefined ? {} : { phone: base.phone }),
    ...(base?.email === undefined ? {} : { email: base.email }),
    ...(base?.wechat === undefined ? {} : { wechat: base.wechat }),
    ...(base?.region === undefined ? {} : { region: base.region }),
    ...(args.phone === undefined ? {} : { phone: args.phone }),
    ...(args.email === undefined ? {} : { email: args.email }),
    ...(args.wechat === undefined ? {} : { wechat: args.wechat }),
    ...(args.region === undefined ? {} : { region: args.region }),
  }
  return Object.keys(contact).length > 0 ? contact : undefined
}

/** Collect the provided financial fields over `base`; undefined when nothing changed. */
function pickFinancial(args: FinancialParams, base?: FinancialProfile): FinancialProfile | undefined {
  const given = args.totalAum !== undefined || args.annualIncome !== undefined
    || args.liquidAssets !== undefined || args.currency !== undefined
  if (!given && base === undefined) return undefined
  const merged: FinancialProfile = base ?? { totalAum: 0, currency: 'CNY' }
  const annualIncome = args.annualIncome ?? merged.annualIncome
  const liquidAssets = args.liquidAssets ?? merged.liquidAssets
  const hasAnnualIncome = annualIncome !== undefined
  const hasLiquidAssets = liquidAssets !== undefined
  return {
    totalAum: args.totalAum ?? merged.totalAum,
    ...(hasAnnualIncome ? { annualIncome } : {}),
    ...(hasLiquidAssets ? { liquidAssets } : {}),
    currency: args.currency ?? merged.currency,
  }
}

/**
 * Register the four client tools on `ctx.tools`.
 * @param ctx - Registrant context carrying the tool registry and `ctx.crm`.
 */
export function registerClientTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'crm_client_create',
    description:
      'Create one client record in the advisory CRM. Use after intake (form, referral, first contact) '
      + 'before any interaction, consultation, or opportunity can reference the client.',
    parameters: {
      name: { type: 'string', required: true, description: 'Client display name — an individual or an institution name.' },
      kind: { type: 'string', required: true, enum: ['individual', 'institution'], description: 'Retail individual or institutional client.' },
      lifecycle: { type: 'string', enum: [...LIFECYCLES], description: 'Funnel stage; defaults to lead.' },
      advisorId: { type: 'string', description: 'Owning advisor id (see crm_advisor_list).' },
      tolerance: { type: 'string', enum: [...TOLERANCES], description: `${TOLERANCE_DESCRIPTION} Provide when intake completed the questionnaire; the assessment expires after the configured validity.` },
      score: { type: 'integer', description: 'Questionnaire score 1–100 recorded with the first assessment.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Segmentation tags, e.g. 高净值, 基金定投, 转介绍.' },
      notes: { type: 'string', description: 'Free-text notes.' },
      ...CONTACT_PARAMS,
      ...FINANCIAL_PARAMS,
    },
    output: {
      schema: clientOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Created client ${value.client.name} (${value.client.id}, ${value.client.lifecycle}${value.client.riskProfile === undefined ? '' : `, ${value.client.riskProfile.tolerance}`}).`,
      }],
    },
    execute(args) {
      const contact = pickContact(args)
      const financial = pickFinancial(args)
      return ctx.crm.createClient({
        name: args.name,
        kind: args.kind,
        ...(args.lifecycle === undefined ? {} : { lifecycle: args.lifecycle }),
        ...(args.advisorId === undefined ? {} : { advisorId: args.advisorId as AdvisorId }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(contact === undefined ? {} : { contact }),
        ...(financial === undefined ? {} : { financial }),
        ...(args.tolerance === undefined ? {} : {
          riskProfile: { tolerance: args.tolerance, ...(args.score === undefined ? {} : { score: args.score }) },
        }),
      }).then(client => ({ client: wireClient(client, Date.now()) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Create CRM client', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_client_search',
    description:
      'Search the client book. Filters combine with AND; the free-text query matches name, tags, and '
      + 'contact fields case-insensitively. Use before any client-addressed action to resolve a clientId.',
    parameters: {
      query: { type: 'string', description: 'Free-text match against name, tags, phone, email, wechat, region.' },
      kind: { type: 'string', enum: ['individual', 'institution'], description: 'Exact individual/institution filter.' },
      lifecycle: { type: 'string', enum: [...LIFECYCLES], description: 'Exact lifecycle filter.' },
      tolerance: { type: 'string', enum: [...TOLERANCES], description: TOLERANCE_DESCRIPTION },
      advisorId: { type: 'string', description: 'Exact owning-advisor filter.' },
      tag: { type: 'string', description: 'Exact tag filter.' },
      limit: { type: 'integer', description: 'Maximum rows (default 20, max 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clients: { type: 'array', items: clientSummaryWireSchema, required: true },
          returned: { type: 'integer', required: true, description: 'Rows in this response.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.clients.length === 0
          ? 'No matching clients.'
          : `Found ${value.clients.length} clients: ${listPreview(value.clients.map(row => `${row.name} (${row.id}, ${row.lifecycle})`))}.`,
      }],
    },
    execute(args) {
      const rows = ctx.crm.searchClients({
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.lifecycle === undefined ? {} : { lifecycle: args.lifecycle }),
        ...(args.tolerance === undefined ? {} : { tolerance: args.tolerance }),
        ...(args.advisorId === undefined ? {} : { advisorId: args.advisorId as AdvisorId }),
        ...(args.tag === undefined ? {} : { tag: args.tag }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return Promise.resolve({ clients: rows.map(wireClientSummary), returned: rows.length })
    },
    presentCall: args => ({ card: 'generic', title: 'Search CRM clients', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_client_get',
    description:
      'Read the full 360° view of one client: profile, last 10 interactions, the 10 soonest-due open '
      + 'tasks, live and recently-won opportunities, last 10 consultations, and risk-assessment '
      + 'validity. Use it to prepare before any client conversation.',
    parameters: {
      clientId: { type: 'string', required: true, description: 'Client id from crm_client_search or crm_client_create.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          client: { ...clientWireSchema, required: true },
          interactions: { type: 'array', items: interactionWireSchema, required: true },
          openTasks: { type: 'array', items: taskWireSchema, required: true },
          opportunities: { type: 'array', items: opportunityWireSchema, required: true },
          consultations: { type: 'array', items: consultationWireSchema, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Client ${value.client.name} (${value.client.lifecycle}, profile ${value.client.profileStatus}): `
          + `${value.interactions.length} recent interactions, ${value.openTasks.length} open tasks, `
          + `${value.opportunities.length} opportunities, ${value.consultations.length} consultations.`,
      }],
    },
    execute(args) {
      const book = ctx.crm.clientBook(ClientId(args.clientId))
      const now = Date.now()
      return Promise.resolve({
        client: wireClient(book.client, now),
        interactions: book.interactions.map(record => wireInteraction(record)),
        openTasks: book.openTasks.map(record => wireTask(record, now)),
        opportunities: book.opportunities.map(record => wireOpportunity(record)),
        consultations: book.consultations.map(record => wireConsultation(record)),
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Read CRM client 360°', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_client_update',
    description:
      'Patch one client record: absent fields keep their values. Supplying tolerance re-runs the risk '
      + 'assessment now and restarts its validity window; contact and financial fields merge over the '
      + 'stored values.',
    parameters: {
      clientId: { type: 'string', required: true, description: 'Client to update.' },
      name: { type: 'string', description: 'New display name.' },
      lifecycle: { type: 'string', enum: [...LIFECYCLES], description: 'New funnel stage.' },
      advisorId: { type: 'string', description: 'New owning advisor id.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag set.' },
      notes: { type: 'string', description: 'Replacement free-text notes.' },
      tolerance: { type: 'string', enum: [...TOLERANCES], description: `${TOLERANCE_DESCRIPTION} Supplying it re-assesses the client now.` },
      score: { type: 'integer', description: 'Questionnaire score 1–100 recorded with the re-assessment.' },
      ...CONTACT_PARAMS,
      ...FINANCIAL_PARAMS,
    },
    output: {
      schema: clientOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Updated client ${value.client.name} (${value.client.id}); profile ${value.client.profileStatus}.`,
      }],
    },
    execute(args) {
      const current = ctx.crm.getClient(ClientId(args.clientId))
      if (current === undefined) {
        return Promise.reject(new Error(`unknown CRM client '${args.clientId}'`))
      }
      // With neither a stored value nor any new field there is nothing to
      // merge; skip building (and re-putting) identical objects.
      const contact = hasContactArgs(args) || current.contact !== undefined ? pickContact(args, current.contact) : undefined
      const financial = hasFinancialArgs(args) || current.financial !== undefined ? pickFinancial(args, current.financial) : undefined
      const patch: ClientPatch = {
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.lifecycle === undefined ? {} : { lifecycle: args.lifecycle }),
        ...(args.advisorId === undefined ? {} : { advisorId: args.advisorId as AdvisorId }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(contact === undefined ? {} : { contact }),
        ...(financial === undefined ? {} : { financial }),
        ...(args.tolerance === undefined ? {} : {
          riskProfile: { tolerance: args.tolerance, ...(args.score === undefined ? {} : { score: args.score }) },
        }),
      }
      return ctx.crm.updateClient(ClientId(args.clientId), patch)
        .then(client => ({ client: wireClient(client, Date.now()) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Update CRM client', kind: 'edit', rawInput: args }),
  }))
}
