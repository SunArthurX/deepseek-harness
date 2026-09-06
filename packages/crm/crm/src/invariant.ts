/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-crm`: asserts the
 * durable domain's cross-table referential integrity. Every landed
 * advisor-scoped row must reference an existing client and advisor, every
 * task's optional opportunity must exist (and, when the task also names a
 * client, belong to it), and a landed client's advisor must exist. The
 * service validates the same rules inside each mutation; this companion
 * catches a row that reaches the medium by any other path.
 * @module @deepseek-ai/dsh-crm/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {
  AdvisorRecord,
  ClientRecord,
  ConsultationRecord,
  InteractionRecord,
  OpportunityRecord,
  TaskRecord,
} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-crm'

/** Cordis companion plugin name. */
export const name = 'crm-invariant'
/** Service required before the companion can read the authoritative tables. */
export const inject = ['invariants']

/** The service-surface slice the companion reads; `ctx.crm` satisfies it structurally. */
interface CrmLookup {
  crm: {
    getClient(id: string): ClientRecord | undefined
    getAdvisor(id: string): AdvisorRecord | undefined
    getOpportunity(id: string): OpportunityRecord | undefined
  }
}

/** Assert one landed row against the authoritative client/advisor/opportunity tables. */
function validateChange(change: DomainChanged, ctx: CrmLookup, fail: InvariantFailure): void {
  if (change.domain !== 'crm') return
  const value = change.operation === 'put' ? change.value : undefined
  if (value === undefined) return
  switch (change.table) {
    case 'clients': {
      const client = value as ClientRecord
      if (client.advisorId !== undefined && ctx.crm.getAdvisor(client.advisorId) === undefined) {
        fail(`crm clients row '${change.key}' references unknown advisor '${client.advisorId}'`)
      }
      break
    }
    case 'interactions': {
      const record = value as InteractionRecord
      if (ctx.crm.getClient(record.clientId) === undefined) {
        fail(`crm interactions row '${change.key}' references unknown client '${record.clientId}'`)
      }
      if (ctx.crm.getAdvisor(record.advisorId) === undefined) {
        fail(`crm interactions row '${change.key}' references unknown advisor '${record.advisorId}'`)
      }
      break
    }
    case 'consultations': {
      const record = value as ConsultationRecord
      if (ctx.crm.getClient(record.clientId) === undefined) {
        fail(`crm consultations row '${change.key}' references unknown client '${record.clientId}'`)
      }
      if (ctx.crm.getAdvisor(record.advisorId) === undefined) {
        fail(`crm consultations row '${change.key}' references unknown advisor '${record.advisorId}'`)
      }
      break
    }
    case 'opportunities': {
      const record = value as OpportunityRecord
      if (ctx.crm.getClient(record.clientId) === undefined) {
        fail(`crm opportunities row '${change.key}' references unknown client '${record.clientId}'`)
      }
      if (ctx.crm.getAdvisor(record.advisorId) === undefined) {
        fail(`crm opportunities row '${change.key}' references unknown advisor '${record.advisorId}'`)
      }
      break
    }
    case 'tasks': {
      const record = value as TaskRecord
      if (record.clientId !== undefined && ctx.crm.getClient(record.clientId) === undefined) {
        fail(`crm tasks row '${change.key}' references unknown client '${record.clientId}'`)
      }
      if (ctx.crm.getAdvisor(record.advisorId) === undefined) {
        fail(`crm tasks row '${change.key}' references unknown advisor '${record.advisorId}'`)
      }
      if (record.opportunityId !== undefined && ctx.crm.getOpportunity(record.opportunityId) === undefined) {
        fail(`crm tasks row '${change.key}' references unknown opportunity '${record.opportunityId}'`)
      }
      break
    }
    default:
      break
  }
}

/** Install validation over every landed CRM domain change. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('domain/changed', (change: DomainChanged) => {
    validateChange(change, ctx, fail)
  }, { global: true })
}, { inject: ['crm'] })

/**
 * Register the CRM invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
