// Full-surface coverage for the crm_* tools: every optional parameter path,
// every presentCall presenter, and every render branch runs at least once on
// both sides, completing the per-file coverage gate for this package.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolHarness } from './helpers/tool-harness.ts'
import type { ToolHarness } from './helpers/tool-harness.ts'

const NOW = Date.UTC(2026, 8, 1, 8)

let harness: ToolHarness | undefined

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW })
  harness = await toolHarness({ seed: false })
})

afterEach(async () => {
  vi.useRealTimers()
  await harness?.dispose()
  harness = undefined
})

/** Execute one tool call through the shared harness. */
function call(name: string, args: unknown) {
  return harness!.call(name, args)
}

/** Resolve a tool definition for direct presenter invocation. */
function def(name: string) {
  return harness!.def(name)
}

const FULL_CLIENT = {
  name: '王建国',
  kind: 'individual',
  lifecycle: 'prospect',
  phone: '13900001111',
  email: 'wgj@example.com',
  wechat: 'wgj_wx',
  region: '上海',
  annualIncome: 850_000,
  liquidAssets: 1_200_000,
  totalAum: 3_800_000,
  currency: 'CNY',
  tags: ['私行客户', '再平衡季度'],
  notes: '转介绍客户',
}

describe('client tools full surface', () => {
  it('creates with every optional field and an initial assessment', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const created = await call('crm_client_create', { ...FULL_CLIENT, advisorId: advisor.id, tolerance: 'C3', score: 62 })
    expect(created.isError).toBe(false)
    const client = (created.value as { client: Record<string, unknown> }).client
    expect(client.contact).toEqual({ phone: '13900001111', email: 'wgj@example.com', wechat: 'wgj_wx', region: '上海' })
    expect(client.financial).toEqual({ totalAum: 3_800_000, annualIncome: 850_000, liquidAssets: 1_200_000, currency: 'CNY' })
    expect(client.riskProfile).toMatchObject({ tolerance: 'C3', score: 62 })
    expect(created.text).toContain('C3')
  })

  it('creates a client without any optional field and one without an assessment', async () => {
    const bare = await call('crm_client_create', { name: '冯丽娜', kind: 'individual' })
    const client = (bare.value as { client: Record<string, unknown> }).client
    expect(client.contact).toBeUndefined()
    expect(client.financial).toBeUndefined()
    expect(client.riskProfile).toBeUndefined()
    expect(bare.text).not.toContain('C3')
  })

  it('searches with a bare query and filters, including empty results and clamped limits', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    await call('crm_client_create', { name: '王建国', kind: 'individual', advisorId: advisor.id, tolerance: 'C3', tags: ['私行客户'] })
    const byName = await call('crm_client_search', { query: '王建国' })
    expect((byName.value as { clients: unknown[] }).clients).toHaveLength(1)
    const empty = await call('crm_client_search', { query: '不存在' })
    expect(empty.text).toContain('No matching clients')
    const filtered = await call('crm_client_search', { lifecycle: 'active', advisorId: advisor.id, tag: '私行客户', limit: 5 })
    expect((filtered.value as { clients: unknown[] }).clients).toHaveLength(0)
  })

  it('patches every optional client field through the update tool', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const created = await call('crm_client_create', {
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      phone: '13900001111',
      totalAum: 100,
      currency: 'USD',
    })
    const clientId = (created.value as { client: { id: string } }).client.id
    const updated = await call('crm_client_update', {
      clientId,
      name: '王建国(改)',
      lifecycle: 'active',
      advisorId: advisor.id,
      tags: ['新标签'],
      notes: '新备注',
      email: 'new@example.com',
      region: '北京',
      wechat: 'new_wx',
      annualIncome: 1,
      liquidAssets: 2,
      totalAum: 200,
      currency: 'CNY',
      tolerance: 'C4',
      score: 70,
    })
    expect(updated.isError).toBe(false)
    const client = (updated.value as { client: Record<string, unknown> }).client
    expect(client.name).toBe('王建国(改)')
    expect(client.contact).toEqual({ phone: '13900001111', email: 'new@example.com', wechat: 'new_wx', region: '北京' })
    expect(client.financial).toEqual({ totalAum: 200, annualIncome: 1, liquidAssets: 2, currency: 'CNY' })
    expect(client.riskProfile).toMatchObject({ tolerance: 'C4', score: 70 })
  })

  it('updates a client with only the identity field and rejects an unknown one', async () => {
    await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const clientId = (await harness!.ctx.crm.createClient({ name: '王建国', kind: 'individual' })).id
    const minimal = await call('crm_client_update', { clientId })
    expect(minimal.isError).toBe(false)
    const unknown = await call('crm_client_update', { clientId: 'missing' })
    expect(unknown.isError).toBe(true)
  })
})

describe('engagement tools full surface', () => {
  it('registers an advisor with every optional field and lists empty results', async () => {
    const registered = await call('crm_advisor_register', {
      name: '张伟明',
      team: '财富管理一部',
      licenseNo: 'S14400002001',
      specialties: ['asset_allocation', 'retirement'],
      active: false,
    })
    expect(registered.isError).toBe(false)
    const none = await call('crm_advisor_list', { active: true })
    expect((none.value as { advisors: unknown[] }).advisors).toHaveLength(0)
    expect(none.text).toContain('No advisors registered')
  })

  it('lists advisors without the filter and presents calls', async () => {
    await harness!.ctx.crm.registerAdvisor({ name: '张伟明', team: '一部' })
    const listed = await call('crm_advisor_list', {})
    expect((listed.value as { advisors: unknown[] }).advisors).toHaveLength(1)
    expect(listed.text).toContain('一部')
    expect(def('crm_advisor_list').presentCall?.({})).toMatchObject({ card: 'generic' })
    expect(def('crm_advisor_register').presentCall?.({ name: '张伟明' })).toMatchObject({ card: 'generic' })
  })

  it('logs an interaction with every optional field and lists with filters', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await harness!.ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    const logged = await call('crm_interaction_log', {
      clientId: client.id,
      advisorId: advisor.id,
      kind: 'report_review',
      summary: '陪同解读季报',
      occurredAt: '2026-08-15T02:00:00.000Z',
      durationMin: 30,
      sentiment: 'negative',
      topics: ['product_review', 'market_outlook'],
      nextStep: '调整仓位前再沟通',
      sessionId: 'sess-1',
    })
    expect(logged.isError).toBe(false)
    const interaction = (logged.value as { interaction: Record<string, unknown> }).interaction
    expect(interaction).toMatchObject({ durationMin: 30, sentiment: 'negative', sessionId: 'sess-1', nextStep: '调整仓位前再沟通' })

    const minimal = await call('crm_interaction_log', { clientId: client.id, summary: '微信答疑' })
    expect((minimal.value as { interaction: Record<string, unknown> }).interaction.kind).toBe('consultation')

    const empty = await call('crm_interaction_list', { kind: 'email' })
    expect(empty.text).toContain('No matching interactions')
    const byKind = await call('crm_interaction_list', { clientId: client.id, kind: 'report_review', since: '2026-08-01T00:00:00.000Z' })
    expect((byKind.value as { interactions: unknown[] }).interactions).toHaveLength(1)
    expect(byKind.text).toContain('report_review')
    expect(def('crm_interaction_log').presentCall?.({ clientId: 'x', summary: '沟通' })).toMatchObject({ card: 'generic' })
    expect(def('crm_interaction_list').presentCall?.({})).toMatchObject({ card: 'generic' })
  })

  it('records a consultation with every optional field', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await harness!.ctx.crm.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C2' },
    })
    const interaction = await harness!.ctx.crm.logInteraction({ clientId: client.id, summary: '会前沟通' })
    const result = await call('crm_consultation_record', {
      clientId: client.id,
      advisorId: advisor.id,
      interactionId: interaction.id,
      occurredAt: '2026-08-20T06:00:00.000Z',
      topics: ['insurance', 'education'],
      products: [
        { name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' },
        { name: '全球医药生物混合基金', kind: 'fund', riskLevel: 'R4' },
      ],
      recommendations: ['先补齐应急现金', '暂缓高波动主题基金'],
      followUpRequired: true,
      summary: '教育金与保险规划',
      sessionId: 'sess-2',
    })
    const consultation = (result.value as { consultation: Record<string, unknown> }).consultation
    expect(consultation.interactionId).toBe(interaction.id)
    expect(consultation.sessionId).toBe('sess-2')
    expect(consultation.topics).toEqual(['insurance', 'education'])
    expect((result.value as { suitability: { blocked: number } }).suitability.blocked).toBe(1)
    expect(def('crm_consultation_record').presentCall?.({ clientId: 'x' })).toMatchObject({ card: 'generic' })
  })
})

describe('pipeline tools full surface', () => {
  /** One advisor and client most pipeline calls need. */
  async function setup() {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await harness!.ctx.crm.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C3' },
    })
    return { advisorId: advisor.id, clientId: client.id }
  }

  it('opens an opportunity with every optional field', async () => {
    const { advisorId, clientId } = await setup()
    const opened = await call('crm_opportunity_create', {
      clientId,
      advisorId,
      productKind: 'retirement',
      productName: '年金保险·福瑞人生',
      stage: 'qualified',
      amount: 500_000,
      currency: 'USD',
      probability: 40,
      expectedCloseAt: '2026-12-01T00:00:00.000Z',
      notes: '对冲长寿风险',
    })
    const deal = (opened.value as { opportunity: Record<string, unknown> }).opportunity
    expect(deal).toMatchObject({
      productKind: 'retirement',
      stage: 'qualified',
      currency: 'USD',
      probability: 40,
      notes: '对冲长寿风险',
    })
    expect(opened.text).toContain('年金保险·福瑞人生')
  })

  it('moves with explicit probability and notes, and lists empty results', async () => {
    const { clientId } = await setup()
    const opened = await call('crm_opportunity_create', { clientId, productKind: 'fund', amount: 1_000 })
    const id = (opened.value as { opportunity: { id: string } }).opportunity.id
    const moved = await call('crm_opportunity_move', { opportunityId: id, to: 'proposal', probability: 60, notes: '方案已出' })
    expect((moved.value as { opportunity: Record<string, unknown> }).opportunity).toMatchObject({ probability: 60, notes: '方案已出' })
    const empty = await call('crm_opportunity_list', { stage: 'won' })
    expect(empty.text).toContain('No matching opportunities')
    const all = await call('crm_opportunity_list', { clientId })
    expect(all.text).toContain('fund')
    expect(def('crm_opportunity_create').presentCall?.({ clientId: 'x', productKind: 'fund', amount: 1 })).toMatchObject({ card: 'generic' })
    expect(def('crm_opportunity_move').presentCall?.({ opportunityId: 'x', to: 'won' })).toMatchObject({ card: 'generic' })
    expect(def('crm_opportunity_list').presentCall?.({})).toMatchObject({ card: 'generic' })
    expect(def('crm_opportunity_list').presentCall?.({ clientId: 'x' })).toMatchObject({ card: 'generic' })
  })

  it('creates a task with every optional field and exercises every list filter', async () => {
    const { advisorId, clientId } = await setup()
    const created = await call('crm_task_create', {
      advisorId,
      clientId,
      kind: 'compliance_check',
      title: '核对适当性材料',
      dueAt: '2026-09-10T01:00:00.000Z',
      priority: 'urgent',
      notes: '双录文件补传',
    })
    const task = (created.value as { task: Record<string, unknown> }).task
    expect(task).toMatchObject({ kind: 'compliance_check', priority: 'urgent', notes: '双录文件补传' })

    await call('crm_task_create', { advisorId, clientId, title: '较早任务', dueAt: '2026-08-01T00:00:00.000Z' })
    const byStatus = await call('crm_task_list', { status: 'cancelled' })
    expect((byStatus.value as { tasks: unknown[] }).tasks).toHaveLength(0)
    expect(byStatus.text).toContain('No matching tasks')
    const byDue = await call('crm_task_list', { advisorId, clientId, dueBefore: '2026-08-02T00:00:00.000Z' })
    expect((byDue.value as { tasks: unknown[] }).tasks).toHaveLength(1)
    const overdue = await call('crm_task_list', { overdue: true })
    expect((overdue.value as { tasks: { overdue: boolean }[] }).tasks.every(t => t.overdue)).toBe(true)
    expect(overdue.text).toContain('OVERDUE')
    expect(def('crm_task_create').presentCall?.({ title: '跟进', dueAt: '2026-09-05T00:00:00.000Z' })).toMatchObject({ card: 'generic' })
    expect(def('crm_task_list').presentCall?.({ clientId: 'x' })).toMatchObject({ card: 'generic' })
    expect(def('crm_task_complete').presentCall?.({ taskId: 'x' })).toMatchObject({ card: 'generic' })
    expect(def('crm_task_cancel').presentCall?.({ taskId: 'x' })).toMatchObject({ card: 'generic' })
    expect(def('crm_task_reschedule').presentCall?.({ taskId: 'x', dueAt: '2026-09-05T00:00:00.000Z' })).toMatchObject({ card: 'generic' })
  })

  it('reschedules and presents task cards', async () => {
    const { advisorId } = await setup()
    const created = await call('crm_task_create', { advisorId, title: '跟进', dueAt: '2026-09-05T00:00:00.000Z' })
    const id = (created.value as { task: { id: string } }).task.id
    const rescheduled = await call('crm_task_reschedule', { taskId: id, dueAt: '2026-09-06T00:00:00.000Z' })
    expect((rescheduled.value as { task: Record<string, unknown> }).task.dueAt).toContain('2026-09-06')
  })
})

describe('client tool presenters', () => {
  it('presents every client tool call card', async () => {
    expect(def('crm_client_create').presentCall?.({ name: 'x', kind: 'individual' })).toMatchObject({ card: 'generic' })
    expect(def('crm_client_search').presentCall?.({ query: 'x' })).toMatchObject({ card: 'generic' })
    expect(def('crm_client_get').presentCall?.({ clientId: 'x' })).toMatchObject({ card: 'generic' })
    expect(def('crm_client_update').presentCall?.({ clientId: 'x', lifecycle: 'active' })).toMatchObject({ card: 'generic' })
    expect(def('crm_report').presentCall?.({ kind: 'book' })).toMatchObject({ card: 'generic', title: 'Run CRM report: book' })
  })
})

describe('remaining optional and status branches', () => {
  it('merges contact and financial base fields the args do not mention', async () => {
    const created = await call('crm_client_create', {
      name: '王建国',
      kind: 'individual',
      email: 'keep@example.com',
      wechat: 'keep_wx',
      annualIncome: 100,
      liquidAssets: 200,
      totalAum: 300,
      currency: 'USD',
    })
    const clientId = (created.value as { client: { id: string } }).client.id
    const updated = await call('crm_client_update', { clientId, totalAum: 400 })
    const client = (updated.value as { client: Record<string, unknown> }).client
    const contact = client.contact as Record<string, string>
    expect(contact.email).toBe('keep@example.com')
    expect(contact.wechat).toBe('keep_wx')
    expect('phone' in contact).toBe(false)
    const financial = client.financial as Record<string, unknown>
    expect(financial.annualIncome).toBe(100)
    expect(financial.liquidAssets).toBe(200)
    expect(financial.totalAum).toBe(400)
  })

  it('reads a populated 360° book through the tool', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await harness!.ctx.crm.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C3' },
    })
    await harness!.ctx.crm.logInteraction({ clientId: client.id, summary: '面谈' })
    await harness!.ctx.crm.createTask({ clientId: client.id, title: '跟进', dueAt: NOW + 86_400_000 })
    await harness!.ctx.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 100 })
    await harness!.ctx.crm.recordConsultation({
      clientId: client.id,
      products: [{ name: '现金宝货币市场基金A', kind: 'fund', riskLevel: 'R1' }],
    })
    const got = await call('crm_client_get', { clientId: client.id })
    const value = got.value as { interactions: unknown[]; openTasks: unknown[]; opportunities: unknown[]; consultations: unknown[] }
    expect(value.interactions).toHaveLength(1)
    expect(value.openTasks).toHaveLength(1)
    expect(value.opportunities).toHaveLength(1)
    expect(value.consultations).toHaveLength(1)
  })

  it('renders an advisor without a team and filters interactions by advisor and limit', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '无队顾问' })
    const bare = await call('crm_advisor_register', { name: '光杆顾问' })
    expect(bare.isError).toBe(false)
    const listed = await call('crm_advisor_list', {})
    expect(listed.text).toContain('无队顾问')

    const client = await harness!.ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    await harness!.ctx.crm.logInteraction({ clientId: client.id, summary: '第一条' })
    await harness!.ctx.crm.logInteraction({ clientId: client.id, summary: '第二条' })
    const filtered = await call('crm_interaction_list', { advisorId: advisor.id, limit: 1 })
    expect((filtered.value as { interactions: unknown[] }).interactions).toHaveLength(1)
  })

  it('lists opportunities by advisor with a limit and schedules an opportunity task', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await harness!.ctx.crm.createClient({ name: '王建国', kind: 'individual', advisorId: advisor.id })
    await harness!.ctx.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 1 })
    await harness!.ctx.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 2 })
    const listed = await call('crm_opportunity_list', { advisorId: advisor.id, limit: 1 })
    expect((listed.value as { opportunities: unknown[] }).opportunities).toHaveLength(1)

    const deal = harness!.ctx.crm.listOpportunities({ clientId: client.id })[0]
    if (deal === undefined) throw new Error('expected a seeded deal')
    const task = await call('crm_task_create', {
      opportunityId: deal.id,
      title: '商机跟进',
      dueAt: '2026-09-08T00:00:00.000Z',
    })
    expect((task.value as { task: Record<string, unknown> }).task.opportunityId).toBe(deal.id)
    const limited = await call('crm_task_list', { limit: 1 })
    expect((limited.value as { tasks: unknown[] }).tasks).toHaveLength(1)
  })

  it('renders a non-null win rate and the suitability fallback line', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await harness!.ctx.crm.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C3' },
    })
    const won = await harness!.ctx.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 10 })
    const lost = await harness!.ctx.crm.createOpportunity({ clientId: client.id, productKind: 'fund', amount: 20 })
    await harness!.ctx.crm.moveOpportunity({ opportunityId: won.id, to: 'won' })
    await harness!.ctx.crm.moveOpportunity({ opportunityId: lost.id, to: 'lost', closeReason: '价格因素' })
    const pipeline = await call('crm_report', { kind: 'pipeline' })
    expect((pipeline.value as { pipeline: { winRate: number } }).pipeline.winRate).toBe(50)
    expect(pipeline.text).toContain('win rate 50%')

    await harness!.ctx.crm.recordConsultation({ clientId: client.id, products: [] })
    const suitability = await call('crm_report', { kind: 'suitability' })
    expect(suitability.text).toContain('0 entries')
  })

  it('reports expiring and expired profiles through the client wire', async () => {
    const advisor = await harness!.ctx.crm.registerAdvisor({ name: '张伟明' })
    const client = await harness!.ctx.crm.createClient({
      name: '王建国',
      kind: 'individual',
      advisorId: advisor.id,
      riskProfile: { tolerance: 'C3' },
    })
    vi.setSystemTime(NOW + 715 * 86_400_000)
    const expiring = await call('crm_client_get', { clientId: client.id })
    expect((expiring.value as { client: { profileStatus: string } }).client.profileStatus).toBe('expiring')
    vi.setSystemTime(NOW + 731 * 86_400_000)
    const expired = await call('crm_client_search', { query: '王建国' })
    expect((expired.value as { clients: { profileStatus: string }[] }).clients[0]?.profileStatus).toBe('expired')
    const expiredGet = await call('crm_client_get', { clientId: client.id })
    expect((expiredGet.value as { client: { profileStatus: string } }).client.profileStatus).toBe('expired')
    expect(def('crm_client_get').presentCall?.({ clientId: 'x' })).toMatchObject({ card: 'generic' })
  })
})


describe('report render helper', () => {
  it('covers the foreign-kind fallthrough with no audit payload', async () => {
    await import('../src/tools-report.ts').then(({ describeReport }) => {
      expect(describeReport('tasks', {})).toContain('Suitability audit: 0 entries')
      expect(describeReport('suitability', { audit: [{ verdict: 'matched' }, { verdict: 'missing-profile' }] }))
        .toContain('1 with a blocking verdict')
    })
  })

  it('renders integral amounts raw and fractional amounts to two digits', async () => {
    await import('../src/wire.ts').then(({ fmtAmount }) => {
      expect(fmtAmount(1_234_000)).toBe('1234000')
      expect(fmtAmount(1234.5)).toBe('1234.5')
      expect(fmtAmount(0.125)).toBe('0.13')
    })
  })

  it('rejects an ISO-shaped but unparseable date and a date-only form parses as UTC', async () => {
    await import('../src/wire.ts').then(({ parseWhen }) => {
      expect(() => parseWhen('2026-13-40T00:00:00Z', 'x')).toThrow(/ISO 8601/)
      expect(parseWhen('2026-09-01', 'x')).toBe(Date.UTC(2026, 8, 1))
    })
  })
})
