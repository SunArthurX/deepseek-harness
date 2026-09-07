/**
 * Gateway between the session-import console's JSON API and the
 * {@link SessionImportService}: HTTP verb + path segments → one service call →
 * one JSON value. Owns translation only; every business rule stays in
 * `dsh-session-import`. Response bodies are always
 * `{ ok: true, data } | { ok: false, error }` so the page never parses
 * status codes.
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

/** The routing table proper; every throw below becomes the error envelope. */
async function route(service: SessionImportService, request: ApiRequest): Promise<unknown> {
  const [resource, ...rest] = request.segments
  if (resource === 'providers') {
    if (request.method !== 'GET') throw new Error('providers: GET only')
    return CONSOLE_PROVIDERS
  }
  if (resource === 'sources') {
    if (request.method !== 'GET') throw new Error('sources: GET only')
    const provider = request.query.get('provider')
    const query = request.query.get('query') ?? undefined
    const limitRaw = request.query.get('limit')
    const limit = limitRaw === null ? undefined : Number(limitRaw)
    if (provider !== null && !isProvider(provider)) throw new Error(`unknown provider "${provider}"`)
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('limit must be a non-negative integer')
    const filtered: { provider?: ExternalProviderId; query?: string; limit?: number } = {}
    if (provider !== null) filtered.provider = provider
    if (query !== undefined && query.length > 0) filtered.query = query
    if (limit !== undefined) filtered.limit = limit
    return service.listSources(filtered)
  }
  if (resource === 'preview') {
    if (request.method !== 'GET') throw new Error('preview: GET only')
    if (rest.length > 0) throw new Error('preview: no sub-paths')
    const provider = request.query.get('provider')
    const sourceId = request.query.get('sourceId')
    if (provider === null) throw new Error('preview: `provider` is required')
    if (!isProvider(provider)) throw new Error(`unknown provider "${provider}"`)
    if (sourceId === null || sourceId.length === 0) throw new Error('preview: `sourceId` is required')
    const maxRaw = request.query.get('maxMessages')
    const maxMessages = maxRaw === null ? undefined : Number(maxRaw)
    if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages < 1)) {
      throw new Error('maxMessages must be a positive integer')
    }
    return service.previewSource({ provider, sourceId }, { ...(maxMessages !== undefined ? { maxMessages } : {}) })
  }
  if (resource === 'sync') {
    if (request.method !== 'POST') throw new Error('sync: POST only')
    if (rest.length > 0) throw new Error('sync: no sub-paths')
    const provider = request.body === undefined ? undefined : optionalString(request.body, 'provider')
    if (provider !== undefined && !isProvider(provider)) throw new Error(`unknown provider "${provider}"`)
    const limitRaw = request.body === undefined ? undefined : request.body['limit']
    if (limitRaw !== undefined && (!Number.isSafeInteger(limitRaw) || typeof limitRaw !== 'number' || limitRaw < 0)) {
      throw new Error('sync: `limit` must be a non-negative integer')
    }
    return service.syncAll({
      ...(provider !== undefined ? { provider } : {}),
      ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
    })
  }
  if (resource === 'import') {
    if (request.method !== 'POST') throw new Error('import: POST only')
    if (rest.length > 0) throw new Error('import: no sub-paths')
    const provider = readProvider(request.body)
    const sourceId = readSourceId(request.body)
    const targetId = optionalString(request.body, 'targetId')
    const force = request.body !== undefined && request.body['force'] === true
    return service.importSource({
      provider,
      sourceId,
      ...(targetId !== undefined ? { targetId } : {}),
      ...(force ? { force: true } : {}),
    })
  }
  throw new Error(`unknown resource "${resource ?? ''}"`)
}

/** Whether a string names a provider the console knows. */
function isProvider(value: string): value is ExternalProviderId {
  return (CONSOLE_PROVIDERS as readonly string[]).includes(value)
}

/** Read the required provider field off a JSON body. */
function readProvider(body: Record<string, unknown> | undefined): ExternalProviderId {
  const value = optionalString(body, 'provider')
  if (value === undefined) throw new Error('import: `provider` is required')
  if (!isProvider(value)) throw new Error(`unknown provider "${value}"`)
  return value
}

/** Read the required sourceId field off a JSON body. */
function readSourceId(body: Record<string, unknown> | undefined): string {
  const value = optionalString(body, 'sourceId')
  if (value === undefined) throw new Error('import: `sourceId` is required')
  return value
}

/** Read one optional non-empty string field off a JSON body. */
function optionalString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body === undefined ? undefined : body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`import: \`${key}\` must be a non-empty string`)
  return value
}
