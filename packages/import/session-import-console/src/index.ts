/**
 * Browser management console for session import (`session-import-console`
 * plugin): serves one single-page admin UI and a read/write JSON API over the
 * harness web server's route registry. The gateway owns translation only —
 * HTTP to service calls and back — while every business rule stays in
 * `dsh-session-import`. Mount it beside `dsh-session-import` in a profile
 * that carries the web server; without either dependency the plugin stays
 * dormant.
 * @module @deepseek-ai/dsh-session-import-console
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import { dispatchApi, type ApiResponse } from './api.ts'
import { CONSOLE_PAGE } from './page.ts'

export const name = 'session-import-console'
export const inject = ['webServer', 'sessionImport']

/** The console's fixed mount paths; a composition-level contract. */
const PAGE_PATH = '/session-import-console'
const API_PREFIX = '/session-import-console/api'

export { dispatchApi } from './api.ts'
export { CONSOLE_PROVIDERS, type ApiRequest, type ApiResponse } from './api.ts'
export { CONSOLE_PAGE } from './page.ts'

/**
 * Serve the console page and its JSON API on the harness web server.
 * @param ctx - registrant context carrying `webServer` and `sessionImport`.
 */
/** The context surface this plugin injects, structurally. */
interface ConsoleContext extends Context {
  readonly webServer: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }) => void | Promise<void> }): () => void
  }
  readonly sessionImport: import('@deepseek-ai/dsh-session-import').default
}

export function apply(ctx: ConsoleContext): void {
  const service = ctx.sessionImport
  ctx.webServer.register({
    kind: 'exact',
    path: PAGE_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(CONSOLE_PAGE)
    },
  })
  ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      // The whole API branch answers through the envelope — body decode
      // failures included — so the page never sees a bare status code.
      let result: ApiResponse
      try {
        // node:http always populates `url`/`method` on server requests.
        /* v8 ignore next -- node invariant: req.url is always set */
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = url.pathname
          .slice(API_PREFIX.length)
          .split('/')
          .filter(segment => segment !== '')
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined
        result = await dispatchApi(service, {
          /* v8 ignore next -- node invariant: req.method is always set */
          method: req.method ?? 'GET',
          segments,
          query: url.searchParams,
          ...(body !== undefined ? { body } : {}),
        })
      } catch (error: unknown) {
        // readJsonBody only throws Error instances; the String() arm guards
        // future non-Error rethrows from the dispatch boundary.
        /* v8 ignore next -- every current throw site constructs an Error */
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    },
  })
}

/** Read one JSON request body; an absent or empty body resolves to undefined. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch (error: unknown) {
        // JSON.parse failures are always SyntaxError instances.
        /* v8 ignore next -- JSON.parse throws SyntaxError, never a non-Error */
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : 'parse failed'}`))
      }
    })
    req.on('error', reject)
  })
}
