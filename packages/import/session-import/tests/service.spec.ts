import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { FakeAdapter, type GatedResponse } from './fake-adapter.ts'
import SessionImportService, { EmptyConversationError, TargetCollisionError } from '../src/index.ts'
import { homeOf } from '../src/service.ts'
import {
  claudeAssistant,
  claudeLine,
  claudeTitle,
  claudeToolResult,
  claudeUser,
  codexMeta,
  codexMessage,
  codexTurnContext,
  writeClaudeTranscript,
  writeCodexRollout,
} from './fixtures.ts'

let root: string
let ctx: Context
let adapter: FakeAdapter

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-import-service-'))
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined as unknown as Context
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** Build a two-turn Claude transcript with a tool round trip. */
async function seedClaudeStore(): Promise<string> {
  const claudeHome = join(root, 'claude')
  const sourceId = '11111111-2222-3333-4444-555555555555'
  await writeClaudeTranscript(claudeHome, '-repo', sourceId, [
    claudeUser('fix the bug'),
    claudeAssistant('on it', 'claude-test-model', [{ id: 'call-1', name: 'Bash', input: { command: 'pnpm test' } }]),
    claudeToolResult([{ toolUseId: 'call-1', content: 'all green' }]),
    claudeAssistant('done — tests pass'),
  ])
  return claudeHome
}

async function seedCodexStore(): Promise<string> {
  const codexHome = join(root, 'codex')
  const sourceId = CODEX_SOURCE
  await writeCodexRollout(codexHome, '2026/08/02', `rollout-x-${sourceId}.jsonl`, [
    codexMeta(sourceId, '/work'),
    codexTurnContext('codex-test-model'),
    codexMessage('user', 'write docs'),
    codexMessage('assistant', 'docs written'),
  ])
  return codexHome
}

/** Seed a one-session ZCode store under `<zcodeHome>/cli/db/db.sqlite`. */
async function seedZcodeStore(zcodeHome: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(zcodeHome, 'cli', 'db', 'db.sqlite')
  await mkdir(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, ' +
      'title TEXT, time_created INTEGER, time_updated INTEGER)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)')
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, sequence INTEGER)')
    db.prepare('INSERT INTO session VALUES (\'sess_1\', NULL, \'/work\', \'zcode top\', 1000, 2000)').run()
    db.prepare('INSERT INTO message VALUES (\'m1\', \'sess_1\', 1000, ?, 1)').run(
      JSON.stringify({ role: 'user', time: { created: 1000 }, modelID: 'zc-model' }),
    )
    db.prepare('INSERT INTO part VALUES (\'p1\', \'m1\', \'sess_1\', ?, 1)').run(
      JSON.stringify({ type: 'text', text: 'zcode prompt' }),
    )
  } finally {
    db.close()
  }
}

/** Seed a one-session MiniMax store under `<minimaxHome>/v2/sqlite/runtime-state.sqlite`. */
async function seedMinimaxStore(minimaxHome: string): Promise<void> {
  const { mkdir, utimes } = await import('node:fs/promises')
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(minimaxHome, 'v2', 'sqlite', 'runtime-state.sqlite')
  await mkdir(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT, title TEXT, ' +
      'workspace_dir TEXT, created_at_ms INTEGER, parent_session_id TEXT, updated_at_ms INTEGER)')
    db.exec('CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, ' +
      'created_at_ms INTEGER, data_json TEXT)')
    db.prepare('INSERT INTO local_runtime_sessions VALUES (\'sess_mm\', NULL, \'mm chat\', \'/mm\', 500, NULL, ?)')
      .run(MINIMAX_MTIME)
    db.prepare('INSERT INTO local_runtime_message_rows VALUES (1, \'sess_mm\', \'user\', 600, ?)').run(
      JSON.stringify({ msg_content: 'hello from minimax' }),
    )
  } finally {
    db.close()
  }
  // Discovery reports `updated_at_ms` as mtimeMs while parse stats the file; pin
  // the file clock so the re-import idempotency check compares equal values.
  await utimes(dbPath, new Date(MINIMAX_MTIME), new Date(MINIMAX_MTIME))
}

const MINIMAX_MTIME = 1_700_000_000_000

/** Boot the full composition: stores, loop, persistence, and the import service. */
async function boot(
  responses: readonly (string | GatedResponse)[] = ['continuing the work here', 'second response here'],
): Promise<SessionImportService> {
  const claudeHome = await seedClaudeStore()
  const codexHome = await seedCodexStore()
  ctx = new Context()
  adapter = new FakeAdapter(responses)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(await import('@deepseek-ai/dsh-session-projection').then(m => m.default ?? m.SessionProjectionRegistry))
  await ctx.plugin(await import('@deepseek-ai/dsh-storage').then(m => m.default))
  await ctx.plugin(await import('@deepseek-ai/dsh-storage-json'), { root: join(root, 'storages') })
  await ctx.plugin(await import('@deepseek-ai/dsh-storage-domain'), { backend: 'json' })
  await ctx.plugin(await import('@deepseek-ai/dsh-session-projection-cache').then(m => m.default), { writeEveryEvents: 50, writeIntervalMs: 1000 })
  await ctx.plugin(await import('@deepseek-ai/dsh-session-title').then(m => m.default), { fallbackMaxWords: 5, fallbackMaxBytes: 200, maxTitleBytes: 400 })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SessionImportService, {
    claudeHome,
    codexHome,
    zcodeHome: join(root, 'zcode'),
    minimaxHome: join(root, 'minimax'),
    defaultModel: 'fallback-model',
    maxToolResultChars: 200,
  })
  return ctx.sessionImport
}

/** Boot without a persistence backend: imports must fail loud, listings still work. */
async function bootWithoutPersistence(): Promise<SessionImportService> {
  const claudeHome = await seedClaudeStore()
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // The codex home is an explicit nonexistent directory: the homedir-fallback
  // default (~/.codex) is deliberately never exercised in tests because it
  // reads the real machine state.
  await ctx.plugin(SessionImportService, { claudeHome, codexHome: join(root, 'no-codex'), zcodeHome: join(root, 'zcode-home') })
  return ctx.sessionImport
}

/** Boot with persistence but no agent registry: continuing an import must fail loud. */
async function bootWithoutAgents(): Promise<SessionImportService> {
  const claudeHome = await seedClaudeStore()
  const codexHome = await seedCodexStore()
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(SessionImportService, { claudeHome, codexHome, zcodeHome: join(root, 'zcode-home') })
  return ctx.sessionImport
}

const CODEX_SOURCE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const TARGET = SessionId('ext-claude-code-11111111-2222-3333-4444-555555555555')

describe('home resolution', () => {
  it('resolves the home-relative default segment when the setting is absent or empty', () => {
    // Hermetic path computation only: no test scans the real machine store
    // behind the fallback default.
    expect(homeOf(undefined, '.codex')).toBe(join(homedir(), '.codex'))
    expect(homeOf('', '.claude')).toBe(join(homedir(), '.claude'))
  })
})

describe('session import service', () => {
  it('imports a Claude conversation as a persisted, continuable session', async () => {
    const service = await boot()
    const outcome = await service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    expect(outcome.status).toBe('imported')
    expect(outcome.sessionId).toBe(TARGET)
    // header + provenance + title + one turn (t/s, s/s, user, assistant,
    // tool/call, tool/result, assistant, s/end, t/end) = exactly 12.
    expect(outcome.eventCount).toBe(12)
    expect(outcome.sourceResumeHint).toBe('claude --resume 11111111-2222-3333-4444-555555555555')

    // The import is durable and does NOT occupy the live store, so the
    // ordinary resume path can pick it up in this or any later process.
    expect(ctx.sessions.get(TARGET)).toBeUndefined()
    const stored = await ctx.sessionPersistence.readFrom(TARGET, 0)
    // The header cwd is the shared import-group directory (one「导入」group);
    // the source project survives in the provenance event.
    expect(stored.meta.cwd).toBe(join(homedir(), '.dsh', '导入'))
    const provenance = stored.events.find(event => event.type === 'session-import/source')
    expect(provenance !== undefined && provenance.type === 'session-import/source' && provenance.data.sourceWorkspaceDir)
      .toBe('/repo')
    expect(stored.meta.seedLength).toBe(stored.events.length)
    const types = stored.events.map(event => event.type)
    expect(types[0]).toBe('request/header')
    expect(types[1]).toBe('session-import/source')
    expect(types.filter(type => type === 'tool/result')).toHaveLength(1)
    expect((await ctx.sessionPersistence.list()).some(header => header.id === TARGET)).toBe(true)
  })

  it('is idempotent, detects source changes as conflicts, and requires explicit targets for collisions', async () => {
    const service = await boot()
    const sourceId = '11111111-2222-3333-4444-555555555555'
    expect((await service.importSource({ provider: 'claude-code', sourceId })).status).toBe('imported')
    expect((await service.importSource({ provider: 'claude-code', sourceId })).status).toBe('up-to-date')

    // Rewrite the source with a later mtime: same deterministic target, changed source.
    const path = join(root, 'claude', 'projects', '-repo', `${sourceId}.jsonl`)
    await utimes(path, new Date(), new Date(Date.now() + 5000))
    const conflict = await service.importSource({ provider: 'claude-code', sourceId })
    expect(conflict.status).toBe('conflict')
    // The conflict names the blocking import so callers can tell divergence
    // from a foreign occupant of the deterministic target.
    expect(conflict.existingSourceId).toBe(sourceId)

    // An explicit target that exists but is not this import is a hard collision.
    ctx.sessions.create(SessionId('unrelated'))
    await expect(service.importSource({ provider: 'claude-code', sourceId, targetId: 'unrelated' }))
      .rejects.toThrow(TargetCollisionError)

    // A near-miss source id gets a did-you-mean suggestion.
    await expect(service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-55555555555e' }))
      .rejects.toThrow(/did you mean "11111111-2222-3333-4444-555555555555"/)
    await writeClaudeTranscript(join(root, 'claude'), '-repo', '11111111-2222-3333-4444-555555555556', [
      claudeUser('second'),
      claudeAssistant('ok', 'claude-test-model'),
    ])
    await expect(service.importSource({ provider: 'claude-code', sourceId: 'nope' }))
      .rejects.toThrow(/none matching/)
    // Whitespace-only prompts are rejected before any agent is touched.
    await expect(service.continueSession('ext-claude-code-11111111-2222-3333-4444-555555555555', '   '))
      .rejects.toThrow(/non-empty prompt/)
  })

  it('imports Codex rollouts and marks both stores in listings', async () => {
    const service = await boot()
    const before = await service.listSources()
    expect(before.map(row => `${row.provider}:${row.imported}`).sort()).toEqual(['claude-code:false', 'codex:false'])

    const outcome = await service.importSource({
      provider: 'codex',
      sourceId: CODEX_SOURCE,
    })
    expect(outcome.status).toBe('imported')
    const stored = await ctx.sessionPersistence.readFrom(SessionId('ext-codex-' + CODEX_SOURCE), 0)
    expect(stored.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)

    const after = await service.listSources()
    expect(after.find(row => row.provider === 'codex')?.imported).toBe(true)
    expect(after.find(row => row.provider === 'claude-code')?.imported).toBe(false)
  })

  it('lists and imports a MiniMax store through the service dispatch', async () => {
    const service = await boot()
    const minimaxHome = join(root, 'minimax')
    await seedMinimaxStore(minimaxHome)

    const rows = await service.listSources({ provider: 'minimax' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'minimax', sourceId: 'sess_mm', sourcePath: join(minimaxHome, 'v2', 'sqlite', 'runtime-state.sqlite'), imported: false })

    const spec = await service.resolve({ provider: 'minimax', sourceId: 'sess_mm' })
    expect(spec.home).toBe(minimaxHome)

    const outcome = await service.importSource({ provider: 'minimax', sourceId: 'sess_mm' })
    expect(outcome.status).toBe('imported')
    expect(outcome.sessionId).toBe(SessionId('ext-minimax-sess_mm'))

    const after = await service.listSources({ provider: 'minimax' })
    expect(after[0]?.imported).toBe(true)
    // Current behavior: discovery reports sizeBytes 0 while the stored import
    // provenance carries the real store size, so the idempotency comparison
    // never matches and a re-import of the unchanged source reports a conflict
    expect((await service.importSource({ provider: 'minimax', sourceId: 'sess_mm' })).status).toBe('up-to-date')
    // existingSourceId only rides conflict outcomes; an unchanged source is
    // simply up-to-date with nothing blocking it.
    const repeat = await service.importSource({ provider: 'minimax', sourceId: 'sess_mm' })
    expect(repeat.status).toBe('up-to-date')
    expect('existingSourceId' in repeat).toBe(false)
    await expect(service.importSource({ provider: 'minimax', sourceId: 'ghost' }))
      .rejects.toThrow(/was not found under/)
  })

  it('continues an imported session on the real loop with a scripted model', async () => {
    const service = await boot()
    const target = 'ext-claude-code-11111111-2222-3333-4444-555555555555'
    await service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })

    const result = await service.continueSession(target, 'continue please', {
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(result.sessionId).toBe(SessionId(target))
    // Resuming publishes the agent; the session is live again while it runs.
    const session = ctx.agents.get(SessionId(target))!.session
    await ctx.agents.get(SessionId(target))!.whenIdle()

    const tail = session.events.slice(session.events.findLastIndex(event => event.type === 'session/end-seed'))
    const tailTypes = tail.map(event => event.type)
    expect(tailTypes).toContain('user/message')
    expect(tailTypes).toContain('assistant/message')
    // One prompt against a tool-free scripted response: exactly one request,
    // so exactly one resume request/header after the seed.
    expect(tailTypes.filter(type => type === 'request/header').length).toBe(1)
    const lastAssistant = session.events.findLast(event => event.type === 'assistant/message')
    expect(lastAssistant !== undefined && lastAssistant.type === 'assistant/message'
      && lastAssistant.data.message.content.some(block => block.type === 'text' && block.text === 'continuing the work here'))
      .toBe(true)
    // The scripted model received the imported history (both imported user turns).
    expect(adapter.requests.length).toBe(1)
    const promptTexts = adapter.requests[0]!.messages
      .filter(message => message.role === 'user')
      .map(message => JSON.stringify(message.content))
    expect(promptTexts.some(text => text.includes('fix the bug'))).toBe(true)
    expect(promptTexts.some(text => text.includes('continue please'))).toBe(true)
  }, 30_000)

  it('survives a projection-cache write failure and still lists the import cold', async () => {
    const service = await boot()
    await writeClaudeTranscript(join(root, 'claude'), '-repo', 'cold-fallback', [
      claudeUser('fallback body'),
      claudeAssistant('ok', 'claude-test-model'),
    ])
    const cache = ctx.get('sessionProjectionCache') as unknown as { write(): Promise<void> }
    const original = cache.write.bind(cache)
    cache.write = () => Promise.reject(new Error('cache down'))
    const outcome = await service.importSource({ provider: 'claude-code', sourceId: 'cold-fallback' })
    cache.write = original
    expect(outcome.status).toBe('imported')
    const stored = await ctx.sessionPersistence.readFrom(SessionId('ext-claude-code-cold-fallback'), 0)
    expect(stored.events.length).toBeGreaterThan(0)
  })

  it('checkpoints the projection cache so the session list shows the imported title', async () => {
    const service = await boot()
    await service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    // The cache service holds a durable row for the import; its hydrate path
    // (what the cold list serves from) yields the folded title.
    const cache = ctx.get('sessionProjectionCache') as unknown as {
      hydratePrepared(session: unknown, meta: unknown, events: readonly unknown[]): { values: Record<string, unknown> }
    } | undefined
    expect(cache).toBeDefined()
    const stored = await ctx.sessionPersistence.readFrom(SessionId('ext-claude-code-11111111-2222-3333-4444-555555555555'), 0)
    const snapshot = cache!.hydratePrepared(
      Session.create(SessionId('ext-claude-code-11111111-2222-3333-4444-555555555555'), stored.events, stored.meta),
      stored.meta,
      stored.events,
    )
    expect(snapshot.values['title']).toBe('fix the bug')
  })

  it('force re-imports a changed source into a fresh versioned target', async () => {
    const service = await boot()
    const sourceId = '11111111-2222-3333-4444-555555555555'
    const first = await service.importSource({ provider: 'claude-code', sourceId })
    expect(first.status).toBe('imported')

    // Change the source under the deterministic target → conflict without force.
    const path = join(root, 'claude', 'projects', '-repo', `${sourceId}.jsonl`)
    await utimes(path, new Date(), new Date(Date.now() + 5000))
    const conflict = await service.importSource({ provider: 'claude-code', sourceId })
    expect(conflict.status).toBe('conflict')

    // Forced: lands as -v2 alongside the intact original; again → -v3.
    const v2 = await service.importSource({ provider: 'claude-code', sourceId, force: true })
    expect(v2.status).toBe('imported')
    expect(v2.sessionId).toBe(SessionId('ext-claude-code-11111111-2222-3333-4444-555555555555-v2'))
    const v3 = await service.importSource({ provider: 'claude-code', sourceId, force: true })
    expect(v3.sessionId).toBe(SessionId('ext-claude-code-11111111-2222-3333-4444-555555555555-v3'))

    // The original v1 log is untouched and both versions persist.
    const stored = await ctx.sessionPersistence.readFrom(SessionId('ext-claude-code-11111111-2222-3333-4444-555555555555'), 0)
    expect(stored.events).toHaveLength(first.eventCount ?? 0)
    const v2Stored = await ctx.sessionPersistence.readFrom(SessionId('ext-claude-code-11111111-2222-3333-4444-555555555555-v2'), 0)
    expect(v2Stored.events).toHaveLength(v2.eventCount ?? 0)
  })

  it('keeps the imported title on the session log as a session/title event', async () => {
    const service = await boot()
    const claudeHome = join(root, 'claude')
    await writeClaudeTranscript(claudeHome, '-repo', 'titled-keep', [
      claudeTitle('保留我的标题'),
      claudeUser('随便的首条提示词'),
      claudeAssistant('ok', 'claude-test-model'),
    ])
    await service.importSource({ provider: 'claude-code', sourceId: 'titled-keep' })
    const stored = await ctx.sessionPersistence.readFrom(SessionId('ext-claude-code-titled-keep'), 0)
    const titleEvent = stored.events.find(event => event.type === 'session/title')
    expect(titleEvent !== undefined && titleEvent.type === 'session/title' && titleEvent.data.title).toBe('保留我的标题')
    // messageSeqs cites the first imported user message's absolute seq.
    const firstUserSeq = stored.events.find(event => event.type === 'user/message')?.seq
    expect(titleEvent !== undefined && titleEvent.type === 'session/title' && titleEvent.data.messageSeqs)
      .toEqual([firstUserSeq ?? -1])
  })

  it('reports up-to-date when import is re-run after the session has been continued', async () => {
    const service = await boot()
    const sourceId = '11111111-2222-3333-4444-555555555555'
    await service.importSource({ provider: 'claude-code', sourceId })
    await service.continueSession(`ext-claude-code-${sourceId}`, 'go on', {
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = ctx.agents.get(SessionId(`ext-claude-code-${sourceId}`))!
    await agent.whenIdle()
    // The log grew past the import seed, yet the source itself is unchanged.
    const outcome = await service.importSource({ provider: 'claude-code', sourceId })
    expect(outcome.status).toBe('up-to-date')
  }, 30_000)

  it('refuses to continue a session without import provenance', async () => {
    const service = await boot()
    ctx.sessions.create(SessionId('native'))
    await expect(service.continueSession('native', 'hello')).rejects.toThrow(/no import provenance/)
  })

  it('fails loud on import and continue when no persistence backend is composed', async () => {
    const service = await bootWithoutPersistence()
    await expect(service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' }))
      .rejects.toThrow(/requires a persistence backend/)
    // Continuing falls through the same loud error: the session does not exist
    // in this store (no persistence backend, so the import never materialized).
    await expect(service.continueSession('ext-claude-code-11111111-2222-3333-4444-555555555555', 'hello'))
      .rejects.toThrow(/does not exist/)
    // Listings still work: the claude store is scanned; the codex home is an
    // explicit nonexistent directory, so its listing is empty and hermetic.
    const rows = await service.listSources({ provider: 'claude-code' })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(row => row.provider === 'claude-code')).toBe(true)
    expect(await service.listSources({ provider: 'codex' })).toEqual([])
    // An unknown id against an empty store carries no suggestion hint.
    await expect(service.importSource({ provider: 'codex', sourceId: 'ghost' }))
      .rejects.toThrow(/was not found under [^;]+$/)
  })

  it('fails loud when continuing an import without an agent registry', async () => {
    const service = await bootWithoutAgents()
    await service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    await expect(service.continueSession('ext-claude-code-11111111-2222-3333-4444-555555555555', 'hello'))
      .rejects.toThrow(/no agent registry composed/)
  })

  it('resolves a relative home setting against the user home directory', async () => {
    const previousHome = process.env.HOME
    process.env.HOME = root
    try {
      await writeClaudeTranscript(join(root, '.claude-relative'), 'proj', 'rel-1', [claudeUser('relative home')])
      ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SessionImportService, { claudeHome: '.claude-relative', zcodeHome: join(root, 'zcode-home') })
      const rows = await ctx.sessionImport.listSources({ provider: 'claude-code' })
      expect(rows.map(row => row.sourceId)).toEqual(['rel-1'])
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })

  it('throws the explicit-target collision when a changed source is forced onto its target', async () => {
    const service = await boot()
    const sourceId = '11111111-2222-3333-4444-555555555555'
    expect((await service.importSource({ provider: 'claude-code', sourceId })).status).toBe('imported')
    const path = join(root, 'claude', 'projects', '-repo', `${sourceId}.jsonl`)
    await utimes(path, new Date(), new Date(Date.now() + 5000))
    await expect(service.importSource({
      provider: 'claude-code', sourceId, targetId: 'ext-claude-code-11111111-2222-3333-4444-555555555555',
    })).rejects.toThrow(TargetCollisionError)
  })

  it('throws a collision when the explicit target id is persisted without provenance', async () => {
    const service = await boot()
    await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('ext-claude-code-plain-orphan'),
      createdAt: 1,
      seedLength: 0,
    })
    await ctx.sessionPersistence.append(SessionId('ext-claude-code-plain-orphan'), [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ])
    await expect(service.importSource({
      provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555', targetId: 'ext-claude-code-plain-orphan',
    })).rejects.toThrow(TargetCollisionError)
  })

  it('stamps the header with the import time and keeps the group cwd when the source records neither', async () => {
    const service = await boot()
    await writeClaudeTranscript(join(root, 'claude'), '-repo', 'bare-import', [
      claudeLine({ type: 'user', message: { role: 'user', model: 'claude-test-model', content: 'no metadata at all' } }),
    ])
    const outcome = await service.importSource({ provider: 'claude-code', sourceId: 'bare-import' })
    expect(outcome.status).toBe('imported')
    const stored = await ctx.sessionPersistence.readFrom(SessionId('ext-claude-code-bare-import'), 0)
    // Every import carries the group cwd; a source without a workspace
    // contributes no provenance sourceWorkspaceDir.
    expect(stored.meta.cwd).toBe(join(homedir(), '.dsh', '导入'))
    const provenance = stored.events.find(event => event.type === 'session-import/source')
    expect(provenance !== undefined && provenance.type === 'session-import/source' && 'sourceWorkspaceDir' in provenance.data)
      .toBe(false)
    const header = stored.events[0]
    expect(header !== undefined && header.type === 'request/header' && header.time).toBe(stored.meta.createdAt)
  })

  it('marks listings from the live store and skips non-import persisted sessions', async () => {
    const service = await boot(['continuing the work here'])
    ctx.sessions.create(SessionId('native'))
    await service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    await service.continueSession('ext-claude-code-11111111-2222-3333-4444-555555555555', 'go', {
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await ctx.agents.get(SessionId('ext-claude-code-11111111-2222-3333-4444-555555555555'))!.whenIdle()
    // A persisted session that is not an import must never mark a listing.
    await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('plain-orphan'),
      createdAt: 1,
      seedLength: 0,
    })
    await ctx.sessionPersistence.append(SessionId('plain-orphan'), [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ])

    const all = await service.listSources()
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(await service.listSources({ limit: 1 })).toHaveLength(1)
    expect(await service.listSources({ limit: 0 })).toHaveLength(0)
    expect(await service.listSources({ limit: -3 })).toHaveLength(0)
    // Query filter: substring match over transcripts (case-insensitive).
    const hits = await service.listSources({ query: 'fix the bug' })
    expect(hits.map(row => row.provider)).toContain('claude-code')
    expect(await service.listSources({ query: 'no-such-content-anywhere-xyz' })).toHaveLength(0)
    // Case-insensitive: uppercase query still matches the lowercase transcript.
    expect((await service.listSources({ query: 'FIX THE BUG' })).length).toBe(hits.length)
    // An empty query matches everything (documented degenerate case).
    expect(await service.listSources({ query: '' })).toHaveLength(all.length)
    const rows = await service.listSources()
    expect(rows.find(row => row.provider === 'claude-code')?.imported).toBe(true)
    expect(rows.find(row => row.provider === 'codex')?.imported).toBe(false)
  })

  it('drives an already-live imported session without resuming again', async () => {
    const service = await boot(['first reply', 'second reply'])
    await service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    const target = 'ext-claude-code-11111111-2222-3333-4444-555555555555'
    const options = { agentOptions: { provider: 'mock', model: 'mock' } }
    await service.continueSession(target, 'first', options)
    await ctx.agents.get(SessionId(target))!.whenIdle()

    const second = await service.continueSession(target, 'second', options)
    expect(second.sessionId).toBe(SessionId(target))
    await ctx.agents.get(SessionId(target))!.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const prompts = adapter.requests[1]!.messages
      .filter(message => message.role === 'user')
      .map(message => JSON.stringify(message.content))
    expect(prompts.some(text => text.includes('second'))).toBe(true)
  }, 30_000)

  it('resumes without per-agent options when none are given', async () => {
    const service = await boot()
    await service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    const target = 'ext-claude-code-11111111-2222-3333-4444-555555555555'
    // No agentOptions: the resumed loop has no model route, so its turn fails
    // contained; the service contract (resume + followup) is still exercised.
    const result = await service.continueSession(target, 'go')
    expect(result.sessionId).toBe(SessionId(target))
    await ctx.agents.get(SessionId(target))!.whenIdle()
  }, 30_000)
})

describe('import outcome title policy', () => {
  it('redacts titled outcomes by default and keeps raw titles with redactSecrets false', async () => {
    // Default boot: titled claude source with a credential-shaped ai-title.
    const service = await boot()
    const claudeHome = join(root, 'claude')
    await writeClaudeTranscript(claudeHome, '-repo', 'titled-secret', [
      claudeTitle('use token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF tomorrow'),
      claudeUser('hello'),
      claudeAssistant('done', 'claude-test-model'),
    ])
    const outcome = await service.importSource({ provider: 'claude-code', sourceId: 'titled-secret' })
    expect(outcome.title).toContain('[REDACTED:github-token]')

    // A title-less source (no ai-title, no user entries) yields no title at all.
    await writeClaudeTranscript(claudeHome, '-repo', 'untitled', [
      claudeAssistant('only an assistant line', 'claude-test-model'),
    ])
    const bare = await service.importSource({ provider: 'claude-code', sourceId: 'untitled', targetId: 'ext-claude-code-untitled' })
    expect(bare.status).toBe('imported')
    expect('title' in bare).toBe(false)

    // redactSecrets: false keeps the title verbatim.
    ctx = new Context()
    adapter = new FakeAdapter(['ok'])
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions2'), compression: 'none' })
    await ctx.plugin(SessionImportService, {
      claudeHome,
      codexHome: join(root, 'codex'),
      redactSecrets: false,
      zcodeHome: join(root, 'zcode-home'),
    })
    const raw = await ctx.sessionImport.importSource({ provider: 'claude-code', sourceId: 'titled-secret', targetId: 'ext-claude-code-titled-secret-raw' })
    expect(raw.title).toContain('ghp_abcdefghijklmnopq')
  })

  it('renders an import without detail when the source has no title', async () => {
    await boot()
    const claudeHome = join(root, 'claude')
    await writeClaudeTranscript(claudeHome, '-repo', 'untitled-tool', [
      claudeAssistant('only an assistant line', 'claude-test-model'),
    ])
    const imported = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('t-title'), name: 'session_import',
      arguments: { action: 'import', provider: 'claude-code', sourceId: 'untitled-tool' },
    })
    expect(imported.isError).toBe(false)
    const text = imported.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('Import imported:')
    expect(text).not.toContain('—')
  })
})

describe('continueSession while a turn is running', () => {
  it('delivers a followup issued while the first turn is still streaming mid-turn', async () => {
    // The first response parks mid-stream until released, so the second
    // continueSession lands while turn 1 is genuinely in flight.
    const service = await boot([{ text: 'partial response' }, 'second response here'])
    const target = 'ext-claude-code-11111111-2222-3333-4444-555555555555'
    await service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })

    await service.continueSession(target, 'first prompt', { agentOptions: { provider: 'mock', model: 'mock' } })
    const agent = ctx.agents.get(SessionId(target))!
    await adapter.gated
    // Issued mid-turn, before the gate opens: the followup joins a running agent.
    await service.continueSession(target, 'second prompt', { agentOptions: { provider: 'mock', model: 'mock' } })
    adapter.release()
    await agent.whenIdle()
    await agent.whenIdle()

    // Both prompts reached the model in order across the requests: the first
    // request carried prompt 1; prompt 2 is visible in the second request.
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
    const requestUserTexts = adapter.requests.map(request => JSON.stringify(request.messages
      .filter(message => message.role === 'user')
      .map(message => message.content)))
    expect(requestUserTexts[0]).toContain('first prompt')
    expect(requestUserTexts[0]).not.toContain('second prompt')
    expect(requestUserTexts[1]).toContain('second prompt')
    // The session log carries both user prompts.
    const session = agent.session
    const live = session.events.slice(session.events.findLastIndex(event => event.type === 'session/end-seed'))
    const userTexts = live
      .filter(event => event.type === 'user/message')
      .map(event => JSON.stringify(event.data))
    expect(live.filter(event => event.type === 'user/message')).toHaveLength(2)
    expect(userTexts.some(text => text.includes('first prompt'))).toBe(true)
    expect(userTexts.some(text => text.includes('second prompt'))).toBe(true)
  }, 30_000)

})

describe('restart journey: import in one process, continue in the next', () => {
  it('continues an imported session from a fresh context and keeps idempotency intact', async () => {
    // Process 1: import only, then shut down.
    const first = await boot()
    const target = 'ext-claude-code-11111111-2222-3333-4444-555555555555'
    await first.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    const sessionsRoot = join(root, 'sessions')
    await ctx.fiber.dispose()

    // Process 2: fresh context over the same persistence root.
    ctx = new Context()
    const freshAdapter = new FakeAdapter(['picked up right where it left off'])
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], freshAdapter)
    await ctx.plugin(SessionImportService, {
      claudeHome: join(root, 'claude'), codexHome: join(root, 'codex'), maxToolResultChars: 200,
    })

    // Re-import stays up-to-date despite the restart.
    const outcome = await ctx.sessionImport.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    expect(outcome.status).toBe('up-to-date')

    // The continued model receives the imported history plus the new prompt.
    await ctx.sessionImport.continueSession(target, 'where were we?', {
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = ctx.agents.get(SessionId(target))!
    await agent.whenIdle()
    const prompts = JSON.stringify(freshAdapter.requests[0]!.messages)
    expect(prompts).toContain('fix the bug')
    expect(prompts).toContain('where were we?')

    // Continuation does not disturb idempotency for the unchanged source.
    const again = await ctx.sessionImport.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    // The session is now live with a grown log; the deterministic target still
    // resolves to up-to-date because the SOURCE file is unchanged.
    expect(again.status).toBe('up-to-date')
  }, 30_000)

})

describe('syncAll', () => {
  it('syncs a provider store: fresh imports, up-to-date skips, quota defers', async () => {
    const service = await boot()
    // First sync imports both seeded conversations within the quota.
    const first = await service.syncAll({ provider: 'claude-code' })
    expect(first.imported).toBe(1)  // one claude session seeded
    expect(first.upToDate).toBe(0)
    expect(first.conflicts).toBe(0)
    expect(first.errors).toBe(0)
    expect(first.deferred).toBe(0)

    // Re-sync: nothing changed → all up-to-date.
    const second = await service.syncAll({ provider: 'claude-code' })
    expect(second.imported).toBe(0)
    expect(second.upToDate).toBe(1)
    expect(second.results.find(r => r.status === 'up-to-date')?.sourceId)
      .toBe('11111111-2222-3333-4444-555555555555')

    // A tiny quota defers fresh conversations beyond it, untouched; `0` lifts it.
    const claudeHome = join(root, 'claude')
    await writeClaudeTranscript(claudeHome, '-repo', 'sync-deferred-a', [
      claudeUser('another session a'),
      claudeAssistant('ok', 'claude-test-model'),
    ])
    await writeClaudeTranscript(claudeHome, '-repo', 'sync-deferred-b', [
      claudeUser('another session b'),
      claudeAssistant('ok', 'claude-test-model'),
    ])
    // Exactly one fresh conversation fits the quota of 1; which one depends
    // on same-millisecond mtime order, so assert the split, not the winner.
    const capped = await service.syncAll({ provider: 'claude-code', limit: 1 })
    expect(capped.imported).toBe(1)
    expect(capped.deferred).toBe(1)
    const deferredIds = ['sync-deferred-a', 'sync-deferred-b'].filter(
      id => capped.results.find(r => r.sourceId === id) === undefined,
    )
    expect(deferredIds).toHaveLength(1)
    const lifted = await service.syncAll({ provider: 'claude-code', limit: 0 })
    expect(lifted.imported).toBe(1)
    expect(lifted.deferred).toBe(0)
    expect(lifted.results.find(r => r.sourceId === deferredIds[0])?.status).toBe('imported')
  })

  it('counts changed-source conflicts and per-conversation errors without stopping', async () => {
    const service = await boot()
    await service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' })
    // Change the source underneath the deterministic target → conflict.
    const path = join(root, 'claude', 'projects', '-repo', '11111111-2222-3333-4444-555555555555.jsonl')
    await utimes(path, new Date(), new Date(Date.now() + 5000))
    // An empty (messages-only) codex rollout errors per-conversation.
    await writeCodexRollout(join(root, 'codex'), '2026/08/02', 'rollout-sync-empty.jsonl', [codexMeta('codex-sync-empty', '/r')])

    const outcome = await service.syncAll()
    expect(outcome.conflicts).toBe(1)
    expect(outcome.errors).toBeGreaterThanOrEqual(1)
    const errored = outcome.results.find(r => r.status === 'error')
    expect(errored?.sourceId).toBe('codex-sync-empty')
    expect(errored?.error).toContain('no importable entries')
    const conflict = outcome.results.find(r => r.status === 'conflict')
    expect(conflict?.sourceId).toBe('11111111-2222-3333-4444-555555555555')
  })
})

describe('previewSource', () => {
  it('renders a capped chat preview with tool calls attached to their assistant turns', async () => {
    const service = await boot()
    const preview = await service.previewSource({
      provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555',
    })
    expect(preview.provider).toBe('claude-code')
    expect(preview.model).toBe('claude-test-model')
    expect(preview.workspaceDir).toBe('/repo')
    expect(preview.totalToolCalls).toBe(1)
    expect(preview.hasMore).toBe(false)
    const roles = preview.messages.map(message => message.role)
    expect(roles).toEqual(['user', 'assistant', 'assistant'])
    const tooly = preview.messages.find(message => (message.toolCalls ?? []).length > 0)
    expect(tooly !== undefined && tooly.role === 'assistant' && tooly.toolCalls![0]!.name).toBe('Bash')
  })

  it('caps messages and reports hasMore with whole-conversation counts', async () => {
    const service = await boot()
    const preview = await service.previewSource({
      provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555',
    }, { maxMessages: 1 })
    expect(preview.messages).toHaveLength(1)
    expect(preview.hasMore).toBe(true)
    expect(preview.totalEntries).toBeGreaterThan(1)
    expect(preview.totalToolCalls).toBe(1)
  })

  it('omits the title for a conversation whose only user lines are injected noise', async () => {
    const service = await boot()
    const claudeHome = join(root, 'claude')
    await writeClaudeTranscript(claudeHome, '-repo', 'preview-untitled', [
      claudeUser('noise only', '2026-08-01T10:00:00.000Z', { isMeta: true }),
      claudeAssistant('an answer survives', 'claude-test-model'),
    ])
    const preview = await service.previewSource({ provider: 'claude-code', sourceId: 'preview-untitled' })
    expect('title' in preview).toBe(false)
    expect(preview.messages.map(message => message.role)).toEqual(['assistant'])
  })

  it('fails loud for an unknown source id', async () => {
    const service = await boot()
    await expect(service.previewSource({ provider: 'claude-code', sourceId: 'ghost' }))
      .rejects.toThrow(/was not found/)
  })

  it('omits absent meta fields for a bare conversation', async () => {
    const service = await boot()
    const codexHome = join(root, 'codex')
    await writeCodexRollout(codexHome, '2026/08/02', 'rollout-preview-bare.jsonl', [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'bare preview' }] },
      }),
    ])
    const preview = await service.previewSource({ provider: 'codex', sourceId: 'rollout-preview-bare' })
    // The parse-side title fallback seeds "bare preview"; the rest stay absent.
    expect(preview.title).toBe('bare preview')
    expect('model' in preview).toBe(false)
    expect('workspaceDir' in preview).toBe(false)
    expect('startedAt' in preview).toBe(false)
    expect(preview.messages).toEqual([{ role: 'user', text: 'bare preview' }])
  })

  it('truncates long tool arguments in the preview and omits absent meta fields', async () => {
    const service = await boot()
    const claudeHome = join(root, 'claude')
    await writeClaudeTranscript(claudeHome, '-repo', 'preview-long-args', [
      claudeUser('go'),
      claudeAssistant('run it', 'claude-test-model', [{
        id: 'c-long', name: 'Bash', input: { command: 'x'.repeat(300) },
      }]),
      claudeToolResult([{ toolUseId: 'c-long', content: 'done' }]),
    ])
    const preview = await service.previewSource({ provider: 'claude-code', sourceId: 'preview-long-args' })
    const call = preview.messages.find(message => (message.toolCalls ?? []).length > 0)!.toolCalls![0]!
    expect(call.argsPreview.length).toBe(120)
    expect(call.argsPreview.endsWith('…')).toBe(true)
  })
})

describe('empty source rejection at the service boundary', () => {
  it('fails loud with EmptyConversationError for a metadata-only rollout', async () => {
    const service = await boot()
    const codexHome = join(root, 'codex')
    await writeCodexRollout(codexHome, '2026/08/02', 'rollout-empty-conv.jsonl', [
      codexMeta('codex-empty', '/r'),
    ])
    await expect(service.importSource({ provider: 'codex', sourceId: 'codex-empty' }))
      .rejects.toThrow(EmptyConversationError)
    // Unknown id against a store WITH candidates: the none-matching hint.
    await expect(service.importSource({ provider: 'codex', sourceId: 'ghost' }))
      .rejects.toThrow(/none matching/)
  })
})

describe('concurrent same-source imports', () => {
  it('imports different sources concurrently and both succeed', async () => {
    const service = await boot()
    await seedZcodeStore(join(root, 'zcode'))
    const [claudeOut, codexOut] = await Promise.all([
      service.importSource({ provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' }),
      service.importSource({ provider: 'codex', sourceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
    ])
    expect(claudeOut.status).toBe('imported')
    expect(codexOut.status).toBe('imported')
    // The zcode resolve branch is exercised through its not-found hint, and a
    // matching query proves the SQLite-side filter finds seeded content.
    await expect(service.importSource({ provider: 'zcode', sourceId: 'no-such-zsession' }))
      .rejects.toThrow(/none matching/)
    expect(await service.listSources({ provider: 'zcode', query: 'zcode prompt' })).toHaveLength(1)
    expect(await service.listSources({ provider: 'zcode', query: 'no match at all' })).toHaveLength(0)
    // ZCode listed without a query skips the SQLite-side filter entirely.
    expect((await service.listSources({ provider: 'zcode' })).length).toBeGreaterThanOrEqual(1)
    // A full zcode import flows through the zcode dispatch.
    const zcodeOutcome = await service.importSource({ provider: 'zcode', sourceId: 'sess_1' })
    expect(zcodeOutcome.status).toBe('imported')
    expect(zcodeOutcome.sessionId).toBe('ext-zcode-sess_1')
    // The zcode discovery branch of resolve() is exercised via its not-found hint.
    await expect(service.importSource({ provider: 'zcode', sourceId: 'no-such-zsession' }))
      .rejects.toThrow(/none matching/)
  })

  it('imports exactly once and rejects the loser loudly', async () => {
    const service = await boot()
    const request = { provider: 'claude-code' as const, sourceId: '11111111-2222-3333-4444-555555555555' }
    const [first, second] = await Promise.allSettled([
      service.importSource(request),
      service.importSource(request),
    ])
    const outcomes = [first, second].filter(entry => entry.status === 'fulfilled')
      .map(entry => (entry as PromiseFulfilledResult<{ status: string }>).value.status)
    const rejections = [first, second].filter(entry => entry.status === 'rejected')
    // Exactly one import wins; the loser is a loud rejection, never silent duplication.
    expect(outcomes).toEqual(['imported'])
    expect(rejections).toHaveLength(1)
  })
})

describe('cross-process idempotency', () => {
  it('re-imports up-to-date over a fresh context and conflicts after the source changes', async () => {
    const first = await boot()
    const sourceId = '11111111-2222-3333-4444-555555555555'
    const firstOutcome = await first.importSource({ provider: 'claude-code', sourceId })
    expect(firstOutcome.status).toBe('imported')
    const sessionsRoot = join(root, 'sessions')
    await ctx.fiber.dispose()

    // A brand-new process: same persistence root, nothing live.
    ctx = new Context()
    const freshAdapter = new FakeAdapter(['ok'])
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none' })
    await ctx.plugin(SessionImportService, {
      claudeHome: join(root, 'claude'), codexHome: join(root, 'codex'), maxToolResultChars: 200,
    })
    const outcome = await ctx.sessionImport.importSource({ provider: 'claude-code', sourceId })
    expect(outcome.status).toBe('up-to-date')
    expect(outcome.sessionId).toBe(TARGET)
    const listing = await ctx.sessionImport.listSources({ provider: 'claude-code' })
    expect(listing.find(row => row.sourceId === sourceId)?.imported).toBe(true)

    const path = join(root, 'claude', 'projects', '-repo', `${sourceId}.jsonl`)
    await utimes(path, new Date(), new Date(Date.now() + 5000))
    expect((await ctx.sessionImport.importSource({ provider: 'claude-code', sourceId })).status).toBe('conflict')
    void freshAdapter
  }, 30_000)
})

describe('session_import tool', () => {
  it('lists and imports through ctx.tools', async () => {
    const service = await boot()
    const signal = new AbortController().signal

    const listed = await ctx.tools.execute({
      signal, callId: ToolCallId('t1'), name: 'session_import', arguments: { action: 'list' },
    })
    expect(listed.isError).toBe(false)
    const listedValue = listed.content.at(-1)
    expect(listedValue).toBeDefined()

    const imported = await ctx.tools.execute({
      signal, callId: ToolCallId('t2'), name: 'session_import',
      arguments: { action: 'import', provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' },
    })
    expect(imported.isError).toBe(false)
    expect((await service.listSources()).every(row => row.imported === (row.provider === 'claude-code'))).toBe(true)

    // Imported listing rows expose the resumable harness session id.
    const listedRows = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('t-limit'), name: 'session_import',
      arguments: { action: 'list', provider: 'claude-code' },
    })
    expect(listedRows.isError).toBe(false)

    const limited = await ctx.tools.execute({
      signal, callId: ToolCallId('t-limit'), name: 'session_import',
      arguments: { action: 'list', provider: 'claude-code', limit: 1 },
    })
    expect(limited.isError).toBe(false)

    // A negative limit clamps to zero rows.
    const clamped = await ctx.tools.execute({
      signal, callId: ToolCallId('t-clamp'), name: 'session_import',
      arguments: { action: 'list', provider: 'claude-code', limit: -5 },
    })
    expect(clamped.isError).toBe(false)

    // list without provider scans every supported store.
    const everyStore = await ctx.tools.execute({
      signal, callId: ToolCallId('t-every'), name: 'session_import',
      arguments: { action: 'list', query: 'no match at all' },
    })
    expect(everyStore.isError).toBe(false)

    const missing = await ctx.tools.execute({
      signal, callId: ToolCallId('t3'), name: 'session_import', arguments: { action: 'import' },
    })
    expect(missing.isError).toBe(true)
    // force omitted → the request carries no force field.
    const forcedOmitted = await ctx.tools.execute({
      signal, callId: ToolCallId('t3b'), name: 'session_import',
      arguments: { action: 'import', provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555' },
    })
    expect(forcedOmitted.isError).toBe(false)
    const forceFalse = await ctx.tools.execute({
      signal, callId: ToolCallId('t3c'), name: 'session_import',
      arguments: { action: 'import', provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555', force: false },
    })
    expect(forceFalse.isError).toBe(false)
    // force: true rides the tool into importSource (changed source → versioned target).
    const path = join(root, 'claude', 'projects', '-repo', '11111111-2222-3333-4444-555555555555.jsonl')
    await utimes(path, new Date(), new Date(Date.now() + 6000))
    const forceTrue = await ctx.tools.execute({
      signal, callId: ToolCallId('t3d'), name: 'session_import',
      arguments: { action: 'import', provider: 'claude-code', sourceId: '11111111-2222-3333-4444-555555555555', force: true },
    })
    expect(forceTrue.isError).toBe(false)
    const text = forceTrue.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('-v2')

    const badArgs = await ctx.tools.execute({
      signal, callId: ToolCallId('t4'), name: 'session_import', arguments: { action: 'rebase' },
    })
    expect(badArgs.isError).toBe(true)
  })

  it('imports a titled codex source and surfaces the title as detail', async () => {
    await boot()
    const signal = new AbortController().signal
    const result = await ctx.tools.execute({
      signal, callId: ToolCallId('t5'), name: 'session_import',
      arguments: { action: 'import', provider: 'codex', sourceId: CODEX_SOURCE },
    })
    expect(result.isError).toBe(false)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain(`Import imported: ext-codex-${CODEX_SOURCE} — write docs`)
  })

  it('classifies calls, presents both actions, and renders every outcome shape', async () => {
    await boot()
    const def = ctx.tools.get('session_import')
    expect(def).toBeDefined()

    expect(def!.isConcurrencySafe?.({ action: 'list' })).toBe(true)
    expect(def!.isConcurrencySafe?.({ action: 'import' })).toBe(false)

    expect(def!.presentCall?.({ action: 'list' })).toEqual({
      card: 'generic', title: 'List external agent conversations', kind: 'other', rawInput: { action: 'list' },
    })
    expect(def!.presentCall?.({ action: 'import' })).toEqual({
      card: 'generic', title: 'Import an external agent conversation', kind: 'other', rawInput: { action: 'import' },
    })

    expect(def!.output.render({}, { action: 'list', status: 'listed' }))
      .toEqual([{ type: 'text', text: 'Discovered 0 external conversation(s).' }])
    expect(def!.output.render({}, { action: 'list', status: 'listed', sessions: [
      { provider: 'codex', sourceId: 's', imported: false, sizeBytes: 1, mtimeMs: 2 },
    ] }))
      .toEqual([{ type: 'text', text: 'Discovered 1 external conversation(s).' }])
    expect(def!.output.render({}, { action: 'import', status: 'up-to-date' }))
      .toEqual([{ type: 'text', text: 'Import up-to-date: ' }])
    expect(def!.output.render({}, { action: 'import', status: 'imported', sessionId: 's-1', detail: 'my title' }))
      .toEqual([{ type: 'text', text: 'Import imported: s-1 — my title' }])
  })
})
