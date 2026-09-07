import { mkdtemp, chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { claudeListingTitle, discoverClaudeCodeSessions, parseClaudeCodeSession } from '../src/adapters/claude-code.ts'
import {
  codexListingTitle,
  discoverCodexSessions,
  parseCodexSession,
} from '../src/adapters/codex.ts'
import { discoverZcodeSessions, parseZcodeSession } from '../src/adapters/zcode.ts'
import { discoverMinimaxSessions, parseMinimaxSession } from '../src/adapters/minimax.ts'
import { epochMs, fileContains, MAX_LINE_BYTES, parseFirstJsonlLine, parseJsonlFile, SourceFileTooLargeError } from '../src/jsonl.ts'
import {
  claudeAssistant,
  claudeLine,
  claudeThinking,
  claudeTitle,
  claudeToolResult,
  claudeUser,
  codexCustomToolCall,
  codexNamedCustomToolCall,
  codexFunctionCall,
  codexFunctionOutput,
  codexMeta,
  codexMessage,
  codexTurnContext,
  writeClaudeTranscript,
  writeCodexArchivedRollout,
  writeCodexRollout,
} from './fixtures.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-import-adapters-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('jsonl reading', () => {
  /** Write a raw file with the given lines (no fixtures shape). */
  async function writeRaw(name: string, lines: readonly string[]): Promise<string> {
    const path = join(root, name)
    await writeFile(path, `${lines.join('\n')}\n`)
    return path
  }

  it('parses every valid line and skips oversized lines mid-file', async () => {
    const path = await writeRaw('mixed.jsonl', [
      '{"n":1}',
      JSON.stringify({ big: 'x'.repeat(MAX_LINE_BYTES + 1) }),
      '',
      '   ',
      '{"n":2}',
    ])
    const parsed = await parseJsonlFile(path, 64 * 1024 * 1024)
    expect(parsed.values).toEqual([{ n: 1 }, { n: 2 }])
    expect(parsed.skippedRecords).toBe(0)
    expect(parsed.oversizedRecords).toBe(1)
  })

  it('returns undefined for a first line that is empty, invalid, or oversized', async () => {
    expect(await parseFirstJsonlLine(await writeRaw('empty.jsonl', []))).toBeUndefined()
    expect(await parseFirstJsonlLine(await writeRaw('blank.jsonl', ['', '   ']))).toBeUndefined()
    expect(await parseFirstJsonlLine(await writeRaw('bad.jsonl', ['{not json', '{"n":1}']))).toBeUndefined()
    expect(await parseFirstJsonlLine(
      await writeRaw('big-first.jsonl', [JSON.stringify({ big: 'x'.repeat(MAX_LINE_BYTES + 1) }), '{"n":1}']),
    )).toBeUndefined()
  })

  it('reads a bounded prefix: huge files still yield their first line at constant cost', async () => {
    const path = await writeRaw('first-line.jsonl', ['{"n":1}', '${"x".repeat(500)}'])
    expect(await parseFirstJsonlLine(path)).toEqual({ n: 1 })
  })

  it('returns undefined for a missing file instead of throwing', async () => {
    expect(await parseFirstJsonlLine('definitely/missing/rollout.jsonl')).toBeUndefined()
  })

  it('rethrows read failures other than a missing file', async () => {
    await expect(parseFirstJsonlLine(root)).rejects.toThrow()
  })

  it('rethrows open failures other than a missing file', async () => {
    const dir = join(root, 'locked')
    await mkdir(dir)
    await writeFile(join(dir, 'locked.jsonl'), '{"n":1}')
    await chmod(dir, 0o000)
    try {
      await expect(parseFirstJsonlLine(join(dir, 'locked.jsonl'))).rejects.toThrow()
    } finally {
      await chmod(dir, 0o755)
    }
  })

  it('parses, skips, and counts a final line that has no trailing newline', async () => {
    const ok = join(root, 'tail-ok.jsonl')
    await writeFile(ok, '{"n":1}\n{"last":true}')
    expect(await parseJsonlFile(ok, 64 * 1024 * 1024)).toEqual({
      values: [{ n: 1 }, { last: true }], skippedRecords: 0, oversizedRecords: 0,
    })

    const bad = join(root, 'tail-bad.jsonl')
    await writeFile(bad, '{"n":1}\n{not json')
    expect(await parseJsonlFile(bad, 64 * 1024 * 1024)).toEqual({ values: [{ n: 1 }], skippedRecords: 1, oversizedRecords: 0 })

    const huge = join(root, 'tail-huge.jsonl')
    await writeFile(huge, `{"n":1}\n${JSON.stringify({ big: 'x'.repeat(MAX_LINE_BYTES + 1) })}`)
    expect(await parseJsonlFile(huge, 64 * 1024 * 1024)).toEqual({ values: [{ n: 1 }], skippedRecords: 0, oversizedRecords: 1 })
  })

  it('leaves undefined timestamps and unparseable dates unmapped', () => {
    expect(epochMs(undefined)).toBeUndefined()
    expect(epochMs('not a date')).toBeUndefined()
    expect(epochMs('2026-08-01T10:00:00.000Z')).toBe(Date.parse('2026-08-01T10:00:00.000Z'))
  })
})

describe('claude-code discovery', () => {
  it('finds every transcript under projects/ and sorts by size descending', async () => {
    const small = await writeClaudeTranscript(join(root, 'claude'), 'proj-a', 'id-small', [claudeUser('hi')])
    const big = await writeClaudeTranscript(join(root, 'claude'), 'proj-b', 'id-big', [
      claudeUser('hi'),
      claudeAssistant('hello there, this line is deliberately much longer'),
    ])
    await writeFile(join(root, 'claude', 'projects', 'proj-a', 'notes.txt'), 'not a transcript')

    const found = await discoverClaudeCodeSessions(join(root, 'claude'))
    expect(found.map(row => row.sourceId)).toEqual(['id-big', 'id-small'])
    expect(found[0]).toMatchObject({ provider: 'claude-code', sourcePath: big, sizeBytes: (await stat(big)).size })
    expect(found[1]!.sourcePath).toBe(small)
    expect(found[0]!.mtimeMs).toBeGreaterThan(0)
  })

  it('returns an empty list for a missing store', async () => {
    expect(await discoverClaudeCodeSessions(join(root, 'absent'))).toEqual([])
  })

  it('skips a non-directory project entry and an unreadable transcript file', async () => {
    const claudeHome = join(root, 'claude')
    const kept = await writeClaudeTranscript(claudeHome, 'proj', 'kept', [claudeUser('hi')])
    // A regular file where a project directory is expected fails readdir.
    await writeFile(join(claudeHome, 'projects', 'proj-file'), 'not a directory')
    // A transcript whose directory denies execute fails stat between discovery and sizing.
    const noStatDir = join(claudeHome, 'projects', 'proj-nostat')
    await mkdir(noStatDir)
    await writeFile(join(noStatDir, 'lost.jsonl'), claudeUser('hi'))
    await chmod(noStatDir, 0o444)
    try {
      const found = await discoverClaudeCodeSessions(claudeHome)
      expect(found.map(row => row.sourceId)).toEqual(['kept'])
      expect(found[0]!.sourcePath).toBe(kept)
    } finally {
      await chmod(noStatDir, 0o755)
    }
  })
})

describe('claude-code parsing', () => {
  it('maps prompts, answers, tool calls, and results in source order', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-1', [
      claudeUser('fix the bug', '2026-08-01T10:00:00.000Z'),
      claudeAssistant('on it', 'claude-test-model', [{ id: 'call-1', name: 'Bash', input: { command: 'ls' } }]),
      claudeToolResult([{ toolUseId: 'call-1', content: 'file.ts' }]),
      claudeAssistant('done'),
      claudeTitle('Fix the parser bug'),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.provider).toBe('claude-code')
    expect(conversation.sourceId).toBe('sess-1')
    expect(conversation.title).toBe('Fix the parser bug')
    expect(conversation.model).toBe('claude-test-model')
    expect(conversation.workspaceDir).toBe('/repo')
    expect(conversation.startedAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'))
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'fix the bug', at: Date.parse('2026-08-01T10:00:00.000Z') },
      {
        kind: 'assistant', text: 'on it', model: 'claude-test-model',
        at: Date.parse('2026-08-01T10:00:05.000Z'),
      },
      { kind: 'tool_call', callId: 'call-1', name: 'Bash', arguments: '{"command":"ls"}', at: Date.parse('2026-08-01T10:00:05.000Z') },
      { kind: 'tool_result', callId: 'call-1', text: 'file.ts', isError: false, at: Date.parse('2026-08-01T10:00:06.000Z') },
      { kind: 'assistant', text: 'done', model: 'claude-test-model', at: Date.parse('2026-08-01T10:00:05.000Z') },
    ])
    expect(conversation.skippedRecords).toBe(0)
  })

  it('skips the housekeeping preamble and reads metadata from the first conversation line', async () => {
    // Real transcripts open with non-conversation housekeeping lines before the
    // first user turn; only the `attachment` kind carries top-level cwd and
    // timestamp fields (mirroring real files), and neither may win.
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-preamble', [
      claudeLine({
        type: 'file-history-snapshot',
        messageId: 'm-1',
        snapshot: { messageId: 'm-1', trackedFileBackups: {}, timestamp: '2026-07-31T00:00:00.000Z' },
        isSnapshotUpdate: false,
      }),
      claudeLine({ type: 'last-prompt', leafUuid: 'leaf-1' }),
      claudeLine({ type: 'mode', mode: 'normal' }),
      claudeLine({ type: 'permission-mode', permissionMode: 'bypassPermissions' }),
      claudeLine({
        type: 'attachment',
        attachment: { type: 'hook_success', hookName: 'SessionStart:startup' },
        uuid: 'att-1',
        timestamp: '2026-07-31T00:00:00.000Z',
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/preamble-cwd',
        version: '2.1.220',
        gitBranch: 'HEAD',
      }),
      claudeUser('first real prompt', '2026-08-01T10:00:00.000Z'),
      claudeAssistant('done'),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.entries).toHaveLength(2)
    // The preamble attachment's cwd and timestamps are ignored: both come from
    // the first conversation line.
    expect(conversation.workspaceDir).toBe('/repo')
    expect(conversation.startedAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'))
    expect(conversation.skippedRecords).toBe(5)
  })

  it('strips system reminders, skips meta lines and tool-result-only prompts, keeps real text', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-2', [
      claudeUser('please continue <system-reminder>noise</system-reminder>'),
      claudeUser('<system-reminder>only noise</system-reminder>'),
      claudeUser('todo update', '2026-08-01T10:00:00.000Z', { isMeta: true }),
      claudeUser('real prompt'),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.entries.map(entry => entry.kind === 'user' ? entry.text : entry.kind)).toEqual(['please continue', 'real prompt'])
  })

  it('prefers ai-title over the user-text fallback and skips the fallback without user entries', async () => {
    const titled = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-title', [
      claudeUser('the very first user prompt that is long enough to truncate at sixty characters, definitely'),
      claudeAssistant('ack'),
      claudeTitle('Curated title'),
    ])
    expect((await parseClaudeCodeSession(titled, { maxFileBytes: 1024 * 1024, includeReasoning: false })).title)
      .toBe('Curated title')

    const untitled = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-no-user', [
      claudeAssistant('only an assistant line'),
    ])
    expect((await parseClaudeCodeSession(untitled, { maxFileBytes: 1024 * 1024, includeReasoning: false })).title)
      .toBeUndefined()
  })

  it('orders mixed tool_result-and-text user lines as result then prompt', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-mixed', [
      claudeUser('fix it', '2026-08-01T10:00:00.000Z'),
      claudeAssistant('on it', 'claude-test-model', [{ id: 'call-9', name: 'Bash', input: { command: 'ls' } }]),
      claudeLine({
        type: 'user', uuid: 'mixed', timestamp: '2026-08-01T10:00:06.000Z', cwd: '/repo',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-9', content: 'done' },
            { type: 'text', text: 'also, next' },
          ],
        },
      }),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'fix it', at: Date.parse('2026-08-01T10:00:00.000Z') },
      { kind: 'assistant', text: 'on it', model: 'claude-test-model', at: Date.parse('2026-08-01T10:00:05.000Z') },
      { kind: 'tool_call', callId: 'call-9', name: 'Bash', arguments: '{"command":"ls"}', at: Date.parse('2026-08-01T10:00:05.000Z') },
      { kind: 'tool_result', callId: 'call-9', text: 'done', isError: false, at: Date.parse('2026-08-01T10:00:06.000Z') },
      { kind: 'user', text: 'also, next', at: Date.parse('2026-08-01T10:00:06.000Z') },
    ])
  })

  it('drops thinking blocks by default and keeps them when asked', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-3', [
      claudeUser('go'),
      claudeThinking('secret plan'),
    ])
    const dropped = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(dropped.entries).toEqual([{ kind: 'user', text: 'go', at: Date.parse('2026-08-01T10:00:00.000Z') }])

    const kept = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: true })
    expect(kept.entries[1]).toMatchObject({ kind: 'assistant', reasoning: 'secret plan' })
  })

  it('counts unreadable and unrecognized lines without failing the file', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-4', [
      claudeUser('go'),
      '{not json',
      JSON.stringify({ type: 'progress', payload: {} }),
      '["not", "an", "object"]',
      JSON.stringify({ type: 'assistant', message: 'not-an-object' }),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.entries.length).toBe(1)
    expect(conversation.skippedRecords).toBe(4)
  })

  it('skips sidechain lines as foreign turns and reads the source is_error flag', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-side', [
      claudeUser('main thread', '2026-08-01T10:00:00.000Z'),
      claudeLine({
        type: 'user', isSidechain: true, message: { role: 'user', content: 'sidechain prompt' },
      }),
      claudeLine({
        type: 'assistant', isSidechain: true,
        message: { role: 'assistant', model: 'claude-test-model', content: [{ type: 'text', text: 'sidechain answer' }] },
      }),
      claudeLine({
        type: 'user',
        timestamp: '2026-08-01T10:00:06.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-1', content: 'boom', is_error: true },
            { type: 'tool_result', tool_use_id: 'call-2', content: 'fine' },
          ],
        },
      }),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'main thread', at: Date.parse('2026-08-01T10:00:00.000Z') },
      { kind: 'tool_result', callId: 'call-1', text: 'boom', isError: true, at: Date.parse('2026-08-01T10:00:06.000Z') },
      { kind: 'tool_result', callId: 'call-2', text: 'fine', isError: false, at: Date.parse('2026-08-01T10:00:06.000Z') },
    ])
    expect(conversation.skippedRecords).toBe(2)
  })

  it('rejects a file over the import budget', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'huge', [claudeUser('go')])
    await expect(parseClaudeCodeSession(path, { maxFileBytes: 1, includeReasoning: false }))
      .rejects.toThrow(SourceFileTooLargeError)
  })

  it('keeps entries without timestamps, model, cwd, or title as bare entries', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'bare', [
      claudeLine({ type: 'user', message: { role: 'user', content: 'no metadata' } }),
      claudeLine({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'working' },
            { type: 'tool_use', id: 'call-1', name: 'Bash', input: {} },
          ],
        },
      }),
      claudeLine({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'out' }] },
      }),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: true })
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'no metadata' },
      { kind: 'assistant', text: 'working' },
      { kind: 'tool_call', callId: 'call-1', name: 'Bash', arguments: '{}' },
      { kind: 'tool_result', callId: 'call-1', text: 'out', isError: false },
    ])
    expect(conversation.workspaceDir).toBeUndefined()
    // No ai-title anywhere: the title falls back to the first user text.
    expect(conversation.title).toBe('no metadata')
    expect(conversation.model).toBeUndefined()
    expect(conversation.startedAt).toBeUndefined()
  })

  it('filters untyped blocks, non-array content, and nameless tool calls', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'blocknoise', [
      // Non-record and typeless entries inside a content array are dropped, not fatal.
      claudeLine({
        type: 'user',
        message: { role: 'user', content: [33, { text: 'untyped' }, { type: 'text', text: 'hello' }] },
      }),
      // Content that is neither a string nor an array yields no blocks.
      claudeLine({ type: 'user', message: { role: 'user', content: 42 } }),
      // A tool_use block without a name is skipped and counted.
      claudeLine({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-9', input: {} }] },
      }),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.entries).toEqual([{ kind: 'user', text: 'hello' }])
    expect(conversation.skippedRecords).toBe(2)
  })

  it('resolves titles through the ai-title fallback chain and summary lines', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'titles', [
      // Summary with no earlier title seeds it.
      claudeLine({ type: 'summary', summary: 'early summary' }),
      claudeUser('go'),
      claudeTitle('explicit ai title'),
      claudeLine({ type: 'ai-title', title: 'plain title field' }),
      claudeLine({ type: 'ai-title', summary: 'summary field' }),
      // None of the fields keeps the previous title.
      claudeLine({ type: 'ai-title' }),
      // A later summary line never overwrites an existing title.
      claudeLine({ type: 'summary', summary: 'late summary' }),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.title).toBe('summary field')
  })

  it('seeds a title from a summary line alone', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'summary-only', [
      claudeUser('go'),
      claudeLine({ type: 'summary', summary: 'only summary' }),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.title).toBe('only summary')
  })
})

describe('codex discovery', () => {
  it('finds dated rollouts plus archived rollouts, largest first', async () => {
    const home = join(root, 'codex')
    const daily = await writeCodexRollout(home, '2026/08/02', 'rollout-2026-08-02-a.jsonl', [codexMeta('codex-1', '/r')])
    const archived = await writeCodexArchivedRollout(home, 'rollout-archived-b.jsonl', [
      codexMeta('codex-2', '/r'),
      codexMessage('user', 'more text so this file is bigger'),
    ])
    const found = await discoverCodexSessions(home)
    expect(found.map(row => row.sourcePath)).toEqual([archived, daily])
    expect(found.map(row => row.sourceId)).toEqual(['codex-2', 'codex-1'])
  })

  it('falls back to the file stem when the first line carries no session_meta id', async () => {
    const home = join(root, 'codex')
    await writeCodexRollout(home, '2026/08/02', 'rollout-x-id-here.jsonl', [codexMessage('user', 'hi')])
    const found = await discoverCodexSessions(home)
    expect(found[0]!.sourceId).toBe('rollout-x-id-here')
  })

  it('returns an empty list for a missing store', async () => {
    expect(await discoverCodexSessions(join(root, 'absent'))).toEqual([])
  })

  it('ignores non-jsonl files and rollouts beyond the recursion budget', async () => {
    const home = join(root, 'codex')
    await writeCodexRollout(home, '2026/08/02', 'rollout-kept.jsonl', [codexMeta('kept', '/r')])
    await writeFile(join(home, 'sessions', '2026', '08', '02', 'notes.txt'), 'not a rollout')
    // A rollout nested below six directory levels is never scanned.
    const deepDir = join(home, 'sessions', '2026', '08', '02', 'd1', 'd2', 'd3', 'd4')
    await mkdir(deepDir, { recursive: true })
    await writeFile(join(deepDir, 'rollout-too-deep.jsonl'), codexMeta('too-deep', '/r'))
    const found = await discoverCodexSessions(home)
    expect(found.map(row => row.sourceId)).toEqual(['kept'])
  })

  it('skips a rollout whose stat fails and falls back to the stem without a meta id', async () => {
    const home = join(root, 'codex')
    const day = await writeCodexRollout(home, '2026/08/02', 'rollout-plain.jsonl', [codexMessage('user', 'hi')])
      .then(path => dirname(path))
    await writeFile(join(day, 'notes.txt'), 'not a rollout')
    // Deny execute on the day directory: listing still works, stat of entries fails.
    await chmod(day, 0o444)
    const noMetaPath = await writeCodexRollout(home, '2026/08/03', 'rollout-nometa.jsonl', [
      JSON.stringify({ timestamp: '2026-08-03T09:00:00.000Z', type: 'session_meta', payload: { source: 'cli' } }),
    ])
    try {
      const found = await discoverCodexSessions(home)
      expect(found.map(row => row.sourceId)).toEqual(['rollout-nometa'])
      expect(found[0]!.sourcePath).toBe(noMetaPath)
    } finally {
      await chmod(day, 0o755)
    }
  })
})

describe('codex parsing', () => {
  it('maps prompts, answers, call/result pairs, and the js bridge', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-main.jsonl', [
      codexMeta('codex-main', '/work/repo'),
      codexTurnContext('codex-test-model'),
      codexMessage('user', 'ship it'),
      codexMessage('assistant', 'running checks'),
      codexFunctionCall('shell', { cmd: ['ls'] }, 'call-9'),
      codexFunctionOutput('call-9', 'file.ts'),
      codexCustomToolCall('await tools.update_plan({ plan: ["a"] })', 'call-10'),
      codexFunctionOutput('call-10', 'ok'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.provider).toBe('codex')
    expect(conversation.sourceId).toBe('codex-main')
    expect(conversation.workspaceDir).toBe('/work/repo')
    expect(conversation.model).toBe('codex-test-model')
    expect(conversation.title).toBe('ship it')
    // The js-bridge arguments are not source JSON (unquoted key), so the raw
    // text is wrapped; both outputs carry the shared codexFunctionOutput stamp.
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'ship it', at: Date.parse('2026-08-02T09:00:05.000Z') },
      { kind: 'assistant', text: 'running checks', model: 'codex-test-model', at: Date.parse('2026-08-02T09:00:05.000Z') },
      { kind: 'tool_call', callId: 'call-9', name: 'shell', arguments: '{"cmd":["ls"]}', at: Date.parse('2026-08-02T09:00:06.000Z') },
      { kind: 'tool_result', callId: 'call-9', text: 'file.ts', isError: false, at: Date.parse('2026-08-02T09:00:07.000Z') },
      { kind: 'tool_call', callId: 'call-10', name: 'update_plan', arguments: '{"raw":"{ plan: [\\"a\\"] }"}', at: Date.parse('2026-08-02T09:00:08.000Z') },
      { kind: 'tool_result', callId: 'call-10', text: 'ok', isError: false, at: Date.parse('2026-08-02T09:00:07.000Z') },
    ])
    expect(conversation.skippedRecords).toBe(0)
  })

  it('skips injected runtime context, wait polls, and token counts', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-noise.jsonl', [
      codexMeta('codex-noise', '/r'),
      codexMessage('user', '<environment_context>env</environment_context>'),
      codexMessage('user', '# AGENTS.md\ninstructions'),
      codexFunctionCall('wait', {}, 'call-w'),
      JSON.stringify({
        timestamp: '2026-08-02T09:00:09.000Z', type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } },
      }),
      codexMessage('user', 'real'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'real', at: Date.parse('2026-08-02T09:00:05.000Z') },
    ])
  })

  it('counts an unrecognized top-level type with a valid payload as skipped', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-mystery.jsonl', [
      codexMeta('codex-mystery', '/r'),
      JSON.stringify({ timestamp: '2026-08-02T09:00:10.000Z', type: 'mystery', payload: { note: 'x' } }),
      codexMessage('user', 'go'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toHaveLength(1)
    expect(conversation.skippedRecords).toBe(1)
    expect(conversation.oversizedRecords).toBe(0)
  })

  it('seeds a claude title from a long first user text without an ai-title', async () => {
    const longPrompt = 'a'.repeat(80)
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 'sess-long-fallback', [
      claudeUser(longPrompt),
      claudeAssistant('ack'),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    // The shared prompt-title rule bounds by UTF-8 bytes (80), not characters.
    expect(conversation.title).toBe('a'.repeat(80))
  })

  it('keeps named custom_tool_call records (apply_patch) and pairs their outputs', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-patch.jsonl', [
      codexMeta('codex-patch', '/r'),
      codexMessage('user', 'add the file'),
      codexNamedCustomToolCall('apply_patch', '*** Begin Patch\n*** Add File: new.ts\n+export {}', 'call-p1'),
      JSON.stringify({
        timestamp: '2026-08-02T09:00:12.000Z', type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'call-p1', output: 'Done!' },
      }),
      codexFunctionCall('shell', { cmd: ['false'] }, 'call-p2'),
      codexFunctionOutput('call-p2', 'Process exited with code 1'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'add the file', at: Date.parse('2026-08-02T09:00:05.000Z') },
      { kind: 'tool_call', callId: 'call-p1', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Add File: new.ts\n+export {}' }), at: Date.parse('2026-08-02T09:00:11.000Z') },
      { kind: 'tool_result', callId: 'call-p1', text: 'Done!', isError: false, at: Date.parse('2026-08-02T09:00:12.000Z') },
      { kind: 'tool_call', callId: 'call-p2', name: 'shell', arguments: '{"cmd":["false"]}', at: Date.parse('2026-08-02T09:00:06.000Z') },
      { kind: 'tool_result', callId: 'call-p2', text: 'Process exited with code 1', isError: true, at: Date.parse('2026-08-02T09:00:07.000Z') },
    ])
    expect(conversation.skippedRecords).toBe(0)
  })

  it('skips encrypted reasoning items, developer roles, and failure outputs as errors', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-extra.jsonl', [
      codexMeta('codex-extra', '/r'),
      codexMessage('user', 'go'),
      JSON.stringify({
        timestamp: '2026-08-02T09:00:06.000Z', type: 'response_item',
        payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'gAAAA' },
      }),
      JSON.stringify({
        timestamp: '2026-08-02T09:00:07.000Z', type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] },
      }),
      codexFunctionCall('shell', { cmd: ['boom'] }, 'call-e1'),
      codexFunctionOutput('call-e1', JSON.stringify({ output: 'boom', metadata: { exit_code: 2 } })),
      codexMessage('assistant', 'recovered'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'go', at: Date.parse('2026-08-02T09:00:05.000Z') },
      { kind: 'tool_call', callId: 'call-e1', name: 'shell', arguments: '{"cmd":["boom"]}', at: Date.parse('2026-08-02T09:00:06.000Z') },
      { kind: 'tool_result', callId: 'call-e1', text: 'boom', isError: true, at: Date.parse('2026-08-02T09:00:07.000Z') },
      { kind: 'assistant', text: 'recovered', model: undefined, at: Date.parse('2026-08-02T09:00:05.000Z') },
    ])
    // reasoning (recognized) + developer message (drop with accounting).
    expect(conversation.skippedRecords).toBe(1)
  })

  it('flags a bare exited-with-code output as an error', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-exit.jsonl', [
      codexMeta('codex-exit', '/r'),
      codexFunctionCall('shell', { cmd: ['fail'] }, 'call-x'),
      codexFunctionOutput('call-x', 'Process exited with code 127'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toEqual([
      { kind: 'tool_call', callId: 'call-x', name: 'shell', arguments: '{"cmd":["fail"]}', at: Date.parse('2026-08-02T09:00:06.000Z') },
      { kind: 'tool_result', callId: 'call-x', text: 'Process exited with code 127', isError: true, at: Date.parse('2026-08-02T09:00:07.000Z') },
    ])
  })

  it('handles empty assistant text, object outputs, and broken envelopes', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-shapes.jsonl', [
      codexMeta('codex-shapes', '/r'),
      codexMessage('assistant', ''),
      codexMessage('assistant', ''),
      codexFunctionCall('shell', { cmd: ['ls'] }, 'call-s1'),
      JSON.stringify({
        timestamp: '2026-08-02T09:00:07.000Z', type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-s1', output: { output: 'listing', metadata: { exit_code: 0 } } },
      }),
      codexFunctionCall('shell', { cmd: ['env'] }, 'call-s2'),
      JSON.stringify({
        timestamp: '2026-08-02T09:00:08.000Z', type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-s2', output: '{broken json' },
      }),
      JSON.stringify({ timestamp: '2026-08-02T09:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] } }),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toEqual([
      { kind: 'tool_call', callId: 'call-s1', name: 'shell', arguments: '{"cmd":["ls"]}', at: Date.parse('2026-08-02T09:00:06.000Z') },
      { kind: 'tool_result', callId: 'call-s1', text: 'listing', isError: false, at: Date.parse('2026-08-02T09:00:07.000Z') },
      { kind: 'tool_call', callId: 'call-s2', name: 'shell', arguments: '{"cmd":["env"]}', at: Date.parse('2026-08-02T09:00:06.000Z') },
      { kind: 'tool_result', callId: 'call-s2', text: '{broken json', isError: false, at: Date.parse('2026-08-02T09:00:08.000Z') },
    ])
    expect(conversation.skippedRecords).toBe(2)
  })

  it('flags an explicit failure envelope and ignores non-zero text lookalikes', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-failure.jsonl', [
      codexMeta('codex-failure', '/r'),
      codexFunctionCall('shell', { cmd: ['a'] }, 'call-f1'),
      JSON.stringify({
        timestamp: '2026-08-02T09:00:07.000Z', type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-f1', output: { type: 'failure', message: 'killed' } },
      }),
      codexFunctionCall('shell', { cmd: ['b'] }, 'call-f2'),
      codexFunctionOutput('call-f2', 'Process exited with code 0'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    const results = conversation.entries.filter(entry => entry.kind === 'tool_result')
    expect(results.map(entry => entry.kind === 'tool_result' ? entry.isError : null)).toEqual([true, false])
  })

  it('skips injected and empty codex user lines, and stops at the scan budget', async () => {
    const path = join(root, 'codex', 'sessions', '2026', '08', '02', 'rollout-titlejunk.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [
      codexMessage('user', '<environment_context>noise</environment_context>'),
      codexMessage('user', ''),
      codexMessage('user', 'the surviving title'),
    ].join('\n') + '\n')
    expect(await codexListingTitle(path)).toBe('the surviving title')

    // Budget stop: a title buried past 256KB of noise stays untitled.
    const noise: string[] = Array.from({ length: 3200 }, () =>
      JSON.stringify({ timestamp: '2026-08-02T09:00:01.000Z', type: 'event_msg', payload: { type: 'token_count' } }),
    )
    const buried = join(root, 'codex', 'sessions', '2026', '08', '02', 'rollout-titlebudget.jsonl')
    await writeFile(buried, [...noise, codexMessage('user', 'buried title')].join('\n') + '\n')
    expect(await codexListingTitle(buried)).toBeUndefined()
  })

  it('returns an undefined codex listing title for a missing file and non-user records', async () => {
    expect(await codexListingTitle(join(root, 'codex', 'absent-rollout.jsonl'))).toBeUndefined()
    const path = join(root, 'codex', 'sessions', '2026', '08', '02', 'rollout-nonuser.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [
      codexMessage('assistant', 'not a user line'),
      codexMeta('codex-nonuser', '/r'),
    ].join('\n') + '\n')
    expect(await codexListingTitle(path)).toBeUndefined()
  })

  it('skips blank, bad-JSON, and non-object lines during a codex listing scan', async () => {
    const path = join(root, 'codex', 'sessions', '2026', '08', '02', 'rollout-scanjunk.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [
      '',
      '   ',
      '{broken',
      '[1,2]',
      'null',
      codexMessage('user', 'real title survives junk'),
    ].join('\n') + '\n')
    expect(await codexListingTitle(path)).toBe('real title survives junk')
  })

  it('uses the LAST ai-title so a rename updates the listing title', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-renamed', [
      claudeTitle('旧标题'),
      claudeUser('go'),
      claudeAssistant('ok', 'claude-test-model'),
      claudeTitle('新标题'),
    ])
    expect(await claudeListingTitle(path)).toBe('新标题')

    // Parse side: multiple ai-title lines — the last one names the conversation.
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.title).toBe('新标题')
  })

  it('resolves a listing title from the bare title key when aiTitle is absent', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-bare-title', [
      claudeLine({ type: 'ai-title', title: '裸 title 字段' }),
      claudeUser('go'),
    ])
    expect(await claudeListingTitle(path)).toBe('裸 title 字段')
  })

  it('titles an assistant-only claude transcript from its ai-title with an empty message citation', async () => {
    const path = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-assistant-only', [
      claudeTitle('只有助手的会话'),
      claudeAssistant('solo answer', 'claude-test-model'),
    ])
    const conversation = await parseClaudeCodeSession(path, { maxFileBytes: 1024 * 1024, includeReasoning: false })
    expect(conversation.title).toBe('只有助手的会话')
    expect(conversation.entries.every(entry => entry.kind !== 'user')).toBe(true)
  })

  it('parses CRLF-terminated JSONL', async () => {
    const home = join(root, 'codex')
    const crlfPath = await writeCodexRollout(home, '2026/08/02', 'rollout-crlf.jsonl', [
      codexMeta('codex-crlf', '/r'),
      codexMessage('user', 'windows line endings'),
    ])
    const raw = await import('node:fs/promises').then(fs => fs.readFile(crlfPath, 'utf8'))
    await import('node:fs/promises').then(fs => fs.writeFile(crlfPath, raw.replace(/\n/g, '\r\n')))
    const conversation = await parseCodexSession(crlfPath, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'windows line endings', at: Date.parse('2026-08-02T09:00:05.000Z') },
    ])
  })

  it('prefers the thread-name index title over the prompt-derived one (rename sync)', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-rename.jsonl', [
      codexMeta('codex-rename', '/r'),
      codexMessage('user', 'original prompt text'),
      codexMessage('assistant', 'answer'),
    ])
    // No index: title falls back to the prompt.
    const before = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(before.title).toBe('original prompt text')

    // Index carries the renamed name: discovery and parse both prefer it.
    await writeFile(join(home, 'session_index.jsonl'), [
      JSON.stringify({ id: 'other', thread_name: '别的会话' }),
      JSON.stringify({ id: 'codex-rename', thread_name: '重命名后的标题' }),
      '{broken line',
      '',
    ].join('\n') + '\n')
    const found = await discoverCodexSessions(home)
    expect(found.find(row => row.sourceId === 'codex-rename')?.title).toBe('重命名后的标题')
    const after = await parseCodexSession(path, { maxFileBytes: 1024 * 1024, codexHome: home })
    expect(after.title).toBe('重命名后的标题')

    // An index row with an empty name never blanks an existing title.
    await writeFile(join(home, 'session_index.jsonl'),
      JSON.stringify({ id: 'codex-rename', thread_name: '' }) + '\n')
    const kept = await parseCodexSession(path, { maxFileBytes: 1024 * 1024, codexHome: home })
    expect(kept.title).toBe('original prompt text')

    // Discovery with the same empty-name index: the scan title survives too.
    const foundKept = await discoverCodexSessions(home)
    expect(foundKept.find(row => row.sourceId === 'codex-rename')?.title).toBe('original prompt text')

    // An index name equal to the derived title is a no-op branch.
    await writeFile(join(home, 'session_index.jsonl'),
      JSON.stringify({ id: 'codex-rename', thread_name: 'original prompt text' }) + '\n')
    const foundSame = await discoverCodexSessions(home)
    expect(foundSame.find(row => row.sourceId === 'codex-rename')?.title).toBe('original prompt text')
  })

  it('honors an authoritative source id over the records when given', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-authority.jsonl', [
      codexMeta('records-id', '/r'),
      codexMessage('user', 'go'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024, sourceId: 'discovery-id' })
    expect(conversation.sourceId).toBe('discovery-id')
    // Without the override, the first record's meta id still wins.
    const plain = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(plain.sourceId).toBe('records-id')
  })

  it('counts a complete oversized line while keeping its chunk-mates', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-oversize-mid.jsonl', [
      codexMeta('codex-oversize', '/r'),
      codexMessage('user', 'before'),
      JSON.stringify({ blob: 'x'.repeat(MAX_LINE_BYTES * 2) }),
      codexMessage('user', 'after'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 * 64 })
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'before', at: Date.parse('2026-08-02T09:00:05.000Z') },
      { kind: 'user', text: 'after', at: Date.parse('2026-08-02T09:00:05.000Z') },
    ])
    expect(conversation.oversizedRecords).toBe(1)
    expect(conversation.skippedRecords).toBe(0)
  })

  it('counts an oversized final line with no trailing newline', async () => {
    const home = join(root, 'codex')
    const path = join(home, 'sessions', '2026', '08', '02', 'rollout-tail.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [
      codexMeta('codex-tail', '/r'),
      codexMessage('user', 'go'),
      JSON.stringify({ blob: 'y'.repeat(MAX_LINE_BYTES * 2) }),
    ].join('\n'))
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 * 64 })
    expect(conversation.entries).toHaveLength(1)
    expect(conversation.oversizedRecords).toBe(1)
    expect(conversation.skippedRecords).toBe(0)
  })

  it('strips a UTF-8 byte-order mark from the first line of both readers', async () => {
    const home = join(root, 'codex')
    const path = join(home, 'sessions', '2026', '08', '02', 'rollout-bom.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '\uFEFF' + [
      codexMeta('codex-bom', '/r'),
      codexMessage('user', 'after a byte-order mark'),
    ].join('\n') + '\n')

    const discovered = await discoverCodexSessions(home)
    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.sourceId).toBe('codex-bom')

    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.sourceId).toBe('codex-bom')
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'after a byte-order mark', at: Date.parse('2026-08-02T09:00:05.000Z') },
    ])
    expect(conversation.skippedRecords).toBe(0)
  })

  it('prefers the explicit name over the js bridge and wraps the raw input', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-named-bridge.jsonl', [
      codexMeta('codex-named-bridge', '/r'),
      codexNamedCustomToolCall('apply_patch', 'await tools.shell({ cmd: ["x"] })', 'call-nb'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toEqual([
      {
        kind: 'tool_call', callId: 'call-nb', name: 'apply_patch',
        arguments: JSON.stringify({ input: 'await tools.shell({ cmd: ["x"] })' }),
        at: Date.parse('2026-08-02T09:00:11.000Z'),
      },
    ])
  })

  it('discovers and parses a zcode sqlite store', async () => {
    const home = join(root, 'zcode')
    const dbPath = join(home, 'cli', 'db', 'db.sqlite')
    await mkdir(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)')
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, sequence INTEGER)')
    db.prepare('INSERT INTO session VALUES (\'sess_top\', NULL, \'/work\', \'the top conversation\', 1000, 2000)').run()
    db.prepare('INSERT INTO session VALUES (\'sess_sub\', \'sess_top\', \'/work\', \'sub transcript\', 1500, 1600)').run()
    db.prepare('INSERT INTO session VALUES (\'sess_nulltitle\', NULL, \'/work\', NULL, 1000, 1500)').run()
    const insMsg = db.prepare('INSERT INTO message VALUES (?, \'sess_top\', ?, ?, ?)')
    const insPart = db.prepare('INSERT INTO part VALUES (?, ?, \'sess_top\', ?, ?)')
    insMsg.run('m1', 1000, JSON.stringify({ role: 'user', time: { created: 1000 } }), 1)
    insMsg.run('m0', 500, '{broken json', 0)
    insMsg.run('mS', 600, JSON.stringify({ role: 'user', synthetic: true, parts: [{ type: 'text', text: 'noise' }] }), 0)
    insPart.run('pS', 'mS', JSON.stringify({ type: 'text', text: 'noise' }), 1)
    insMsg.run('mT', 700, JSON.stringify({ role: 'user', time: { created: 'not-a-number' } }), 0)
    insPart.run('pT', 'mT', JSON.stringify({ type: 'text', text: 'bad clock' }), 1)
    insPart.run('p0', 'm1', JSON.stringify({ type: 'image' }), 0)
    insPart.run('p1', 'm1', JSON.stringify({ type: 'text', text: 'please fix <system-reminder>x</system-reminder>the bug' }), 1)
    insMsg.run('mR', 800, JSON.stringify({ role: 'user', parts: [{ type: 'text', text: '<system-reminder>only noise</system-reminder>' }] }), 2)
    insPart.run('pR', 'mR', JSON.stringify({ type: 'text', text: '<system-reminder>only noise</system-reminder>' }), 1)
    insMsg.run('mS2', 2900, JSON.stringify({ role: 'system', parts: [] }), 2)
    insMsg.run('m3', 3000, JSON.stringify({ role: 'assistant', modelID: 'zc-model' }), 3)
    insPart.run('p3a', 'm3', JSON.stringify({ type: 'reasoning', text: 'thinking it through' }), 1)
    insPart.run('p3b', 'm3', JSON.stringify({ type: 'text', text: '   ' }), 2)
    insPart.run('p3c', 'm3', JSON.stringify({ type: 'tool', callID: 'c9', tool: 'Read', state: { status: 'completed', input: { path: '/a' }, output: 'contents' } }), 3)
    insMsg.run('m2', 2000, JSON.stringify({ role: 'assistant', modelID: 'zc-model' }), 2)
    insPart.run('p2', 'm2', JSON.stringify({ type: 'text', text: 'on it' }), 1)
    insPart.run('p3', 'm2', JSON.stringify({ type: 'tool', callID: 'c1', tool: 'Bash', state: { status: 'error', input: { command: 'nope' }, output: 'boom' } }), 2)
    db.close()

    const discovered = await discoverZcodeSessions(home)
    expect(discovered.map(row => row.sourceId)).toEqual(['sess_top', 'sess_nulltitle'])
    expect(discovered[0]).toMatchObject({ title: 'the top conversation' })
    expect('title' in discovered[1]!).toBe(false)

    const conversation = await parseZcodeSession('sess_top', { maxFileBytes: 64 * 1024 * 1024, includeReasoning: true }, home)
    expect(conversation.provider).toBe('zcode')
    expect(conversation.title).toBe('the top conversation')
    expect(conversation.workspaceDir).toBe('/work')
    expect(conversation.model).toBe('zc-model')
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'bad clock' },
      { kind: 'user', text: 'please fix the bug', at: 1000 },
      { kind: 'assistant', text: 'on it', model: 'zc-model', at: 2000 },
      { kind: 'tool_call', callId: 'c1', name: 'Bash', arguments: '{"command":"nope"}', at: 2000 },
      { kind: 'tool_result', callId: 'c1', text: 'boom', isError: true, at: 2000 },
      { kind: 'assistant', text: '', model: 'zc-model', reasoning: 'thinking it through', at: 3000 },
      { kind: 'tool_call', callId: 'c9', name: 'Read', arguments: '{"path":"/a"}', at: 3000 },
      { kind: 'tool_result', callId: 'c9', text: 'contents', isError: false, at: 3000 },
    ])
    // Subagent sessions are excluded from discovery entirely.
    expect(discovered.find(row => row.sourceId === 'sess_sub')).toBeUndefined()
    await expect(parseZcodeSession('sess_absent', { maxFileBytes: 1024 * 1024, includeReasoning: false }, home))
      .rejects.toThrow(/was not found in/)
  })

  it('fileContains: empty query matches, cross-chunk matches are found, misses do not', async () => {
    const path = join(root, 'filecontains.txt')
    await writeFile(path, 'alpha\n' + 'x'.repeat(200 * 1024) + '\nneedle at the end\n')
    expect(await fileContains(path, '')).toBe(true)
    expect(await fileContains(path, 'x'.repeat(150 * 1024))).toBe(true)
    expect(await fileContains(path, 'needle at the end')).toBe(true)
    expect(await fileContains(path, 'no such content here')).toBe(false)
    expect(await fileContains(join(root, 'missing.txt'), 'anything')).toBe(false)
  })

  it('derives listing titles: ai-title chain, string and array user content, markup-only skip, budget stop', async () => {
    // ai-title with the summary fallback key.
    const a = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-summary', [
      claudeLine({ type: 'ai-title', summary: 'summary title' }),
    ])
    expect(await claudeListingTitle(a)).toBe('summary title')

    // String (non-array) user content.
    const b = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-string', [
      claudeLine({ type: 'user', message: { role: 'user', content: 'plain string prompt' } }),
    ])
    expect(await claudeListingTitle(b)).toBe('plain string prompt')

    // Array content with markup only in the first text block keeps scanning to real text.
    const c = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-markup', [
      claudeLine({
        type: 'user', message: { role: 'user', content: [
          { type: 'text', text: '<command-name>/x</command-name><command-message>y</command-message>' },
        ] },
      }),
      claudeUser('after the markup'),
    ])
    expect(await claudeListingTitle(c)).toBe('after the markup')

    // An ai-title line with only empty title fields falls through to user text.
    const a0 = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-emptytitle', [
      claudeLine({ type: 'ai-title', aiTitle: '', title: '', summary: '' }),
      claudeUser('seeded by user line'),
    ])
    expect(await claudeListingTitle(a0)).toBe('seeded by user line')

    // The scan budget stops before a title that sits beyond 256KB of noise.
    const noiseDir = join(root, 'claude', 'projects', 'proj')
    await mkdir(noiseDir, { recursive: true })
    const noisePath = join(noiseDir, 't-budget.jsonl')
    const noiseLines = Array.from({ length: 1400 }, () =>
      claudeLine({ type: 'progress', payload: { n: 'x'.repeat(200) } }),
    )
    const { writeFile: wbudget } = await import('node:fs/promises')
    await wbudget(noisePath, [...noiseLines, claudeUser('buried title')].join('\n') + '\n')
    expect(await claudeListingTitle(noisePath)).toBeUndefined()

    // Mixed block arrays join only text blocks; null content reads as empty.
    const a2 = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-mixed', [
      claudeLine({
        type: 'user', message: { role: 'user', content: [
          { type: 'image' }, { type: 'text', text: 'text among blocks' },
        ] },
      }),
    ])
    expect(await claudeListingTitle(a2)).toBe('text among blocks')
    const a3 = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-nullcontent', [
      claudeLine({ type: 'user', message: { role: 'user', content: null } }),
      claudeUser('fallback after null'),
    ])
    expect(await claudeListingTitle(a3)).toBe('fallback after null')

    // A user line whose message is not a record is skipped.
    const a1 = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-badmsg', [
      claudeLine({ type: 'user', message: 'junk' }),
      claudeUser('good message'),
    ])
    expect(await claudeListingTitle(a1)).toBe('good message')

    // A non-object JSON line (array) and a broken line are skipped, not fatal.
    const d0 = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-nonobject', [
      claudeLine({ type: 'user', message: { role: 'user', content: 'real after junk' } }),
    ])
    // Rewrite: prepend junk lines around the real one via raw write.
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(d0, '[1,2]\n{broken\n' + [
      claudeLine({ type: 'user', message: { role: 'user', content: 'real after junk' } }),
    ].join('\n') + '\n')
    expect(await claudeListingTitle(d0)).toBe('real after junk')

    // Meta and sidechain user lines never seed the title.
    const d = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-meta', [
      claudeUser('meta noise', '2026-08-01T10:00:00.000Z', { isMeta: true }),
      claudeLine({ type: 'user', isSidechain: true, message: { role: 'user', content: 'side noise' } }),
      claudeLine({ type: 'user', message: 'not-an-object' }),
      claudeUser('the real one'),
    ])
    expect(await claudeListingTitle(d)).toBe('the real one')

    // Missing file and a title-less transcript both stay untitled.
    expect(await claudeListingTitle(join(root, 'claude', 'absent.jsonl'))).toBeUndefined()
    const e = await writeClaudeTranscript(join(root, 'claude'), 'proj', 't-none', [
      claudeAssistant('no user line at all'),
    ])
    expect(await claudeListingTitle(e)).toBeUndefined()
  })

  it('treats event_msg telemetry as recognized, not skipped', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-telemetry.jsonl', [
      codexMeta('codex-telemetry', '/r'),
      codexMessage('user', 'go'),
      JSON.stringify({
        timestamp: '2026-08-02T09:00:09.000Z', type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5 } } },
      }),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toHaveLength(1)
    expect(conversation.skippedRecords).toBe(0)
  })

  it('wraps an unparseable js-bridge call and counts unrecognized payloads', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-edge.jsonl', [
      codexMeta('codex-edge', '/r'),
      codexCustomToolCall('not a bridge call at all', 'call-x'),
      codexMessage('user', 'go'),
      'broken json',
      JSON.stringify({ type: 'response_item', payload: { type: 'ghost' } }),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries.map(entry => entry.kind)).toEqual(['user'])
    expect(conversation.skippedRecords).toBe(3)
  })

  it('ignores a session_meta id off the first record and counts nameless function calls', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-late-meta.jsonl', [
      codexTurnContext('codex-test-model'),
      codexMeta('late-meta-id', '/late'),
      JSON.stringify({
        timestamp: '2026-08-02T09:00:06.000Z', type: 'response_item',
        payload: { type: 'function_call', arguments: '{"cmd":["ls"]}', call_id: 'call-n' },
      }),
      codexMessage('user', 'hello'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    // Identity follows discovery: only a FIRST-record session_meta names the session.
    expect(conversation.sourceId).toBe('rollout-late-meta')
    // The working directory is still read from a later session_meta.
    expect(conversation.workspaceDir).toBe('/late')
    expect(conversation.entries.map(entry => entry.kind)).toEqual(['user'])
    expect(conversation.skippedRecords).toBe(1)
  })

  it('rejects a file over the import budget', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-big.jsonl', [codexMeta('big', '/r')])
    await expect(parseCodexSession(path, { maxFileBytes: 1 })).rejects.toThrow(SourceFileTooLargeError)
  })

  it('parses a bare assistant-only rollout with no metadata at all', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-bare.jsonl', [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'lonely' }] },
      }),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.sourceId).toBe('rollout-bare')
    expect(conversation.entries).toEqual([{ kind: 'assistant', text: 'lonely' }])
    expect(conversation.workspaceDir).toBeUndefined()
    // No user entry exists, so the title fallback has nothing to seed from.
    expect(conversation.title).toBeUndefined()
    expect(conversation.model).toBeUndefined()
    expect(conversation.startedAt).toBeUndefined()
    expect(conversation.skippedRecords).toBe(0)
  })

  it('maps every record kind without timestamps and skips system roles', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-stamps.jsonl', [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'no time' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'system noise' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":["ls"]}', call_id: 'call-a' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', input: 'tools.plan({"step":1})', arguments: '', call_id: 'call-b' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-b', output: 'done' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-a', output: 'out' } }),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'no time' },
      { kind: 'tool_call', callId: 'call-a', name: 'shell', arguments: '{"cmd":["ls"]}' },
      { kind: 'tool_call', callId: 'call-b', name: 'plan', arguments: '{"step":1}' },
      { kind: 'tool_result', callId: 'call-b', text: 'done', isError: false },
      { kind: 'tool_result', callId: 'call-a', text: 'out', isError: false },
    ])
    expect(conversation.startedAt).toBeUndefined()
  })

  it('keeps file-derived defaults when the meta carries no id, cwd, or model', async () => {
    const home = join(root, 'codex')
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-defaults.jsonl', [
      JSON.stringify({ timestamp: '2026-08-02T09:00:00.000Z', type: 'session_meta', payload: { source: 'cli' } }),
      JSON.stringify({ timestamp: '2026-08-02T09:00:01.000Z', type: 'turn_context', payload: { cwd: '/repo' } }),
      // A non-record top-level value and a record with no payload are counted.
      '[1, 2]',
      JSON.stringify({ type: 'response_item' }),
      // Content shapes: plain string, non-array non-string, and blocks without text.
      JSON.stringify({ timestamp: '2026-08-02T09:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'plain string content' } }),
      JSON.stringify({ timestamp: '2026-08-02T09:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 42 } }),
      JSON.stringify({ timestamp: '2026-08-02T09:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text' }, { type: 'input_text', text: 'mixed' }] } }),
      codexMessage('user', 'find me'),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    expect(conversation.sourceId).toBe('rollout-defaults')
    expect(conversation.workspaceDir).toBeUndefined()
    expect(conversation.model).toBeUndefined()
    expect(conversation.title).toBe('plain string content')
    expect(conversation.entries.filter(entry => entry.kind === 'user').map(entry => entry.kind === 'user' && entry.text))
      .toEqual(['plain string content', 'mixed', 'find me'])
    expect(conversation.skippedRecords).toBe(2)
  })

  it('bounds a long first user text to whole words and bytes in the title', async () => {
    const home = join(root, 'codex')
    const long = 'explain the entire build pipeline from the ground up please and slowly and carefully and thoroughly'
    const path = await writeCodexRollout(home, '2026/08/02', 'rollout-long.jsonl', [
      codexMeta('codex-long', '/r'),
      codexMessage('user', long),
    ])
    const conversation = await parseCodexSession(path, { maxFileBytes: 1024 * 1024 })
    // The shared prompt-title rule caps at 12 whole words / 80 UTF-8 bytes.
    expect(conversation.title).toBe('explain the entire build pipeline from the ground up please and slowly')
  })
})

describe('zcode adapter edge branches', () => {
  /** One message row: the raw `data` column JSON plus its ordered raw part JSON strings. */
  interface ZcodeMessageRow {
    readonly id: string
    readonly data: string
    readonly time: number
    readonly parts: readonly string[]
  }

  /** One session row with its ordered messages; omitted columns are stored as NULL. */
  interface ZcodeSessionRow {
    readonly id: string
    readonly directory?: string
    readonly title?: string
    readonly messages: readonly ZcodeMessageRow[]
  }

  const messageData = (message: object): string => JSON.stringify(message)
  const textPart = (text: string): string => messageData({ type: 'text', text })
  const reasoningPart = (text: string): string => messageData({ type: 'reasoning', text })
  const toolPart = (part: object): string => messageData({ type: 'tool', ...part })

  /** Build the real sqlite store at `<home>/cli/db/db.sqlite`. */
  async function writeZcodeStore(home: string, sessions: readonly ZcodeSessionRow[]): Promise<void> {
    const dbPath = join(home, 'cli', 'db', 'db.sqlite')
    await mkdir(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)')
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, sequence INTEGER)')
    for (const [sessionIndex, session] of sessions.entries()) {
      db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?)')
        .run(session.id, session.directory ?? null, session.title ?? null, 1000 + sessionIndex, 2000 + sessionIndex)
      for (const [sequence, message] of session.messages.entries()) {
        db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(message.id, session.id, message.time, message.data, sequence)
        for (const [partSequence, part] of message.parts.entries()) {
          db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
            .run(`${message.id}-p${partSequence}`, message.id, session.id, part, partSequence)
        }
      }
    }
    db.close()
  }

  /** Parse one session from a store under the temp root; reasoning is dropped unless asked for. */
  function parseSession(sessionId: string, home: string, includeReasoning = false): ReturnType<typeof parseZcodeSession> {
    return parseZcodeSession(sessionId, { maxFileBytes: 64 * 1024 * 1024, includeReasoning }, home)
  }

  it('drops a reasoning-only assistant turn while reasoning is off and keeps it without metadata when on', async () => {
    const home = join(root, 'zcode')
    await writeZcodeStore(home, [
      {
        id: 'sess_meta',
        messages: [
          { id: 'm1', time: 1000, data: messageData({ role: 'user', time: { created: 1000 } }), parts: [textPart('hello')] },
          {
            id: 'm2',
            time: 2000,
            data: messageData({ role: 'assistant', time: { created: 'not-a-number' } }),
            parts: [reasoningPart('secret plan'), textPart('   ')],
          },
        ],
      },
    ])
    // Whitespace-only text, dropped reasoning, and no tools leave the turn empty.
    const dropped = await parseSession('sess_meta', home)
    expect(dropped.entries).toEqual([{ kind: 'user', text: 'hello', at: 1000 }])
    expect(dropped.skippedRecords).toBe(0)
    expect(dropped.workspaceDir).toBeUndefined()
    expect(dropped.title).toBeUndefined()
    expect(dropped.model).toBeUndefined()

    // With reasoning kept, the same turn survives as a bare reasoning entry.
    const kept = await parseSession('sess_meta', home, true)
    expect(kept.entries).toEqual([
      { kind: 'user', text: 'hello', at: 1000 },
      { kind: 'assistant', text: '', reasoning: 'secret plan' },
    ])
  })

  it('maps a stateless tool part to a bare call with an empty result and no timestamps', async () => {
    const home = join(root, 'zcode')
    await writeZcodeStore(home, [
      {
        id: 'sess_stateless',
        messages: [
          {
            id: 'm1',
            time: 1000,
            data: messageData({ role: 'assistant', time: { created: 'not-a-number' } }),
            parts: [toolPart({ callID: 'c1', tool: 'Bash' })],
          },
        ],
      },
    ])
    const conversation = await parseSession('sess_stateless', home)
    expect(conversation.entries).toEqual([
      { kind: 'assistant', text: '' },
      { kind: 'tool_call', callId: 'c1', name: 'Bash', arguments: '{}' },
      { kind: 'tool_result', callId: 'c1', text: '', isError: false },
    ])
  })

  it('synthesizes a missing call id and reads an object output whose state has no input', async () => {
    const home = join(root, 'zcode')
    await writeZcodeStore(home, [
      {
        id: 'sess_synth',
        messages: [
          {
            id: 'm1',
            time: 1000,
            data: messageData({ role: 'assistant' }),
            parts: [toolPart({ tool: 'Read', state: { status: 'completed', output: { output: 'object output' } } })],
          },
        ],
      },
    ])
    const conversation = await parseSession('sess_synth', home)
    const call = conversation.entries.find(entry => entry.kind === 'tool_call')
    const result = conversation.entries.find(entry => entry.kind === 'tool_result')
    if (call?.kind !== 'tool_call' || result?.kind !== 'tool_result') throw new Error('expected a paired tool call and result')
    expect(conversation.entries).toEqual([
      { kind: 'assistant', text: '', at: 1000 },
      { kind: 'tool_call', callId: call.callId, name: 'Read', arguments: '{}', at: 1000 },
      { kind: 'tool_result', callId: call.callId, text: 'object output', isError: false, at: 1000 },
    ])
    expect(call.callId).toMatch(/^imported-call-\d+$/)
  })

  it('counts non-record message payloads as skipped records', async () => {
    const home = join(root, 'zcode')
    await writeZcodeStore(home, [
      {
        id: 'sess_noise',
        messages: [
          { id: 'm1', time: 1000, data: '["an", "array"]', parts: [] },
          { id: 'm2', time: 1001, data: '"a bare string"', parts: [] },
          { id: 'm3', time: 1002, data: messageData({ role: 'user', time: { created: 1002 } }), parts: [textPart('kept')] },
        ],
      },
    ])
    const conversation = await parseSession('sess_noise', home)
    expect(conversation.entries).toEqual([{ kind: 'user', text: 'kept', at: 1002 }])
    expect(conversation.skippedRecords).toBe(2)
  })

  it('reads the model id from a nested model record and keeps modelless turns bare', async () => {
    const home = join(root, 'zcode')
    await writeZcodeStore(home, [
      {
        id: 'sess_model',
        directory: '',
        title: 'kept title',
        messages: [
          {
            id: 'm1',
            time: 1000,
            data: messageData({ role: 'user', model: { modelID: 'nested-model' }, time: { created: 1000 } }),
            parts: [textPart('hi')],
          },
          { id: 'm2', time: 2000, data: messageData({ role: 'assistant', time: { created: 2000 } }), parts: [textPart('reply')] },
        ],
      },
    ])
    const conversation = await parseSession('sess_model', home)
    // The conversation model comes from the first message carrying one, even
    // nested; the modelless assistant turn stays bare.
    expect(conversation.model).toBe('nested-model')
    // An empty directory string is not a workspace directory.
    expect(conversation.workspaceDir).toBeUndefined()
    expect(conversation.title).toBe('kept title')
    expect(conversation.entries).toEqual([
      { kind: 'user', text: 'hi', at: 1000 },
      { kind: 'assistant', text: 'reply', at: 2000 },
    ])
  })

  it('returns an empty discovery list for a missing store and for an empty store', async () => {
    expect(await discoverZcodeSessions(join(root, 'absent'))).toEqual([])
    const home = join(root, 'zcode')
    await writeZcodeStore(home, [])
    expect(await discoverZcodeSessions(home)).toEqual([])
  })
})

describe('minimax adapter', () => {
  /** One message row of a MiniMax session: role, timestamp, and the raw `data_json`. */
  interface MinimaxMessageRow {
    readonly role: string | null
    readonly at: number | null
    readonly data: string
  }

  /** One session row with its ordered messages; omitted columns are stored as NULL. */
  interface MinimaxSessionRow {
    readonly id: string
    readonly parentSessionId?: string
    readonly title?: string
    readonly workspaceDir?: string
    readonly createdAtMs?: number
    readonly updatedAtMs?: number
    readonly recordJson?: string
    readonly messages: readonly MinimaxMessageRow[]
  }

  const messageData = (message: object): string => JSON.stringify(message)

  /** Build the real sqlite store at `<home>/v2/sqlite/runtime-state.sqlite`. */
  async function writeMinimaxStore(home: string, sessions: readonly MinimaxSessionRow[]): Promise<string> {
    const dbPath = join(home, 'v2', 'sqlite', 'runtime-state.sqlite')
    await mkdir(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT, title TEXT,'
      + ' workspace_dir TEXT, created_at_ms INTEGER, parent_session_id TEXT, updated_at_ms INTEGER)')
    db.exec('CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,'
      + ' created_at_ms INTEGER, data_json TEXT)')
    let messageId = 0
    for (const session of sessions) {
      db.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        session.id,
        session.recordJson ?? null,
        session.title ?? null,
        session.workspaceDir ?? null,
        session.createdAtMs ?? null,
        session.parentSessionId ?? null,
        session.updatedAtMs ?? null,
      )
      for (const message of session.messages) {
        messageId++
        db.prepare('INSERT INTO local_runtime_message_rows VALUES (?, ?, ?, ?, ?)')
          .run(messageId, session.id, message.role, message.at, message.data)
      }
    }
    db.close()
    return dbPath
  }

  /** Parse one session from a store under the temp root. */
  function parseSession(sessionId: string, home: string, includeReasoning = false): ReturnType<typeof parseMinimaxSession> {
    return parseMinimaxSession(sessionId, { maxFileBytes: 64 * 1024 * 1024, includeReasoning }, home)
  }

  it('discovers top-level sessions newest first and returns empty for a missing store', async () => {
    const home = join(root, 'minimax')
    const dbPath = await writeMinimaxStore(home, [
      { id: 'sess_new', title: 'newest', updatedAtMs: 3000, createdAtMs: 2500, messages: [] },
      { id: 'sess_old', updatedAtMs: 1000, messages: [] },
      { id: 'sess_nulltime', messages: [] },
      { id: 'sess_emptytitle', title: '', messages: [] },
      { id: 'sess_sub', parentSessionId: 'sess_new', updatedAtMs: 9000, messages: [] },
    ])
    const found = await discoverMinimaxSessions(home)
    expect(found.map(row => row.sourceId)).toEqual(['sess_new', 'sess_old', 'sess_nulltime', 'sess_emptytitle'])
    // Discovery reports the real store size so import idempotency can compare
    // it against the provenance recorded at import time.
    const dbSize = (await (await import('node:fs/promises')).stat(dbPath)).size
    expect(found[0]).toMatchObject({ provider: 'minimax', sourceId: 'sess_new', sourcePath: dbPath })
    expect(found[0]!.sizeBytes).toBe(dbSize)
    // Titles ride along when the column carries one; empty strings stay absent,
    // and a session without a usable updated_at_ms still lists with a zero timestamp.
    expect(found[0]).toMatchObject({ title: 'newest' })
    expect(found[2] !== undefined && 'title' in found[2]).toBe(false)
    expect(found[3] !== undefined && 'title' in found[3]).toBe(false)
    expect(found[2]).toEqual({ provider: 'minimax', sourceId: 'sess_nulltime', sourcePath: dbPath, sizeBytes: found[0]!.sizeBytes, mtimeMs: 0 })
    // The subagent row (non-empty parent_session_id) is excluded entirely.
    expect(found.find(row => row.sourceId === 'sess_sub')).toBeUndefined()
    expect(await discoverMinimaxSessions(join(root, 'absent'))).toEqual([])
  })

  it('parses messages, tool calls, and results, and counts every skip reason', async () => {
    const home = join(root, 'minimax')
    await writeMinimaxStore(home, [
      {
        id: 'sess_main',
        title: 'main chat',
        workspaceDir: '/mm',
        createdAtMs: 900,
        updatedAtMs: 3000,
        messages: [
          { role: 'user', at: 1000, data: messageData({ msg_content: 'please fix <system-reminder>noise</system-reminder>the bug' }) },
          { role: 'system', at: 1001, data: messageData({ msg_content: 'housekeeping' }) },
          { role: null, at: 1002, data: messageData({ msg_content: 'orphan role' }) },
          { role: 'user', at: 1003, data: '{broken json' },
          { role: 'user', at: 1004, data: '"a bare string"' },
          { role: 'user', at: 1005, data: messageData({ msg_content: '<system-reminder>only noise</system-reminder>' }) },
          { role: 'user', at: 1006, data: messageData({ other: 'no message content' }) },
          {
            role: 'assistant',
            at: 2000,
            data: messageData({
              msg_content: 'on it',
              thinking_content: 'secret plan',
              tool_calls: [
                33,
                {
                  tool_name: 'Bash',
                  tool_call_id: 'c1',
                  tool_call_status: 2,
                  tool_call_args: '{"command":"ls"}',
                  tool_call_result_data: '{"content":[{"type":"text","text":"file.ts"},{"type":"text","text":"more"}]}',
                },
                {
                  tool_name: 'Shell',
                  tool_call_id: 'c2',
                  tool_call_status: 1,
                  tool_call_args: 'not json',
                  tool_call_result_data: 'plain output',
                },
                {
                  tool_name: 'Read',
                  tool_call_id: 'c3',
                  tool_call_status: 2,
                  tool_call_result_data: '{"content":[{"type":"image"}]}',
                },
                {
                  tool_name: 'Grep',
                  tool_call_id: 'c4',
                  tool_call_status: 2,
                  tool_call_result_data: '{broken envelope',
                },
                {
                  tool_name: 'Write',
                  tool_call_status: 2,
                  tool_call_args: '{"path":"/a"}',
                  tool_call_result_data: 'written',
                },
                { tool_call_id: 'c9', tool_call_status: 2, tool_call_args: '{}' },
              ],
            }),
          },
          { role: 'assistant', at: null, data: messageData({ msg_content: 'quiet', tool_calls: 'not-an-array' }) },
          { role: 'assistant', at: 2100, data: messageData({ msg_content: '' }) },
        ],
      },
    ])

    const dropped = await parseSession('sess_main', home)
    expect(dropped.provider).toBe('minimax')
    expect(dropped.sourceId).toBe('sess_main')
    expect(dropped.title).toBe('main chat')
    expect(dropped.workspaceDir).toBe('/mm')
    expect(dropped.startedAt).toBe(900)
    expect(dropped.entries).toEqual([
      { kind: 'user', text: 'please fix the bug', at: 1000 },
      { kind: 'assistant', text: 'on it', at: 2000 },
      { kind: 'tool_call', callId: 'c1', name: 'Bash', arguments: '{"command":"ls"}', at: 2000 },
      { kind: 'tool_result', callId: 'c1', text: 'file.ts\nmore', isError: false, at: 2000 },
      { kind: 'tool_call', callId: 'c2', name: 'Shell', arguments: '{"raw":"not json"}', at: 2000 },
      { kind: 'tool_result', callId: 'c2', text: 'plain output', isError: true, at: 2000 },
      { kind: 'tool_call', callId: 'c3', name: 'Read', arguments: '{}', at: 2000 },
      { kind: 'tool_result', callId: 'c3', text: '{"content":[{"type":"image"}]}', isError: false, at: 2000 },
      { kind: 'tool_call', callId: 'c4', name: 'Grep', arguments: '{}', at: 2000 },
      { kind: 'tool_result', callId: 'c4', text: '{broken envelope', isError: false, at: 2000 },
      { kind: 'tool_call', callId: 'minimax-sess_main-5', name: 'Write', arguments: '{"path":"/a"}', at: 2000 },
      { kind: 'tool_result', callId: 'minimax-sess_main-5', text: 'written', isError: false, at: 2000 },
      { kind: 'assistant', text: 'quiet' },
    ])
    // system role, null role, broken json, bare-string json, reminder-only
    // prompt, missing msg_content, and the nameless tool call.
    expect(dropped.skippedRecords).toBe(7)

    const kept = await parseSession('sess_main', home, true)
    expect(kept.entries[1]).toMatchObject({ kind: 'assistant', text: 'on it', reasoning: 'secret plan', at: 2000 })
  })

  it('falls back to record_json for the title, workspace, and start time', async () => {
    const home = join(root, 'minimax')
    await writeMinimaxStore(home, [
      {
        id: 'sess_record',
        recordJson: messageData({ title: 'rec title', workspaceDir: '/rec', createdAtMs: 123 }),
        messages: [{ role: 'user', at: 200, data: messageData({ msg_content: 'hello from minimax' }) }],
      },
    ])
    const conversation = await parseSession('sess_record', home)
    expect(conversation.title).toBe('rec title')
    expect(conversation.workspaceDir).toBe('/rec')
    expect(conversation.startedAt).toBe(123)
    expect(conversation.entries).toEqual([{ kind: 'user', text: 'hello from minimax', at: 200 }])
  })

  it('keeps entries without timestamps and falls back through record_json fields', async () => {
    const home = join(root, 'minimax')
    await writeMinimaxStore(home, [
      {
        id: 'sess_bare',
        messages: [
          { role: 'user', at: null, data: messageData({ msg_content: 'bare user' }) },
          {
            role: 'assistant',
            at: null,
            data: messageData({
              msg_content: '',
              tool_calls: [{ tool_name: 'Touch', tool_call_status: 2, tool_call_args: '{}' }],
            }),
          },
        ],
      },
      {
        id: 'sess_badclock',
        recordJson: messageData({ createdAtMs: 'not-a-number' }),
        messages: [{ role: 'user', at: 300, data: messageData({ msg_content: 'bad clock' }) }],
      },
    ])

    const bare = await parseSession('sess_bare', home)
    expect(bare.title).toBeUndefined()
    expect(bare.workspaceDir).toBeUndefined()
    expect(bare.startedAt).toBeUndefined()
    expect(bare.entries).toEqual([
      { kind: 'user', text: 'bare user' },
      { kind: 'assistant', text: '' },
      { kind: 'tool_call', callId: 'minimax-sess_bare-1', name: 'Touch', arguments: '{}' },
      { kind: 'tool_result', callId: 'minimax-sess_bare-1', text: String(undefined), isError: false },
    ])

    // A record_json clock that is not a safe integer never becomes startedAt.
    const badClock = await parseSession('sess_badclock', home)
    expect(badClock.startedAt).toBeUndefined()
    expect(badClock.entries).toEqual([{ kind: 'user', text: 'bad clock', at: 300 }])
  })

  it('throws for a session id that is not in the store', async () => {
    const home = join(root, 'minimax')
    await writeMinimaxStore(home, [{ id: 'sess_present', messages: [] }])
    await expect(parseSession('sess_absent', home)).rejects.toThrow(/was not found in/)
  })
})
