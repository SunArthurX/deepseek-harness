/**
 * Type guards and sanitizers shared by the external-store adapters. Kept in one
 * place so both adapters treat malformed records identically and the clone
 * detector sees no parallel helper copies.
 * @module @deepseek-ai/dsh-session-import/adapters/shared
 */

import { fallbackSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { ExternalConversation, ExternalEntry } from '../model.ts'

/**
 * Whether a runtime value is a plain record (JSON object).
 * @param value - the runtime value to test.
 * @returns true when the value is a non-null object and not an array.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a required non-empty string field from a record.
 * @param record - the parsed source record.
 * @param key - the field name.
 * @returns the string, or undefined when absent, empty, or not a string.
 */
export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Prefixes Codex injects as user-role records for runtime context; never real prompts. */
const CODEX_INJECTED_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<recommended_plugins>',
  '<turn_context>',
  '<turn_aborted>',
  '<runtime_credentials>',
  '<IDE_INFORMATION>',
  '<ENVIRONMENT',
  '# AGENTS.md',
  '<system-reminder>',
]

/**
 * Whether a Codex user text is an injected runtime block rather than a prompt.
 * @param text - the user-role text.
 * @returns true when the text starts with a known injection marker.
 */
export function isCodexInjectedContext(text: string): boolean {
  return CODEX_INJECTED_PREFIXES.some(prefix => text.startsWith(prefix))
}

/**
 * Remove strips of harness-injected markup from Claude Code user text and
 * report whether anything prompt-like remains.
 * @param text - the raw user text.
 * @returns the cleaned text, already trimmed; empty when only markup remained.
 */
export function stripClaudeInjectedMarkup(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .trim()
}

/**
 * Extract readable text from a source tool-result content value (a string, an
 * array of text blocks, or anything else stringified).
 * @param value - the raw content value.
 * @returns the extracted text.
 */
export function toolResultTextOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(block => isRecord(block) && typeof block['text'] === 'string' ? block['text'] : '')
      .filter(text => text.length > 0)
      .join('\n')
  }
  if (isRecord(value)) {
    const output = value['output']
    if (typeof output === 'string') return output
    if (typeof value['text'] === 'string') return value['text']
    if (typeof value['content'] === 'string') return value['content']
    return JSON.stringify(value)
  }
  return String(value)
}

/** Counter for synthesizing call ids when a source record carries none. */
let synthesizedCallSeq = 0

/**
 * Return the source call id, or synthesize a stable substitute for sources
 * that recorded a call without an id.
 * @param callId - the raw call id field, when present.
 * @returns a non-empty call id.
 */
export function callIdOf(callId: unknown): string {
  if (typeof callId === 'string' && callId.length > 0) return callId
  synthesizedCallSeq++
  return `imported-call-${synthesizedCallSeq}`
}

/**
 * Keep tool-call arguments provider-valid: the durable log stores the raw JSON
 * string, and later continuation requests parse it, so an unparseable source
 * record is wrapped instead of passed through.
 * @param arguments_ - the raw arguments value (expected to be a JSON string).
 * @returns a JSON-parseable arguments string.
 */
export function argumentsJsonOf(arguments_: unknown): string {
  if (typeof arguments_ === 'string' && arguments_.length > 0) {
    try {
      JSON.parse(arguments_)
      return arguments_
    } catch {
      return JSON.stringify({ raw: arguments_ })
    }
  }
  if (arguments_ === undefined || arguments_ === null) return '{}'
  return JSON.stringify(arguments_)
}

/**
 * Extract the tool name and arguments from a Codex JS-bridge call input
 * (`tools.<name>({...})`).
 * @param input - the custom-tool-call input text.
 * @returns the extracted name and arguments, or undefined when the input is not a bridge call.
 */
export function parseCodexJsBridge(input: string): { name: string; arguments: string } | undefined {
  const match = /tools\.([A-Za-z0-9_]+)\s*\(/.exec(input)
  if (match === null || match[1] === undefined) return undefined
  const name: string = match[1]
  const open = input.indexOf('(', match.index)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = open; i < input.length; i++) {
    const ch = input[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) {
        const body = input.slice(open + 1, i).trim()
        return { name, arguments: argumentsJsonOf(body.length > 0 ? body : '{}') }
      }
    }
  }
  return { name, arguments: JSON.stringify({ raw: input }) }
}

/**
 * Assemble the parsed conversation envelope and apply the shared title rule:
 * an explicit title wins; otherwise the first user prompt seeds one, trimmed
 * to sixty characters. Both adapters would otherwise drift apart here.
 * @param parts - the adapter's parsed fields and transcript entries.
 * @returns the finished conversation.
 */
export function finalizeConversation(parts: {
  readonly provider: 'claude-code' | 'codex'
  readonly sourceId: string
  readonly sourcePath: string
  readonly stats: { readonly size: number; readonly mtimeMs: number }
  readonly workspaceDir?: string | undefined
  title?: string | undefined
  readonly model?: string | undefined
  readonly startedAt?: number | undefined
  readonly entries: ExternalEntry[]
  readonly skipped: number
  readonly oversized: number
}): ExternalConversation {
  let { title } = parts
  if (title === undefined) {
    const firstUser = parts.entries.find(entry => entry.kind === 'user')
    if (firstUser !== undefined) {
      title = promptTitleOf(firstUser.text)
    }
  }
  return {
    provider: parts.provider,
    sourceId: parts.sourceId,
    sourcePath: parts.sourcePath,
    sizeBytes: parts.stats.size,
    mtimeMs: Math.round(parts.stats.mtimeMs),
    ...(parts.workspaceDir !== undefined ? { workspaceDir: parts.workspaceDir } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(parts.model !== undefined ? { model: parts.model } : {}),
    ...(parts.startedAt !== undefined ? { startedAt: parts.startedAt } : {}),
    entries: parts.entries,
    skippedRecords: parts.skipped,
    oversizedRecords: parts.oversized,
  }
}

/**
 * Derive a clean conversation title from a raw first prompt, the way the
 * harness names its own sessions: strip slash-command prefixes (`/goal 1.`)
 * and markdown link syntax, then bound to whole words and UTF-8 bytes via the
 * harness title normalizer. Shared by every provider that must title from a
 * prompt (Codex, Claude Code); stores with real title columns pass those
 * through untouched.
 * @param text - the raw first user prompt, any length or shape.
 * @returns the normalized title, or undefined when nothing title-like remains.
 */
export function promptTitleOf(text: string): string | undefined {
  const cleaned = text
    .replace(/^\s*(?:\/[A-Za-z][\w-]*\s*)+(?:\d+[\.:、]\s*)?/, '')
    .replace(/^\s*```[\w-]*\s*/m, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  const title = fallbackSessionTitle(cleaned, 12, 80)
  return title.length > 0 ? title : undefined
}
