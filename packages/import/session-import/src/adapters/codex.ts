/**
 * Codex source adapter: read-only discovery and parsing of
 * `<codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl` rollouts plus
 * `<codexHome>/archived_sessions/*.jsonl`. Both the legacy `function_call`
 * encoding and the newer JS-bridge `custom_tool_call` encoding are handled;
 * call/result pairing follows the source `call_id`.
 * @module @deepseek-ai/dsh-session-import/adapters/codex
 */

import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import type { DiscoveredSession, ExternalConversation, ExternalEntry } from '../model.ts'
import { epochMs, parseFirstJsonlLine, parseJsonlFile } from '../jsonl.ts'
import {
  argumentsJsonOf,
  finalizeConversation,
  promptTitleOf,
  callIdOf,
  isCodexInjectedContext,
  isRecord,
  parseCodexJsBridge,
  stringField,
  toolResultTextOf,
} from './shared.ts'
import type { ParseOptions, ProviderAdapter } from './registry.ts'

/** Options for one Codex parse. */
export interface ParseCodexOptions {
  /** Rejection budget for the whole source file, in bytes. */
  readonly maxFileBytes: number
  /**
   * Discovery-resolved source id. When present it overrides whatever the
   * records say, so import identity always matches the listing that offered
   * the conversation — a truncated first line can otherwise make the two
   * rules diverge.
   */
  readonly sourceId?: string
  /**
   * Codex home directory, for reading the thread-name index. When supplied,
   * the index's current name (renames included) overrides the
   * prompt-derived title on the parsed conversation.
   */
  readonly codexHome?: string
}

/**
 * List the Codex rollout files present under a Codex home directory.
 * A missing store (Codex not installed) is an empty result, not an error.
 * @param codexHome - absolute path of the Codex home directory.
 * @returns one row per rollout, largest first.
 */
export async function discoverCodexSessions(codexHome: string): Promise<DiscoveredSession[]> {
  const found: DiscoveredSession[] = []
  const roots = [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]
  for (const root of roots) {
    await collectRollouts(root, 0, found)
  }
  // The thread index holds the CURRENT name (renames included); it overrides
  // the prompt-derived scan title so a rename inside Codex lands here on the
  // next listing refresh.
  const names = codexThreadNames(codexHome)
  for (const row of found) {
    const indexed = names.get(row.sourceId)
    // codexThreadNames never stores an empty name, so presence is enough.
    if (indexed !== undefined && indexed !== row.title) {
      found[found.indexOf(row)] = { ...row, title: indexed }
    }
  }
  return found.sort((a, b) => b.sizeBytes - a.sizeBytes)
}

/**
 * Recursively collect `*.jsonl` rollout files below one root.
 * @param dir - directory to scan.
 * @param depth - current recursion depth (budgeted).
 * @param found - accumulator for discovered rows.
 */
async function collectRollouts(dir: string, depth: number, found: DiscoveredSession[]): Promise<void> {
  if (depth > 6) return
  let dirEntries: Dirent[]
  try {
    dirEntries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of dirEntries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectRollouts(path, depth + 1, found)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const stats = await stat(path)
      const title = await codexListingTitle(path)
      found.push({
        provider: 'codex',
        sourceId: await codexSessionIdOf(path),
        sourcePath: path,
        sizeBytes: stats.size,
        mtimeMs: Math.round(stats.mtimeMs),
        ...(title === undefined ? {} : { title }),
      })
    } catch {
      continue
    }
  }
}

/**
 * Resolve a rollout's source id: the `session_meta` payload id when the first
 * line carries one, else the file stem. The SAME first-record rule governs the
 * full parse, so discovery and import always agree on the identity.
 * @param sourcePath - absolute rollout path.
 * @returns the source session id.
 */
async function codexSessionIdOf(sourcePath: string): Promise<string> {
  const stem = basename(sourcePath).replace(/\.jsonl$/, '')
  try {
    const first = await parseFirstJsonlLine(sourcePath)
    if (isRecord(first) && first['type'] === 'session_meta' && isRecord(first['payload'])) {
      return stringField(first['payload'], 'id') ?? stem
    }
  } catch {
    // Unreadable rollouts still need a stable listing id.
  }
  return stem
}

/**
 * Parse one Codex rollout into the provider-neutral model.
 * @param sourcePath - absolute path of the rollout file.
 * @param options - parse budget and optional discovery-resolved source id.
 * @returns the conversation, including its skip accounting.
 * @throws {@link Error} when the file cannot be read at all.
 */
export async function parseCodexSession(
  sourcePath: string,
  options: ParseCodexOptions,
): Promise<ExternalConversation> {
  const { values, skippedRecords, oversizedRecords } = await parseJsonlFile(sourcePath, options.maxFileBytes)
  const { stat } = await import('node:fs/promises')
  const stats = await stat(sourcePath)
  const entries: ExternalEntry[] = []
  // Identity precedence: discovery's resolved id, then the PHYSICAL first
  // line's session_meta id, then the file stem — the same precedence discovery
  // uses, so a blank/unparseable/oversized first line resolves identically on
  // both sides.
  const sourceId = options.sourceId
    ?? await (async () => {
      const first = await parseFirstJsonlLine(sourcePath)
      if (isRecord(first) && first['type'] === 'session_meta' && isRecord(first['payload'])) {
        return stringField(first['payload'], 'id')
      }
      return undefined
    })()
    ?? basename(sourcePath).replace(/\.jsonl$/, '')
  let title: string | undefined
  let model: string | undefined
  let workspaceDir: string | undefined
  let startedAt: number | undefined
  let skipped = skippedRecords

  for (const value of values) {
    if (!isRecord(value)) {
      skipped++
      continue
    }
    const at = epochMs(stringField(value, 'timestamp'))
    if (at !== undefined && startedAt === undefined) startedAt = at
    const type = value['type']
    const payload = value['payload']
    if (!isRecord(payload)) {
      skipped++
      continue
    }
    switch (type) {
      case 'session_meta': {
        workspaceDir = stringField(payload, 'cwd') ?? workspaceDir
        continue
      }
      case 'turn_context': {
        model = stringField(payload, 'model') ?? model
        continue
      }
      case 'response_item':
        break
      case 'event_msg':
        // Runtime telemetry (token counts, agent annotations): recognized,
        // deliberately not part of the transcript, and not a skip.
        continue
      default:
        skipped++
        continue
    }
    const itemType = payload['type']
    if (itemType === 'reasoning') {
      // Codex reasoning is stored encrypted-only (summary/content empty), so
      // no plaintext exists to import; recognized and not a skip.
      continue
    }
    if (itemType === 'message') {
      const role = payload['role']
      if (role !== 'user' && role !== 'assistant') {
        // Developer/system roles carry Codex's own instructions; the harness
        // supplies its own, so the content drops with skip accounting.
        skipped++
        continue
      }
    }
    if (itemType === 'message') {
      const role = payload['role']
      const text = codexContentText(payload['content'])
      if (role === 'user') {
        if (isCodexInjectedContext(text)) {
          skipped++
        } else if (text.length > 0) {
          if (title === undefined) title = listingTitleOf(text)
          entries.push({ kind: 'user', text, ...(at !== undefined ? { at } : {}) })
        }
      } else {
        // developer/system roles were already counted above; only assistant remains.
        if (text.length === 0) {
          // An empty assistant record is runtime noise; count, don't import.
          skipped++
        } else {
          entries.push({
            kind: 'assistant',
            text,
            ...(model !== undefined ? { model } : {}),
            ...(at !== undefined ? { at } : {}),
          })
        }
      }
      continue
    }
    if (itemType === 'function_call') {
      const name = stringField(payload, 'name')
      if (name === 'wait') continue
      if (name === undefined) {
        skipped++
        continue
      }
      entries.push({
        kind: 'tool_call',
        callId: callIdOf(payload['call_id']),
        name,
        arguments: argumentsJsonOf(payload['arguments']),
        ...(at !== undefined ? { at } : {}),
      })
      continue
    }
    if (itemType === 'custom_tool_call') {
      const input = toolResultTextOf(payload['input'])
      // Real rollouts name the call directly (apply_patch & friends); the
      // JS-bridge shape (`tools.<name>(...)`) is the fallback strategy.
      const bridge = parseCodexJsBridge(input)
      const name = stringField(payload, 'name') ?? bridge?.name
      if (name === undefined) {
        skipped++
        continue
      }
      entries.push({
        kind: 'tool_call',
        callId: callIdOf(payload['call_id']),
        name,
        arguments: bridge !== undefined && stringField(payload, 'name') === undefined
          ? bridge.arguments
          : JSON.stringify({ input }),
        ...(at !== undefined ? { at } : {}),
      })
      continue
    }
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      const callId = callIdOf(payload['call_id'])
      entries.push({
        kind: 'tool_result',
        callId,
        text: codexOutputTextOf(payload['output']),
        isError: codexOutputIsError(payload['output']),
        ...(at !== undefined ? { at } : {}),
      })
      continue
    }
    skipped++
  }

  // The title stays undefined only when the rollout holds no real user
  // message; listings then fall back to the source id.
  const indexedTitle = options.codexHome !== undefined
    ? codexThreadNames(options.codexHome).get(sourceId)
    : undefined
  return finalizeConversation({
    provider: 'codex', sourceId, sourcePath, stats,
    workspaceDir,
    ...(indexedTitle !== undefined && indexedTitle.length > 0 ? { title: indexedTitle } : { title }),
    model, startedAt, entries, skipped, oversized: oversizedRecords,
  })
}

/** Unwrap a string-encoded JSON envelope, else pass the value through. */
function codexOutputRecord(output: unknown): unknown {
  if (typeof output === 'string' && output.trimStart().startsWith('{')) {
    try {
      return JSON.parse(output) as unknown
    } catch {
      return output
    }
  }
  return output
}

/**
 * Extract the model-facing text of a Codex tool output: a JSON envelope's
 * inner `output` field when present, else the raw value's text.
 * @param output - the raw output value.
 * @returns the extracted text.
 */
function codexOutputTextOf(output: unknown): string {
  const record = codexOutputRecord(output)
  if (isRecord(record) && typeof record['output'] === 'string') return record['output']
  return toolResultTextOf(output)
}

/**
 * Whether a Codex tool output records a failure: a non-zero exit code in the
 * JSON envelope or in the trailing text, or an explicit failure marker.
 * @param output - the raw output value.
 * @returns true when the output carries a failure signal.
 */
function codexOutputIsError(output: unknown): boolean {
  const record = codexOutputRecord(output)
  if (isRecord(record)) {
    if (record['type'] === 'failure') return true
    const metadata = record['metadata']
    if (isRecord(metadata) && typeof metadata['exit_code'] === 'number' && metadata['exit_code'] !== 0) return true
  }
  const text = toolResultTextOf(output)
  const exit = /exited with code (\d+)/.exec(text)
  return exit !== null && exit[1] !== undefined && exit[1] !== '0'
}

/** Parse one JSONL line to a record, or undefined for blanks/bad JSON. */
function safeJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Bounded bytes scanned per rollout while deriving a listing title. */
const TITLE_SCAN_BYTES = 256 * 1024

/** Title a rollout from its first real prompt via the shared prompt-title rule. */
function listingTitleOf(text: string): string | undefined {
  return promptTitleOf(text)
}

/** One row of Codex's own `~/.codex/session_index.jsonl` thread index. */
interface CodexIndexRow {
  readonly id: string
  readonly thread_name?: string
}

/**
 * Read Codex's thread index (`<codexHome>/session_index.jsonl`) as an
 * id→title map. The index is authoritative for thread names: it carries the
 * CURRENT name, so a rename inside Codex updates this file and flows through
 * discovery and preview on the next listing refresh. A missing or unreadable
 * index yields an empty map and callers fall back to prompt-derived titles.
 * @param codexHome - absolute path of the Codex home directory.
 * @returns session id to current thread name.
 */
export function codexThreadNames(codexHome: string): Map<string, string> {
  const names = new Map<string, string>()
  let lines: string
  try {
    lines = readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8')
  } catch {
    return names
  }
  for (const line of lines.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const row = JSON.parse(trimmed) as CodexIndexRow
      if (typeof row.id === 'string' && typeof row.thread_name === 'string' && row.thread_name.length > 0) {
        names.set(row.id, row.thread_name)
      }
    } catch {
      // One torn line never invalidates the rest of the index.
    }
  }
  return names
}

/**
 * Derive a listing title by bounded header scan: the first non-injected user
 * message in the rollout prefix, whitespace-collapsed and length-capped. Codex
 * rollouts carry no explicit title record, so the first real prompt names the
 * conversation — the same convention the harness uses for its own sessions'
 * first-prompt titles. The thread index, when present, overrides this.
 * @param sourcePath - absolute rollout path.
 * @returns the title, or undefined when the prefix holds no real user message.
 */
export async function codexListingTitle(sourcePath: string): Promise<string | undefined> {
  const { open } = await import('node:fs/promises')
  let handle
  try {
    handle = await open(sourcePath, 'r')
  } catch {
    return undefined
  }
  try {
    const stream = handle.createReadStream({ encoding: 'utf8' })
    let carry = ''
    let scanned = 0
    for await (const rawChunk of stream) {
      // utf8-decoded streams always yield strings.
      /* v8 ignore next -- StringDecoder output is always string */
      const chunkText: string = typeof rawChunk === 'string' ? rawChunk : String(rawChunk)
      const chunk = carry + chunkText
      scanned += chunkText.length
      const lines = chunk.split('\n')
      /* v8 ignore next -- split() always yields at least one element */
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const value = safeJson(line)
        if (value === undefined) continue
        if (value['type'] !== 'response_item') continue
        const payload = value['payload']
        if (!isRecord(payload) || payload['type'] !== 'message' || payload['role'] !== 'user') continue
        const text = codexContentText(payload['content'])
        if (text.length === 0 || isCodexInjectedContext(text)) continue
        return listingTitleOf(text)
      }
      if (scanned >= TITLE_SCAN_BYTES) break
    }
    return undefined
  } finally {
    await handle.close()
  }
}

/**
 * Join a Codex message content array (`input_text` / `output_text` blocks) into
 * one text.
 * @param content - the raw content value.
 * @returns the joined text.
 */
function codexContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map(block => isRecord(block) && typeof block['text'] === 'string' ? block['text'] : '')
    .filter(text => text.length > 0)
    .join('\n')
    .trim()
}

/** Normalized adapter surface for the service-class dispatch. */
export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  defaultHomeSegment: '.codex',
  homeSettingKey: 'codexHome',
  discover: discoverCodexSessions,
  parse: (source, options: ParseOptions) => parseCodexSession(source.sourcePath, {
    maxFileBytes: options.maxFileBytes,
    codexHome: options.home,
  }),
}
