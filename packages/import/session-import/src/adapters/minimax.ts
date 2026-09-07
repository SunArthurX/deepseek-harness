/**
 * MiniMax source adapter: read-only discovery and parsing of the MiniMax
 * session store (`<minimaxHome>/v2/sqlite/runtime-state.sqlite`) through Node's
 * built-in `node:sqlite` module — no external dependency. Sessions with a
 * `parent_session_id` are subagent transcripts and are excluded from
 * discovery. The store is only ever opened with `readOnly`.
 *
 * Layout (verified against a real v2 store): `local_runtime_sessions` holds
 * columnized metadata (`title`, `workspace_dir`, `created_at_ms`, …) with a
 * `record_json` JSON fallback for older rows; `local_runtime_message_rows`
 * holds one row per message whose `data_json` carries `msg_content`,
 * `thinking_content`, and a `tool_calls` array of
 * `{tool_name, tool_call_id, tool_call_status, tool_call_args,
 * tool_call_result_data}` — status 2 means completed.
 * @module @deepseek-ai/dsh-session-import/adapters/minimax
 */

import { DatabaseSync } from 'node:sqlite'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiscoveredSession, ExternalConversation, ExternalEntry } from '../model.ts'
import { argumentsJsonOf, callIdOf, isRecord, stripClaudeInjectedMarkup, stringField, toolResultTextOf } from './shared.ts'
import type { ParseOptions, ProviderAdapter } from './registry.ts'

/** Completed tool-call status code in the MiniMax wire format. */
const TOOL_CALL_STATUS_COMPLETED = 2

/** Options for one MiniMax parse. */
export interface ParseMinimaxOptions {
  /** Rejection budget for the whole store file, in bytes. */
  readonly maxFileBytes: number
  /** Keep source thinking text as reasoning content instead of dropping it. */
  readonly includeReasoning: boolean
}

/** The store file path for one MiniMax home. */
function storePath(minimaxHome: string): string {
  return join(minimaxHome, 'v2', 'sqlite', 'runtime-state.sqlite')
}

/** Open the MiniMax store read-only (this package never writes source stores). */
function openStore(minimaxHome: string): DatabaseSync {
  return new DatabaseSync(storePath(minimaxHome), { readOnly: true })
}

/**
 * List the top-level MiniMax sessions in the store, most recently updated
 * first. Subagent sessions (non-empty `parent_session_id`) are foreign agent
 * transcripts and are excluded. A missing store is an empty result.
 * @param minimaxHome - absolute path of the MiniMax home directory.
 * @returns one row per top-level session.
 */
export async function discoverMinimaxSessions(minimaxHome: string): Promise<DiscoveredSession[]> {
  const dbPath = storePath(minimaxHome)
  let sizeBytes: number
  let db: DatabaseSync
  try {
    sizeBytes = (await stat(dbPath)).size
    db = openStore(minimaxHome)
  } catch {
    // A missing store (or an unreadable one) has no conversations to list.
    return []
  }
  try {
    const rows = db.prepare(
      'SELECT session_id, title, workspace_dir, created_at_ms, updated_at_ms'
      + ' FROM local_runtime_sessions WHERE parent_session_id IS NULL OR parent_session_id = \'\''
      + ' ORDER BY updated_at_ms DESC',
    ).all() as {
      session_id: string
      title: string | null
      workspace_dir: string | null
      created_at_ms: number | null
      updated_at_ms: number | null
    }[]
    const dbPath = storePath(minimaxHome)
    return rows.map(row => ({
      provider: 'minimax' as const,
      sourceId: row.session_id,
      sourcePath: dbPath,
      sizeBytes,
      mtimeMs: row.updated_at_ms !== null && Number.isSafeInteger(row.updated_at_ms) ? row.updated_at_ms : 0,
      ...(row.title !== null && row.title.length > 0 ? { title: row.title } : {}),
    }))
  } finally {
    db.close()
  }
}

/** First non-empty trimmed string among the candidates. */
function firstText(...values: (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value.length > 0) return value
  }
  return undefined
}

/** Read one string field out of a parsed `record_json`, when present. */
function recordText(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record === undefined ? undefined : record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read one numeric field out of a parsed `record_json`, when present. */
function numberFromRecord(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record === undefined ? undefined : record[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/** Parse JSON, returning undefined for unparseable or non-object values. */
function safeJson(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract the model-facing text of a tool result: MiniMax wraps it in a JSON
 * envelope (`{"content":[{"type":"text","text":…}]}`), whose inner texts are
 * joined; anything else falls through to the shared text extractor.
 * @param value - the raw `tool_call_result_data` value.
 * @returns the extracted text.
 */
function resultTextOf(value: unknown): string {
  if (typeof value === 'string' && value.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (isRecord(parsed) && Array.isArray(parsed['content'])) {
        const text = parsed['content']
          .map(block => (isRecord(block) && typeof block['text'] === 'string' ? block['text'] : ''))
          .filter(text => text.length > 0)
          .join('\n')
        if (text.length > 0) return text
      }
    } catch {
      // Not an envelope; fall through to the shared extractor.
    }
  }
  return toolResultTextOf(value)
}

/**
 * Parse one MiniMax session — `local_runtime_message_rows` in id order — into
 * the provider-neutral model. Assistant rows carry text, thinking, and a
 * `tool_calls` array whose entries embed both the call arguments and the
 * result payload, so each call maps to a `tool_call` entry immediately
 * followed by its `tool_result` entry.
 * @param sessionId - the source session id to parse.
 * @param options - parse budget and thinking retention.
 * @param minimaxHome - absolute path of the MiniMax home directory.
 * @returns the conversation, including its skip accounting.
 * @throws when the store or the session cannot be read.
 */
export async function parseMinimaxSession(
  sessionId: string,
  options: ParseMinimaxOptions,
  minimaxHome: string,
): Promise<ExternalConversation> {
  const dbPath = storePath(minimaxHome)
  const stats = await stat(dbPath)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const session = db.prepare(
      'SELECT session_id, record_json, title, workspace_dir, created_at_ms'
      + ' FROM local_runtime_sessions WHERE session_id = ?',
    ).get(sessionId) as {
      session_id: string
      record_json: string | null
      title: string | null
      workspace_dir: string | null
      created_at_ms: number | null
    } | undefined
    if (session === undefined) throw new Error(`minimax session "${sessionId}" was not found in ${minimaxHome}`)
    const record = safeJson(session.record_json)

    const entries: ExternalEntry[] = []
    let skipped = 0
    const messages = db.prepare(
      'SELECT role, created_at_ms, data_json FROM local_runtime_message_rows WHERE session_id = ? ORDER BY id',
    ).all(sessionId) as { role: string | null; created_at_ms: number | null; data_json: string | null }[]

    for (const row of messages) {
      const data = safeJson(row.data_json)
      const at = row.created_at_ms !== null && Number.isSafeInteger(row.created_at_ms) ? row.created_at_ms : undefined
      if (row.role !== 'user' && row.role !== 'assistant') {
        skipped++
        continue
      }
      if (data === undefined) {
        skipped++
        continue
      }

      if (row.role === 'user') {
        const raw = stringField(data, 'msg_content')
        if (raw === undefined) {
          skipped++
          continue
        }
        const cleaned = stripClaudeInjectedMarkup(raw)
        if (cleaned.length === 0) {
          skipped++
          continue
        }
        entries.push({ kind: 'user', text: cleaned, ...(at !== undefined ? { at } : {}) })
        continue
      }

      const text = stringField(data, 'msg_content') ?? ''
      const thinking = stringField(data, 'thinking_content')
      const reasoning = options.includeReasoning && thinking !== undefined && thinking.length > 0 ? thinking : undefined
      const toolCalls = Array.isArray(data['tool_calls'])
        ? data['tool_calls'].map(call => (isRecord(call) ? call : undefined)).filter(call => call !== undefined)
        : []
      if (text.length > 0 || reasoning !== undefined || toolCalls.length > 0) {
        entries.push({
          kind: 'assistant',
          text,
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(at !== undefined ? { at } : {}),
        })
      }
      let callCounter = 0
      for (const call of toolCalls) {
        const name = stringField(call, 'tool_name')
        if (name === undefined) {
          skipped++
          continue
        }
        callCounter++
        const callId = callIdOf(stringField(call, 'tool_call_id') ?? `minimax-${sessionId}-${callCounter}`)
        entries.push({
          kind: 'tool_call',
          callId,
          name,
          arguments: argumentsJsonOf(stringField(call, 'tool_call_args') ?? '{}'),
          ...(at !== undefined ? { at } : {}),
        })
        entries.push({
          kind: 'tool_result',
          callId,
          text: resultTextOf(call['tool_call_result_data']),
          isError: call['tool_call_status'] !== TOOL_CALL_STATUS_COMPLETED,
          ...(at !== undefined ? { at } : {}),
        })
      }
    }

    const workspaceDir = firstText(session.workspace_dir, recordText(record, 'workspaceDir'))
    const title = firstText(session.title, recordText(record, 'title'))
    const createdAt = session.created_at_ms ?? numberFromRecord(record, 'createdAtMs')
    return {
      provider: 'minimax',
      sourceId: sessionId,
      sourcePath: dbPath,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      ...(workspaceDir !== undefined ? { workspaceDir } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(createdAt !== undefined ? { startedAt: createdAt } : {}),
      entries,
      skippedRecords: skipped,
      oversizedRecords: 0,
    }
  } finally {
    db.close()
  }
}

/** Normalized adapter surface for the service-class dispatch. */
export const minimaxAdapter: ProviderAdapter = {
  id: 'minimax',
  defaultHomeSegment: '.minimax',
  homeSettingKey: 'minimaxHome',
  discover: discoverMinimaxSessions,
  parse: (source, options: ParseOptions) => parseMinimaxSession(source.sourceId, {
    maxFileBytes: options.maxFileBytes,
    includeReasoning: options.includeReasoning,
  }, options.home),
}
