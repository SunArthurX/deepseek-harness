/**
 * Shared JSONL reading for external agent stores: bounded lines, per-line JSON,
 * and skip accounting. Unreadable lines are counted, never silently dropped —
 * the count travels on the conversation so importers can see degraded sources.
 * @module @deepseek-ai/dsh-session-import/jsonl
 */


/** Upper bound for one JSONL line, matching the largest real transcript lines with headroom. */
export const MAX_LINE_BYTES = 2 * 1024 * 1024

/**
 * Bounded prefix read for first-line discovery: `session_meta`-style headers
 * are the first line, so discovery never needs more than this many bytes of
 * any file, whatever its total size.
 */
export const DISCOVERY_READ_BYTES = 256 * 1024

/** Error thrown when a source file exceeds the configured import budget. */
export class SourceFileTooLargeError extends Error {
  constructor(path: string, sizeBytes: number, maxFileBytes: number) {
    super(`external session file ${path} is ${sizeBytes} bytes, over the ${maxFileBytes} byte import cap`)
    this.name = 'SourceFileTooLargeError'
  }
}

/** One parsed JSONL file: ordered values plus per-cause skip accounting. */
export interface ParsedJsonl {
  readonly values: unknown[]
  /** Lines dropped as unparseable (bad JSON). */
  readonly skippedRecords: number
  /** Lines dropped whole for exceeding {@link MAX_LINE_BYTES}. */
  readonly oversizedRecords: number
}

/**
 * Stream a JSONL file line by line, parsing each line, counting skips instead
 * of failing. Memory stays bounded regardless of file size — real Codex
 * rollouts reach multiple gigabytes — and the caller's `maxFileBytes` budget
 * rejects the whole file up front when it must not be processed at all.
 * Oversized lines (embedded base64 payloads, binary noise) are skipped whole —
 * they are never split, so per-line memory stays bounded by {@link MAX_LINE_BYTES}.
 * @param filePath - absolute path of the JSONL file.
 * @param maxFileBytes - rejection budget for the whole file.
 * @returns the parsed values and the skip count.
 * @throws {@link SourceFileTooLargeError} when the file exceeds `maxFileBytes`.
 * @throws when the file cannot be read at all (missing, unreadable).
 */
export async function parseJsonlFile(filePath: string, maxFileBytes: number): Promise<ParsedJsonl> {
  const { stat, open } = await import('node:fs/promises')
  const stats = await stat(filePath)
  if (stats.size > maxFileBytes) throw new SourceFileTooLargeError(filePath, stats.size, maxFileBytes)
  const handle = await open(filePath, 'r')
  try {
    const values: unknown[] = []
    let skippedRecords = 0
    let oversizedRecords = 0
    const stream = handle.createReadStream({ encoding: 'utf8' })
    let pending = ''
    let firstChunk = true
    // Skip mode drains chunks to the next newline without accumulating, so an
    // oversized (or even newline-free multi-gigabyte) line can never balloon
    // `pending` past the per-line bound the module documents. Complete lines
    // that share a chunk with it are still processed normally.
    let skipping = false
    for await (const chunkText of stream) {
      const chunk = String(chunkText)
      let text: string
      if (skipping) {
        const newline = chunk.indexOf('\n')
        if (newline === -1) continue
        text = chunk.slice(newline + 1)
        skipping = false
      } else {
        // A UTF-8 byte-order mark would make JSON.parse reject the first line.
        text = pending + (firstChunk ? chunk.replace(/^\uFEFF/, '') : chunk)
      }
      firstChunk = false
      const lines = text.split('\n')
      /* v8 ignore next -- split() always yields at least one element, so pop() never returns undefined */
      pending = lines.pop() ?? ''
      if (pending.length > MAX_LINE_BYTES) {
        // The unbounded tail is one oversized line; discard it and drain.
        oversizedRecords++
        pending = ''
        skipping = true
      }
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        if (trimmed.length > MAX_LINE_BYTES) {
          oversizedRecords++
          continue
        }
        try {
          values.push(JSON.parse(trimmed) as unknown)
        } catch {
          skippedRecords++
        }
      }
    }
    if (skipping) return { values, skippedRecords, oversizedRecords }
    const trimmed = pending.trim()
    // A tail over the line cap is impossible here: the mid-chunk guard already
    // entered skip mode for it, so whatever remains is a bounded final line.
    if (trimmed.length === 0) return { values, skippedRecords, oversizedRecords }
    try {
      values.push(JSON.parse(trimmed) as unknown)
    } catch {
      skippedRecords++
    }
    return { values, skippedRecords, oversizedRecords }
  } finally {
    await handle.close()
  }
}

/**
 * Parse only the first line of a JSONL file (cheap discovery over large
 * stores): reads at most {@link DISCOVERY_READ_BYTES} from the file start, so
 * a gigabyte rollout costs the same bounded read on every discovery pass.
 * @param filePath - absolute path of the JSONL file.
 * @returns the first parsed value, or undefined when the prefix has no valid line.
 * @throws when the file cannot be read at all (missing, unreadable).
 */
export async function parseFirstJsonlLine(filePath: string): Promise<unknown> {
  const { open } = await import('node:fs/promises')
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const { bytesRead, buffer } = await handle.read({
      buffer: Buffer.alloc(DISCOVERY_READ_BYTES),
      position: 0,
    })
    const firstNewline = buffer.subarray(0, bytesRead).indexOf('\n')
    const line = buffer.subarray(0, firstNewline === -1 ? bytesRead : firstNewline).toString('utf8').replace(/^\uFEFF/, '').trim()
    if (line.length === 0 || line.length > MAX_LINE_BYTES) return undefined
    try {
      return JSON.parse(line) as unknown
    } catch {
      return undefined
    }
  } finally {
    await handle.close()
  }
}

/**
 * Convert an ISO 8601 timestamp to Unix epoch milliseconds.
 * @param value - the source timestamp string.
 * @returns the epoch milliseconds, or undefined when unparseable or out of range.
 */
export function epochMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) ? ms : undefined
}

/**
 * Whether a text file contains the query substring (case-insensitive),
 * streaming in chunks so huge transcripts cost the same bounded memory as a
 * small one. The scan exits on the first match.
 * @param filePath - absolute path of the text file.
 * @param query - the raw query substring (any length ≥ 1).
 * @returns true when the file contains the query, ignoring case.
 */
export async function fileContains(filePath: string, query: string): Promise<boolean> {
  if (query.length === 0) return true
  const needle = query.toLowerCase()
  const { open } = await import('node:fs/promises')
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return false
  }
  try {
    const stream = handle.createReadStream({ encoding: 'utf8' })
    // Carry the tail so a match spanning a chunk boundary is still found.
    let carry = ''
    for await (const chunkText of stream) {
      const chunk = (carry + String(chunkText)).toLowerCase()
      if (chunk.includes(needle)) return true
      carry = chunk.slice(Math.max(0, chunk.length - (needle.length - 1)))
    }
    return false
  } finally {
    await handle.close()
  }
}
