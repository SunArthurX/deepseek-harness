// End-to-end flows walkthrough: drives every crm_* tool through the real
// pipeline in the order an advisory team would use them, asserts the outcomes,
// and emits a demo transcript (JSON) for documentation rendering.
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolHarness } from './helpers/tool-harness.ts'
import type { ToolHarness } from './helpers/tool-harness.ts'

interface DemoStep {
  readonly tool: string
  readonly args: unknown
  readonly render: string
  readonly value: unknown
}

interface DemoFlow {
  readonly id: string
  readonly title: string
  readonly intro: string
  readonly steps: DemoStep[]
}

interface DemoTranscript {
  readonly generatedAt: string
  readonly flows: DemoFlow[]
}

const flows: DemoFlow[] = []
let harness: ToolHarness | undefined
let flow: DemoFlow | undefined

beforeEach(async () => {
  // One fixed demo date so every rendered timestamp is stable.
  vi.useFakeTimers({ now: Date.UTC(2026, 8, 7, 9) })
  harness = await toolHarness({ seed: false, setTime: ms => vi.setSystemTime(ms) })
})

afterEach(async () => {
  const dir = join(tmpdir(), 'crm-demo')
  mkdirSync(dir, { recursive: true })
  const transcript: DemoTranscript = { generatedAt: new Date().toISOString(), flows }
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcript, null, 2))
  await harness?.dispose()
  harness = undefined
  flow = undefined
})

/** Run one tool call through the real pipeline and record it. */
async function step(tool: string, args: unknown): Promise<Record<string, unknown>> {
  const result = await harness!.call(tool, args)
  expect(result.isError, `${tool} failed: ${result.text}`).toBe(false)
  const value = result.value as Record<string, unknown>
  flow!.steps.push({ tool, args, render: result.text, value })
  return value
}

function beginFlow(id: string, title: string, intro: string): void {
  flow = { id, title, intro, steps: [] }
  flows.push(flow)
}

describe('CRM demo walkthrough', () => {
  it('walks every CRM flow end to end', async () => {
    // ── 流程一 · 顾问团队注册 ──────────────────────────────────────────
    beginFlow('team', '流程一 · 顾问团队注册',
      '先建顾问名册：团队、执业编号、擅长领域。所有客户、互动、商机都通过 advisorId 关联到顾问。')
    await step('crm_advisor_register', {
      name: '张伟明',
      team: '财富管理一部',
      licenseNo: 'S14400002001',
      specialties: ['asset_allocation', 'retirement'],
    })
    await step('crm_advisor_register', {
      name: '林晓芳',
      team: '财富管理二部',
      licenseNo: 'S14400002002',
      specialties: ['insurance', 'education'],
    })
    await step('crm_advisor_list', {})

    // ── 流程二 · 客户建档 ──────────────────────────────────────────────
    beginFlow('intake', '流程二 · 客户建档',
      '客户录入：个人/机构、归属顾问、风险测评（C1–C5，有效期由部署配置决定）、财务画像与标签。')
    const advisors = await step('crm_advisor_list', {})
    const roster = (advisors as { advisors: { id: string; name: string }[] }).advisors
    const zhang = roster.find(advisor => advisor.name === '张伟明')
    const lin = roster.find(advisor => advisor.name === '林晓芳')
    if (zhang === undefined || lin === undefined) throw new Error('demo advisors missing')
    await step('crm_client_create', {
      name: '王建国',
      kind: 'individual',
      lifecycle: 'active',
      advisorId: zhang.id,
      tolerance: 'C3',
      score: 62,
      region: '上海',
      totalAum: 3_800_000,
      annualIncome: 850_000,
      tags: ['私行客户', '再平衡季度'],
    })
    await step('crm_client_create', {
      name: '冯丽娜',
      kind: 'individual',
      advisorId: lin.id,
      region: '武汉',
      tags: ['线上获客'],
    })
    await step('crm_client_create', {
      name: '杭州云启创业投资有限公司',
      kind: 'institution',
      lifecycle: 'onboarding',
      advisorId: lin.id,
      region: '杭州',
      totalAum: 26_000_000,
      tags: ['机构客户', '现金管理'],
    })
    await step('crm_client_search', { query: '王', limit: 10 })

    // ── 流程三 · 客户互动记录 ──────────────────────────────────────────
    beginFlow('interactions', '流程三 · 客户互动记录',
      '每次触点即时留痕：渠道、时长、客户情绪、讨论主题与下一步约定，形成可审计的展业历史。')
    const wangRow = (await step('crm_client_search', { query: '王建国' }) as unknown as
      { clients: { id: string }[] }).clients[0]
    if (wangRow === undefined) throw new Error('demo client missing')
    const wang = wangRow.id
    await step('crm_interaction_log', {
      clientId: wang,
      kind: 'meeting',
      summary: '面谈回顾持仓，讨论四季度再平衡方案',
      occurredAt: '2026-09-01T09:30:00.000Z',
      durationMin: 45,
      sentiment: 'positive',
      topics: ['asset_allocation', 'market_outlook'],
      nextStep: '下周出具再平衡建议书',
    })
    await step('crm_interaction_log', {
      clientId: wang,
      kind: 'wechat',
      summary: '微信确认风险测评即将到期，预约复测',
      occurredAt: '2026-09-04T14:00:00.000Z',
      sentiment: 'neutral',
      topics: ['other'],
    })
    await step('crm_interaction_list', { clientId: wang })

    // ── 流程四 · 投顾咨询与适当性审计 ──────────────────────────────────
    beginFlow('consultation', '流程四 · 投顾咨询与适当性审计',
      '正式咨询的每款产品都按客户当前风险档案自动判定：容忍度等级 ≥ 产品风险等级且测评未过期。'
      + '不利判定照常入档——审计轨迹必须完整，模型据此停止推荐而非隐瞒。')
    await step('crm_consultation_record', {
      clientId: wang,
      topics: ['asset_allocation'],
      products: [
        { name: '中证红利低波ETF联接A', kind: 'fund', riskLevel: 'R3' },
        { name: '雪球结构·中证500两年期', kind: 'structured', riskLevel: 'R5' },
      ],
      recommendations: ['通过红利低波ETF执行再平衡', '雪球结构超出风险承受能力，本次不推荐'],
      followUpRequired: true,
      summary: '季度再平衡咨询，雪球结构未通过适当性',
    })
    const fengRow = (await step('crm_client_search', { query: '冯丽娜' }) as unknown as
      { clients: { id: string }[] }).clients[0]
    if (fengRow === undefined) throw new Error('demo client missing')
    await step('crm_consultation_record', {
      clientId: fengRow.id,
      topics: ['insurance'],
      products: [{ name: '增额终身寿险·鑫享版', kind: 'insurance', riskLevel: 'R2' }],
      recommendations: ['先补齐风险测评再谈产品'],
      summary: '首次接触，未测评，仅记录需求',
    })

    // ── 流程五 · 商机管线推进 ──────────────────────────────────────────
    beginFlow('pipeline', '流程五 · 商机管线推进',
      '从线索到成交的阶段状态机：new → qualified → proposal → negotiation → won/lost/abandoned。'
      + '终态盖章收尾时间，lost/abandoned 必须留原因。')
    const opened = await step('crm_opportunity_create', {
      clientId: wang,
      productKind: 'fund',
      productName: '中证红利低波ETF联接A',
      amount: 1_500_000,
      expectedCloseAt: '2026-12-31T00:00:00.000Z',
      notes: '再平衡方案落地',
    })
    const dealId = (opened as { opportunity: { id: string } }).opportunity.id
    await step('crm_opportunity_move', { opportunityId: dealId, to: 'qualified' })
    await step('crm_opportunity_move', { opportunityId: dealId, to: 'proposal', probability: 60 })
    await step('crm_opportunity_move', { opportunityId: dealId, to: 'won' })
    const second = await step('crm_opportunity_create', {
      clientId: fengRow.id,
      productKind: 'insurance',
      productName: '增额终身寿险·鑫享版',
      amount: 200_000,
    })
    const secondId = (second as { opportunity: { id: string } }).opportunity.id
    await step('crm_opportunity_move', { opportunityId: secondId, to: 'lost', closeReason: '客户暂缓投保计划' })

    // ── 流程六 · 跟进任务管理 ──────────────────────────────────────────
    beginFlow('tasks', '流程六 · 跟进任务管理',
      '把咨询结论变成可执行任务：到期时间、优先级、责任顾问。逾期是读取时派生的，永远如实反映当前时刻。')
    await step('crm_task_create', {
      clientId: wang,
      kind: 'document_delivery',
      title: '发送再平衡建议书并归档双录文件',
      dueAt: '2026-09-12T09:00:00.000Z',
      priority: 'high',
    })
    await step('crm_task_create', {
      clientId: wang,
      kind: 'risk_review',
      title: '提醒王建国完成风险测评复测',
      dueAt: '2026-09-05T09:00:00.000Z',
      priority: 'urgent',
    })
    const overdue = await step('crm_task_list', { overdue: true })
    const overdueId = (overdue as { tasks: { id: string }[] }).tasks[0]?.id
    if (overdueId !== undefined) {
      await step('crm_task_complete', { taskId: overdueId })
    }
    await step('crm_task_list', { clientId: wang })

    // ── 流程七 · 经营报表 ──────────────────────────────────────────────
    beginFlow('reports', '流程七 · 经营报表',
      '四类读模型报表：管线（加权预测/赢率）、客户簿（生命周期与容忍度分布、AUM、测评到期预警）、'
      + '任务负载、适当性审计轨迹。')
    await step('crm_report', { kind: 'pipeline' })
    await step('crm_report', { kind: 'book' })
    await step('crm_report', { kind: 'tasks' })
    await step('crm_report', { kind: 'suitability' })

    // ── 流程八 · 客户 360° 视图 ────────────────────────────────────────
    beginFlow('book', '流程八 · 客户 360° 视图',
      '一次调用读全貌：档案与测评有效性、最近互动、未完成任务、商机、历史咨询——面谈前的准备入口。')
    await step('crm_client_get', { clientId: wang })
  })
})
