import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ImportInvariant from '@deepseek-ai/dsh-session-import/invariant'
import type { SessionImportSourceEventData } from '../src/index.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ImportInvariant)
  return ctx
}

const PROVENANCE: SessionImportSourceEventData = {
  provider: 'claude-code',
  sourceId: 'src-9',
  sourcePath: '/store/src-9.jsonl',
  sizeBytes: 10,
  mtimeMs: 20,
  importedAt: 30,
  redactions: 0,
  skippedRecords: 0,
  oversizedRecords: 0,
}

function headerData(): { header: { config: { provider: string; model: string } }; reason: 'initial' } {
  return { header: { config: { provider: 'claude-code', model: 'm' } }, reason: 'initial' }
}

describe('import provenance invariants', () => {
  it('accepts one provenance record at seq 1, live-appended beside its header', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('live-import'))
    expect(() => {
      session.append('request/header', headerData())
      session.append('session-import/source', PROVENANCE)
    }).not.toThrow()
  })

  it('rejects a second provenance record on one session', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('double'))
    session.append('request/header', headerData())
    session.append('session-import/source', PROVENANCE)
    expect(() => session.append('session-import/source', PROVENANCE)).toThrow(/more than once/)
  })

  it('rejects a provenance record off seq 1', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('late'))
    session.append('request/header', headerData())
    session.append('turn/start', { turn: 1 })
    expect(() => session.append('session-import/source', PROVENANCE)).toThrow(/seq 1/)
  })

  it('validates seeded sessions announced after companion installation', async () => {
    const ctx = await setup()
    expect(() => ctx.sessions.create(SessionId('good-import'), { seed: [
      { type: 'request/header', seq: 0, time: 1, data: headerData() },
      { type: 'session-import/source', seq: 1, time: 2, data: PROVENANCE },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
    ] })).not.toThrow()

    expect(() => ctx.sessions.create(SessionId('bad-import'), { seed: [
      { type: 'request/header', seq: 0, time: 1, data: headerData() },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'session-import/source', seq: 2, time: 3, data: PROVENANCE },
    ] })).toThrow(/seq 1/)
  })

  it('rejects an existing misplaced record on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('bad-seed'))
    session.append('request/header', headerData())
    session.append('turn/start', { turn: 1 })
    session.append('session-import/source', PROVENANCE)
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(ImportInvariant).then(() => undefined)).rejects.toThrow(/seq 1/)
  })

  it('ignores sessions without provenance events', async () => {
    const ctx = await setup()
    expect(() => {
      const session = ctx.sessions.create(SessionId('plain'))
      session.append('turn/start', { turn: 1 })
      ctx.emit('tools/change')
      void session
    }).not.toThrow()
  })
})
