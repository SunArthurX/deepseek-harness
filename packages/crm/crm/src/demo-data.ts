/**
 * One-click realistic demo data for the investment-advisory CRM: a coherent
 * narrative book loaded through the real service API so every business rule
 * (suitability verdicts, stage stamps, advisor resolution) applies exactly as
 * in production. Every page shows 20+ rows in deliberately varied states, and
 * the rows reference each other the way a real month of advisory work does —
 * an interaction precedes its consultation, the consultation precedes the
 * opportunity it created, won deals and completed tasks cite their clients,
 * and risk-assessment stories (valid / expiring / expired / missing) explain
 * which consultations were blocked.
 * @module @deepseek-ai/dsh-crm/src/demo-data
 */

import type CrmService from './index.ts'

/** Milliseconds in one day. */
const DAY = 86_400_000

/** What the loader committed, for the confirmation toast. */
export interface DemoDataSummary {
  readonly advisors: number
  readonly clients: number
  readonly interactions: number
  readonly consultations: number
  readonly opportunities: number
  readonly tasks: number
}

/** One client row the narrative needs before staging its history. */
interface DemoClient {
  readonly name: string
  readonly kind: 'individual' | 'institution'
  readonly lifecycle: 'lead' | 'prospect' | 'onboarding' | 'active' | 'dormant' | 'lost'
  readonly advisor: 'zhang' | 'lin'
  readonly region: string
  readonly aum: number
  /** Tolerance plus score; absent for the unassessed story. */
  readonly tolerance?: 'C1' | 'C2' | 'C3' | 'C4' | 'C5'
  readonly score?: number
  /** Days before `now` the assessment was taken (drives expiry stories). */
  readonly assessedDaysAgo?: number
  readonly tags: readonly string[]
}

/** The demo roster: 24 clients, every lifecycle and every profile status. */
const ROSTER: readonly DemoClient[] = [
  { name: '王建国', kind: 'individual', lifecycle: 'active', advisor: 'zhang', region: '上海', aum: 3_800_000, tolerance: 'C3', score: 62, assessedDaysAgo: 120, tags: ['私行客户', '再平衡季度'] },
  { name: '李秀英', kind: 'individual', lifecycle: 'active', advisor: 'zhang', region: '北京', aum: 1_250_000, tolerance: 'C2', score: 45, assessedDaysAgo: 200, tags: ['稳健型', '固收偏好'] },
  { name: '陈志强', kind: 'individual', lifecycle: 'active', advisor: 'lin', region: '深圳', aum: 5_600_000, tolerance: 'C4', score: 78, assessedDaysAgo: 723, tags: ['高净值'] },
  { name: '冯丽娜', kind: 'individual', lifecycle: 'lead', advisor: 'lin', region: '武汉', aum: 0, tags: ['线上获客'] },
  { name: '吴铁军', kind: 'individual', lifecycle: 'active', advisor: 'lin', region: '上海', aum: 9_200_000, tolerance: 'C5', score: 92, assessedDaysAgo: 60, tags: ['私行客户', '衍生品'] },
  { name: '郑淑华', kind: 'individual', lifecycle: 'active', advisor: 'zhang', region: '广州', aum: 1_760_000, tolerance: 'C3', score: 60, assessedDaysAgo: 300, tags: ['教育金'] },
  { name: '孙国庆', kind: 'individual', lifecycle: 'prospect', advisor: 'lin', region: '成都', aum: 0, tolerance: 'C2', score: 38, assessedDaysAgo: 40, tags: ['转介绍'] },
  { name: '周雅琴', kind: 'individual', lifecycle: 'dormant', advisor: 'zhang', region: '南京', aum: 890_000, tolerance: 'C1', score: 25, assessedDaysAgo: 400, tags: ['长尾', '存款到期'] },
  { name: '吴建国', kind: 'individual', lifecycle: 'lost', advisor: 'zhang', region: '重庆', aum: 0, tolerance: 'C2', score: 40, assessedDaysAgo: 300, tags: ['竞对流失'] },
  { name: '卫东升', kind: 'individual', lifecycle: 'active', advisor: 'lin', region: '北京', aum: 4_300_000, tolerance: 'C4', score: 80, assessedDaysAgo: 15, tags: ['私行客户', '股权减持'] },
  { name: '华春燕', kind: 'individual', lifecycle: 'active', advisor: 'zhang', region: '苏州', aum: 45_000_000, tolerance: 'C2', score: 52, assessedDaysAgo: 100, tags: ['基金定投', '私行客户'] },
  { name: '杭州云启创业投资有限公司', kind: 'institution', lifecycle: 'onboarding', advisor: 'zhang', region: '杭州', aum: 26_000_000, tolerance: 'C4', score: 75, assessedDaysAgo: 55, tags: ['机构客户', '现金管理'] },
  { name: '刘梅', kind: 'individual', lifecycle: 'prospect', advisor: 'lin', region: '杭州', aum: 300_000, tolerance: 'C2', score: 38, assessedDaysAgo: 20, tags: ['新客'] },
  { name: '深圳前海恒信私募基金管理有限公司', kind: 'institution', lifecycle: 'active', advisor: 'lin', region: '深圳', aum: 60_000_000, tolerance: 'C4', score: 82, assessedDaysAgo: 80, tags: ['机构客户', '专户'] },
  { name: '许小娟', kind: 'individual', lifecycle: 'active', advisor: 'zhang', region: '无锡', aum: 3_516_000, tolerance: 'C2', score: 48, assessedDaysAgo: 150, tags: ['稳健型', '进取型'] },
  { name: '严俊杰', kind: 'individual', lifecycle: 'dormant', advisor: 'lin', region: '西安', aum: 1_009_000, tolerance: 'C3', score: 58, assessedDaysAgo: 500, tags: ['代发工资', '固收偏好'] },
  { name: '陶丽君', kind: 'individual', lifecycle: 'onboarding', advisor: 'zhang', region: '南京', aum: 1_735_000, tolerance: 'C3', score: 61, assessedDaysAgo: 5, tags: ['代发工资', '长尾'] },
  { name: '金淑珍', kind: 'individual', lifecycle: 'active', advisor: 'lin', region: '青岛', aum: 1_959_000, tolerance: 'C3', score: 59, assessedDaysAgo: 90, tags: ['长尾', '固收偏好'] },
  { name: '邹雅雯', kind: 'individual', lifecycle: 'active', advisor: 'zhang', region: '天津', aum: 6_342_000, tolerance: 'C4', score: 77, assessedDaysAgo: 30, tags: ['转介绍', '基金定投'] },
  { name: '范春燕', kind: 'individual', lifecycle: 'prospect', advisor: 'zhang', region: '合肥', aum: 0, tags: ['线上获客'] },
  { name: '华德福', kind: 'individual', lifecycle: 'active', advisor: 'lin', region: '宁波', aum: 727_000, tolerance: 'C2', score: 44, assessedDaysAgo: 250, tags: ['线上获客', '企业主'] },
  { name: '曹子墨', kind: 'individual', lifecycle: 'onboarding', advisor: 'zhang', region: '长沙', aum: 499_000, tolerance: 'C3', score: 57, assessedDaysAgo: 8, tags: ['退休规划', '转介绍'] },
  { name: '魏雅雯', kind: 'individual', lifecycle: 'active', advisor: 'lin', region: '厦门', aum: 2_948_000, tolerance: 'C4', score: 76, assessedDaysAgo: 70, tags: ['企业主', '长尾'] },
  { name: '秦浩然', kind: 'individual', lifecycle: 'active', advisor: 'zhang', region: '郑州', aum: 758_000, tolerance: 'C1', score: 22, assessedDaysAgo: 180, tags: ['代发工资'] },
]

/**
 * Load the demo book through the real service API. Refuses when the client
 * book is non-empty so pressing the button twice never duplicates rows.
 * @param crm - The booted CRM service.
 * @param now - Reference time in epoch ms the demo stages around (default:
 * real clock, so "overdue" and "expiring" read correctly on the day it runs).
 * @returns committed record counts.
 */
export async function loadDemoData(crm: CrmService, now: number = Date.now()): Promise<DemoDataSummary> {
  if (crm.searchClients({ limit: 1 }).length > 0) {
    throw new Error('demo data: client book is not empty (demo data can only load into a fresh book)')
  }

  const zhang = await crm.registerAdvisor({
    name: '张伟明',
    team: '财富管理一部',
    licenseNo: 'S14400009001',
    specialties: ['asset_allocation', 'retirement'],
  })
  const lin = await crm.registerAdvisor({
    name: '林晓芳',
    team: '财富管理二部',
    licenseNo: 'S14400009002',
    specialties: ['insurance', 'education'],
  })
  const advisorOf = (key: 'zhang' | 'lin'): typeof zhang => key === 'zhang' ? zhang : lin

  // ── Clients: every lifecycle and every assessment story. ──────────────
  const ids = new Map<string, import('./types.ts').ClientId>()
  for (const spec of ROSTER) {
    const client = await crm.createClient({
      name: spec.name,
      kind: spec.kind,
      lifecycle: spec.lifecycle,
      advisorId: advisorOf(spec.advisor).id,
      ...(spec.tolerance === undefined ? {} : {
        riskProfile: {
          tolerance: spec.tolerance,
          ...(spec.score === undefined ? {} : { score: spec.score }),
        },
      }),
      contact: { region: spec.region },
      financial: {
        totalAum: spec.aum,
        ...(spec.aum > 1_000_000 ? { annualIncome: Math.round(spec.aum / 5) } : {}),
        currency: 'CNY',
      },
      tags: [...spec.tags],
    })
    ids.set(spec.name, client.id)
    // Re-stage the assessment to its story time (createClient stamps it now).
    if (spec.tolerance !== undefined && spec.assessedDaysAgo !== undefined) {
      await crm.updateClient(client.id, {
        riskProfile: {
          tolerance: spec.tolerance,
          ...(spec.score === undefined ? {} : { score: spec.score }),
          assessedAt: now - spec.assessedDaysAgo * DAY,
        },
      })
    }
  }

  const id = (name: string): import('./types.ts').ClientId => {
    const value = ids.get(name)
    if (value === undefined) throw new Error(`demo data: roster client '${name}' missing`)
    return value
  }
  let interactions = 0
  let consultations = 0
  let opportunities = 0

  // ── Narrative arc 1: 王建国's rebalance (interaction → consultation → won
  // deal → document task). The reference story a novice should read first. ──
  await crm.logInteraction({
    clientId: id('王建国'), kind: 'meeting', occurredAt: now - 21 * DAY, durationMin: 45,
    summary: '季度面谈：回顾持仓，讨论四季度再平衡方案', sentiment: 'positive',
    topics: ['asset_allocation', 'market_outlook'], nextStep: '出具再平衡建议书',
  })
  interactions++
  await crm.recordConsultation({
    clientId: id('王建国'), occurredAt: now - 14 * DAY, topics: ['asset_allocation'],
    products: [
      { name: '中证红利低波ETF联接A', kind: 'fund', riskLevel: 'R3' },
      { name: '雪球结构·中证500两年期', kind: 'structured', riskLevel: 'R5' },
    ],
    recommendations: ['通过红利低波ETF执行再平衡', '雪球结构超出风险承受能力，本次不推荐'],
    followUpRequired: true, summary: '季度再平衡咨询，雪球结构未通过适当性',
  })
  consultations++
  const rebalance = await crm.createOpportunity({
    clientId: id('王建国'), productKind: 'fund', productName: '中证红利低波ETF联接A',
    amount: 1_500_000, expectedCloseAt: now + 90 * DAY, notes: '再平衡咨询转化',
  })
  opportunities++
  await crm.moveOpportunity({ opportunityId: rebalance.id, to: 'qualified' })
  await crm.moveOpportunity({ opportunityId: rebalance.id, to: 'proposal', probability: 70 })
  await crm.moveOpportunity({ opportunityId: rebalance.id, to: 'won' })
  await crm.createTask({
    clientId: id('王建国'), advisorId: zhang.id, kind: 'document_delivery',
    title: '发送再平衡成交报告与双录归档', dueAt: now + 3 * DAY, priority: 'high',
  })

  // ── Arc 2: 陈志强's expiring assessment → blocked consult → 复测 task
  // (assessed 723 days ago; the 730-day window lapses in a week). ─────────
  await crm.logInteraction({
    clientId: id('陈志强'), kind: 'call', occurredAt: now - 3 * DAY, durationMin: 20,
    summary: '电话提醒风险测评下周到期，预约复测', sentiment: 'neutral', topics: ['other'],
  })
  interactions++
  await crm.recordConsultation({
    clientId: id('陈志强'), occurredAt: now - 10 * DAY, topics: ['asset_allocation'],
    products: [{ name: '全球医药生物混合基金', kind: 'fund', riskLevel: 'R4' }],
    recommendations: ['本次产品超出等级判定存档；到期后可复评再议'],
    summary: '临近到期的产品讨论，按当时等级判定',
  })
  consultations++
  await crm.createTask({
    clientId: id('陈志强'), advisorId: lin.id, kind: 'risk_review',
    title: '陈志强风险测评复测（测评 7 天后到期）', dueAt: now + 5 * DAY, priority: 'high',
  })

  // ── Arc 3: 冯丽娜 walk-in (no assessment → missing-profile blocks, then a
  // booked assessment task keeps the story moving). ────────────────────────
  await crm.logInteraction({
    clientId: id('冯丽娜'), kind: 'email', occurredAt: now - 1 * DAY,
    summary: '发送产品资料与风险测评链接', sentiment: 'neutral', topics: ['education'],
  })
  interactions++
  await crm.recordConsultation({
    clientId: id('冯丽娜'), occurredAt: now - DAY, topics: ['insurance'],
    products: [{ name: '增额终身寿险·鑫享版', kind: 'insurance', riskLevel: 'R2' }],
    recommendations: ['先补齐风险测评再谈产品'],
    summary: '首次接触，未测评，仅记录需求',
  })
  consultations++
  await crm.createTask({
    clientId: id('冯丽娜'), advisorId: lin.id, kind: 'follow_up',
    title: '跟进冯丽娜完成风险测评', dueAt: now + 2 * DAY,
  })

  // ── Arc 4: 吴铁军's C5 matched consult → won structured deal. ───────────
  await crm.logInteraction({
    clientId: id('吴铁军'), kind: 'consultation', occurredAt: now - 12 * DAY, durationMin: 60,
    summary: '雪球结构专题咨询', sentiment: 'neutral', topics: ['asset_allocation'],
  })
  interactions++
  await crm.recordConsultation({
    clientId: id('吴铁军'), occurredAt: now - 12 * DAY, topics: ['asset_allocation'],
    products: [{ name: '雪球结构·中证500两年期', kind: 'structured', riskLevel: 'R5' }],
    recommendations: ['适当性匹配，可少量参与'],
    summary: '衍生品专题，判定匹配',
  })
  consultations++
  const snowball = await crm.createOpportunity({
    clientId: id('吴铁军'), productKind: 'structured', productName: '雪球结构·中证500两年期',
    amount: 3_000_000,
  })
  opportunities++
  await crm.moveOpportunity({ opportunityId: snowball.id, to: 'won' })

  // ── Arc 5: 冯丽娜's lost retirement deal (reasoned terminal state). ──────
  const retirement = await crm.createOpportunity({
    clientId: id('冯丽娜'), productKind: 'retirement', productName: '养老目标基金',
    amount: 100_000,
  })
  opportunities++
  await crm.moveOpportunity({ opportunityId: retirement.id, to: 'lost', closeReason: '客户暂缓投资计划' })

  // ── Arc 6: 机构客户 云启's cash-management relationship (report review →
  // negotiation deal → compliance task). ──────────────────────────────────
  await crm.logInteraction({
    clientId: id('杭州云启创业投资有限公司'), kind: 'report_review', occurredAt: now - 5 * DAY,
    summary: '陪同解读现金管理季报', sentiment: 'positive', topics: ['product_review'],
  })
  interactions++
  const cash = await crm.createOpportunity({
    clientId: id('杭州云启创业投资有限公司'), productKind: 'fund',
    productName: '现金宝货币市场基金A', amount: 8_000_000,
    expectedCloseAt: now + 20 * DAY, notes: '机构现金管理续作',
  })
  opportunities++
  await crm.moveOpportunity({ opportunityId: cash.id, to: 'negotiation', probability: 80 })
  await crm.createTask({
    clientId: id('杭州云启创业投资有限公司'), advisorId: zhang.id, kind: 'compliance_check',
    title: '云启机构适当性材料年检', dueAt: now - DAY, priority: 'urgent', notes: '已逾期，联系对接人补件',
  })

  // ── Arc 7: 恒信专户的债基赎回流失（有因流失）+ 周雅琴的沉睡唤醒任务。────
  const redeemed = await crm.createOpportunity({
    clientId: id('深圳前海恒信私募基金管理有限公司'), productKind: 'fund',
    productName: '稳健添利债券基金C', amount: 2_000_000,
  })
  opportunities++
  await crm.moveOpportunity({ opportunityId: redeemed.id, to: 'abandoned', closeReason: '专户赎回，资金自有安排' })
  await crm.createTask({
    clientId: id('周雅琴'), advisorId: zhang.id, kind: 'client_care',
    title: '周雅琴存款到期唤醒回访', dueAt: now - 2 * DAY, priority: 'normal', notes: '已逾期，存款本周期内到期',
  })

  // ── Volume layer: 20+ additional touchpoints so the interactions page reads
  // like a real month, distributed over clients and channels. ─────────────
  const VOLUME: readonly (readonly [string, InteractionRecordKind, string, number, Topic])[] = [
    ['李秀英', 'call', '电话沟通债基回撤，安抚客户情绪', 8, 'product_review'],
    ['李秀英', 'wechat', '推送固收+月度观点', 5, 'market_outlook'],
    ['郑淑华', 'meeting', '教育金规划面谈，测算留学缺口', 9, 'education'],
    ['郑淑华', 'email', '发送教育金方案修订稿', 2, 'education'],
    ['孙国庆', 'call', '转介绍破冰电话', 11, 'other'],
    ['刘梅', 'wechat', '确认定投扣款日与金额', 4, 'asset_allocation'],
    ['周雅琴', 'call', '存款到期前例行问候', 15, 'other'],
    ['卫东升', 'meeting', '股权减持资金再配置面谈', 7, 'asset_allocation'],
    ['卫东升', 'wechat', '发送打新日历提醒', 3, 'market_outlook'],
    ['华春燕', 'call', '定投扣款异常排查', 6, 'product_review'],
    ['华春燕', 'email', '发送定投协议变更指引', 1, 'other'],
    ['许小娟', 'meeting', '稳健型组合半年度检', 13, 'portfolio_rebalance'],
    ['严俊杰', 'wechat', '代发工资到账提醒与理财建议', 10, 'asset_allocation'],
    ['陶丽君', 'call', '开户资料补录沟通', 4, 'other'],
    ['金淑珍', 'meeting', '固收偏好组合讲解', 12, 'product_review'],
    ['邹雅雯', 'call', '定投加仓方案确认', 2, 'asset_allocation'],
    ['范春燕', 'wechat', '发送新客礼包说明', 3, 'other'],
    ['华德福', 'call', '企业经营周转与理财规划沟通', 14, 'tax'],
    ['曹子墨', 'meeting', '退休规划启动面谈', 6, 'retirement'],
    ['魏雅雯', 'wechat', '推送企业主专属产品简报', 5, 'product_review'],
    ['秦浩然', 'email', '发送代发工资理财指引', 9, 'asset_allocation'],
    ['深圳前海恒信私募基金管理有限公司', 'report_review', '专户月度对账单解读', 4, 'product_review'],
    ['杭州云启创业投资有限公司', 'wechat', '确认季报解读会议时间', 5, 'other'],
  ]
  for (const [name, kind, summary, daysAgo, topic] of VOLUME) {
    await crm.logInteraction({
      clientId: id(name),
      kind,
      summary,
      occurredAt: now - daysAgo * DAY,
      topics: [topic],
      sentiment: summary.includes('安抚') || summary.includes('异常') ? 'negative' : 'positive',
    })
    interactions++
  }

  // ── Extra consultations so the audit page passes 20 entries. ────────────
  const EXTRA_CONSULTS: readonly (readonly [string, string, ProductKind, ProductRisk, number, boolean])[] = [
    ['李秀英', '稳健添利债券基金C', 'fund', 'R2', 9, false],
    ['郑淑华', '年金保险·福瑞人生', 'insurance', 'R2', 9, true],
    ['刘梅', '现金宝货币市场基金A', 'fund', 'R1', 20, false],
    ['许小娟', '科技成长混合基金A', 'fund', 'R4', 13, true],
    ['严俊杰', '稳健添利债券基金C', 'fund', 'R2', 10, false],
    ['金淑珍', '中证红利低波ETF联接A', 'fund', 'R3', 12, false],
    ['邹雅雯', '全球医药生物混合基金', 'fund', 'R4', 2, true],
    ['华德福', '增额终身寿险·鑫享版', 'insurance', 'R2', 14, false],
    ['曹子墨', '养老目标基金', 'retirement', 'R3', 6, false],
    ['魏雅雯', '科技成长混合基金A', 'fund', 'R4', 5, true],
    ['孙国庆', '稳健添利债券基金C', 'fund', 'R2', 11, false],
    ['秦浩然', '现金宝货币市场基金A', 'fund', 'R1', 9, false],
    ['卫东升', '雪球结构·中证500两年期', 'structured', 'R5', 7, true],
    ['华春燕', '中证红利低波ETF联接A', 'fund', 'R3', 6, false],
    ['深圳前海恒信私募基金管理有限公司', '稳健添利债券基金C', 'fund', 'R2', 4, false],
    ['周雅琴', '现金宝货币市场基金A', 'fund', 'R1', 15, false],
    ['陶丽君', '养老目标基金', 'retirement', 'R3', 4, false],
  ]
  for (const [name, productName, kind, risk, daysAgo, followUp] of EXTRA_CONSULTS) {
    await crm.recordConsultation({
      clientId: id(name),
      occurredAt: now - daysAgo * DAY,
      topics: [kind === 'insurance' ? 'insurance' : kind === 'retirement' ? 'retirement' : 'product_review'],
      products: [{ name: productName, kind, riskLevel: risk }],
      recommendations: ['按适当性结论与客户确认后续安排'],
      followUpRequired: followUp,
      summary: '产品适当性评估',
    })
    consultations++
  }

  // ── Extra pipeline rows so the board passes 20 across stages. ───────────
  const EXTRA_DEALS: readonly (readonly [string, ProductKind, string, number, Stage])[] = [
    ['李秀英', 'fund', '稳健添利债券基金C', 400_000, 'proposal'],
    ['卫东升', 'structured', '雪球结构·中证500两年期', 2_500_000, 'negotiation'],
    ['华春燕', 'fund', '中证红利低波ETF联接A', 800_000, 'qualified'],
    ['许小娟', 'fund', '科技成长混合基金A', 300_000, 'new'],
    ['邹雅雯', 'fund', '全球医药生物混合基金', 500_000, 'qualified'],
    ['郑淑华', 'insurance', '年金保险·福瑞人生', 600_000, 'negotiation'],
    ['刘梅', 'insurance', '增额终身寿险·鑫享版', 200_000, 'new'],
    ['金淑珍', 'fund', '中证红利低波ETF联接A', 350_000, 'proposal'],
    ['曹子墨', 'retirement', '养老目标基金', 300_000, 'qualified'],
    ['魏雅雯', 'fund', '科技成长混合基金A', 450_000, 'new'],
    ['陶丽君', 'retirement', '养老目标基金', 250_000, 'new'],
    ['华德福', 'insurance', '增额终身寿险·鑫享版', 400_000, 'qualified'],
    ['秦浩然', 'fund', '现金宝货币市场基金A', 100_000, 'new'],
    ['孙国庆', 'insurance', '增额终身寿险·鑫享版', 150_000, 'new'],
    ['范春燕', 'fund', '现金宝货币市场基金A', 50_000, 'new'],
    ['王建国', 'insurance', '年金保险·福瑞人生', 500_000, 'new'],
  ]
  for (const [name, productKind, productName, amount, stage] of EXTRA_DEALS) {
    const deal = await crm.createOpportunity({
      clientId: id(name),
      productKind,
      productName,
      amount,
      stage,
      expectedCloseAt: now + 30 * DAY,
    })
    opportunities++
    // createOpportunity opens in `stage`; a later move only makes sense when
    // the narrative walked the deal forward (proposal → negotiation).
    if (stage === 'negotiation') {
      await crm.moveOpportunity({ opportunityId: deal.id, to: 'negotiation', probability: 75 })
    }
  }

  // ── Extra tasks so the agenda passes 20 across statuses and priorities. ──
  const EXTRA_TASKS: readonly (readonly [string, 'zhang' | 'lin', string, TaskKind, number, TaskPriority, string])[] = [
    ['王建国', 'zhang', '王建国组合成交后回访', 'client_care', 1, 'normal', '确认到账与份额'],
    ['吴铁军', 'lin', '吴铁军雪球票息观察', 'client_care', 10, 'normal', '票息观察点跟踪'],
    ['李秀英', 'zhang', '李秀英固收组合再平衡', 'meeting_prep', 6, 'high', ''],
    ['郑淑华', 'zhang', '教育金方案终稿确认', 'meeting_prep', 3, 'normal', ''],
    ['冯丽娜', 'lin', '冯丽娜测评链接跟进短信', 'follow_up', -1, 'urgent', '二次提醒'],
    ['刘梅', 'lin', '刘梅定投协议签署确认', 'document_delivery', 4, 'normal', ''],
    ['杭州云启创业投资有限公司', 'zhang', '云启现金管理续作协议', 'document_delivery', 8, 'high', ''],
    ['深圳前海恒信私募基金管理有限公司', 'lin', '恒信专户赎回后续资料归档', 'compliance_check', 5, 'normal', ''],
    ['周雅琴', 'zhang', '周雅琴资产盘点预约', 'meeting_prep', 7, 'low', ''],
    ['卫东升', 'lin', '卫东升减持资金到账核对', 'compliance_check', 2, 'high', ''],
    ['华春燕', 'zhang', '华春燕定投扣款修复回访', 'follow_up', -3, 'urgent', '连续两月扣款失败'],
    ['金淑珍', 'lin', '金淑珍半年度检材料准备', 'meeting_prep', 9, 'low', ''],
    ['许小娟', 'zhang', '许小娟风险测评更新提醒', 'risk_review', 12, 'normal', ''],
    ['曹子墨', 'zhang', '曹子墨养老金账户开立跟进', 'document_delivery', 5, 'normal', ''],
    ['陶丽君', 'zhang', '陶丽君双录文件核验', 'compliance_check', 6, 'normal', ''],
    ['邹雅雯', 'zhang', '邹雅雯加仓适当性复核', 'risk_review', 1, 'high', ''],
    ['魏雅雯', 'lin', '魏雅雯企业主方案二稿', 'meeting_prep', 11, 'normal', ''],
    ['华德福', 'lin', '华德福税务资料收集', 'document_delivery', 13, 'low', ''],
    ['秦浩然', 'zhang', '秦浩然代发客群活动邀约', 'client_care', 14, 'low', ''],
    ['孙国庆', 'lin', '孙国庆转介绍感谢回访', 'client_care', 3, 'normal', ''],
  ]
  let extraTasks = 0
  for (const [clientName, advisor, title, kind, daysFromNow, priority, notes] of EXTRA_TASKS) {
    await crm.createTask({
      clientId: id(clientName),
      advisorId: advisor === 'zhang' ? zhang.id : lin.id,
      kind,
      title,
      dueAt: now + daysFromNow * DAY,
      priority,
      ...(notes === '' ? {} : { notes }),
    })
    extraTasks++
  }

  return {
    advisors: 2,
    clients: ROSTER.length,
    interactions,
    consultations,
    opportunities,
    tasks: 7 + extraTasks,
  }
}

type InteractionRecordKind = 'consultation' | 'call' | 'wechat' | 'meeting' | 'email' | 'report_review'
type Topic = 'asset_allocation' | 'retirement' | 'tax' | 'insurance' | 'education' | 'market_outlook' | 'product_review' | 'portfolio_rebalance' | 'other'
type ProductKind = 'fund' | 'insurance' | 'structured' | 'retirement' | 'education' | 'tax' | 'advisory_fee'
type ProductRisk = 'R1' | 'R2' | 'R3' | 'R4' | 'R5'
type Stage = 'new' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost' | 'abandoned'
type TaskKind = 'follow_up' | 'meeting_prep' | 'risk_review' | 'compliance_check' | 'document_delivery' | 'report_delivery' | 'client_care'
type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'
