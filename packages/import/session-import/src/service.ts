/**
 * Service-module types and helpers for the `session-import` plugin: deployment
 * configuration, request/spec shapes, typed errors, and the pure functions the
 * service class in the package entry composes. The class itself is declared in
 * `index.ts`, where the Loader expects the default export.
 * @module @deepseek-ai/dsh-session-import/service
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ExternalProviderId, DiscoveredSession } from './model.ts'
import type { TranslationSpec } from './translate.ts'
import type { SessionImportSourceEventData } from './types.ts'

/** Deployment configuration for the session-import plugin. */
export interface Config {
  /** Claude home directory; defaults to `~/.claude` when absent or empty. */
  claudeHome?: string
  /** Codex home directory; defaults to `~/.codex` when absent or empty. */
  codexHome?: string
  /** ZCode home directory; defaults to `~/.zcode` when absent or empty. */
  zcodeHome?: string
  /** MiniMax home directory; defaults to `~/.minimax` when absent or empty. */
  minimaxHome?: string
  /** Model id recorded when a source conversation reports none. */
  defaultModel?: string
  /** Rejection budget for one source file, in bytes. */
  maxFileBytes?: number
  /** Per-tool-result text cap, in characters. */
  maxToolResultChars?: number
  /** Keep source reasoning text as `reasoning` blocks instead of dropping it. */
  includeReasoning?: boolean
  /** Replace credential-shaped substrings before they enter the durable log. */
  redactSecrets?: boolean
  /**
   * Working directory stamped onto every imported session header. All imports
   * therefore share one workspace group (named after this directory's last
   * segment) instead of scattering across their source projects; the source
   * project path survives in the import provenance event. Defaults to
   * `<dsh home>/导入`. Absolute, or relative to the user's home directory.
   */
  importGroupHome?: string
}

/**
 * Default per-file import budget: real Codex rollouts reach multiple gigabytes,
 * and the streaming reader keeps memory bounded at any size.
 */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

/** Default new-import quota per batch sync; `0` from the caller lifts it. */
export const DEFAULT_SYNC_LIMIT = 200

/** Directory name under the dsh home that groups every imported session. */
export const IMPORT_GROUP_DIR_NAME = '导入'

/** Default message cap for chat previews. */
export const DEFAULT_PREVIEW_MESSAGES = 120

/** Default tool-result truncation point, in characters. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 20_000

/** The resolved, validated form of one import request. */
export interface ImportSpec {
  readonly source: DiscoveredSession
  readonly targetId: SessionId
  readonly home: string
  readonly translation: TranslationSpec
}

/** Outcome of one importSource call. */
export interface ImportOutcome {
  readonly status: 'imported' | 'up-to-date' | 'conflict'
  readonly sessionId: SessionId
  /** Event count of the imported seed, for imported outcomes. */
  readonly eventCount?: number
  readonly title?: string
  /** Provenance of the existing import, for up-to-date outcomes. */
  readonly importedAt?: number
  /** Source id recorded by the blocking import, for conflict outcomes. */
  readonly existingSourceId?: string
  /** How to reopen the conversation in its source agent, when that agent supports it. */
  readonly sourceResumeHint?: string
}

/** One listing row: a discovered source plus whether this harness already imported it. */
export interface SourceListing extends DiscoveredSession {
  readonly imported: boolean
}

/** One chat bubble in a {@link SourcePreview}: role, text, and the calls it made. */
export interface SourcePreviewMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly at?: number
  /** Tool calls made in the same assistant turn, in source order. */
  readonly toolCalls?: { readonly name: string; readonly argsPreview: string }[]
}

/** One source conversation's result inside a {@link SyncOutcome}. */
export interface SyncResult {
  readonly provider: ExternalProviderId
  readonly sourceId: string
  readonly status: 'imported' | 'up-to-date' | 'conflict' | 'error'
  readonly error?: string
}

/** Whole-store batch sync outcome: per-conversation results plus rollups. */
export interface SyncOutcome {
  readonly results: readonly SyncResult[]
  readonly imported: number
  readonly upToDate: number
  readonly conflicts: number
  readonly errors: number
  /** Conversations left unprocessed because the new-import quota was reached. */
  readonly deferred: number
}

/** A read-only chat rendering of one source conversation, capped for display. */
export interface SourcePreview {
  readonly provider: ExternalProviderId
  readonly sourceId: string
  readonly title?: string
  readonly model?: string
  readonly workspaceDir?: string
  readonly startedAt?: number
  readonly skippedRecords: number
  readonly oversizedRecords: number
  readonly totalEntries: number
  readonly totalToolCalls: number
  readonly messages: readonly SourcePreviewMessage[]
  /** True when `messages` was capped; the counts above always cover the whole conversation. */
  readonly hasMore: boolean
}

/** Error thrown when a requested source conversation is not in the discovered store. */
export class SourceNotFoundError extends Error {
  constructor(sourceId: string, home: string, available: readonly string[] = []) {
    let hint = ''
    if (available.length > 0) {
      const nearest = available
        .map(id => ({ id, prefix: sharedPrefixLength(sourceId, id) }))
        .sort((a, b) => b.prefix - a.prefix)[0]
      if (nearest !== undefined && nearest.prefix >= 6) {
        hint = ` (did you mean "${nearest.id}"?)`
      } else {
        hint = `; the store has ${available.length} conversation(s), none matching`
      }
    }
    super(`external conversation "${sourceId}" was not found under ${home}${hint}`)
    this.name = 'SourceNotFoundError'
  }
}

/**
 * Longest shared prefix between two ids — the closeness measure behind the
 * not-found suggestion (a one-character typo in a UUID keeps a long prefix).
 * @param a - the requested source id.
 * @param b - a candidate source id.
 * @returns the number of leading characters the two ids share.
 */
function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charAt(i) === b.charAt(i)) i++
  return i
}

/** Error thrown when an import is requested with no persistence backend composed. */
export class PersistenceRequiredError extends Error {
  constructor() {
    super('session import requires a persistence backend (load a dsh-session-persistence plugin)')
    this.name = 'PersistenceRequiredError'
  }
}

/** The version suffix base for forced re-imports (`-2`, `-3`, …). */
const REIMPORT_VERSION_BASE = 2

/**
 * Pick a free versioned target for a forced re-import: the smallest
 * `ext-<provider>-<sourceId>-vN` (N ≥ 2) not present in the live store, the
 * persisted set, or the existing-import registry the caller supplies.
 * @param base - the deterministic target id (`ext-<provider>-<sourceId>`).
 * @param taken - ids known to be occupied.
 * @returns the first free versioned id.
 */
export function versionedTargetOf(base: SessionId, taken: ReadonlySet<string>): SessionId {
  for (let version = REIMPORT_VERSION_BASE; ; version++) {
    const candidate = SessionId(`${base}-v${String(version)}`)
    if (!taken.has(candidate)) return candidate
  }
}

/** Error thrown when the deterministic target id is taken by an unrelated session. */
export class TargetCollisionError extends Error {
  constructor(targetId: string) {
    super(`target session "${targetId}" already exists and carries no matching import provenance; pass an explicit targetId`)
    this.name = 'TargetCollisionError'
  }
}

/**
 * Resolve one home-directory setting to a usable absolute path.
 * @param setting - the configured home, absolute, relative-to-home, or absent.
 * @param fallbackSegment - the home-relative default segment for this provider.
 * @returns an absolute home directory.
 */
export function homeOf(setting: string | undefined, fallbackSegment: string): string {
  if (setting !== undefined && setting.length > 0) return isAbsolute(setting) ? setting : join(homedir(), setting)
  return join(homedir(), fallbackSegment)
}

/**
 * Map a source id to the deterministic target session id namespace.
 * @param provider - the source agent.
 * @param sourceId - the source conversation id.
 * @returns the deterministic, filesystem-safe target session id.
 */
export function targetIdFor(provider: ExternalProviderId, sourceId: string): SessionId {
  const safe = sourceId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120)
  return SessionId(`ext-${provider}-${safe}`)
}

/**
 * Extract the import provenance from a seed prefix, when present.
 * @param events - the first events of a candidate session log.
 * @returns the provenance payload, or undefined when the log is not an import.
 */
export function provenanceOf(events: readonly SessionEvent[]): SessionImportSourceEventData | undefined {
  const event = events[1]
  return event !== undefined && event.type === 'session-import/source' ? event.data : undefined
}
