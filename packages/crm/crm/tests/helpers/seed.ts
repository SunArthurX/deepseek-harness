/**
 * Deterministic enterprise-scale seed data for the CRM tests: 4 advisors,
 * 60 clients, 150+ interactions, 25 consultations, 40 opportunities (all
 * stages, terminal deals closed through the real stage machine), and 30
 * tasks (12 overdue at the reference time) covering every suitability
 * verdict and profile status. The generator is fully deterministic (LCG
 * with a fixed seed), so analytics assertions can recompute expectations
 * from the returned records.
 *
 * The seed drives the REAL service API with the caller-provided clock
 * setter, so every committed record reflects the service's own rules
 * (expiry derivation, advisor resolution, stage defaults).
 */

import type CrmService from '../../src/index.ts'
import type {
  AdvisorRecord,
  ClientLifecycle,
  ClientRecord,
  ConsultationRecord,
  InteractionRecord,
  OpportunityRecord,
  ProductRiskLevel,
  RiskTolerance,
  TaskKind,
  TaskPriority,
  TaskRecord,
} from '../../src/types.ts'

/** One day in ms. */
export const DAY = 86_400_000

/** Reference "now" the whole seed is staged around: 2026-09-01T00:00:00Z. */
export const SEED_NOW = Date.UTC(2026, 8, 1)

/** Everything the seed committed, for recomputing expectations in tests. */
export interface SeedResult {
  readonly advisors: AdvisorRecord[]
  readonly clients: ClientRecord[]
  readonly interactions: InteractionRecord[]
  readonly consultations: ConsultationRecord[]
  readonly opportunities: OpportunityRecord[]
  readonly tasks: TaskRecord[]
}

/** Deterministic pseudo-random floats in [0, 1) — an LCG, no dependencies. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

interface AdvisorSpec {
  readonly name: string
  readonly team: string
  readonly licenseNo: string
  readonly specialties: AdvisorRecord['specialties']
}

const ADVISOR_SPECS: readonly AdvisorSpec[] = [
  { name: '张伟明', team: '财富管理一部', licenseNo: 'S14400002001', specialties: ['asset_allocation', 'retirement'] },
  { name: '林晓芳', team: '财富管理一部', licenseNo: 'S14400002002', specialties: ['insurance', 'education'] },
  { name: '王海涛', team: '财富管理二部', licenseNo: 'S14400002003', specialties: ['market_outlook', 'portfolio_rebalance'] },
  { name: '赵静怡', team: '私人银行部', licenseNo: 'S14400002004', specialties: ['tax', 'asset_allocation'] },
]

interface FeaturedClientSpec {
  readonly name: string
  readonly kind: ClientRecord['kind']
  readonly lifecycle: ClientLifecycle
  readonly tolerance?: RiskTolerance
  /** Days before SEED_NOW the assessment was taken; undefined with a tolerance seeds it at creation. */
  readonly assessedDaysAgo?: number
  readonly score?: number
  readonly aum: number
  readonly annualIncome: number
  readonly region: string
  readonly tags: readonly string[]
  readonly advisor: number
}

/**
 * Twelve hand-crafted clients whose assessment windows pin every profile
 * status at {@link SEED_NOW} under the test config's 730-day validity:
 * 王建国 valid, 李秀英 expiring (assessed 710 days back), 陈志强 expired
 * (800 days), 刘梅 and 冯丽娜 missing.
 */
const FEATURED_CLIENTS: readonly FeaturedClientSpec[] = [
  { name: '王建国', kind: 'individual', lifecycle: 'active', tolerance: 'C3', assessedDaysAgo: 10, score: 62, aum: 3_800_000, annualIncome: 850_000, region: '上海', tags: ['私行客户', '再平衡季度'], advisor: 0 },
  { name: '李秀英', kind: 'individual', lifecycle: 'active', tolerance: 'C2', assessedDaysAgo: 710, score: 45, aum: 1_250_000, annualIncome: 420_000, region: '北京', tags: ['稳健型', '固收偏好'], advisor: 0 },
  { name: '陈志强', kind: 'individual', lifecycle: 'active', tolerance: 'C4', assessedDaysAgo: 800, score: 78, aum: 5_600_000, annualIncome: 1_200_000, region: '深圳', tags: ['高净值'], advisor: 3 },
  { name: '刘梅', kind: 'individual', lifecycle: 'onboarding', tolerance: 'C3', aum: 300_000, annualIncome: 260_000, region: '杭州', tags: ['新客'], advisor: 1 },
  { name: '孙国庆', kind: 'individual', lifecycle: 'prospect', tolerance: 'C2', assessedDaysAgo: 40, score: 38, aum: 0, annualIncome: 180_000, region: '成都', tags: ['转介绍'], advisor: 1 },
  { name: '周雅琴', kind: 'individual', lifecycle: 'dormant', tolerance: 'C1', assessedDaysAgo: 700, score: 25, aum: 890_000, annualIncome: 0, region: '南京', tags: ['长尾', '存款到期'], advisor: 2 },
  { name: '吴铁军', kind: 'individual', lifecycle: 'active', tolerance: 'C5', assessedDaysAgo: 90, score: 92, aum: 9_200_000, annualIncome: 2_000_000, region: '上海', tags: ['私行客户', '衍生品'], advisor: 3 },
  { name: '郑淑华', kind: 'individual', lifecycle: 'active', tolerance: 'C3', assessedDaysAgo: 200, score: 60, aum: 1_760_000, annualIncome: 540_000, region: '广州', tags: ['教育金'], advisor: 1 },
  { name: '杭州云启创业投资有限公司', kind: 'institution', lifecycle: 'active', tolerance: 'C4', assessedDaysAgo: 55, score: 75, aum: 26_000_000, annualIncome: 0, region: '杭州', tags: ['机构客户', '现金管理'], advisor: 2 },
  { name: '冯丽娜', kind: 'individual', lifecycle: 'lead', aum: 0, annualIncome: 200_000, region: '武汉', tags: ['线上获客'], advisor: 2 },
  { name: '褚天明', kind: 'individual', lifecycle: 'lost', tolerance: 'C2', assessedDaysAgo: 300, score: 40, aum: 0, annualIncome: 150_000, region: '重庆', tags: ['竞对流失'], advisor: 0 },
  { name: '卫东升', kind: 'individual', lifecycle: 'active', tolerance: 'C4', assessedDaysAgo: 15, score: 80, aum: 4_300_000, annualIncome: 980_000, region: '北京', tags: ['私行客户', '股权减持'], advisor: 3 },
]

const GENERATED_SURNAMES = ['许', '何', '吕', '施', '朱', '孔', '曹', '严', '华', '金', '魏', '陶', '姜', '戚', '谢', '邹', '苏', '潘', '葛', '范', '彭', '鲁', '韦', '贾', '沈', '侯', '邵', '龚', '秦', '许']
const GENERATED_GIVEN = ['文轩', '雨桐', '子墨', '浩然', '欣怡', '梓萱', '俊杰', '思远', '梦琪', '天佑', '若曦', '志远', '雅雯', '承宇', '晓东', '丽君', '国栋', '淑珍', '建军', '红梅', '立群', '春燕', '永强', '小娟', '德福']
const REGIONS = ['上海', '北京', '深圳', '广州', '杭州', '成都', '南京', '苏州', '武汉', '西安', '长沙', '青岛', '天津', '厦门', '宁波', '无锡', '佛山', '东莞', '合肥', '郑州']
const TAG_POOL = ['稳健型', '进取型', '固收偏好', '基金定投', '私行客户', '长尾', '代发工资', '到期提醒', '转介绍', '线上获客', '企业主', '退休规划']
const LIFECYCLE_WEIGHTS: readonly (readonly [ClientLifecycle, number])[] = [
  ['lead', 8],
  ['prospect', 10],
  ['onboarding', 6],
  ['active', 48],
  ['dormant', 16],
  ['lost', 12],
]
const TOLERANCE_WEIGHTS: readonly (readonly [RiskTolerance, number])[] = [
  ['C1', 10],
  ['C2', 25],
  ['C3', 35],
  ['C4', 22],
  ['C5', 8],
]
const AUM_RANGES: readonly (readonly [number, number])[] = [
  [0, 0],
  [50_000, 300_000],
  [300_000, 1_000_000],
  [1_000_000, 3_000_000],
  [3_000_000, 10_000_000],
  [10_000_000, 50_000_000],
]

/** Epoch ms `n` days before the seed reference time. */
function daysAgo(n: number): number {
  return SEED_NOW - n * DAY
}

/** Deterministically pick one element; the pools are non-empty by construction. */
function pick<T>(items: readonly T[], random: () => number): T {
  const chosen = items[Math.floor(random() * items.length)]
  if (chosen === undefined) throw new Error('seed pool is empty')
  return chosen
}

/**
 * Total weight of one table, computed once per table. A WeakMap so per-run
 * arrays (the advisor roster) drop their cache entry with the array instead of
 * accumulating one entry per seed invocation.
 */
const weightedTotals = new WeakMap<readonly (readonly [unknown, number])[], number>()
function totalWeight(table: ReadonlyArray<readonly [unknown, number]>): number {
  const cached = weightedTotals.get(table)
  if (cached !== undefined) return cached
  const total = table.reduce((sum, [, weight]) => sum + weight, 0)
  weightedTotals.set(table, total)
  return total
}

/** Pick one weighted option. */
function weighted<T>(random: () => number, table: readonly (readonly [T, number])[]): T {
  let cursor = random() * totalWeight(table)
  for (const [value, weight] of table) {
    cursor -= weight
    if (cursor <= 0) return value
  }
  const last = table[table.length - 1]
  if (last === undefined) throw new Error('weighted table is empty')
  return last[0]
}

const INTERACTION_KINDS: readonly InteractionRecord['kind'][] = ['call', 'wechat', 'meeting', 'email', 'report_review', 'consultation']
const TOPIC_POOL: readonly ConsultationRecord['topics'][number][] = [
  'asset_allocation',
  'retirement',
  'tax',
  'insurance',
  'education',
  'market_outlook',
  'product_review',
  'portfolio_rebalance',
]

/** One shelf product with its documented risk level, mirroring a real advisory shelf. */
interface ShelfProduct {
  readonly name: string
  readonly kind: OpportunityRecord['productKind']
  readonly risk: ProductRiskLevel
  readonly minAmount: number
}

/** Product catalog used for consultations and opportunities. */
const PRODUCT_SHELF: readonly ShelfProduct[] = [
  { name: '现金宝货币市场基金A', kind: 'fund', risk: 'R1', minAmount: 1_000 },
  { name: '稳健添利债券基金C', kind: 'fund', risk: 'R2', minAmount: 10_000 },
  { name: '增额终身寿险·鑫享版', kind: 'insurance', risk: 'R2', minAmount: 100_000 },
  { name: '中证红利低波ETF联接A', kind: 'fund', risk: 'R3', minAmount: 10_000 },
  { name: '全球医药生物混合基金', kind: 'fund', risk: 'R4', minAmount: 50_000 },
  { name: '科技成长混合基金A', kind: 'fund', risk: 'R4', minAmount: 50_000 },
  { name: '雪球结构·中证500两年期', kind: 'structured', risk: 'R5', minAmount: 1_000_000 },
]

const SUMMARY_BY_KIND: Record<InteractionRecord['kind'], string> = {
  call: '电话沟通市场波动,安抚客户情绪',
  wechat: '微信解答产品申赎问题',
  meeting: '面谈回顾持仓并讨论调整方案',
  email: '发送月度资产报告',
  report_review: '陪同解读季报,确认再平衡意向',
  consultation: '投资顾问正式咨询,形成书面建议',
}

const TASK_KINDS: readonly TaskKind[] = [
  'follow_up',
  'meeting_prep',
  'risk_review',
  'compliance_check',
  'document_delivery',
  'report_delivery',
  'client_care',
]

const TASK_TITLES: Record<TaskKind, string> = {
  follow_up: '电话跟进上次咨询结论',
  meeting_prep: '准备下次面谈材料',
  risk_review: '预约风险测评更新',
  compliance_check: '核对适当性匹配材料',
  document_delivery: '递送签约文件',
  report_delivery: '发送季度资产报告',
  client_care: '生日关怀问候',
}

const PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent']

/** Close reasons keyed by terminal stage; `pick` keeps access total. */
const CLOSE_REASONS = [
  { stage: 'won', reason: '签约打款' },
  { stage: 'lost', reason: '选择了竞对方案' },
  { stage: 'abandoned', reason: '客户暂缓投资计划' },
] as const

const closeReasonFor = (stage: 'won' | 'lost' | 'abandoned'): string => {
  const entry = CLOSE_REASONS.find(row => row.stage === stage)
  if (entry === undefined) throw new Error(`no close reason for ${stage}`)
  return entry.reason
}

/**
 * Seed the full enterprise book through the real service API.
 * @param crm - The booted CRM service.
 * @param setTime - Test clock setter (e.g. `ms => vi.setSystemTime(ms)`); the
 * seed stages time around {@link SEED_NOW} and restores it at the end.
 * @returns every committed record, grouped by kind.
 */
export async function seedCrm(crm: CrmService, setTime: (ms: number) => void): Promise<SeedResult> {
  const random = lcg(20260901)

  const advisors: AdvisorRecord[] = []
  for (const spec of ADVISOR_SPECS) {
    advisors.push(await crm.registerAdvisor(spec))
  }
  const advisorAt = (index: number): AdvisorRecord => {
    const advisor = advisors[index]
    if (advisor === undefined) throw new Error(`seed advisor ${index} missing`)
    return advisor
  }

  const clients: ClientRecord[] = []
  for (const spec of FEATURED_CLIENTS) {
    const createdDaysAgo = 200 + Math.floor(random() * 400)
    setTime(SEED_NOW - createdDaysAgo * DAY)
    const client = await crm.createClient({
      name: spec.name,
      kind: spec.kind,
      lifecycle: spec.lifecycle,
      tags: spec.tags,
      advisorId: advisorAt(spec.advisor).id,
      contact: {
        region: spec.region,
        phone: `139${String(10_000_000 + Math.floor(random() * 89_999_999)).slice(0, 8)}`,
      },
      financial: {
        totalAum: spec.aum,
        annualIncome: spec.annualIncome,
        liquidAssets: Math.round(spec.aum * 0.4),
        currency: 'CNY',
      },
      ...(spec.kind === 'institution' ? { notes: '对公账户,资金划转走托管行' } : {}),
    })
    let committed = client
    if (spec.tolerance !== undefined) {
      const assessedAt = daysAgo(spec.assessedDaysAgo ?? createdDaysAgo)
      setTime(assessedAt)
      committed = await crm.updateClient(client.id, {
        riskProfile: { tolerance: spec.tolerance, ...(spec.score === undefined ? {} : { score: spec.score }) },
      })
    }
    clients.push(committed)
  }

  // 48 generated clients round the book out to 60.
  const usedNames = new Set(clients.map(client => client.name))
  for (let i = 0; i < 48; i += 1) {
    let name = `${pick(GENERATED_SURNAMES, random)}${pick(GENERATED_GIVEN, random)}`
    while (usedNames.has(name)) {
      name = `${pick(GENERATED_SURNAMES, random)}${pick(GENERATED_GIVEN, random)}`
    }
    usedNames.add(name)
    const advisor = pick(advisors, random)
    const [aumFloor, aumCeil] = pick(AUM_RANGES, random)
    const aum = Math.round((aumFloor + random() * (aumCeil - aumFloor)) / 1000) * 1000
    const createdDaysAgo = 30 + Math.floor(random() * 500)
    setTime(SEED_NOW - createdDaysAgo * DAY)
    const firstTag = pick(TAG_POOL, random)
    const secondTag = pick(TAG_POOL, random)
    const tags = secondTag === firstTag ? [firstTag] : [firstTag, secondTag]
    const client = await crm.createClient({
      name,
      kind: 'individual',
      lifecycle: weighted(random, LIFECYCLE_WEIGHTS),
      tags,
      advisorId: advisor.id,
      contact: { region: pick(REGIONS, random) },
      financial: { totalAum: aum, currency: 'CNY' },
    })
    let committed = client
    // 85% carry an assessment staged 20–900 days back, so valid, expiring,
    // and expired statuses all appear across the generated book.
    if (random() < 0.85) {
      const tolerance = weighted(random, TOLERANCE_WEIGHTS)
      const assessedDaysAgo = 20 + Math.floor(random() * 880)
      setTime(daysAgo(assessedDaysAgo))
      committed = await crm.updateClient(client.id, {
        riskProfile: { tolerance, score: 20 + Math.floor(random() * 75) },
      })
    }
    clients.push(committed)
  }

  // Interactions: featured clients get 4–6 touchpoints, generated clients
  // 2–3, staged over the last 180 days (170+ total).
  const interactions: InteractionRecord[] = []
  const featuredNames = new Set(FEATURED_CLIENTS.map(spec => spec.name))
  for (const client of clients) {
    const featured = featuredNames.has(client.name)
    const count = featured ? 4 + Math.floor(random() * 3) : 2 + Math.floor(random() * 2)
    for (let i = 0; i < count; i += 1) {
      const daysAgoCount = 1 + Math.floor(random() * 180)
      const occurredAt = daysAgo(daysAgoCount) - Math.floor(random() * 8) * 3_600_000
      setTime(occurredAt)
      const kind = pick(INTERACTION_KINDS, random)
      interactions.push(await crm.logInteraction({
        clientId: client.id,
        kind,
        occurredAt,
        ...(kind === 'meeting' || kind === 'consultation' ? { durationMin: 30 + Math.floor(random() * 60) } : {}),
        summary: SUMMARY_BY_KIND[kind],
        sentiment: random() < 0.15 ? 'negative' : random() < 0.6 ? 'positive' : 'neutral',
        topics: [pick(TOPIC_POOL, random)],
        ...(random() < 0.4 ? { nextStep: '下周电话跟进' } : {}),
      }))
    }
  }

  // Consultations: 25 over the first assessed clients. The featured spread
  // guarantees every verdict appears: C1/C2 clients meeting R3+ products
  // (product-exceeds-profile), 陈志强's expired C4 with the R5 snow-ball
  // structure (assessment-expired), R1/R2 products against live profiles
  // (matched); 冯丽娜/刘梅 stay unassessed for missing-profile in tests.
  const consultations: ConsultationRecord[] = []
  const consultable = clients.filter(client => client.riskProfile !== undefined).slice(0, 25)
  for (const client of consultable) {
    const consultDaysAgo = 3 + Math.floor(random() * 150)
    const occurredAt = daysAgo(consultDaysAgo)
    setTime(occurredAt)
    const first = pick(PRODUCT_SHELF, random)
    const picks = [first]
    if (random() < 0.4) {
      const second = pick(PRODUCT_SHELF, random)
      if (second !== first) picks.push(second)
    }
    consultations.push(await crm.recordConsultation({
      clientId: client.id,
      occurredAt,
      topics: [pick(TOPIC_POOL, random)],
      products: picks.map(product => ({ name: product.name, kind: product.kind, riskLevel: product.risk })),
      recommendations: [first.risk === 'R1' ? '保留应急现金,货基托管' : '按再平衡纪律分批建仓'],
      followUpRequired: random() < 0.5,
      summary: `年度回顾,讨论${picks.map(product => product.name).join('、')}`,
    }))
  }

  // Opportunities: 40 across every stage. Terminal targets are created in
  // 'new' then moved through the real stage machine (stamping closedAt and
  // closeReason), at a staged later time.
  const STAGE_PLAN: readonly OpportunityRecord['stage'][] = [
    ...Array<OpportunityRecord['stage']>(8).fill('new'),
    ...Array<OpportunityRecord['stage']>(7).fill('qualified'),
    ...Array<OpportunityRecord['stage']>(6).fill('proposal'),
    ...Array<OpportunityRecord['stage']>(5).fill('negotiation'),
    ...Array<OpportunityRecord['stage']>(7).fill('won'),
    ...Array<OpportunityRecord['stage']>(5).fill('lost'),
    ...Array<OpportunityRecord['stage']>(2).fill('abandoned'),
  ]
  const opportunities: OpportunityRecord[] = []
  for (let i = 0; i < STAGE_PLAN.length; i += 1) {
    const target = STAGE_PLAN[i] ?? 'new'
    const indexedClient = clients[i % clients.length]
    if (indexedClient === undefined) throw new Error(`seed client ${i} missing`)
    const client = indexedClient
    const product = pick(PRODUCT_SHELF, random)
    const createdDaysAgo = 30 + Math.floor(random() * 150)
    const createdAt = daysAgo(createdDaysAgo)
    setTime(createdAt)
    const multiplier = 1 + Math.floor(random() * 9)
    const created = await crm.createOpportunity({
      clientId: client.id,
      productKind: product.kind,
      productName: product.name,
      amount: product.minAmount * multiplier,
      expectedCloseAt: SEED_NOW + Math.floor(random() * 90) * DAY,
    })
    if (target === 'won' || target === 'lost' || target === 'abandoned') {
      const closedAt = createdAt + Math.floor(random() * 20 + 1) * DAY
      setTime(closedAt)
      opportunities.push(await crm.moveOpportunity({
        opportunityId: created.id,
        to: target,
        closeReason: closeReasonFor(target),
      }))
    } else {
      opportunities.push(created)
    }
  }

  // Tasks: 30 — the first 12 overdue at SEED_NOW, the rest due within 45 days.
  const tasks: TaskRecord[] = []
  for (let i = 0; i < 30; i += 1) {
    const client = pick(clients, random)
    const dueAt = i < 12
      ? SEED_NOW - (1 + Math.floor(random() * 20)) * DAY
      : SEED_NOW + Math.floor(random() * 45) * DAY
    setTime(SEED_NOW - Math.floor(random() * 10) * DAY)
    const kind = TASK_KINDS[i % TASK_KINDS.length] ?? 'follow_up'
    tasks.push(await crm.createTask({
      clientId: client.id,
      kind,
      title: TASK_TITLES[kind] ?? '电话跟进上次咨询结论',
      dueAt,
      priority: pick(PRIORITIES, random),
      ...(i < 12 ? { notes: '已逾期,优先处理' } : {}),
    }))
  }

  setTime(SEED_NOW)
  return { advisors, clients, interactions, consultations, opportunities, tasks }
}
