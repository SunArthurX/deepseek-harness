import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { redactText } from '../src/redact.ts'
import {
  EmptyConversationError,
  findSeedStructuralError,
  MissingModelError,
  translateConversation,
} from '../src/translate.ts'
import type { ExternalConversation, ExternalEntry } from '../src/model.ts'

const SPEC = {
  fallbackModel: 'fallback-model',
  includeReasoning: false,
  maxToolResultChars: 20,
  redactSecrets: true,
}

/** Build a conversation from entries with the common envelope fields. */
function conversation(
  entries: readonly ExternalEntry[],
  model?: string,
  opts: { readonly noStartedAt?: boolean } = {},
): ExternalConversation {
  return {
    provider: 'claude-code',
    sourceId: 'src-1',
    sourcePath: '/store/src-1.jsonl',
    sizeBytes: 100,
    mtimeMs: 1000,
    oversizedRecords: 0,
    ...(model !== undefined ? { model } : {}),
    ...(!opts.noStartedAt ? { startedAt: 5000 } : {}),
    entries,
    skippedRecords: 2,
  }
}

function textOf(event: SessionEvent | undefined): string {
  if (event === undefined) return ''
  if (event.type === 'user/message') {
    return event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
  }
  if (event.type === 'assistant/message') {
    return event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  }
  if (event.type === 'tool/result') {
    return event.data.message.content[0].content.filter(block => block.type === 'text').map(block => block.text).join('')
  }
  return ''
}

describe('seed translation', () => {
  it('builds a balanced continuable seed with header, provenance, and turns', () => {
    const seed = translateConversation(conversation([
      { kind: 'user', text: 'fix it' },
      { kind: 'assistant', text: 'on it', model: 'src-model' },
      { kind: 'tool_call', callId: 'c1', name: 'Bash', arguments: '{"command":"ls"}' },
      { kind: 'tool_result', callId: 'c1', text: 'out', isError: false },
      { kind: 'assistant', text: 'done', model: 'src-model' },
      { kind: 'user', text: 'thanks' },
    ], 'src-model'), SPEC, 9000)

    expect(seed[0]).toMatchObject({ type: 'request/header' })
    expect((seed[0] as { data: { header: { config: { provider: string; model: string } } } }).data.header.config)
      .toEqual({ provider: 'claude-code', model: 'src-model' })
    expect(seed[1]).toMatchObject({ type: 'session-import/source' })
    expect(seed[1]!.data).toMatchObject({ sourceId: 'src-1', redactions: 0, skippedRecords: 2, importedAt: 9000 })
    expect(seed.map(event => event.type)).toEqual([
      'request/header',
      'session-import/source',
      'turn/start', 'step/start',
      'user/message', 'assistant/message', 'tool/call', 'tool/result', 'assistant/message',
      'step/end', 'turn/end',
      'turn/start', 'step/start', 'user/message', 'step/end', 'turn/end',
    ])
    expect(findSeedStructuralError(seed)).toBeUndefined()
    // Seqs are contiguous and times fall back to the conversation start.
    expect(seed.every((event, index) => event.seq === index)).toBe(true)
    expect(seed[2]!.time).toBe(5000)
  })

  it('keeps assistant tool-call blocks correlated with their results', () => {
    const seed = translateConversation(conversation([
      { kind: 'user', text: 'go' },
      { kind: 'assistant', text: '', model: 'm' },
      { kind: 'tool_call', callId: 'c1', name: 'Read', arguments: '{}' },
      { kind: 'tool_call', callId: 'c2', name: 'Edit', arguments: '{}' },
      { kind: 'tool_result', callId: 'c2', text: 'ok', isError: false },
    ]), SPEC, 9000)

    const assistant = seed.find(event => event.type === 'assistant/message')
    expect(assistant !== undefined && assistant.type === 'assistant/message' && assistant.data.message.content.map(block => block.type))
      .toEqual(['tool-call', 'tool-call'])
    const results = seed.filter(event => event.type === 'tool/result')
    // c1 has no result in the source: it must be synthesized as an error result.
    expect(results.map(event => event.type === 'tool/result' && event.data.message.source.callId)).toEqual(['c2', 'c1'])
    const synthesized = results[1]
    expect(synthesized !== undefined && synthesized.type === 'tool/result' && synthesized.data.message.content[0].isError).toBe(true)
    expect(textOf(synthesized)).toContain('never recorded this tool result')
    expect(findSeedStructuralError(seed)).toBeUndefined()
  })

  it('applies redaction and counts matches, including tool arguments', () => {
    const seed = translateConversation(conversation([
      { kind: 'user', text: 'use key AKIAIOSFODNN7EXAMPLE today' },
      { kind: 'assistant', text: 'calling with gh pats ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF skipped', model: 'm' },
      { kind: 'tool_call', callId: 'c1', name: 'Bash', arguments: '{"token":"sk-ant-token123456789012345"}' },
      { kind: 'tool_result', callId: 'c1', text: 'export AWS_KEY=AKIAIOSFODNN7EXAMPLE', isError: false },
    ]), SPEC, 9000)

    const provenance = seed[1]
    // Exactly four matches: one per secret-bearing text plus the tool argument
    // and the tool result each carry one.
    expect(provenance !== undefined && provenance.type === 'session-import/source' && provenance.data.redactions).toBe(4)
    expect(textOf(seed[4])).toContain('[REDACTED:aws-access-key]')
    expect(textOf(seed[5])).toContain('[REDACTED:github-token]')
    const call = seed.find(event => event.type === 'tool/call')
    expect(call !== undefined && call.type === 'tool/call' && call.data.arguments).toContain('[REDACTED:anthropic-api-key]')
    expect(findSeedStructuralError(seed)).toBeUndefined()
  })

  it('truncates tool results to the character budget', () => {
    const seed = translateConversation(conversation([
      { kind: 'user', text: 'go' },
      { kind: 'assistant', text: 'ok', model: 'm' },
      { kind: 'tool_call', callId: 'c1', name: 'Bash', arguments: '{}' },
      { kind: 'tool_result', callId: 'c1', text: 'x'.repeat(100), isError: false },
    ]), { ...SPEC, maxToolResultChars: 10 }, 9000)
    const result = seed.find(event => event.type === 'tool/result')
    expect(textOf(result)).toHaveLength(10)
    expect(textOf(result).endsWith('…')).toBe(true)
  })

  it('skips orphan tool results and opens an implicit assistant for orphan calls', () => {
    const seed = translateConversation(conversation([
      { kind: 'tool_result', callId: 'ghost', text: 'no call', isError: false },
      { kind: 'tool_call', callId: 'also-ghost', name: 'Bash', arguments: '{}' },
      { kind: 'user', text: 'hello' },
    ]), SPEC, 9000)
    // One skipped orphan result (source had 2 skipped records already).
    expect(seed[1]!.data).toMatchObject({ skippedRecords: 3 })
    // The orphan call is preserved inside an implicit assistant message and
    // closed by a synthesized error result.
    const assistant = seed.find(event => event.type === 'assistant/message')
    expect(assistant !== undefined && assistant.type === 'assistant/message'
      && assistant.data.message.content.map(block => block.type)).toEqual(['tool-call'])
    const results = seed.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.type === 'tool/result' && results[0]!.data.message.content[0].isError).toBe(true)
    expect(findSeedStructuralError(seed)).toBeUndefined()
  })

  it('keeps reasoning blocks only when the spec opts in', () => {
    const entries: ExternalEntry[] = [
      { kind: 'user', text: 'go' },
      { kind: 'assistant', text: 'answer', reasoning: 'because', model: 'm' },
    ]
    const without = translateConversation(conversation(entries), SPEC, 9000)
    const withReasoning = translateConversation(conversation(entries), { ...SPEC, includeReasoning: true }, 9000)
    const assistantBlocks = (seed: SessionEvent[]): string[] => {
      const event = seed.find(candidate => candidate.type === 'assistant/message')
      return event !== undefined && event.type === 'assistant/message'
        ? event.data.message.content.map(block => block.type)
        : []
    }
    expect(assistantBlocks(without)).toEqual(['text'])
    expect(assistantBlocks(withReasoning)).toEqual(['text', 'reasoning'])
  })

  it('fails loud if its own output would be structurally invalid', () => {
    // Simulate a translator bug: drop the provenance event so the internal
    // self-check trips before the seed can reach a session.
    const broken = translateConversation(conversation([
      { kind: 'user', text: 'go' },
      { kind: 'assistant', text: 'ok', model: 'm' },
    ]), SPEC, 9000).filter(event => event.type !== 'session-import/source')
    const resequenced = broken.map((event, index) => ({ ...event, seq: index }))
    expect(findSeedStructuralError(resequenced)).toContain('import provenance')
  })

  it('cites no messages when the titled conversation holds no user entry', () => {
    const seed = translateConversation(conversation([
      { kind: 'assistant', text: 'solo', model: 'm' },
    ]), SPEC, 9000)
    // No explicit title on the conversation → no title event; give one instead.
    const titled = translateConversation({
      provider: 'claude-code', sourceId: 'src-t', sourcePath: '/s', sizeBytes: 1, mtimeMs: 1,
      title: '助手独白', entries: [{ kind: 'assistant', text: 'solo', model: 'm' }], skippedRecords: 0, oversizedRecords: 0,
    }, SPEC, 9000)
    const titleEvent = titled.find(event => event.type === 'session/title')
    expect(titleEvent !== undefined && titleEvent.type === 'session/title' && titleEvent.data.messageSeqs).toEqual([])
    void seed
  })

  it('rejects empty conversations and missing models', () => {
    expect(() => translateConversation(conversation([]), SPEC, 9000)).toThrow(EmptyConversationError)
    expect(() => translateConversation(conversation([{ kind: 'user', text: 'go' }]), {
      ...SPEC, fallbackModel: '',
    }, 9000)).toThrow(MissingModelError)
    // A source-reported model wins over the fallback and satisfies resolution.
    expect(() => translateConversation(conversation([{ kind: 'user', text: 'go' }], 'src-model'), {
      ...SPEC, fallbackModel: '',
    }, 9000)).not.toThrow()
  })

  it('passes text through unredacted when the spec disables redaction', () => {
    const seed = translateConversation(conversation([
      { kind: 'user', text: 'use key AKIAIOSFODNN7EXAMPLE today' },
    ]), { ...SPEC, redactSecrets: false }, 9000)
    expect(textOf(seed[4])).toContain('AKIAIOSFODNN7EXAMPLE')
    expect(seed[1]!.data).toMatchObject({ redactions: 0 })
  })

  it('falls back to the import time for every timestamp when the source has none', () => {
    const seed = translateConversation(conversation([
      { kind: 'user', text: 'go' },
      { kind: 'assistant', text: 'done', model: 'm' },
    ], undefined, { noStartedAt: true }), SPEC, 9000)
    expect(seed.every(event => event.time === 9000)).toBe(true)
    expect(seed[0]!.type === 'request/header' && seed[0]!.time).toBe(9000)
  })

  it('drops an assistant message that stayed empty when the next entry flushes it', () => {
    const seed = translateConversation(conversation([
      { kind: 'user', text: 'first' },
      { kind: 'assistant', text: '', model: 'm' },
      { kind: 'user', text: 'second' },
    ]), SPEC, 9000)
    expect(seed.filter(event => event.type === 'assistant/message')).toHaveLength(0)
    expect(seed.filter(event => event.type === 'user/message')).toHaveLength(2)
    expect(findSeedStructuralError(seed)).toBeUndefined()
  })

  it('keeps the first occurrence of a repeated call id and drops the repeat', () => {
    const seed = translateConversation(conversation([
      { kind: 'user', text: 'go' },
      { kind: 'tool_call', callId: 'dup', name: 'Bash', arguments: '{"n":1}' },
      { kind: 'tool_call', callId: 'dup', name: 'Bash', arguments: '{"n":2}' },
    ]), SPEC, 9000)
    // First occurrence wins; the repeat is dropped and counted on provenance
    // (2 fixture-declared source skips + 1 duplicate).
    const provenance = seed[1]!
    expect(provenance.type === 'session-import/source' && provenance.data.skippedRecords).toBe(3)
    expect(findSeedStructuralError(seed)).toBeUndefined()
  })

  it('gives an empty tool result an explicit placeholder so no empty text block reaches the model', () => {
    const seed = translateConversation(conversation([
      { kind: 'user', text: 'go' },
      { kind: 'assistant', text: 'ok', model: 'm' },
      { kind: 'tool_call', callId: 'c1', name: 'Bash', arguments: '{}' },
      { kind: 'tool_result', callId: 'c1', text: '', isError: false },
    ]), SPEC, 9000)
    const result = seed.find(event => event.type === 'tool/result')
    expect(result !== undefined && result.type === 'tool/result' && result.data.message.content[0].content[0])
      .toMatchObject({ type: 'text', text: 'import: the source tool result carried no text content.' })
  })
})

describe('seed structural validator', () => {
  const valid: SessionEvent[] = translateConversation(conversation([
    { kind: 'user', text: 'go' },
    { kind: 'assistant', text: 'ok', model: 'm' },
  ]), SPEC, 9000)

  it('accepts the translator output', () => {
    expect(findSeedStructuralError(valid)).toBeUndefined()
  })

  const mutations: [string, (events: SessionEvent[]) => SessionEvent[]][] = [
    ['missing header', events => events.slice(1)],
    ['missing provenance', events => [events[0]!, ...events.slice(2)]],
    ['nested turn start', events => [...events.slice(0, 2), {
      type: 'turn/start', seq: -1, time: 0, data: { turn: 9 },
    }, ...events.slice(2)]],
    ['swapped leading seqs', events => [events[1]!, events[0]!, ...events.slice(2)]],
    ['misplaced leading seqs', events => events.map((event, index) => index < 2 ? { ...event, seq: index + 5 } : event)],
    ['open turn', events => events.filter(event => event.type !== 'turn/end')],
    ['open step', events => events.filter(event => event.type !== 'step/end')],
    ['unopened result', events => [...events, {
      type: 'tool/result', seq: -1, time: 0,
      data: { turn: 1, step: 1, message: { id: 'm', role: 'user' as const, content: [], source: { kind: 'tool' as const, callId: 'nope' as never } } },
    } as SessionEvent]],
    ['duplicate call', events => [...events, {
      type: 'tool/call', seq: -1, time: 0, data: { turn: 1, step: 1, callId: 'dup', name: 'x', arguments: '{}' },
    } as SessionEvent, {
      type: 'tool/call', seq: -1, time: 0, data: { turn: 1, step: 1, callId: 'dup', name: 'x', arguments: '{}' },
    } as SessionEvent]],
    ['unclosed call', events => [...events, {
      type: 'tool/call', seq: -1, time: 0, data: { turn: 1, step: 1, callId: 'hanging', name: 'x', arguments: '{}' },
    } as SessionEvent]],
  ]

  it.each(mutations)('rejects a seed with %s', (_label, mutate) => {
    expect(findSeedStructuralError(mutate([...valid]))).toBeDefined()
  })

  it('rejects an empty log', () => {
    expect(findSeedStructuralError([])).toBeDefined()
  })

  /** Prefix a violation onto the valid header+provenance pair. */
  function violating(...extra: readonly SessionEvent[]): SessionEvent[] {
    return [...valid.slice(0, 2), ...extra]
  }

  const turnOpen: SessionEvent = { type: 'turn/start', seq: 2, time: 0, data: { turn: 1 } }
  const stepOpen: SessionEvent = { type: 'step/start', seq: 3, time: 0, data: { turn: 1, step: 1 } }

  it.each([
    ['step/start with no open turn', [], {
      type: 'step/start', seq: 2, time: 0, data: { turn: 1, step: 1 },
    }],
    ['step/start inside an open step', [turnOpen, stepOpen], {
      type: 'step/start', seq: 5, time: 0, data: { turn: 1, step: 2 },
    }],
    ['step/end with no open step', [turnOpen], {
      type: 'step/end', seq: 5, time: 0, data: { turn: 1, step: 1 },
    }],
    ['step/end for a different step', [turnOpen, stepOpen], {
      type: 'step/end', seq: 5, time: 0, data: { turn: 1, step: 2 },
    }],
    ['turn/end for a different turn', [turnOpen], {
      type: 'turn/end', seq: 5, time: 0, data: { turn: 2, reason: { kind: 'completed' } },
    }],
  ] as const)('rejects a seed with %s', (_label, prefix, extra) => {
    expect(findSeedStructuralError(violating(...prefix, extra as SessionEvent))).toBeDefined()
  })
})

describe('redaction rules', () => {
  it.each([
    ['aws key', 'AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF', 'github-token'],
    ['slack token', 'xoxb-123456789-abcdefghijklm', 'slack-token'],
    ['openai key', 'sk-proj-abcdefghijklmnopqrst', 'openai-api-key'],
    ['anthropic key', 'sk-ant-api03-abcdefghijklmnopqrst', 'anthropic-api-key'],
    ['google key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'google-api-key'],
  ])('redacts a %s', (_label, secret, kind) => {
    const outcome = redactText(`please use ${secret} now`)
    expect(outcome.text).toBe(`please use [REDACTED:${kind}] now`)
    expect(outcome.redactions).toBe(1)
  })

  it('redacts a PEM private key block', () => {
    const outcome = redactText('-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----')
    expect(outcome.text).toBe('[REDACTED:private-key-block]')
    expect(outcome.redactions).toBe(1)
  })

  it('leaves ordinary prose untouched', () => {
    const outcome = redactText('the task tracker was updated and the build passed')
    expect(outcome).toEqual({ text: 'the task tracker was updated and the build passed', redactions: 0 })
  })
})
