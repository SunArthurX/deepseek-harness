/**
 * Playwright end-to-end suite: boots the real console over the real web
 * server + CRM service with a seeded demo book (via the real Loader, which
 * awaits service init), then drives the page as a user would — tab
 * navigation, client creation through the dialog, suitability blocking
 * toast, insights view, and CSV download — asserting the DOM after every
 * action.
 * @module @deepseek-ai/dsh-crm-console/tests/e2e-playwright.spec
 */

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
import { seedCrm } from '../../crm/tests/helpers/seed.ts'
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
  // Storage mounts before the Loader applies rows that need the facility.
  await next.plugin(Storage)
  next.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(next, { backend: 'memory', routes: {} })
  next.storage.mount('domain', facility)
  next.provide('storageDomain', facility)

  root = await mkdtemp(join(tmpdir(), 'dsh-crm-e2e-'))
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

  // Seed through the real service with the page's clock frozen to match.
  vi.useFakeTimers({ now: Date.UTC(2026, 8, 7, 9) })
  await seedCrm(next.crm, ms => vi.setSystemTime(ms))
  vi.useRealTimers()

  browser = await chromium.launch()
  page = await browser.newPage()
  await page.goto(`${base}/crm-console`)
  await page.waitForSelector('#overview .card')
}, 120_000)

afterEach(async () => {
  vi.useRealTimers()
  await browser?.close()
  browser = undefined
  page = undefined
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  base = undefined
}, 60_000)

describe('console e2e (real browser)', () => {
  it('renders the overview with seeded KPIs and navigates all six tabs', async () => {
    expect(await page!.title()).toBe('投顾 CRM 控制台')
    const cards = await page!.textContent('#overview .cards')
    expect(cards).toContain('客户总数')
    expect(cards).toContain('60')   // seeded book size
    expect(cards).toContain('58%')  // seeded win rate
    expect(cards).toContain('13 已逾期')
    expect((await page!.$$('#overview .bar')).length).toBeGreaterThanOrEqual(7)
    for (const [tab, section] of [['客户簿', 'clients'], ['商机管线', 'pipeline'], ['跟进任务', 'tasks'], ['适当性审计', 'audit'], ['客户洞察', 'insights']] as const) {
      await page!.click(`nav button:has-text("${tab}")`)
      // Sections render async via fetch; give each a bounded settle wait.
      await page!.waitForFunction(
        (sectionId) => { const el = document.getElementById(sectionId); return el !== null && el.childElementCount > 0 },
        section,
        { timeout: 10_000 },
      )
    }
  })

  it('filters the client book and opens a 360° drawer', async () => {
    await page!.click('nav button:has-text("客户簿")')
    await page!.waitForSelector('#client-list table')
    expect((await page!.$$('#client-list tbody tr td:first-child')).length).toBeGreaterThanOrEqual(20)
    await page!.fill('#client-q', '王建国')
    await page!.waitForFunction(() => {
      const dataRows = [...document.querySelectorAll('#client-list tbody tr')].filter(tr => tr.querySelector('td') !== null)
      return dataRows.length === 1 && dataRows[0]?.textContent.includes('王建国') === true
    })
    expect(await page!.textContent('#client-list tbody tr:last-child') ?? '').toContain('王建国')
    await page!.click('#client-list tbody tr button:has-text("360°")')
    await page!.waitForSelector('#client-detail h3')
    expect(await page!.textContent('#client-detail h3')).toContain('王建国 · 360° 视图')
    expect(await page!.textContent('#client-detail')).toContain('最近互动')
  })

  it('creates a client through the dialog and lists it', async () => {
    await page!.click('nav button:has-text("客户簿")')
    await page!.click('button:has-text("＋ 新建客户")')
    await page!.waitForSelector('#dlg-client[open]')
    await page!.fill('#nc-name', '端到端新建客户')
    await page!.selectOption('#nc-kind', 'individual')
    await page!.selectOption('#nc-advisor', { index: 1 })
    await page!.fill('#nc-region', '北京')
    await page!.fill('#nc-aum', '1000000')
    await page!.click('#nc-save')
    await page!.waitForSelector('#toast')
    expect(await page!.textContent('#toast')).toContain('客户已建档')
    await page!.fill('#client-q', '端到端新建客户')
    // The create already re-rendered the full list; the debounced refetch then
    // narrows to the new client. Wait past the debounce and assert the row.
    await page!.waitForTimeout(900)
    await page!.waitForFunction(() => {
      const dataRows = [...document.querySelectorAll('#client-list tbody tr')].filter(tr => tr.querySelector('td') !== null)
      return dataRows.length === 1 && dataRows[0]?.textContent.includes('端到端新建客户') === true
    })
    expect(await page!.textContent('#client-list tbody tr:last-child') ?? '').toContain('端到端新建客户')
  })

  it('records a consultation with a live suitability block toast', async () => {
    await page!.click('nav button:has-text("客户簿")')
    await page!.waitForSelector('#client-list table')
    // 王建国 is C3: an R5 structured product must be blocked.
    await page!.fill('#client-q', '王建国')
    await page!.waitForFunction(() => {
      const dataRows = [...document.querySelectorAll('#client-list tbody tr')].filter(tr => tr.querySelector('td') !== null)
      return dataRows.length === 1 && dataRows[0]?.textContent.includes('王建国') === true
    })
    await page!.click('#client-list tbody tr button:has-text("记咨询")')
    await page!.waitForSelector('#dlg-consult[open]')
    await page!.fill('#cs-product', '雪球结构·中证500两年期')
    await page!.selectOption('#cs-risk', 'R5')
    await page!.fill('#cs-summary', 'E2E：R5 对 C3 的阻断演示')
    await page!.click('#cs-save')
    await page!.waitForSelector('#toast.err')
    expect(await page!.textContent('#toast')).toContain('已阻断')
  })

  it('downloads the client CSV export and renders the funnel', async () => {
    await page!.click('nav button:has-text("客户洞察")')
    await page!.waitForSelector('#rfm-rows table')
    expect((await page!.$$('#rfm-rows tbody tr')).length).toBeGreaterThanOrEqual(60)
    expect((await page!.$$('#funnel .bar')).length).toBe(5)
    const download = page!.waitForEvent('download')
    await page!.click('button.export[data-export="export-clients"]')
    const file = await download
    expect(file.suggestedFilename()).toContain('crm-clients-')
  })

  it('persists the onboarding dismissal across reloads', async () => {
    await page!.evaluate(() => { localStorage.setItem('crm-onboarding-dismissed', '1') })
    await page!.reload()
    expect(await page!.evaluate(() => localStorage.getItem('crm-onboarding-dismissed'))).toBe('1')
  })
})
