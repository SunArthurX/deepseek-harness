/**
 * Shared test harness for the CRM packages: boots the real storage stack
 * (Storage + memory backend + DomainFacility) and mounts the real
 * {@link CrmService}, exactly the way the product composes them.
 */

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import CrmService from '../../src/index.ts'

export interface CrmHarnessOptions {
  /** Backend to mount; defaults to one over a fresh memory pool. */
  backend?: StorageBackend
  /** Assessment validity in days for the service config; defaults to 730. */
  riskProfileValidityDays?: number
  /** Pool to reuse, for persistence round-trips across harness instances. */
  pool?: MemoryMediaPool
}

export interface CrmHarness {
  ctx: Context
  service: CrmService
  pool: MemoryMediaPool
  /** Dispose the service fiber (HMR/disposal tests). */
  dispose: () => Promise<void>
}

/** Boot the real storage + domain + CRM composition over a memory backend. */
export async function crmHarness(options: CrmHarnessOptions = {}): Promise<CrmHarness> {
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(CrmService, { riskProfileValidityDays: options.riskProfileValidityDays ?? 730 })
  return {
    ctx,
    service: ctx.crm,
    pool,
    dispose: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}
