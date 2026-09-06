/**
 * Provider-neutral intermediate model for one external code-agent conversation.
 * Adapters translate their source stores into this shape; the event translator
 * is the only consumer. Ordered entries preserve the source transcript order so
 * the imported seed replays the exact exchange sequence.
 * @module @deepseek-ai/dsh-session-import/model
 */

/** The external agents this package reads. Claude Code and Codex are JSONL stores; ZCode and MiniMax are SQLite stores. */
export type ExternalProviderId = 'claude-code' | 'codex' | 'zcode' | 'minimax'

/** One ordered transcript entry produced by an adapter. */
export type ExternalEntry =
  | { readonly kind: 'user'; readonly text: string; readonly at?: number }
  | {
    readonly kind: 'assistant'
    readonly text: string
    /** Reasoning text exported by the source agent, kept only when import opts in. */
    readonly reasoning?: string
    /** Source-reported model id, when the line carries one. */
    readonly model?: string
    readonly at?: number
  }
  | {
    readonly kind: 'tool_call'
    /** Source call id correlating the call with its result. */
    readonly callId: string
    readonly name: string
    /** Raw arguments JSON string exactly as the source recorded it. */
    readonly arguments: string
    readonly at?: number
  }
  | {
    readonly kind: 'tool_result'
    /** Source call id of the completed call. */
    readonly callId: string
    readonly text: string
    readonly isError: boolean
    readonly at?: number
  }

/** One discovered external conversation, parsed or listing-only. */
export interface ExternalConversation {
  readonly provider: ExternalProviderId
  /** Stable source id (the source store's own session id). */
  readonly sourceId: string
  /** Absolute path of the source store this conversation was read from. */
  readonly sourcePath: string
  readonly sizeBytes: number
  /** Source file mtime in Unix epoch milliseconds. */
  readonly mtimeMs: number
  /** Working directory the source conversation ran in, when the store records one. */
  readonly workspaceDir?: string
  readonly title?: string
  /** Source-reported model id, when the store records one anywhere. */
  readonly model?: string
  /** Conversation start in Unix epoch milliseconds, when the store records one. */
  readonly startedAt?: number
  readonly entries: readonly ExternalEntry[]
  /** Source lines or records that were unreadable or unrecognized, skipped without failing the import. */
  readonly skippedRecords: number
  /** Source lines dropped whole for exceeding the per-line size cap. */
  readonly oversizedRecords: number
}

/** One listing row: a source conversation known to exist, not yet parsed. */
export interface DiscoveredSession {
  readonly provider: ExternalProviderId
  readonly sourceId: string
  readonly sourcePath: string
  readonly sizeBytes: number
  readonly mtimeMs: number
  /**
   * Cheap title when the store exposes one beside the listing (SQLite columns,
   * or a bounded header scan on JSONL stores); absent stores show their id.
   */
  readonly title?: string
}
