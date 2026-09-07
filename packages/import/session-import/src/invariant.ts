/**
 * Package-owned durable import-provenance invariants. An imported log carries
 * exactly one `session-import/source` event and carries it at seq 1, beside its
 * request header; anything else would let a foreign writer fabricate or move
 * the provenance record that resume, idempotency, and audits rely on.
 * @module @deepseek-ai/dsh-session-import/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-import'

/** Cordis companion plugin name. */
export const name = 'session-import-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Incremental provenance state for one committed session log. */
interface ImportTrace {
  seen: number
}

/** Advance the trace after one event has committed. */
function advanceTrace(trace: ImportTrace, event: SessionEvent): void {
  if (event.type === 'session-import/source') trace.seen++
}

/** Validate one package-owned event against the preceding committed trace. */
function validateEvent(event: SessionEvent, trace: ImportTrace, fail: InvariantFailure): void {
  if (event.type !== 'session-import/source') return
  if (trace.seen > 0) fail('session-import/source appended more than once to one session')
  if (event.seq !== 1) fail(`session-import/source must sit at seq 1, found seq ${event.seq}`)
}

/** Validate one existing log in a single pass and return its tail trace. */
function seedTrace(session: Session, fail: InvariantFailure): ImportTrace {
  const trace: ImportTrace = { seen: 0 }
  for (const event of session.events) {
    validateEvent(event, trace, fail)
    advanceTrace(trace, event)
  }
  return trace
}

/** Install validation for loaded and newly appended import provenance. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, ImportTrace>()
  const seed = (session: Session): void => {
    traces.set(session, seedTrace(session, fail))
  }
  const traceFor = (session: Session): ImportTrace => {
    let trace = traces.get(session)
    /* v8 ignore next 3 -- every session/event follows list() or session/created seeding, as in the session-store companion */
    if (trace === undefined) {
      trace = seedTrace(session, fail)
      traces.set(session, trace)
    }
    return trace
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvent(event, traceFor(session), fail)
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    advanceTrace(traceFor(session), event)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the session-import invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
