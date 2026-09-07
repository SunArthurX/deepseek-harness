import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { AdvisorId, ClientId, OpportunityId } from '../src/index.ts'
import * as CrmInvariant from '../src/invariant.ts'
import type { AdvisorRecord, ClientRecord, OpportunityRecord } from '../src/types.ts'

const advisor = { id: AdvisorId('a1') } as AdvisorRecord
const client = { id: ClientId('c1') } as ClientRecord
const deal = { id: OpportunityId('o1') } as OpportunityRecord

/** Boot the invariant service plus the companion over a stubbed `ctx.crm`. */
async function setup(knowledge: { clients?: string[]; advisors?: string[]; opportunities?: string[] }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  ctx.provide('crm', {
    getClient: (id: string) => knowledge.clients?.includes(id) ? client : undefined,
    getAdvisor: (id: string) => knowledge.advisors?.includes(id) ? advisor : undefined,
    getOpportunity: (id: string) => knowledge.opportunities?.includes(id) ? deal : undefined,
  })
  await ctx.plugin(CrmInvariant)
  return ctx
}

const put = (table: string, key: string, value: unknown): DomainChanged => ({
  domain: 'crm',
  table,
  key,
  operation: 'put',
  value,
})

describe('crm referential-integrity invariant', () => {
  it('accepts rows whose references the service tables hold', async () => {
    const ctx = await setup({ clients: ['c1'], advisors: ['a1'], opportunities: ['o1'] })
    expect(() => {
      ctx.emit('domain/changed', put('clients', 'c1', { id: 'c1', advisorId: 'a1' }))
      ctx.emit('domain/changed', put('interactions', 'i1', { clientId: 'c1', advisorId: 'a1' }))
      ctx.emit('domain/changed', put('consultations', 'k1', { clientId: 'c1', advisorId: 'a1' }))
      ctx.emit('domain/changed', put('opportunities', 'o1', { clientId: 'c1', advisorId: 'a1' }))
      ctx.emit('domain/changed', put('tasks', 't1', {
        advisorId: 'a1',
        clientId: 'c1',
        opportunityId: 'o1',
      }))
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('ignores foreign domains, foreign tables, and deletions', async () => {
    const ctx = await setup({})
    expect(() => {
      ctx.emit('domain/changed', { ...put('clients', 'x', {}), domain: 'workspace' })
      ctx.emit('domain/changed', put('unknown-table', 'x', {}))
      ctx.emit('domain/changed', { domain: 'crm', table: 'clients', key: 'c1', operation: 'deleted' })
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('fails a client row naming an unknown advisor', async () => {
    const ctx = await setup({})
    expect(() => {
      ctx.emit('domain/changed', put('clients', 'c1', { advisorId: 'aX' }))
    }).toThrow(/unknown advisor 'aX'/)
    await ctx.fiber.dispose()
  })

  it('fails interaction, consultation, and opportunity rows with unknown references', async () => {
    const ctx = await setup({ advisors: ['a1'], clients: ['c1'] })
    expect(() => {
      ctx.emit('domain/changed', put('interactions', 'i1', { clientId: 'cX', advisorId: 'a1' }))
    }).toThrow(/unknown client 'cX'/)
    expect(() => {
      ctx.emit('domain/changed', put('interactions', 'i1', { clientId: 'c1', advisorId: 'aX' }))
    }).toThrow(/unknown advisor 'aX'/)
    expect(() => {
      ctx.emit('domain/changed', put('consultations', 'k1', { clientId: 'cX', advisorId: 'a1' }))
    }).toThrow(/unknown client 'cX'/)
    expect(() => {
      ctx.emit('domain/changed', put('consultations', 'k1', { clientId: 'c1', advisorId: 'aX' }))
    }).toThrow(/unknown advisor 'aX'/)
    expect(() => {
      ctx.emit('domain/changed', put('opportunities', 'o1', { clientId: 'cX', advisorId: 'a1' }))
    }).toThrow(/unknown client 'cX'/)
    expect(() => {
      ctx.emit('domain/changed', put('opportunities', 'o1', { clientId: 'c1', advisorId: 'aX' }))
    }).toThrow(/unknown advisor 'aX'/)
    await ctx.fiber.dispose()
  })

  it('fails task rows with unknown client, advisor, or opportunity references', async () => {
    const ctx = await setup({ advisors: ['a1'], clients: ['c1'], opportunities: ['o1'] })
    expect(() => {
      ctx.emit('domain/changed', put('tasks', 't1', { advisorId: 'a1', clientId: 'cX' }))
    }).toThrow(/unknown client 'cX'/)
    expect(() => {
      ctx.emit('domain/changed', put('tasks', 't1', { advisorId: 'aX' }))
    }).toThrow(/unknown advisor 'aX'/)
    expect(() => {
      ctx.emit('domain/changed', put('tasks', 't1', { advisorId: 'a1', opportunityId: 'oX' }))
    }).toThrow(/unknown opportunity 'oX'/)
    await ctx.fiber.dispose()
  })
})
