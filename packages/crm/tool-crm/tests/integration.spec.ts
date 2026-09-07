// Integration boundaries beyond the default memory route: backend routing for
// the crm domain, scoped-report equality against the service snapshots, and
// read-during-write consistency on the serialized mutation chain.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CrmService from '@deepseek-ai/dsh-crm'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { SEED_NOW, seedCrm } from '../../crm/tests/helpers/seed.ts'
import * as ToolCrm from '../src/index.ts'

let ctx: Context | undefined
let counter = 0

/**
 * This spec alone composes custom backend routing, so it boots the stack
 * directly instead of the shared harness's single-backend default.
 */
async function boot(routes: Record<string, string> = {}, pools: Record<string, MemoryMediaPool> = {}): Promise<void> {
  const next = new Context()
  await next.plugin(Storage)
  for (const [name, pool] of Object.entries(pools)) {
    next.storage.backend.register(name, new MemoryStorageBackend(pool))
  }
  const facility = new DomainFacility(next, { backend: 'default', routes })
  next.storage.mount('domain', facility)
  next.provide('storageDomain', facility)
  await next.plugin(CrmService, { riskProfileValidityDays: 730 })
  await next.plugin(SystemPrompt)
  await next.plugin(ToolRuntime)
  await next.plugin(ToolCrm)
  ctx = next
}

beforeEach(async () => {
  vi.useFakeTimers({ now: SEED_NOW })
  const pool = new MemoryMediaPool()
  await boot({}, { default: pool })
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function call(name: string, args: unknown) {
  const result = await ctx!.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`int-${++counter}`),
    name,
    arguments: args,
  })
  return { isError: result.isError, value: result.isError ? undefined : result.value }
}

describe('storage backend routing', () => {
  it('routes the crm domain to a named backend and survives a reopen on it', async () => {
    const pools = { default: new MemoryMediaPool(), crmstore: new MemoryMediaPool() }
    await ctx!.fiber.dispose()
    ctx = undefined
    await boot({ crm: 'crmstore' }, pools)
    const advisor = await ctx!.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx!.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    // The routed backend, not the default one, materialized the crm unit.
    expect([...pools.crmstore.media.keys()]).toContain('crm')
    expect([...pools.default.media.keys()]).not.toContain('crm')
    await ctx!.fiber.dispose()
    ctx = undefined
    await boot({ crm: 'crmstore' }, pools)
    expect(ctx!.crm.getClient(client.id)?.name).toBe('王建国')
  })
})

describe('scoped reports', () => {
  it('answers an advisor-scoped pipeline report equal to the scoped snapshot', async () => {
    const seeded = await seedCrm(ctx!.crm, ms => vi.setSystemTime(ms))
    const advisor = seeded.advisors[0]
    if (advisor === undefined) throw new Error('seed advisor missing')
    const report = await call('crm_report', { kind: 'pipeline', advisorId: advisor.id })
    expect(report.isError).toBe(false)
    const pipeline = (report.value as { pipeline: Record<string, number> }).pipeline
    const snapshot = ctx!.crm.pipelineSnapshot(advisor.id)
    expect(pipeline).toMatchObject({
      openCount: snapshot.openCount,
      wonCount: snapshot.wonCount,
      lostCount: snapshot.lostCount,
    })
    expect(pipeline.openCount).toBeLessThan(ctx!.crm.pipelineSnapshot().openCount)
  })
})

describe('read-during-write consistency', () => {
  it('serves coherent books while concurrent mutations land', async () => {
    const seeded = await seedCrm(ctx!.crm, ms => vi.setSystemTime(ms))
    const advisor = seeded.advisors[0]
    if (advisor === undefined) throw new Error('seed advisor missing')
    const writes = Array.from({ length: 10 }, (_, i) =>
      ctx!.crm.createClient({ name: `写入客户${String(i)}`, kind: 'individual', advisorId: advisor.id }))
    const reads = Array.from({ length: 10 }, () => Promise.resolve(ctx!.crm.bookSnapshot(advisor.id)))
    const [written, books] = await Promise.all([Promise.all(writes), Promise.all(reads)] as const)
    expect(written).toHaveLength(10)
    for (const book of books) {
      // Every observed book is internally consistent: the client count never
      // exceeds the final state and the lifecycle rows always sum to it.
      const sum = book.byLifecycle.reduce((total, row) => total + row.count, 0)
      expect(sum).toBe(book.totalClients)
      expect(book.totalClients).toBeLessThanOrEqual(ctx!.crm.bookSnapshot(advisor.id).totalClients)
    }
  })
})
