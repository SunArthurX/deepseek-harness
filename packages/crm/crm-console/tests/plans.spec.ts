// Console HTTP + page content for the advisory-plan endpoints, booted via the
// real Loader (which awaits service init so the port is bound before tests run).
import { chromium, type Browser, type Page } from 'playwright'
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
import WebServer from '@deepseek-ai/dsh-host-webserver'
import CrmService from '@deepseek-ai/dsh-crm'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as CrmConsole from '../src/index.ts'

let ctx: Context | undefined
let browser: Browser | undefined
let page: Page | undefined
let base: string | undefined
let root: string | undefined

beforeEach(async () => {
  vi.useRealTimers()
  vi.setSystemTime(Date.UTC(2026, 8, 7, 9))
  const next = new Context()
  await next.plugin(Storage)
  next.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(next, { backend: 'memory', routes: {} })
  next.storage.mount('domain', facility)
  next.provide('storageDomain', facility)

  root = await mkdtemp(join(tmpdir(), 'dsh-plans-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-crm'",
    '  config:',
    '    riskProfileValidityDays: 730',
    "- name: '@deepseek-ai/dsh-crm-console'",
    '',
  ].join('\n'))

  next.baseUrl = pathToFileURL(root).href + '/'
  await next.plugin(Loader)
  next.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-crm', CrmService],
    ['@deepseek-ai/dsh-crm-console', CrmConsole],
  ])
  next.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof next.loader.internal>
  await next.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await next.loader.await()
  ctx = next
  base = `http://127.0.0.1:${String(next.webServer.port)}`
  browser = await chromium.launch()
  page = await browser.newPage()
  await page.goto(`${base}/crm-console`)
  await page.waitForSelector('#overview .cards > .card')
}, 120_000)

afterEach(async () => {
  vi.useRealTimers()
  await browser?.close()
  page = undefined
  browser = undefined
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  base = undefined
}, 60_000)

interface Json { [key: string]: unknown }

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { status: response.status, json: await response.json() as Json }
}

describe('advisory-plan console API', () => {
  it('creates all three plan kinds and lists them per client', async () => {
    const advisor = await send('POST', '/crm-console/api/advisors', { name: '张伟明' })
    const advisorId = (advisor.json as { id: string }).id
    const client = await send('POST', '/crm-console/api/clients', {
      name: '王建国', kind: 'individual', advisorId,
    })
    const clientId = (client.json as { id: string }).id

    const recurring = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'recurring-investment', tolerance: 'C3',
      monthlyAmount: 5_000, deductionDay: 15, productName: '中证红利低波ETF联接A',
    })
    expect(recurring.status).toBe(200)
    expect((recurring.json as { recurring: { monthlyAmount: number } }).recurring.monthlyAmount).toBe(5_000)

    const allocation = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'allocation',
      sleevesJson: JSON.stringify([
        { name: '固收', kind: 'fund', targetPercent: 60 },
        { name: '权益', kind: 'fund', targetPercent: 30 },
        { name: '现金', kind: 'fund', targetPercent: 10 },
      ]),
      rebalanceBand: 5,
    })
    expect((allocation.json as { allocation: { sleeves: unknown[] } }).allocation.sleeves).toHaveLength(3)

    const protection = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'protection-gap',
      annualIncome: 500_000, incomeYears: 10,
      existingLifeCover: 1_000_000, existingCriticalIllnessCover: 200_000,
    })
    expect((protection.json as { protectionGap: { recommendedLifeCover: number } }).protectionGap.recommendedLifeCover)
      .toBe(4_000_000)

    const listed = await send('GET', `/crm-console/api/plans?clientId=${clientId}`)
    expect(listed.json as unknown as unknown[]).toHaveLength(3)
  })

  it('transitions status and reviews the plan over HTTP', async () => {
    const advisor = await send('POST', '/crm-console/api/advisors', { name: '张伟明' })
    const advisorId = (advisor.json as { id: string }).id
    const client = await send('POST', '/crm-console/api/clients', { name: '王建国', kind: 'individual', advisorId })
    const clientId = (client.json as { id: string }).id
    const plan = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'allocation',
      sleevesJson: JSON.stringify([
        { name: '固收', kind: 'fund', targetPercent: 60 },
        { name: '权益', kind: 'fund', targetPercent: 40 },
      ]),
      rebalanceBand: 5,
    })
    const planId = (plan.json as { id: string }).id
    const activated = await send('POST', '/crm-console/api/plans-transition', { planId, to: 'active' })
    expect((activated.json as { status: string }).status).toBe('active')
    const review = await send('GET',
      `/crm-console/api/plans-review?planId=${planId}&currentValues=${encodeURIComponent(JSON.stringify({ 固收: 70, 权益: 30 }))}`)
    expect((review.json as { allocation: { needsRebalance: boolean } }).allocation.needsRebalance).toBe(true)
    const illegal = await send('POST', '/crm-console/api/plans-transition', { planId, to: 'draft' })
    expect(illegal.status).toBe(400)
  })

  it('rejects bad payloads with precise messages', async () => {
    const advisor = await send('POST', '/crm-console/api/advisors', { name: '张伟明' })
    const advisorId = (advisor.json as { id: string }).id
    const client = await send('POST', '/crm-console/api/clients', { name: '王建国', kind: 'individual', advisorId })
    const clientId = (client.json as { id: string }).id
    const badSleeves = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'allocation', sleevesJson: 'not-json', rebalanceBand: 5,
    })
    expect(badSleeves.status).toBe(400)
    const badKind = await send('POST', '/crm-console/api/plans', { clientId, kind: 'magic' })
    expect(badKind.status).toBe(400)
    const missing = await send('GET', '/crm-console/api/plans-review?planId=ghost')
    expect(missing.status).toBe(400)
    expect((missing.json as { error: string }).error).toContain('ghost')
  })

  it('accepts every optional field and derives the recurring defaults', async () => {
    const advisor = await send('POST', '/crm-console/api/advisors', { name: '张伟明' })
    const advisorId = (advisor.json as { id: string }).id
    const otherAdvisor = await send('POST', '/crm-console/api/advisors', { name: '林晓芳' })
    const otherId = (otherAdvisor.json as { id: string }).id
    const client = await send('POST', '/crm-console/api/clients', { name: '王建国', kind: 'individual', advisorId })
    const clientId = (client.json as { id: string }).id

    const full = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'recurring-investment', advisorId: otherId, tolerance: 'C4',
      notes: '养老定投', topics: ['retirement'],
      monthlyAmount: 1_500, deductionDay: 20,
    })
    expect(full.status).toBe(200)
    const fullPlan = full.json as {
      recurring: { productName: string }
      tolerance: string
      advisorId: string
      notes: string
      topics: string[]
    }
    expect(fullPlan.recurring.productName).toBe('稳健添利债券基金C')
    expect(fullPlan.tolerance).toBe('C4')
    expect(fullPlan.advisorId).toBe(otherId)
    expect(fullPlan.notes).toBe('养老定投')
    expect(fullPlan.topics).toEqual(['retirement'])

    const bareProtection = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'protection-gap', annualIncome: 120_000, incomeYears: 6,
    })
    expect(bareProtection.status).toBe(200)
    const bareGap = (bareProtection.json as { protectionGap: { existingLifeCover: number; recommendedLifeCover: number } }).protectionGap
    expect(bareGap.existingLifeCover).toBe(0)
    expect(bareGap.recommendedLifeCover).toBe(720_000)

    const unfiltered = await send('GET', '/crm-console/api/plans')
    expect((unfiltered.json as unknown as unknown[]).length).toBeGreaterThanOrEqual(1)
  })

  it('rejects incomplete payloads for every plan kind with a 400', async () => {
    const advisor = await send('POST', '/crm-console/api/advisors', { name: '张伟明' })
    const advisorId = (advisor.json as { id: string }).id
    const client = await send('POST', '/crm-console/api/clients', { name: '王建国', kind: 'individual', advisorId })
    const clientId = (client.json as { id: string }).id

    const noAmount = await send('POST', '/crm-console/api/plans', { clientId, kind: 'recurring-investment', deductionDay: 15 })
    expect(noAmount.status).toBe(400)
    expect((noAmount.json as { error: string }).error).toContain('missing recurring fields')

    const badDay = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'recurring-investment', monthlyAmount: 100, deductionDay: 29,
    })
    expect(badDay.status).toBe(400)
    expect((badDay.json as { error: string }).error).toContain('deductionDay must be an integer 1–28')

    const noSleeves = await send('POST', '/crm-console/api/plans', { clientId, kind: 'allocation', rebalanceBand: 5 })
    expect(noSleeves.status).toBe(400)
    expect((noSleeves.json as { error: string }).error).toContain('sleevesJson')

    const notArray = await send('POST', '/crm-console/api/plans', { clientId, kind: 'allocation', sleevesJson: '{"a":1}', rebalanceBand: 5 })
    expect(notArray.status).toBe(400)
    expect((notArray.json as { error: string }).error).toContain('must be an array')

    const noBand = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'allocation', sleevesJson: JSON.stringify([{ targetPercent: 100 }]),
    })
    expect(noBand.status).toBe(200)
    const defaulted = noBand.json as {
      allocation: { sleeves: { name: string; kind: string; targetPercent: number }[]; rebalanceBand: number }
    }
    expect(defaulted.allocation.sleeves[0]).toEqual({ name: '', kind: 'fund', targetPercent: 100 })
    expect(defaulted.allocation.rebalanceBand).toBe(5)

    const noIncome = await send('POST', '/crm-console/api/plans', { clientId, kind: 'protection-gap', incomeYears: 5 })
    expect(noIncome.status).toBe(400)
    expect((noIncome.json as { error: string }).error).toContain('missing protection-gap fields')

    const noYears = await send('POST', '/crm-console/api/plans', { clientId, kind: 'protection-gap', annualIncome: 100_000 })
    expect(noYears.status).toBe(400)

    const zeroSleeve = await send('POST', '/crm-console/api/plans', {
      clientId, kind: 'allocation', sleevesJson: JSON.stringify([{ name: '固收', kind: 'fund' }]), rebalanceBand: 5,
    })
    expect(zeroSleeve.status).toBe(400)
    expect((zeroSleeve.json as { error: string }).error).toContain('must sum to 100')

    const noPlanId = await send('GET', '/crm-console/api/plans-review')
    expect(noPlanId.status).toBe(400)
    expect((noPlanId.json as { error: string }).error).toContain("missing field 'planId'")

    const viaGet = await send('GET', '/crm-console/api/plans-transition?planId=x&to=active')
    expect(viaGet.status).toBe(400)
    expect((viaGet.json as { error: string }).error).toContain('requires POST')
  })

  it('carries the 方案 view in the page', async () => {
    const html = await (await fetch(`${base}/crm-console`)).text()
    expect(html).toContain('定投计划')
    expect(html).toContain('资产配置')
    expect(html).toContain('保障缺口')
    expect(html).toContain('plans-transition')
  })
})
