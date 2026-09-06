/**
 * Browser management console for the investment-advisory CRM (`console`
 * plugin): serves one single-page admin UI and a read/write JSON API over the
 * harness web server's route registry. The gateway owns translation only —
 * HTTP to service calls and back — while every business rule stays in
 * `dsh-crm`. Mount it beside `dsh-crm` in a profile that carries the web
 * server; without either dependency the plugin stays dormant.
 * @module @deepseek-ai/dsh-crm-console
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import { AdvisorId, ClientId, OpportunityId, TaskId } from '@deepseek-ai/dsh-crm'
import type CrmService from '@deepseek-ai/dsh-crm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CONSOLE_PAGE } from './page.ts'

export const name = 'crm-console'
export const inject = ['webServer', 'crm']

/** One parsed API request: method, path segments, and the decoded query. */
interface ApiRequest {
  readonly method: string
  /** Path segments under the API prefix; empty for the prefix itself. */
  readonly segments: readonly string[]
  readonly query: URLSearchParams
  readonly body: Record<string, unknown> | undefined
}


/**
 * Render one dispatch failure for the wire. Every reachable failure — field
 * validation, closed-vocabulary rejection, service typed errors, body parse —
 * is an Error; the cast records that invariant.
 */
function errorMessage(error: unknown): string {
  return (error as Error).message
}

/** The console's fixed mount paths; a composition-level contract. */
const PAGE_PATH = '/crm-console'
const API_PREFIX = '/crm-console/api'

/*
 * Wire-boundary vocabularies: typed as the service unions so a drift on either
 * side fails compilation here, and used to validate every inbound enum before
 * it crosses into the service (HTTP is an untrusted wire boundary).
 */
const LIFECYCLES: readonly ('lead' | 'prospect' | 'onboarding' | 'active' | 'dormant' | 'lost')[] = [
  'lead', 'prospect', 'onboarding', 'active', 'dormant', 'lost',
]
const TOLERANCES: readonly ('C1' | 'C2' | 'C3' | 'C4' | 'C5')[] = ['C1', 'C2', 'C3', 'C4', 'C5']
const INTERACTION_KINDS: readonly ('consultation' | 'call' | 'wechat' | 'meeting' | 'email' | 'report_review')[] = [
  'consultation', 'call', 'wechat', 'meeting', 'email', 'report_review',
]
const TOPICS: readonly ('asset_allocation' | 'retirement' | 'tax' | 'insurance' | 'education' | 'market_outlook' | 'product_review' | 'portfolio_rebalance' | 'other')[] = [
  'asset_allocation', 'retirement', 'tax', 'insurance', 'education',
  'market_outlook', 'product_review', 'portfolio_rebalance', 'other',
]
const PRODUCT_KINDS: readonly ('fund' | 'insurance' | 'structured' | 'retirement' | 'education' | 'tax' | 'advisory_fee')[] = [
  'fund', 'insurance', 'structured', 'retirement', 'education', 'tax', 'advisory_fee',
]
const STAGES: readonly ('new' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost' | 'abandoned')[] = [
  'new', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'abandoned',
]
const TASK_STATUSES: readonly ('open' | 'done' | 'cancelled')[] = ['open', 'done', 'cancelled']
const TASK_KINDS: readonly ('follow_up' | 'meeting_prep' | 'risk_review' | 'compliance_check' | 'document_delivery' | 'report_delivery' | 'client_care')[] = [
  'follow_up', 'meeting_prep', 'risk_review', 'compliance_check',
  'document_delivery', 'report_delivery', 'client_care',
]
const PRIORITIES: readonly ('low' | 'normal' | 'high' | 'urgent')[] = ['low', 'normal', 'high', 'urgent']

type Lifecycle = (typeof LIFECYCLES)[number]

/** Require one string field to be a member of a closed vocabulary. */
function memberOf<T extends string>(value: string | undefined, values: readonly T[], what: string): T {
  if (value === undefined) throw new Error(`missing field '${what}'`)
  if (!values.includes(value as T)) throw new Error(`field '${what}' must be one of ${values.join(', ')}`)
  return value as T
}

/** Read one JSON request body; an absent body resolves to undefined. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: string[] = []
  // The utf8-decoded request stream yields strings.
  for await (const chunk of req) {
    chunks.push(String(chunk))
  }
  if (chunks.length === 0) return undefined
  const parsed: unknown = JSON.parse(chunks.join(''))
  return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
}

/** Body field readers capturing once so conditional spreads stay narrowed. */
interface BodyReader {
  str(key: string): string | undefined
  num(key: string): number | undefined
  bool(key: string): boolean | undefined
  list(key: string): readonly string[] | undefined
  requireStr(key: string): string
  /** One validated member of a closed vocabulary, or undefined when absent. */
  member<T extends string>(key: string, values: readonly T[]): T | undefined
  /** A validated list over a closed vocabulary, or undefined when absent. */
  memberList<T extends string>(key: string, values: readonly T[]): readonly T[] | undefined
}

/** Bind the readers over one parsed body. */
function bodyReader(body: Record<string, unknown>): BodyReader {
  return {
    str: key => (typeof body[key] === 'string' ? body[key] : undefined),
    num: key => (typeof body[key] === 'number' && Number.isFinite(body[key]) ? body[key] : undefined),
    bool: key => (typeof body[key] === 'boolean' ? body[key] : undefined),
    list: key => (Array.isArray(body[key]) ? (body[key] as unknown[]).every(item => typeof item === 'string') ? body[key] as string[] : undefined : undefined),
    requireStr: (key) => {
      const value = typeof body[key] === 'string' ? body[key] : undefined
      if (value === undefined) throw new Error(`missing field '${key}'`)
      return value
    },
    member: (key, values) => {
      const value = typeof body[key] === 'string' ? body[key] : undefined
      return value === undefined ? undefined : memberOf(value, values, key)
    },
    memberList: (key, values) => {
      const raw = body[key]
      if (!Array.isArray(raw)) return undefined
      return raw.map(item => memberOf(typeof item === 'string' ? item : undefined, values, key))
    },
  }
}

/** Query field readers capturing once so conditional spreads stay narrowed. */
function queryStr(q: URLSearchParams, key: string): string | undefined {
  const raw = q.get(key)
  return raw === null ? undefined : raw
}

function queryNum(q: URLSearchParams, key: string): number | undefined {
  const raw = queryStr(q, key)
  const parsed = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Dispatch one API request against the CRM service.
 * @param service - The durable CRM service.
 * @param request - The parsed request.
 * @returns the JSON-serializable response body.
 */
function dispatchApi(service: CrmService, request: ApiRequest): unknown {
  const [head, second, third] = request.segments
  const q = request.query
  const b = bodyReader(request.body ?? {})

  switch (head) {
    case 'demo-data':
      if (request.method !== 'POST') throw new Error('demo-data requires POST')
      return service.loadDemoData()
    case 'overview':
      return {
        pipeline: service.pipelineSnapshot(),
        book: service.bookSnapshot(),
        taskLoad: service.taskLoad(),
      }
    case 'advisors': {
      if (request.method === 'POST') {
        const team = b.str('team')
        const licenseNo = b.str('licenseNo')
        const specialties = b.memberList('specialties', TOPICS)
        const active = b.bool('active')
        return service.registerAdvisor({
          name: b.requireStr('name'),
          ...(team === undefined ? {} : { team }),
          ...(licenseNo === undefined ? {} : { licenseNo }),
          ...(specialties === undefined ? {} : { specialties }),
          ...(active === undefined ? {} : { active }),
        })
      }
      return service.listAdvisors()
    }
    case 'clients': {
      if (second === undefined) {
        if (request.method === 'POST') {
          const advisorId = b.str('advisorId')
          const tolerance = b.member('tolerance', TOLERANCES)
          const score = b.num('score')
          const region = b.str('region')
          const totalAum = b.num('totalAum')
          const tags = b.list('tags')
          return service.createClient({
            name: b.requireStr('name'),
            kind: b.requireStr('kind') as 'individual' | 'institution',
            ...(b.member('lifecycle', LIFECYCLES) === undefined ? {} : { lifecycle: b.member('lifecycle', LIFECYCLES) as Lifecycle }),
            ...(advisorId === undefined ? {} : { advisorId: AdvisorId(advisorId) }),
            ...(tolerance === undefined ? {} : {
              riskProfile: {
                tolerance,
                ...(score === undefined ? {} : { score }),
              },
            }),
            ...(region === undefined ? {} : { contact: { region } }),
            ...(totalAum === undefined ? {} : { financial: { totalAum, currency: 'CNY' } }),
            ...(tags === undefined ? {} : { tags }),
          })
        }
        const query = queryStr(q, 'query')
        const kind = queryStr(q, 'kind') === undefined ? undefined : memberOf(queryStr(q, 'kind'), ['individual', 'institution'] as const, 'kind')
        const lifecycle = queryStr(q, 'lifecycle') === undefined ? undefined : memberOf(queryStr(q, 'lifecycle'), LIFECYCLES, 'lifecycle')
        const tolerance = queryStr(q, 'tolerance') === undefined ? undefined : memberOf(queryStr(q, 'tolerance'), TOLERANCES, 'tolerance')
        const tag = queryStr(q, 'tag')
        const advisorId = queryStr(q, 'advisorId')
        const limit = queryNum(q, 'limit')
        return service.searchClients({
          ...(query === undefined ? {} : { query }),
          ...(kind === undefined ? {} : { kind }),
          ...(lifecycle === undefined ? {} : { lifecycle }),
          ...(tolerance === undefined ? {} : { tolerance }),
          ...(tag === undefined ? {} : { tag }),
          ...(advisorId === undefined ? {} : { advisorId: AdvisorId(advisorId) }),
          ...(limit === undefined ? {} : { limit }),
        })
      }
      if (request.method === 'PATCH') {
        const lifecycle = b.member('lifecycle', LIFECYCLES)
        const tolerance = b.member('tolerance', TOLERANCES)
        const score = b.num('score')
        const region = b.str('region')
        return service.updateClient(ClientId(second), {
          ...(lifecycle === undefined ? {} : { lifecycle }),
          ...(tolerance === undefined ? {} : {
            riskProfile: {
              tolerance,
              ...(score === undefined ? {} : { score }),
            },
          }),
          ...(region === undefined ? {} : { contact: { region } }),
        })
      }
      return service.clientBook(ClientId(second))
    }
    case 'interactions': {
      if (request.method === 'POST') {
        const kind = b.member('kind', INTERACTION_KINDS)
        const topics = b.memberList('topics', TOPICS)
        return service.logInteraction({
          clientId: ClientId(b.requireStr('clientId')),
          summary: b.requireStr('summary'),
          ...(kind === undefined ? {} : { kind }),
          ...(topics === undefined ? {} : { topics }),
        })
      }
      const clientId = queryStr(q, 'clientId')
      const topic = queryStr(q, 'topic') === undefined ? undefined : memberOf(queryStr(q, 'topic'), TOPICS, 'topic')
      const limit = queryNum(q, 'limit')
      return service.listInteractions({
        ...(clientId === undefined ? {} : { clientId: ClientId(clientId) }),
        ...(topic === undefined ? {} : { topic }),
        ...(limit === undefined ? {} : { limit }),
      })
    }
    case 'consultations': {
      if (request.method === 'POST') {
        const topics = b.memberList('topics', TOPICS)
        const products = b.list('products')
        const recommendations = b.list('recommendations')
        const followUpRequired = b.bool('followUpRequired')
        const summary = b.str('summary')
        return service.recordConsultation({
          clientId: ClientId(b.requireStr('clientId')),
          ...(topics === undefined ? {} : { topics }),
          ...(products === undefined ? {} : { products: products.map(product => JSON.parse(product) as never) }),
          ...(recommendations === undefined ? {} : { recommendations }),
          ...(followUpRequired === undefined ? {} : { followUpRequired }),
          ...(summary === undefined ? {} : { summary }),
        })
      }
      const clientId = queryStr(q, 'clientId')
      const limit = queryNum(q, 'limit')
      return service.listConsultations(
        clientId === undefined ? undefined : ClientId(clientId),
        limit,
      )
    }
    case 'opportunities': {
      if (second === undefined) {
        if (request.method === 'POST') {
          const productName = b.str('productName')
          const amount = b.num('amount')
          if (amount === undefined) throw new Error("missing field 'amount'")
          return service.createOpportunity({
            clientId: ClientId(b.requireStr('clientId')),
            productKind: memberOf(b.str('productKind'), PRODUCT_KINDS, 'productKind'),
            amount,
            ...(productName === undefined ? {} : { productName }),
          })
        }
        const clientId = queryStr(q, 'clientId')
        const stage = queryStr(q, 'stage') === undefined ? undefined : memberOf(queryStr(q, 'stage'), STAGES, 'stage')
        const limit = queryNum(q, 'limit')
        return service.listOpportunities({
          ...(clientId === undefined ? {} : { clientId: ClientId(clientId) }),
          ...(stage === undefined ? {} : { stage }),
          ...(limit === undefined ? {} : { limit }),
        })
      }
      if (third === 'move' && request.method === 'POST') {
        const probability = b.num('probability')
        const closeReason = b.str('closeReason')
        return service.moveOpportunity({
          opportunityId: OpportunityId(second),
          to: memberOf(b.str('to'), STAGES, 'to'),
          ...(probability === undefined ? {} : { probability }),
          ...(closeReason === undefined ? {} : { closeReason }),
        })
      }
      return service.getOpportunity(OpportunityId(second))
    }
    case 'tasks': {
      if (second === undefined) {
        if (request.method === 'POST') {
          const advisorId = b.str('advisorId')
          const clientId = b.str('clientId')
          const priority = b.member('priority', PRIORITIES)
          const createKind = b.member('kind', TASK_KINDS)
          const dueAt = b.num('dueAt')
          if (dueAt === undefined) throw new Error("missing field 'dueAt'")
          return service.createTask({
            title: b.requireStr('title'),
            dueAt,
            ...(advisorId === undefined ? {} : { advisorId: AdvisorId(advisorId) }),
            ...(clientId === undefined ? {} : { clientId: ClientId(clientId) }),
            ...(createKind === undefined ? {} : { kind: createKind }),
            ...(priority === undefined ? {} : { priority }),
          })
        }
        const clientId = queryStr(q, 'clientId')
        const status = queryStr(q, 'status') === undefined ? undefined : memberOf(queryStr(q, 'status'), TASK_STATUSES, 'status')
        const taskKind = queryStr(q, 'kind') === undefined ? undefined : memberOf(queryStr(q, 'kind'), TASK_KINDS, 'kind')
        const limit = queryNum(q, 'limit')
        return service.listTasks({
          ...(clientId === undefined ? {} : { clientId: ClientId(clientId) }),
          ...(status === undefined ? {} : { status }),
          ...(taskKind === undefined ? {} : { kind: taskKind }),
          ...(q.get('overdue') === 'true' ? { overdue: true } : {}),
          ...(limit === undefined ? {} : { limit }),
        })
      }
      if (request.method !== 'POST') {
        return service.listTasks({ clientId: ClientId(second) })
      }
      if (third === 'complete') return service.completeTask(TaskId(second))
      if (third === 'cancel') return service.cancelTask(TaskId(second))
      if (third === 'reschedule') {
        const dueAt = b.num('dueAt')
        if (dueAt === undefined) throw new Error("missing field 'dueAt'")
        return service.rescheduleTask(TaskId(second), dueAt)
      }
      throw new Error(`unknown task action '${third ?? ''}'`)
    }
    case 'audit': {
      const clientId = queryStr(q, 'clientId')
      const advisorId = queryStr(q, 'advisorId')
      return service.suitabilityAudit(
        clientId === undefined ? undefined : ClientId(clientId),
        queryNum(q, 'limit'),
        advisorId === undefined ? undefined : AdvisorId(advisorId),
      )
    }
    default:
      throw new Error(`unknown API resource '${head ?? ''}'`)
  }
}

/**
 * Register the console page route and the API prefix route on the web server.
 * @param ctx - Registrant context carrying `webServer` and `crm`.
 */
export function apply(ctx: Context): void {
  const service = ctx.crm
  const disposePage = ctx.webServer.register({
    kind: 'exact',
    path: PAGE_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(CONSOLE_PAGE)
    },
  })
  const disposeApi = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
           requests; the fallback only satisfies the node typings. */
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = url.pathname
          .slice(API_PREFIX.length)
          .split('/')
          .filter(segment => segment !== '')
        const body = req.method === 'POST' || req.method === 'PATCH'
          ? await readJsonBody(req)
          : undefined
        const request: ApiRequest = {
          /* v8 ignore next -- `?? 'GET'` arm: node:http always sets the method. */
          method: req.method ?? 'GET',
          segments,
          query: url.searchParams,
          body,
        }
        // Mutations resolve to promises; reads are sync values — await both.
        const result = await dispatchApi(service, request)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result ?? null))
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: errorMessage(error) }))
      }
    },
  })
  ctx.effect(() => () => {
    disposeApi()
    disposePage()
  }, 'crm-console.routes')
}
