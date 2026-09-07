/**
 * Gateway between the session-import console's JSON API and the
 * {@link SessionImportService}: HTTP verb + path segments → one service call →
 * one JSON value. Owns translation only; every business rule stays in
 * `dsh-session-import`. Response bodies are always
 * `{ ok: true, data } | { ok: false, error }` so the page never parses
 * status codes.
 *
 * The dispatch table is data, not a chain: each entry declares its allowed
 * method, whether sub-paths are accepted, the query/body parsers, and the
 * service call. Adding an endpoint is one new entry — no central edit.
 * @module @deepseek-ai/dsh-session-import-console/api
 */

import SessionImportService, { type ExternalProviderId } from '@deepseek-ai/dsh-session-import'

/** One parsed API request: method, path segments, decoded query, and decoded body. */
export interface ApiRequest {
  readonly method: string
  /** Path segments under the API prefix; empty for the prefix itself. */
  readonly segments: readonly string[]
  readonly query: URLSearchParams
  readonly body?: Record<string, unknown> | undefined
}

/** The one response envelope every endpoint answers with. */
export interface ApiResponse {
  readonly ok: boolean
  readonly data?: unknown
  readonly error?: string
}

/** The providers the console offers as tabs; the service is the authority. */
export const CONSOLE_PROVIDERS: readonly ExternalProviderId[] = ['claude-code', 'codex', 'zcode', 'minimax']

/** One resource name as it appears in the URL after `/api/`. */
type Resource = 'providers' | 'sources' | 'preview' | 'sync' | 'import'

/** The query and body arguments a `handle` function sees. */
interface ParsedRequest {
  readonly query: unknown
  readonly body: unknown
}

/**
 * One declarative entry of the dispatch table. The query/body parsers run
 * before `handle`; their return values are the typed arguments the service
 * call sees. Anything they `throw` becomes the error envelope.
 */
interface RouteHandler {
  readonly method: 'GET' | 'POST'
  readonly exact: boolean
  readonly parseQuery?: (query: URLSearchParams) => unknown
  readonly parseBody?: (body: Record<string, unknown> | undefined) => unknown
  readonly handle: (service: SessionImportService, parsed: ParsedRequest) => Promise<unknown>
}

/**
 * Route one API request to a service call.
 * @param service - the session-import service the console mounts beside.
 * @param request - the parsed HTTP request.
 * @returns the response envelope; a rejected promise never escapes dispatch.
 */
export async function dispatchApi(service: SessionImportService, request: ApiRequest): Promise<ApiResponse> {
  try {
    return { ok: true, data: await route(service, request) }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Look up the table entry, validate the method/path, run parsers, and call the handler. */
function route(service: SessionImportService, request: ApiRequest): Promise<unknown> {
  const [resource, ...rest] = request.segments
  if (resource === undefined) throw new Error('unknown resource ""')
  const entry = ROUTES[resource as Resource]
  if (request.method !== entry.method) throw new Error(`${resource}: ${entry.method} only`)
  if (entry.exact && rest.length > 0) throw new Error(`${resource}: no sub-paths`)
  const query = entry.parseQuery !== undefined ? entry.parseQuery(request.query) : undefined
  const body = entry.parseBody !== undefined ? entry.parseBody(request.body) : undefined
  return entry.handle(service, { query, body })
}

/** The dispatch table proper; every throw below becomes the error envelope. */
const ROUTES: Record<Resource, RouteHandler> = {
  providers: {
    method: 'GET',
    exact: true,
    handle: () => Promise.resolve(CONSOLE_PROVIDERS),
  },
  sources: {
    method: 'GET',
    exact: true,
    parseQuery: parseSourcesQuery,
    handle: (service, { query }) => service.listSources(query as Parameters<SessionImportService['listSources']>[0]),
  },
  preview: {
    method: 'GET',
    exact: true,
    parseQuery: parsePreviewQuery,
    handle: (service, { query }) => {
      const q = query as PreviewQuery
      return service.previewSource(
        { provider: q.provider, sourceId: q.sourceId },
        { ...(q.maxMessages !== undefined ? { maxMessages: q.maxMessages } : {}) },
      )
    },
  },
  sync: {
    method: 'POST',
    exact: true,
    parseBody: parseSyncBody,
    handle: (service, { body }) => service.syncAll(body as Parameters<SessionImportService['syncAll']>[0]),
  },
  import: {
    method: 'POST',
    exact: true,
    parseBody: parseImportBody,
    handle: (service, { body }) => service.importSource(body as Parameters<SessionImportService['importSource']>[0]),
  },
}

/* ── Typed parse-result shapes, used by the table handlers above. ── */

interface SourcesQuery {
  readonly provider?: ExternalProviderId
  readonly query?: string
  readonly limit?: number
}

interface PreviewQuery {
  readonly provider: ExternalProviderId
  readonly sourceId: string
  readonly maxMessages?: number
}

interface SyncBody {
  readonly provider?: ExternalProviderId
  readonly limit?: number
}

interface ImportBody {
  readonly provider: ExternalProviderId
  readonly sourceId: string
  readonly targetId?: string
  readonly force?: true
}

/* ── Query / body parsers. Each throws on invalid input; the message is the API's error string. ── */

function parseSourcesQuery(query: URLSearchParams): SourcesQuery {
  const providerRaw = query.get('provider')
  const queryText = query.get('query') ?? undefined
  const limitRaw = query.get('limit')
  const limit = limitRaw === null ? undefined : Number(limitRaw)
  if (providerRaw !== null && !isProvider(providerRaw)) throw new Error(`unknown provider "${providerRaw}"`)
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('limit must be a non-negative integer')
  }
  return {
    ...(providerRaw !== null ? { provider: providerRaw } : {}),
    ...(queryText !== undefined && queryText.length > 0 ? { query: queryText } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
}

function parsePreviewQuery(query: URLSearchParams): PreviewQuery {
  const provider = query.get('provider')
  if (provider === null) throw new Error('preview: `provider` is required')
  if (!isProvider(provider)) throw new Error(`unknown provider "${provider}"`)
  const sourceId = query.get('sourceId')
  if (sourceId === null || sourceId.length === 0) throw new Error('preview: `sourceId` is required')
  const maxRaw = query.get('maxMessages')
  const maxMessages = maxRaw === null ? undefined : Number(maxRaw)
  if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages < 1)) {
    throw new Error('maxMessages must be a positive integer')
  }
  return { provider, sourceId, ...(maxMessages !== undefined ? { maxMessages } : {}) }
}

function parseSyncBody(body: Record<string, unknown> | undefined): SyncBody {
  const provider = body === undefined ? undefined : optionalString(body, 'provider')
  if (provider !== undefined && !isProvider(provider)) throw new Error(`unknown provider "${provider}"`)
  const limitRaw = body === undefined ? undefined : body['limit']
  if (limitRaw !== undefined && (typeof limitRaw !== 'number' || !Number.isSafeInteger(limitRaw) || limitRaw < 0)) {
    throw new Error('sync: `limit` must be a non-negative integer')
  }
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(typeof limitRaw === 'number' ? { limit: limitRaw } : {}),
  }
}

function parseImportBody(body: Record<string, unknown> | undefined): ImportBody {
  const providerRaw = body === undefined ? undefined : optionalString(body, 'provider')
  if (providerRaw === undefined) throw new Error('import: `provider` is required')
  if (!isProvider(providerRaw)) throw new Error(`unknown provider "${providerRaw}"`)
  const sourceId = body === undefined ? undefined : optionalString(body, 'sourceId')
  if (sourceId === undefined) throw new Error('import: `sourceId` is required')
  const targetId = body === undefined ? undefined : optionalString(body, 'targetId')
  const force = body !== undefined && body['force'] === true
  return {
    provider: providerRaw,
    sourceId,
    ...(targetId !== undefined ? { targetId } : {}),
    ...(force ? { force: true } : {}),
  }
}

/** Whether a string names a provider the console knows. */
function isProvider(value: string): value is ExternalProviderId {
  return (CONSOLE_PROVIDERS as readonly string[]).includes(value)
}

/** Read one optional non-empty string field off a JSON body. */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`import: \`${key}\` must be a non-empty string`)
  return value
}
