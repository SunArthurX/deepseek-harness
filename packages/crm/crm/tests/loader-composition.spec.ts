// Proves the CRM service loads through the real Loader from a cordis.yml:
// the required validity policy is real configurability driving the expiry
// the service derives, and a missing policy fails the load. The storage
// stack assembles directly on the test context; the Loader path under test
// is the CRM service entry itself.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import CrmService from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 8, 1) })
})

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the CRM service under the given config lines.
 * @param configLines - YAML lines nested under the service's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-crm-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-crm'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-crm', CrmService]])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('crm real Loader composition through cordis.yml', () => {
  it('derives the assessment window from the configured validity', async () => {
    const ctx = await boot(['    riskProfileValidityDays: 365'])
    const advisor = await ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await ctx.crm.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C3' },
    })
    const profile = client.riskProfile
    if (profile === undefined) throw new Error('expected an assessment window')
    expect(profile.expiresAt - profile.assessedAt).toBe(365 * 86_400_000)
  }, 30_000)

  it('fails loading without the required validity policy', async () => {
    await expect(boot([])).rejects.toThrow(/riskProfileValidityDays/)
  }, 30_000)
})
