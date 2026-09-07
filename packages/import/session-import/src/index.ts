/**
 * Import conversations recorded by external coding agents (Claude Code, Codex)
 * as fully continuable DeepSeek Harness sessions. The package's Cordis plugin
 * is the {@link SessionImportService} class plugin: it resolves source stores,
 * translates transcripts into validated session seeds, materializes them
 * through the composed persistence backend, and registers the model-facing
 * `session_import` tool. Read-only against every source store.
 * @module @deepseek-ai/dsh-session-import
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Agent, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ExternalConversation, ExternalProviderId } from './model.ts'
import {
  type Config,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_PREVIEW_MESSAGES,
  DEFAULT_SYNC_LIMIT,
  IMPORT_GROUP_DIR_NAME,
  homeOf,
  provenanceOf,
  targetIdFor,
  PersistenceRequiredError,
  SourceNotFoundError,
  versionedTargetOf,
  TargetCollisionError,
  type ImportOutcome,
  type ImportSpec,
  type SourceListing,
  type SourcePreview,
  type SyncOutcome,
  type SyncResult,
  type SourcePreviewMessage,
} from './service.ts'
import { ADAPTERS, type ParseOptions } from './adapters/registry.ts'
import { translateConversation, type TranslationSpec } from './translate.ts'
import { redactText } from './redact.ts'
import { fileContains } from './jsonl.ts'
import { registerImportTool } from './tool.ts'
import type { SessionImportSourceEventData } from './types.ts'

export type { Config, ImportOutcome, ImportSpec, SourceListing, SourcePreview, SourcePreviewMessage, SyncOutcome, SyncResult }
export type { ExternalProviderId } from './model.ts'
export { provenanceOf, PersistenceRequiredError, SourceNotFoundError, TargetCollisionError, versionedTargetOf } from './service.ts'
export {
  EmptyConversationError,
  findSeedStructuralError,
  MissingModelError,
  translateConversation,
  type TranslationSpec,
} from './translate.ts'
export type { SessionImportSourceEventData } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The session-import service, registered by the `session-import` plugin. */
    sessionImport: SessionImportService
  }
}

/** The `session-import` service (`ctx.sessionImport`). */
export class SessionImportService extends Service {
  static inject = ['sessions', 'tools']

  static Config: z<Config> = z.object({
    claudeHome: z.string(),
    codexHome: z.string(),
    zcodeHome: z.string(),
    minimaxHome: z.string(),
    defaultModel: z.string(),
    maxFileBytes: z.number().step(1).min(1),
    maxToolResultChars: z.number().step(1).min(1),
    includeReasoning: z.boolean(),
    redactSecrets: z.boolean(),
  })

  private readonly settings: Config
  private persistence: SessionPersistence | undefined
  private agents: AgentRegistry | undefined
  /**
   * Short-TTL cache of `listSources` results keyed by JSON-stringified
   * options. Repeated calls from the console within `LIST_CACHE_TTL_MS`
   * skip the per-provider `discover` walks; every successful
   * `importSource` clears the cache so a follow-up listing always reflects
   * the new `imported` flags. `syncAll` bypasses the cache because its
   * quota accounting must see a fresh discovery.
   */
  private readonly listCache = new Map<string, { readonly expires: number; readonly promise: Promise<SourceListing[]> }>()
  private static readonly LIST_CACHE_TTL_MS = 1500

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionImport')
    this.settings = config
    ctx.inject(['sessionPersistence'], (persistenceCtx) => {
      this.persistence = persistenceCtx.sessionPersistence
    })
    ctx.inject(['agents'], (agentsCtx) => {
      this.agents = agentsCtx.agents
    })
    registerImportTool(ctx, this)
  }

  /** Explicit resolve step: deployment defaults become a concrete translation spec. */
  private translationSpec(): TranslationSpec {
    return {
      fallbackModel: this.settings.defaultModel ?? '',
      includeReasoning: this.settings.includeReasoning ?? false,
      maxToolResultChars: this.settings.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS,
      redactSecrets: this.settings.redactSecrets ?? true,
    }
  }

  /**
   * Resolve the home directory one provider reads from.
   * @param provider - the source agent.
   * @returns the absolute home directory.
   */
  private homeFor(provider: ExternalProviderId): string {
    const adapter = ADAPTERS[provider]
    const setting = this.settings[adapter.homeSettingKey]
    return homeOf(setting, adapter.defaultHomeSegment)
  }

  /**
   * List the source conversations a provider's store currently holds, marking
   * the ones this harness already imported. Rows sort most recently modified
   * first, so a `limit` keeps the freshest conversations.
   * @param options - the provider to scan (omitted scans every supported store) and an optional row cap.
   * @returns at most `limit` rows (default all), most recently modified first.
   */
  async listSources(options: {
    readonly provider?: ExternalProviderId
    readonly limit?: number
    /** Raw substring filter: keeps conversations whose transcript contains it (case-insensitive). */
    readonly query?: string
  } = {}): Promise<SourceListing[]> {
    const key = JSON.stringify({
      provider: options.provider ?? '*',
      query: options.query ?? '',
      limit: options.limit ?? -1,
    })
    const cached = this.listCache.get(key)
    if (cached !== undefined && cached.expires > Date.now()) return cached.promise
    const promise = this.listSourcesUncached(options)
    this.listCache.set(key, { expires: Date.now() + SessionImportService.LIST_CACHE_TTL_MS, promise })
    // Failed discoveries evict the entry so the next call retries; a
    // successful completion leaves the entry in place until the TTL expires.
    promise.catch(() => { this.listCache.delete(key) })
    return promise
  }

  /**
   * Uncached {@link listSources}. {@link syncAll} uses this entry point
   * because its quota accounting must observe a fresh discovery on every
   * iteration, not a previously cached snapshot.
   */
  private async listSourcesUncached(options: {
    readonly provider?: ExternalProviderId
    readonly limit?: number
    /** Raw substring filter: keeps conversations whose transcript contains it (case-insensitive). */
    readonly query?: string
  } = {}): Promise<SourceListing[]> {
    const providers: ExternalProviderId[] = options.provider !== undefined
      ? [options.provider]
      : (Object.keys(ADAPTERS) as ExternalProviderId[])
    const known = await this.knownIds()
    const listings: SourceListing[] = []
    for (const id of providers) {
      const home = this.homeFor(id)
      const discovered = await ADAPTERS[id].discover(home)
      let rows = discovered
      const queryText = options.query
      const adapter = ADAPTERS[id]
      if (queryText !== undefined && queryText.length > 0 && adapter.search !== undefined) {
        // SQLite adapters answer through `LIKE` cheaply; JSONL adapters leave
        // `search` undefined and fall through to the per-file scan below.
        const matching = await adapter.search(home, queryText)
        rows = discovered.filter(row => matching.has(row.sourceId))
      }
      for (const row of rows) {
        if (queryText !== undefined && queryText.length > 0 && adapter.search === undefined
          && !(await fileContains(row.sourcePath, queryText))) continue
        listings.push({
          ...row,
          imported: known.has(targetIdFor(row.provider, row.sourceId)),
        })
      }
    }
    const sorted = listings.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return options.limit === undefined ? sorted : sorted.slice(0, Math.max(0, options.limit))
  }

  /**
   * Explicit resolve step for one import: locate the source, name the target,
   * and freeze the translation spec.
   * @param request - the provider, source id, and optional explicit target id.
   * @returns the resolved spec.
   * @throws {@link SourceNotFoundError} when the store has no such conversation.
   */
  async resolve(request: {
    readonly provider: ExternalProviderId
    readonly sourceId: string
    readonly targetId?: string
  }): Promise<ImportSpec> {
    const home = this.homeFor(request.provider)
    const discovered = await ADAPTERS[request.provider].discover(home)
    const source = discovered.find(row => row.sourceId === request.sourceId)
    /* v8 ignore else -- both outcomes are covered by service.spec; the implicit
       fall-through's synthesized count goes negative under v8 range remapping. */
    if (source === undefined) {
      throw new SourceNotFoundError(request.sourceId, home, discovered.map(row => row.sourceId))
    }
    return {
      source,
      targetId: request.targetId !== undefined
        ? SessionId(request.targetId)
        : targetIdFor(request.provider, request.sourceId),
      home,
      translation: this.translationSpec(),
    }
  }

  /**
   * Import one external conversation as a new, continuable harness session.
   * The import writes the translated log straight to the composed persistence
   * backend — it never occupies the live store — so the session resumes through
   * the ordinary path in this or any later process. Idempotent: importing an
   * unchanged source again reports `up-to-date`; importing a changed source
   * over the deterministic target reports `conflict` rather than silently
   * duplicating or diverging history.
   * @param request - the provider, source id, and optional explicit target id.
   * @returns the outcome, including the target session id.
   * @throws {@link SourceNotFoundError} when the store has no such conversation.
   * @throws {@link TargetCollisionError} when the target id is taken by anything else.
   * @throws when no persistence backend is composed, or the source is unreadable, empty, or names no model.
   */
  async importSource(request: {
    readonly provider: ExternalProviderId
    readonly sourceId: string
    readonly targetId?: string
    /** On conflict, re-import the current source into a fresh versioned target instead of skipping. */
    readonly force?: boolean
  }): Promise<ImportOutcome> {
    let spec = await this.resolve(request)
    const importedAt = Date.now()
    const existing = await this.existingProvenance(spec.targetId)
    if (existing !== undefined) {
      const sameSource = existing.provider === request.provider && existing.sourceId === request.sourceId
      if (sameSource && existing.mtimeMs === spec.source.mtimeMs && existing.sizeBytes === spec.source.sizeBytes
        && request.force !== true) {
        return { status: 'up-to-date', sessionId: spec.targetId, importedAt: existing.importedAt }
      }
      if (request.targetId === undefined) {
        if (request.force === true) {
          // Forced re-import: land the current source in the next free
          // versioned target; the previous version stays intact.
          const taken = await this.knownIds()
          spec = { ...spec, targetId: versionedTargetOf(spec.targetId, taken) }
        } else {
          return {
            status: 'conflict',
            sessionId: spec.targetId,
            importedAt: existing.importedAt,
            existingSourceId: existing.sourceId,
          }
        }
      } else {
        throw new TargetCollisionError(spec.targetId)
      }
    }
    // No provenance: the id is either free or owned by a non-import session,
    // and both are hard collisions. The detached create validates the seed and
    // freezes the log exactly as a live create would.
    if (this.persistence === undefined) throw new PersistenceRequiredError()
    if (this.ctx.sessions.get(spec.targetId) !== undefined) throw new TargetCollisionError(spec.targetId)
    if ((await this.persistedIds()).has(spec.targetId)) throw new TargetCollisionError(spec.targetId)

    const conversation = await this.parseResolved(request, spec)
    // Invalidate the listing cache before the import completes so any
    // `listSources` call observing the new "imported" flag sees the
    // write-through rather than a stale cache hit from before the import.
    this.listCache.clear()
    const seed = translateConversation(conversation, spec.translation, importedAt)
    // Every import carries the shared group directory as its header cwd, so
    // workspace grouping shows one「导入」group instead of scattering imports
    // across their source projects (the source path rides the provenance
    // event). The directory must exist for path canonicalization.
    const groupHome = await this.ensureImportGroupHome()
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: spec.targetId,
      createdAt: conversation.startedAt ?? importedAt,
      seedLength: seed.length,
      cwd: groupHome,
    }
    Session.create(spec.targetId, seed, header)
    await this.persistence.create(header)
    await this.persistence.append(spec.targetId, seed)
    // Checkpoint the projection cache from the exact durable seed so the
    // session list (which serves cold rows from the cache, probing only
    // sub-KB logs) shows the imported title and stats immediately; without
    // this, a multi-KB import lists as an untitled row until first open.
    const cache = this.ctx.get('sessionProjectionCache') as
      | { write(session: unknown): Promise<void> }
      | undefined
    if (cache !== undefined) {
      const prepared = Session.create(spec.targetId, seed, header)
      try {
        await cache.write(prepared)
      } catch (error: unknown) {
        this.ctx.logger.warn(`session import: projection checkpoint for "${spec.targetId}" failed; the session still lists cold: ${String(error)}`)
      }
    }
    // The title reaches the model through tool output, so it obeys the same
    // redaction policy as the log content.
    const title = conversation.title !== undefined && this.settings.redactSecrets !== false
      ? redactText(conversation.title).text
      : conversation.title
    return {
      status: 'imported',
      sessionId: spec.targetId,
      eventCount: seed.length,
      ...(title !== undefined ? { title } : {}),
      sourceResumeHint: request.provider === 'claude-code'
        ? `claude --resume ${request.sourceId}`
        : `codex resume ${request.sourceId}`,
    }
  }

  /**
   * Parse one resolved source through the provider dispatch shared by import
   * and preview. Budget and reasoning flags come from the resolved spec.
   * @param request - the provider and source id.
   * @param spec - the resolved import spec naming the source and translation.
   * @returns the parsed conversation.
   * @throws when the source is unreadable, empty, or names no model.
   */
  private async parseResolved(
    request: { readonly provider: ExternalProviderId; readonly sourceId: string },
    spec: ImportSpec,
  ): Promise<ExternalConversation> {
    const maxFileBytes = this.settings.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    const options: ParseOptions = {
      home: spec.home,
      maxFileBytes,
      includeReasoning: spec.translation.includeReasoning,
    }
    return ADAPTERS[request.provider].parse(spec.source, options)
  }

  /**
   * Render one source conversation as a capped, read-only chat preview:
   * user and assistant messages with the tool calls each assistant turn made.
   * Tool results stay summarized in the counts — they are working output,
   * not conversation. Parsing rules (budget, noise filtering, reasoning) are
   * exactly those an import would apply.
   * @param request - the provider and source id.
   * @param options - cap for the returned message list (default 120).
   * @returns the preview, capped for display with whole-conversation counts.
   * @throws {@link SourceNotFoundError} when the store has no such conversation.
   * @throws when the source is unreadable, empty, or names no model.
   */
  async previewSource(
    request: { readonly provider: ExternalProviderId; readonly sourceId: string },
    options: { readonly maxMessages?: number } = {},
  ): Promise<SourcePreview> {
    const spec = await this.resolve(request)
    const conversation = await this.parseResolved(request, spec)
    const maxMessages = options.maxMessages ?? DEFAULT_PREVIEW_MESSAGES
    const messages: SourcePreviewMessage[] = []
    let totalToolCalls = 0
    let hasMore = false
    for (const entry of conversation.entries) {
      if (entry.kind === 'tool_call') {
        totalToolCalls++
        const last = messages.at(-1)
        if (last !== undefined && last.role === 'assistant') {
          const calls = [...(last.toolCalls ?? []), {
            name: entry.name,
            argsPreview: entry.arguments.length > 120 ? `${entry.arguments.slice(0, 119)}…` : entry.arguments,
          }]
          messages[messages.length - 1] = { ...last, toolCalls: calls }
        }
        continue
      }
      if (entry.kind === 'tool_result') continue
      if (messages.length >= maxMessages) {
        hasMore = true
        continue
      }
      messages.push({
        role: entry.kind,
        text: entry.text,
        ...(entry.at !== undefined ? { at: entry.at } : {}),
      })
    }
    return {
      provider: conversation.provider,
      sourceId: conversation.sourceId,
      ...(conversation.title !== undefined ? { title: conversation.title } : {}),
      ...(conversation.model !== undefined ? { model: conversation.model } : {}),
      ...(conversation.workspaceDir !== undefined ? { workspaceDir: conversation.workspaceDir } : {}),
      ...(conversation.startedAt !== undefined ? { startedAt: conversation.startedAt } : {}),
      skippedRecords: conversation.skippedRecords,
      oversizedRecords: conversation.oversizedRecords,
      totalEntries: conversation.entries.length,
      totalToolCalls,
      messages,
      hasMore,
    }
  }

  /**
   * Batch-sync every discovered conversation (or one provider's) into durable
   * harness sessions: new conversations import, unchanged ones report
   * `up-to-date` and skip, and a conversation whose source changed under an
   * existing deterministic target reports `conflict` and skips — sync never
   * overwrites and never duplicates. The new-import quota (`limit`, default
   * 200, `0` = unlimited) counts only fresh imports; up-to-date skips never
   * consume it, so a bounded sync still reaches new conversations.
   * @param options - the provider to sync (omitted syncs every store) and a
   *   new-import cap.
   * @returns per-conversation results plus rolled-up counts.
   */
  async syncAll(options: { readonly provider?: ExternalProviderId; readonly limit?: number } = {}): Promise<SyncOutcome> {
    const quota = options.limit === undefined ? DEFAULT_SYNC_LIMIT : Math.max(0, options.limit)
    const results: SyncResult[] = []
    let imported = 0
    let upToDate = 0
    let conflicts = 0
    let errors = 0
    let deferred = 0
    for (const row of await this.listSourcesUncached(options.provider === undefined ? {} : { provider: options.provider })) {
      // The quota counts only fresh imports and is checked before the import
      // attempt: an unimported row beyond it defers untouched (threadock
      // semantics — up-to-date skips never consume the cap).
      if (!row.imported && quota !== 0 && imported >= quota) {
        deferred++
        continue
      }
      const outcome = await this.importSource({ provider: row.provider, sourceId: row.sourceId })
        .then(value => value)
        .catch((error: unknown) => ({
          status: 'error' as const,
          // Every parse/read path throws Error instances; String() guards future non-Error rethrows.
          /* v8 ignore next -- defensive arm; no current throw site produces a non-Error */
          error: error instanceof Error ? error.message : String(error),
        }))
      if (outcome.status === 'error') {
        errors++
        results.push({ provider: row.provider, sourceId: row.sourceId, status: 'error', error: outcome.error })
        continue
      }
      if (outcome.status === 'imported') {
        imported++
      } else if (outcome.status === 'up-to-date') {
        upToDate++
      } else {
        conflicts++
      }
      results.push({ provider: row.provider, sourceId: row.sourceId, status: outcome.status })
    }
    return { results, imported, upToDate, conflicts, errors, deferred }
  }

  /**
   * Resolve (and create on first use) the shared import-group directory every
   * imported session carries as its header cwd.
   * @returns the absolute group directory.
   */
  private async ensureImportGroupHome(): Promise<string> {
    const dir = homeOf(this.settings.importGroupHome ?? join('.dsh', IMPORT_GROUP_DIR_NAME), join('.dsh', IMPORT_GROUP_DIR_NAME))
    await mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * Send one prompt to an imported session, creating its agent first when the
   * session is not live in this process. The agent then runs the ordinary
   * loop; consumers observe progress on `session/event` as with any session.
   * @param sessionId - the imported session's id.
   * @param prompt - the user prompt that continues the imported conversation.
   * @param options - per-agent options (the model route the continued requests use).
   * @returns the id of the session now being driven.
   * @throws when no session with that id exists, the log is not an import, or no agent factory is registered.
   */
  async continueSession(
    sessionId: string,
    prompt: string,
    options: { readonly agentOptions?: AgentOptions } = {},
  ): Promise<{ sessionId: SessionId }> {
    const id = SessionId(sessionId)
    const exists = this.ctx.sessions.get(id) !== undefined
      || (this.persistence !== undefined && (await this.persistedIds()).has(id))
    if (!exists) {
      throw new Error(`session "${sessionId}" does not exist`)
    }
    const provenance = await this.existingProvenance(id)
    if (provenance === undefined) {
      throw new Error(`session "${sessionId}" carries no import provenance; continueSession only drives imported sessions`)
    }
    if (prompt.trim().length === 0) {
      throw new Error('continueSession requires a non-empty prompt')
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })
    if (this.agents === undefined) throw new Error('no agent registry composed; load an agent plugin to continue sessions')
    const live: Agent | undefined = this.agents.get(id)
    if (live !== undefined) {
      live.followup(message)
      return { sessionId: id }
    }
    const handle = await this.agents.resume({
      resumeSessionId: id,
      ...(options.agentOptions !== undefined ? { agentOptions: options.agentOptions } : {}),
    })
    handle.agent.followup(message)
    return { sessionId: id }
  }

  /**
   * Read the import provenance of one target id: from the live store when the
   * session is live, else from persistence, else undefined.
   * @param targetId - the candidate session id.
   * @returns the provenance payload, or undefined when the session does not exist or is not an import.
   */
  private async existingProvenance(targetId: SessionId): Promise<SessionImportSourceEventData | undefined> {
    const live = this.ctx.sessions.get(targetId)
    if (live !== undefined) return provenanceOf(live.events)
    if (this.persistence !== undefined) {
      try {
        const head = await this.persistence.readFrom(targetId, 0)
        return provenanceOf(head.events)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /**
   * Every session id this process knows: the live store plus the persistence
   * headers. Import listing only needs deterministic-id EXISTENCE — the
   * `ext-<provider>-<sourceId>` namespace makes a hit an import without
   * reading any log — so listings stay O(headers) instead of O(corpus).
   * @returns the known session ids.
   */
  private async knownIds(): Promise<Set<string>> {
    const ids = new Set<string>()
    for (const session of this.ctx.sessions.list()) ids.add(session.id)
    for (const id of await this.persistedIds()) ids.add(id)
    return ids
  }

  /**
   * The target ids of every persisted session, regardless of provenance.
   * @returns the persisted session ids.
   */
  private async persistedIds(): Promise<Set<string>> {
    const ids = new Set<string>()
    /* v8 ignore else -- both call sites run only after the persistence guard passed */
    if (this.persistence !== undefined) {
      for (const header of await this.persistence.list()) ids.add(header.id)
    }
    return ids
  }

}

export default SessionImportService
