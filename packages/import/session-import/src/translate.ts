/**
 * Translate one external conversation into a continuable DeepSeek Harness
 * session seed. The produced log is a complete, balanced event sequence: it
 * opens with a `request/header`, carries the import provenance, and replays the
 * source exchanges as turns whose assistant tool calls are always closed by
 * `tool/result` events — the shape later request assembly requires.
 * @module @deepseek-ai/dsh-session-import/translate
 */

import type { SessionEvent, SessionEventMap, SessionEventType, SurfaceEventType, SurfaceIntent } from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ExternalConversation } from './model.ts'
import type { SessionImportSourceEventData } from './types.ts'
import { redactText } from './redact.ts'

export type { SessionImportSourceEventData } from './types.ts'

/** Options resolving one translation. Produced by the service's explicit resolve step. */
export interface TranslationSpec {
  /** Model id recorded when the source store reports none. */
  readonly fallbackModel: string
  /** Keep source reasoning text as `reasoning` blocks instead of dropping it. */
  readonly includeReasoning: boolean
  /** Per-tool-result text cap, in characters. */
  readonly maxToolResultChars: number
  /** Replace credential-shaped substrings before they enter the durable log. */
  readonly redactSecrets: boolean
}

/** Error thrown for a source conversation that carries no importable content. */
export class EmptyConversationError extends Error {
  constructor(sourceId: string) {
    super(`external conversation "${sourceId}" has no importable entries`)
    this.name = 'EmptyConversationError'
  }
}

/** Error thrown when neither the source store nor the resolved spec names a model. */
export class MissingModelError extends Error {
  constructor(sourceId: string) {
    super(`external conversation "${sourceId}" records no model id and no fallbackModel was resolved`)
    this.name = 'MissingModelError'
  }
}

/**
 * Brand a source call id as the tool-call identity the log stores. Branded ids
 * are compile-time only, so the source string carries over unchanged.
 * @param id - the source call id string.
 * @returns the same string, branded.
 */
function toolCallId(id: string): ToolCallId {
  return id as ToolCallId
}

/** Truncate one text to a character budget, recording an ellipsis when cut. */
function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`
}

/**
 * Translate a parsed external conversation into a seed. Every assistant tool
 * call in the output is closed by a tool result: results missing from a
 * truncated source are synthesized as error results, because a dangling tool
 * call would make the first continued request provider-invalid.
 * @param conversation - the adapter-parsed source conversation.
 * @param spec - the resolved translation options.
 * @param importedAt - import completion time in epoch milliseconds.
 * @returns the seed events, contiguous from seq 0 and structurally balanced.
 * @throws {@link EmptyConversationError} when the conversation has no entries.
 * @throws {@link MissingModelError} when no model id is available.
 */
export function translateConversation(
  conversation: ExternalConversation,
  spec: TranslationSpec,
  importedAt: number,
): SessionEvent[] {
  if (conversation.entries.length === 0) throw new EmptyConversationError(conversation.sourceId)
  const model = conversation.model ?? spec.fallbackModel
  if (model.length === 0) throw new MissingModelError(conversation.sourceId)

  const redactions = { count: 0 }
  const applyRedactions = (text: string): string => {
    if (!spec.redactSecrets) return text
    const outcome = redactText(text)
    redactions.count += outcome.redactions
    return outcome.text
  }
  const timeOf = (at: number | undefined): number => at ?? conversation.startedAt ?? importedAt

  // The body is assembled before the header/provenance prefix is known (the
  // redaction and skip counts are only final after the walk), so push assigns
  // body-relative seqs and the single assembly below reindexes once.
  const body: SessionEvent[] = []
  let nextSeq = 0
  function push<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    time: number,
    ...surface: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): void {
    body.push({ type, seq: nextSeq++, time, data, ...surface[0] } as SessionEvent)
  }

  let turn = 0
  let turnOpen = false
  let cursorTime = conversation.startedAt ?? importedAt
  /** Whether an assistant message is open and awaiting emission (text or calls may still join it). */
  let assistantOpen = false
  let pendingText: string | undefined
  let pendingReasoning: string | undefined
  /** Tool calls accumulated for the pending assistant message. */
  const pendingCalls: { id: ToolCallId; name: string; arguments: string }[] = []
  /** Call ids emitted as `tool/call` whose `tool/result` has not been emitted yet. */
  const awaitingResults = new Set<ToolCallId>()
  const seenCallIds = new Set<ToolCallId>()
  let skipped = 0

  function flushAssistant(): void {
    if (!assistantOpen) return
    assistantOpen = false
    const text = pendingText
    const reasoning = pendingReasoning
    const calls = pendingCalls.splice(0)
    pendingText = undefined
    pendingReasoning = undefined
    const content = [
      ...(text !== undefined && text.length > 0 ? [{ type: 'text' as const, text }] : []),
      ...(reasoning !== undefined && reasoning.length > 0 ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      ...calls.map(call => ({ type: 'tool-call' as const, id: call.id, name: call.name, arguments: call.arguments })),
    ]
    if (content.length === 0) return
    ensureTurn()
    push('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content,
        source: { provider: conversation.provider, model },
      }),
    }, cursorTime, { surfaceOp: 'append' })
    for (const call of calls) {
      push('tool/call', {
        turn,
        step: 1,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      }, cursorTime)
      awaitingResults.add(call.id)
    }
  }

  function ensureTurn(): void {
    if (turnOpen) return
    turn++
    turnOpen = true
    push('turn/start', { turn }, cursorTime)
    push('step/start', { turn, step: 1 }, cursorTime)
  }

  function pushToolResult(callId: ToolCallId, text: string, isError: boolean, time: number): void {
    // An empty text block is useless to the continuing model; name the cause.
    if (text.length === 0) text = 'import: the source tool result carried no text content.'
    push('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text }],
        isError,
      }),
    }, time, { surfaceOp: 'append' })
  }

  /** Close still-open calls with explicit error results so a call and its result never straddle a turn. */
  function closeAwaitingCalls(): void {
    for (const callId of awaitingResults) {
      pushToolResult(
        callId,
        'import: the source transcript never recorded this tool result.',
        true,
        cursorTime,
      )
    }
    awaitingResults.clear()
  }

  function closeTurn(): void {
    if (!turnOpen) return
    closeAwaitingCalls()
    push('step/end', { turn, step: 1 }, cursorTime)
    push('turn/end', { turn, reason: { kind: 'completed' } }, cursorTime)
    turnOpen = false
  }

  for (const entry of conversation.entries) {
    switch (entry.kind) {
      case 'user': {
        flushAssistant()
        closeTurn()
        cursorTime = timeOf(entry.at)
        ensureTurn()
        push('user/message', createUserMessage({
          content: [{ type: 'text', text: applyRedactions(entry.text) }],
          source: { kind: 'user' },
        }), cursorTime, { surfaceOp: 'append' })
        break
      }
      case 'assistant': {
        flushAssistant()
        cursorTime = timeOf(entry.at)
        assistantOpen = true
        const text = applyRedactions(entry.text)
        pendingText = text.length > 0 ? text : undefined
        pendingReasoning = spec.includeReasoning && entry.reasoning !== undefined
          ? applyRedactions(entry.reasoning)
          : undefined
        break
      }
      case 'tool_call': {
        cursorTime = timeOf(entry.at)
        const callId = toolCallId(entry.callId)
        if (seenCallIds.has(callId)) {
          // A repeated call id would duplicate history: the first occurrence
          // stays, the repeat is dropped and counted.
          skipped++
          break
        }
        seenCallIds.add(callId)
        // A call with no open assistant message opens one: sources record the
        // call without the (empty) assistant turn that requested it, and the
        // call must stay attached to an assistant message for the continued
        // request to be provider-valid.
        assistantOpen = true
        pendingCalls.push({
          id: callId,
          name: entry.name,
          arguments: applyRedactions(entry.arguments),
        })
        break
      }
      case 'tool_result': {
        flushAssistant()
        cursorTime = timeOf(entry.at)
        const callId = toolCallId(entry.callId)
        if (!awaitingResults.has(callId)) {
          // A result whose call was never imported: emitting it would place a
          // tool message with no matching assistant tool call in the history.
          skipped++
          break
        }
        awaitingResults.delete(callId)
        pushToolResult(callId, truncate(applyRedactions(entry.text), spec.maxToolResultChars), entry.isError, cursorTime)
        break
      }
    }
  }

  flushAssistant()
  // closeTurn synthesizes error results for calls the source never answered,
  // so the continued request is valid even when the transcript ends mid-call.
  closeTurn()

  const provenance: SessionImportSourceEventData = {
    provider: conversation.provider,
    sourceId: conversation.sourceId,
    sourcePath: conversation.sourcePath,
    sizeBytes: conversation.sizeBytes,
    mtimeMs: conversation.mtimeMs,
    importedAt,
    redactions: redactions.count,
    skippedRecords: conversation.skippedRecords + skipped,
    oversizedRecords: conversation.oversizedRecords,
    ...(conversation.workspaceDir !== undefined ? { sourceWorkspaceDir: conversation.workspaceDir } : {}),
  }
  const header: SessionEvent = {
    type: 'request/header',
    seq: 0,
    time: conversation.startedAt ?? importedAt,
    data: { header: { config: { provider: conversation.provider, model } }, reason: 'initial' },
  }
  const sourceEvent: SessionEvent = { type: 'session-import/source', seq: 1, time: importedAt, data: provenance }
  // The source conversation's title survives the import as a durable
  // `session/title` event, so harness surfaces show the imported name instead
  // of re-deriving one from the (possibly noisy) first prompt. messageSeqs
  // cites the first imported user message when one exists.
  const titleEvents: SessionEvent[] = conversation.title === undefined
    ? []
    : [{
      type: 'session/title',
      seq: 2,
      time: importedAt,
      data: {
        title: conversation.title,
        messageSeqs: firstUserMessageSeq(body),
        source: { kind: 'fallback' },
      },
    }]
  const ordered = [header, sourceEvent, ...titleEvents, ...body]
  // Single documented reindex: body-relative seqs shift behind the two leading events.
  const events = ordered.map((event, index) => event.seq === index ? event : { ...event, seq: index }) as SessionEvent[]

  // findSeedStructuralError is deliberately NOT re-run here: the translator
  // constructs balance by construction, and tests + the invariant companion
  // assert the validator over real outputs.
  return events
}

/** The leading events every imported seed carries before any title event. */
const SEED_BASE_EVENTS = 3

/**
 * Seq of the first `user/message` in the ordered body, rebased behind the
 * seed's leading header/provenance/title events.
 * @param body - body events with their build-time relative seqs.
 * @returns the absolute seq, or an empty citation when the body holds none.
 */
function firstUserMessageSeq(body: readonly SessionEvent[]): number[] {
  const first = body.find(event => event.type === 'user/message')
  return first === undefined ? [] : [first.seq + SEED_BASE_EVENTS]
}

/**
 * Check the structural invariants an imported seed must satisfy for request
 * assembly: header first, provenance second, balanced turns and steps, and
 * every logged tool call closed by exactly one result. Pure — also used by the
 * invariant companion and tests.
 * @param events - the candidate seed, in seq order.
 * @returns the first structural problem, or undefined when the seed is valid.
 */
export function findSeedStructuralError(events: readonly SessionEvent[]): string | undefined {
  const header = events[0]
  if (header === undefined || header.type !== 'request/header') return 'first event is not a request/header'
  const provenance = events[1]
  if (provenance === undefined || provenance.type !== 'session-import/source') {
    return 'second event is not the import provenance'
  }
  if (header.seq !== 0 || provenance.seq !== 1) {
    return 'request/header and provenance must sit at seq 0 and seq 1'
  }
  let openTurn: number | undefined
  let openStep: number | undefined
  const unclosedCalls = new Map<string, string>()
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        if (openTurn !== undefined) return `turn/start ${event.data.turn} inside open turn ${openTurn}`
        openTurn = event.data.turn
        break
      case 'step/start':
        if (openTurn === undefined) return `step/start ${event.data.step} with no open turn`
        if (openStep !== undefined) return `step/start ${event.data.step} inside open step ${openStep}`
        openStep = event.data.step
        break
      case 'step/end':
        if (openStep === undefined || openStep !== event.data.step) {
          return `step/end ${event.data.step} does not close the open step`
        }
        openStep = undefined
        break
      case 'turn/end':
        if (openTurn !== event.data.turn) return `turn/end ${event.data.turn} does not close open turn ${openTurn}`
        if (openStep !== undefined) return `turn/end ${event.data.turn} leaves step ${openStep} open`
        openTurn = undefined
        break
      case 'tool/call':
        if (unclosedCalls.has(event.data.callId)) return `duplicate tool/call id ${event.data.callId}`
        unclosedCalls.set(event.data.callId, event.data.name)
        break
      case 'tool/result':
        if (!unclosedCalls.delete(event.data.message.source.callId)) {
          return `tool/result for unopened call ${event.data.message.source.callId}`
        }
        break
      default:
        break
    }
  }
  if (openTurn !== undefined) return `turn ${openTurn} never ends`
  const unclosed = unclosedCalls.entries().next()
  if (!unclosed.done) return `tool/call ${unclosed.value[0]} (${unclosed.value[1]}) never completes`
  return undefined
}
