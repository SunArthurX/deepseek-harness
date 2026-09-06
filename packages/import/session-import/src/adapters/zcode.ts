/**
 * ZCode source adapter: read-only discovery and parsing of the ZCode session
 * store (`<zcodeHome>/cli/db/db.sqlite`) through Node's built-in `node:sqlite`
 * module — no external dependency. Sessions with a `parent_id` are subagent
 * transcripts, not conversations, and are excluded from discovery. The store
 * is only ever opened with `readOnly`.
 * @module @deepseek-ai/dsh-session-import/adapters/zcode
 */

import { DatabaseSync } from 'node:sqlite'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiscoveredSession, ExternalConversation, ExternalEntry } from '../model.ts'
import { argumentsJsonOf, callIdOf, isRecord, stripClaudeInjectedMarkup, stringField, toolResultTextOf } from './shared.ts'

/** Open the ZCode store read-only (this package never writes source stores). */
function openStore(zcodeHome: string): DatabaseSync {
  return new DatabaseSync(storePath(zcodeHome), { readOnly: true })
}

/** Options for one ZCode parse. */
export interface ParseZcodeOptions {
  /** Rejection budget for the whole store file, in bytes. */
  readonly maxFileBytes: number
  /** Keep source reasoning text as reasoning content instead of dropping it. */
  readonly includeReasoning: boolean
}

/**
 * List the top-level ZCode sessions in the store, most recently updated first.
 * Subagent sessions (non-empty `parent_id`) are foreign agent transcripts and
 * are excluded. A missing store is an empty result, not an error.
 * @param zcodeHome - absolute path of the ZCode home directory.
 * @returns one row per top-level session.
 */
export async function discoverZcodeSessions(zcodeHome: string): Promise<DiscoveredSession[]> {
  let db: DatabaseSync
  try {
    db = openStore(zcodeHome)
  } catch {
    return []
  }
  try {
    // Keep the async signature so callers may uniformly await discovery.
    await Promise.resolve()
    const rows = db.prepare(
      "SELECT id, directory, title, time_created, time_updated FROM session WHERE parent_id IS NULL OR parent_id = ''",
    ).all() as { id: string; directory: string | null; title: string | null; time_created: number; time_updated: number }[]
    const dbPath = storePath(zcodeHome)
    return rows.map(row => ({
      provider: 'zcode' as const,
      sourceId: row.id,
      sourcePath: dbPath,
      sizeBytes: 0,
      mtimeMs: Math.round(row.time_updated),
      ...(typeof row.title === 'string' && row.title.length > 0 ? { title: row.title } : {}),
    }))
  } finally {
    db.close()
  }
}

/**
 * Parse one ZCode session — messages joined with their ordered parts — into
 * the provider-neutral model. ZCode tool parts carry call and output in one
 * record, so each maps to a `tool_call` entry immediately followed by its
 * `tool_result` entry.
 * @param sessionId - the source session id to parse.
 * @param options - parse budget and reasoning retention.
 * @param zcodeHome - absolute path of the ZCode home directory.
 * @returns the conversation, including its skip accounting.
 * @throws when the store or the session cannot be read.
 */
export async function parseZcodeSession(
  sessionId: string,
  options: ParseZcodeOptions,
  zcodeHome: string,
): Promise<ExternalConversation> {
  const dbPath = storePath(zcodeHome)
  const stats = await stat(dbPath)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    type SessionRow = {
      id: string
      directory: string | null
      title: string | null
      time_created: number
      time_updated: number
    }
    const session = db.prepare(
      'SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?',
    ).get(sessionId) as SessionRow | undefined
    if (session === undefined) throw new Error(`zcode session "${sessionId}" was not found in ${zcodeHome}`)

    const entries: ExternalEntry[] = []
    let skipped = 0
    let model: string | undefined
    const messages = db.prepare(
      'SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY sequence',
    ).all(sessionId) as { id: string; data: string; time_created: number }[]

    for (const messageRow of messages) {
      const message = safeJson(messageRow.data)
      if (!isRecord(message)) {
        skipped++
        continue
      }
      const role = message['role']
      const timeField = isRecord(message['time']) ? message['time']['created'] : messageRow.time_created
      const at = typeof timeField === 'number' && Number.isSafeInteger(timeField) ? timeField : undefined
      const lineModel = modelIdOf(message)
      if (lineModel !== undefined && model === undefined) model = lineModel
      const parts = (db.prepare(
        'SELECT data FROM part WHERE message_id = ? ORDER BY sequence',
      ).all(messageRow.id) as { data: string }[]).map(row => safeJson(row.data)).filter(isRecord)

      if (role === 'user') {
        if (message['synthetic'] === true) {
          skipped++
          continue
        }
        const text = stripClaudeInjectedMarkup(
          parts
            .map(part => (part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : ''))
            .join('\n'),
        )
        if (text.length === 0) {
          skipped++
          continue
        }
        entries.push({ kind: 'user', text, ...(at !== undefined ? { at } : {}) })
        continue
      }
      if (role !== 'assistant') {
        // system/carryover roles are harness carriers; count them as skips.
        skipped++
        continue
      }
      /* v8 ignore else -- the role filter above leaves only 'assistant', so the implicit fall-through is unreachable. */
      if (role === 'assistant') { // oxlint-disable-line typescript/no-unnecessary-condition -- role is 'assistant' by the filter above
        const text = parts
          .map(part => (part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : ''))
          .join('\n')
          .trim()
        const reasoning = options.includeReasoning
          ? parts
            .map(part => (part['type'] === 'reasoning' && typeof part['text'] === 'string' ? part['text'] : ''))
            .filter(reasoningText => reasoningText.length > 0)
            .join('\n')
          : undefined
        const tools = parts.filter(isZcodeToolPart)
        if (text.length > 0 || reasoning !== undefined && reasoning.length > 0 || tools.length > 0) {
          entries.push({
            kind: 'assistant',
            text,
            ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning } : {}),
            ...(lineModel !== undefined ? { model: lineModel } : {}),
            ...(at !== undefined ? { at } : {}),
          })
        }
        for (const tool of tools) {
          const state = isRecord(tool['state']) ? tool['state'] : undefined
          const callId = callIdOf(tool['callID'])
          const name = stringField(tool, 'tool')
          /* v8 ignore if -- isZcodeToolPart already required a non-empty string tool name. */
          if (name === undefined) {
            skipped++
            continue
          }
          entries.push({
            kind: 'tool_call',
            callId,
            name,
            arguments: argumentsJsonOf(state !== undefined && isRecord(state['input']) ? state['input'] : {}),
            ...(at !== undefined ? { at } : {}),
          })
          const output = state !== undefined ? toolResultTextOf(state['output']) : ''
          entries.push({
            kind: 'tool_result',
            callId,
            text: output,
            isError: state !== undefined && state['status'] === 'error',
            ...(at !== undefined ? { at } : {}),
          })
        }
        continue
      }
      /* v8 ignore next -- unreachable: user, assistant, and other roles all continue above. */
      skipped++
    }

    const workspaceDir = typeof session.directory === 'string' && session.directory.length > 0 ? session.directory : undefined
    const title = typeof session.title === 'string' && session.title.length > 0 ? session.title : undefined
    return {
      provider: 'zcode',
      sourceId: sessionId,
      sourcePath: dbPath,
      sizeBytes: stats.size,
      mtimeMs: Math.round(stats.mtimeMs),
      ...(workspaceDir !== undefined ? { workspaceDir } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(model !== undefined ? { model } : {}),
      startedAt: session.time_created,
      entries,
      skippedRecords: skipped,
      oversizedRecords: 0,
    }
  } finally {
    db.close()
  }
}

/** The ZCode tool part shape: `data.type === 'tool'` with a `tool` name. */
function isZcodeToolPart(part: Record<string, unknown>): boolean {
  return part['type'] === 'tool' && typeof part['tool'] === 'string' && part['tool'].length > 0
}

/** The store file path for one ZCode home. */
function storePath(zcodeHome: string): string {
  return join(zcodeHome, 'cli', 'db', 'db.sqlite')
}

/** Parse JSON, returning undefined for unparseable or non-object values. */
function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Model ids recorded on a message record, when present. */
function modelIdOf(message: Record<string, unknown>): string | undefined {
  const direct = stringField(message, 'modelID')
  if (direct !== undefined) return direct
  const model = message['model']
  if (isRecord(model)) return stringField(model, 'modelID')
  return undefined
}

/**
 * The ids of sessions whose title, message data, or part data contains the
 * query substring (SQL LIKE, case-insensitive for ASCII).
 * @param zcodeHome - absolute path of the ZCode home directory.
 * @param query - the raw query substring (any length ≥ 1).
 * @returns the matching session ids.
 */
export function zcodeSessionsMatching(zcodeHome: string, query: string): Set<string> {
  let db: DatabaseSync
  try {
    db = openStore(zcodeHome)
  } catch {
    // A missing store simply has no matches.
    return new Set()
  }
  const escaped = query.replace(/[\\%_]/g, '$&')
  const pattern = `%${escaped}%`
  try {
    const rows = db.prepare(
      'SELECT DISTINCT s.id AS id FROM session s'
      + ' LEFT JOIN message m ON m.session_id = s.id'
      + ' LEFT JOIN part p ON p.message_id = m.id'
      + " WHERE s.title LIKE ? ESCAPE '\\' OR m.data LIKE ? ESCAPE '\\' OR p.data LIKE ? ESCAPE '\\'",
    ).all(pattern, pattern, pattern) as { id: string }[]
    return new Set(rows.map(row => row.id))
  } finally {
    db.close()
  }
}
