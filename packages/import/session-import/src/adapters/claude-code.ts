/**
 * Claude Code source adapter: read-only discovery and parsing of
 * `<claudeHome>/projects/<encoded-project>/<session-uuid>.jsonl` transcripts.
 * The source store is never written. Unreadable lines are counted on the
 * conversation, never silently dropped and never fatal for the rest of the file.
 * @module @deepseek-ai/dsh-session-import/adapters/claude-code
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DiscoveredSession, ExternalConversation, ExternalEntry } from '../model.ts'
import { epochMs, parseJsonlFile } from '../jsonl.ts'
import { argumentsJsonOf, callIdOf, finalizeConversation, isRecord, promptTitleOf, stripClaudeInjectedMarkup, stringField, toolResultTextOf } from './shared.ts'
import type { ParseOptions, ProviderAdapter } from './registry.ts'

/** Options for one Claude Code parse. */
export interface ParseClaudeCodeOptions {
  /** Rejection budget for the whole source file, in bytes. */
  readonly maxFileBytes: number
  /** Keep source thinking blocks as reasoning text instead of dropping them. */
  readonly includeReasoning: boolean
}

/**
 * List the Claude Code transcripts present under a Claude home directory.
 * A missing store (Claude Code not installed) is an empty result, not an error.
 * @param claudeHome - absolute path of the Claude home directory.
 * @returns one row per transcript file, largest first.
 */
export async function discoverClaudeCodeSessions(claudeHome: string): Promise<DiscoveredSession[]> {
  const projectsDir = join(claudeHome, 'projects')
  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return []
  }
  const found: DiscoveredSession[] = []
  for (const projectDir of projectDirs) {
    let files: string[]
    try {
      files = await readdir(join(projectsDir, projectDir))
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const sourcePath = join(projectsDir, projectDir, file)
      try {
        const stats = await stat(sourcePath)
        const title = await claudeListingTitle(sourcePath)
        found.push({
          provider: 'claude-code',
          sourceId: file.slice(0, -'.jsonl'.length),
          sourcePath,
          sizeBytes: stats.size,
          mtimeMs: Math.round(stats.mtimeMs),
          ...(title !== undefined ? { title } : {}),
        })
      } catch {
        continue
      }
    }
  }
  return found.sort((a, b) => b.sizeBytes - a.sizeBytes)
}

/** Content block shapes Claude Code writes into `message.content` arrays. */
type ClaudeBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown }
  | Record<string, unknown>

/**
 * Narrow one parsed content-block value to the Claude Code block vocabulary.
 * @param value - the parsed block value.
 * @returns the typed block, or undefined when the value is not an object with a string type.
 */
function claudeBlockOf(value: unknown): ClaudeBlock | undefined {
  return isRecord(value) && typeof value['type'] === 'string' ? value : undefined
}

/**
 * Parse one Claude Code transcript into the provider-neutral model.
 * @param sourcePath - absolute path of the `.jsonl` transcript.
 * @param options - parse budget and reasoning retention.
 * @returns the conversation, including its skip accounting.
 * @throws {@link Error} when the file cannot be read at all.
 */
export async function parseClaudeCodeSession(
  sourcePath: string,
  options: ParseClaudeCodeOptions,
): Promise<ExternalConversation> {
  const { values, skippedRecords, oversizedRecords } = await parseJsonlFile(sourcePath, options.maxFileBytes)
  const { stat } = await import('node:fs/promises')
  const stats = await stat(sourcePath)
  const sourceId = basename(sourcePath).replace(/\.jsonl$/, '')
  const entries: ExternalEntry[] = []
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
    const type = value['type']
    if (type === 'ai-title') {
      title = stringField(value, 'aiTitle') ?? stringField(value, 'title') ?? stringField(value, 'summary') ?? title
      continue
    }
    if (type === 'summary') {
      title = title ?? stringField(value, 'summary')
      continue
    }
    if (value['isSidechain'] === true) {
      // Sidechain lines inline a subagent's own exchange into this file; they
      // are foreign turns, not parent-conversation history.
      skipped++
      continue
    }
    if (type !== 'user' && type !== 'assistant') {
      skipped++
      continue
    }
    const cwd = stringField(value, 'cwd')
    if (cwd !== undefined && workspaceDir === undefined) workspaceDir = cwd
    const at = epochMs(stringField(value, 'timestamp'))
    if (at !== undefined && startedAt === undefined) startedAt = at
    const message = value['message']
    if (!isRecord(message)) {
      skipped++
      continue
    }
    const lineModel = stringField(message, 'model')
    if (lineModel !== undefined && model === undefined) model = lineModel
    const content = message['content']
    const blocks = typeof content === 'string'
      ? [{ type: 'text', text: content }] as ClaudeBlock[]
      : Array.isArray(content)
        ? content.map(claudeBlockOf).filter((block): block is ClaudeBlock => block !== undefined)
        : []

    if (type === 'assistant') {
      const text = blocks
        .filter(block => block.type === 'text' && typeof block['text'] === 'string')
        .map(block => (block as { text: string }).text)
        .join('\n')
        .trim()
      const reasoning = options.includeReasoning
        ? blocks
          .filter(block => block.type === 'thinking' && typeof block['thinking'] === 'string')
          .map(block => (block as { thinking: string }).thinking)
          .join('\n')
        : undefined
      if (text.length > 0 || reasoning !== undefined && reasoning.length > 0) {
        entries.push({ kind: 'assistant', text, ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning } : {}), ...(lineModel !== undefined ? { model: lineModel } : {}), ...(at !== undefined ? { at } : {}) })
      }
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue
        const callId = callIdOf(block['id'])
        const name = stringField(block, 'name')
        if (name === undefined) {
          skipped++
          continue
        }
        entries.push({
          kind: 'tool_call',
          callId,
          name,
          arguments: argumentsJsonOf(block['input']),
          ...(at !== undefined ? { at } : {}),
        })
      }
      continue
    }

    const entriesBeforeLine = entries.length
    // user line: tool_result blocks are results for earlier calls; text is the prompt.
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        entries.push({
          kind: 'tool_result',
          callId: callIdOf(block['tool_use_id']),
          text: toolResultTextOf(block['content']),
          isError: (block as Record<string, unknown>)['is_error'] === true,
          ...(at !== undefined ? { at } : {}),
        })
      }
    }
    if (value['isMeta'] === true) continue
    const userText = stripClaudeInjectedMarkup(
      blocks
        .filter(block => block.type === 'text' && typeof block['text'] === 'string')
        .map(block => (block as { text: string }).text)
        .join('\n'),
    )
    if (userText.length === 0) {
      // Nothing prompt-like remained and nothing was produced from this line:
      // pure injected markup, counted rather than silently dropped.
      if (entries.length === entriesBeforeLine) skipped++
      continue
    }
    entries.push({ kind: 'user', text: userText, ...(at !== undefined ? { at } : {}) })
  }

  return finalizeConversation({
    provider: 'claude-code', sourceId, sourcePath, stats,
    workspaceDir, title, model, startedAt, entries, skipped, oversized: oversizedRecords,
  })
}

/** Parse one JSON line, returning undefined for unparseable or non-object values. */
function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Bounded bytes scanned per file while deriving a listing title. */
const TITLE_SCAN_BYTES = 256 * 1024

/**
 * Derive a listing title with one bounded prefix scan: the first `ai-title`
 * line wins, else the first real user prompt. Stops as soon as either is
 * found, so the common small transcript costs one short read.
 * @param sourcePath - absolute transcript path.
 * @returns the title, or undefined when the prefix holds neither.
 */
export async function claudeListingTitle(sourcePath: string): Promise<string | undefined> {
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
    let latestTitle: string | undefined
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
        if (value['type'] === 'ai-title') {
          // Claude rewrites the title on rename, so transcripts carry several
          // ai-title lines; the LAST one is current. Keep scanning instead of
          // returning on the first hit.
          const title = stringField(value, 'aiTitle') ?? stringField(value, 'title') ?? stringField(value, 'summary')
          if (title !== undefined && title.length > 0) latestTitle = promptTitleOf(title)
          continue
        }
        if (latestTitle !== undefined) continue
        if (value['type'] !== 'user' || value['isMeta'] === true || value['isSidechain'] === true) continue
        const message = value['message']
        if (!isRecord(message)) continue
        const content = message['content']
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
              .map(block => (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''))
              .join('\n')
            : ''
        const cleaned = stripClaudeInjectedMarkup(text)
        if (cleaned.length > 0) latestTitle = promptTitleOf(cleaned)
      }
      if (scanned >= TITLE_SCAN_BYTES) break
    }
    return latestTitle
  } finally {
    await handle.close()
  }
}

/** Normalized adapter surface for the service-class dispatch. */
export const claudeCodeAdapter: ProviderAdapter = {
  id: 'claude-code',
  defaultHomeSegment: '.claude',
  homeSettingKey: 'claudeHome',
  discover: discoverClaudeCodeSessions,
  parse: (source, options: ParseOptions) => parseClaudeCodeSession(source.sourcePath, {
    maxFileBytes: options.maxFileBytes,
    includeReasoning: options.includeReasoning,
  }),
}
