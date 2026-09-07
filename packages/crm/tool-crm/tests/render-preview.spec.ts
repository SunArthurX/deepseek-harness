// Render-preview coverage: listings beyond the five-row preview cap fold to
// an overflow count, keeping result prose bounded on enterprise-scale pages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEED_NOW } from '../../crm/tests/helpers/seed.ts'
import { toolHarness } from './helpers/tool-harness.ts'
import type { ToolHarness } from './helpers/tool-harness.ts'

let harness: ToolHarness | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: SEED_NOW })
  harness = await toolHarness({ setTime: ms => vi.setSystemTime(ms) })
})

afterEach(async () => {
  vi.useRealTimers()
  await harness?.dispose()
  harness = undefined
})

describe('render preview caps', () => {
  it('folds client search beyond five rows into an overflow count', async () => {
    const text = (await harness!.call('crm_client_search', { limit: 20 })).text
    expect(text).toContain('Found 20 clients')
    expect(text).toContain('… and 15 more')
  })

  it('folds interaction listings beyond five rows', async () => {
    const text = (await harness!.call('crm_interaction_list', { limit: 12 })).text
    expect(text).toContain('12 interactions, newest first')
    expect(text).toContain('… and 7 more')
  })

  it('folds opportunity listings beyond five rows', async () => {
    const text = (await harness!.call('crm_opportunity_list', { limit: 10 })).text
    expect(text).toContain('10 deals')
    expect(text).toContain('… and 5 more')
  })

  it('folds task listings beyond five rows', async () => {
    const text = (await harness!.call('crm_task_list', { limit: 10 })).text
    expect(text).toContain('10 tasks')
    expect(text).toContain('… and 5 more')
  })

  it('folds the advisor roster beyond five rows', async () => {
    for (let i = 0; i < 4; i += 1) {
      await harness!.ctx.crm.registerAdvisor({ name: `顾问${String(i)}` })
    }
    const text = (await harness!.call('crm_advisor_list', {})).text
    expect(text).toContain('Advisors:')
    expect(text).toContain('… and 3 more')
  })

  it('spells short listings out fully without an overflow tail', async () => {
    const text = (await harness!.call('crm_client_search', { query: '王建国' })).text
    expect(text).toContain('Found 1 clients: 王建国')
    expect(text).not.toContain('more')
  })
})
