/**
 * Provider adapter registry: one normalized shape for every external code-agent
 * store this package reads, so the service class and the console gateway can
 * dispatch through `ADAPTERS[provider]` instead of repeating
 * `if (provider === 'X') return parseX()` chains. The raw per-provider
 * `discoverXxxSessions` / `parseXxxSession` functions stay exported for direct
 * test access; the adapter object is a thin projection over them.
 * @module @deepseek-ai/dsh-session-import/adapters/registry
 */

import type { DiscoveredSession, ExternalProviderId } from '../model.ts'
import { claudeCodeAdapter } from './claude-code.ts'
import { codexAdapter } from './codex.ts'
import { zcodeAdapter } from './zcode.ts'
import { minimaxAdapter } from './minimax.ts'

/** The Config field that names this provider's home directory. */
export type HomeSettingKey = 'claudeHome' | 'codexHome' | 'zcodeHome' | 'minimaxHome'

/** Options for one parse, shared across every provider. */
export interface ParseOptions {
  /**
   * Provider home directory. JSONL adapters ignore it (the source row already
   * carries the absolute source path); SQLite adapters use it to locate the
   * store. Always present so callers do not branch on the source kind.
   */
  readonly home: string
  /** Rejection budget for the whole source file, in bytes. */
  readonly maxFileBytes: number
  /** Keep source reasoning text as reasoning content instead of dropping it. */
  readonly includeReasoning: boolean
}

/** Normalized external-store adapter. */
export interface ProviderAdapter {
  /** The route key, matching {@link ExternalProviderId}. */
  readonly id: ExternalProviderId
  /**
   * Default home-relative directory when Config omits the home field (the
   * standard per-provider XDG-style convention, e.g. `.claude`).
   */
  readonly defaultHomeSegment: string
  /** Config field carrying this provider's home directory override. */
  readonly homeSettingKey: HomeSettingKey
  /** List the source conversations present under one home directory. */
  discover(home: string): Promise<DiscoveredSession[]>
  /** Parse one discovered source into the provider-neutral model. */
  parse(source: DiscoveredSession, options: ParseOptions): Promise<import('../model.ts').ExternalConversation>
  /**
   * Optional cross-source text search. SQLite adapters answer through `LIKE`
   * cheaply; JSONL adapters omit it and let the service fall back to per-file
   * scan, which the JSONL row's `sourcePath` already supports.
   */
  search?(home: string, query: string): Promise<ReadonlySet<string>>
}

/**
 * The full provider directory. Adding a new provider means one entry here plus
 * one `xxxAdapter` constant in the matching adapter module — no service-class
 * edit, no console gateway edit, no per-endpoint chain.
 */
export const ADAPTERS: Readonly<Record<ExternalProviderId, ProviderAdapter>> = {
  'claude-code': claudeCodeAdapter,
  'codex': codexAdapter,
  'zcode': zcodeAdapter,
  'minimax': minimaxAdapter,
}
