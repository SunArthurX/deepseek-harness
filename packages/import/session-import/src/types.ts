/**
 * Public types and the package's durable session-event vocabulary. The
 * `session-import/source` event is the provenance record folded into every
 * imported log; it is log-only (never on the surface) and merge-declared here,
 * the event vocabulary's single home.
 * @module @deepseek-ai/dsh-session-import/types
 */

import type { ExternalProviderId } from './model.ts'

/** The provenance event payload appended to every imported session log. */
export interface SessionImportSourceEventData {
  /** External agent the conversation came from. */
  readonly provider: ExternalProviderId
  /** Source store's own conversation id. */
  readonly sourceId: string
  /** Absolute source file path. */
  readonly sourcePath: string
  /** Source file size in bytes at import time. */
  readonly sizeBytes: number
  /** Source file mtime in Unix epoch milliseconds at import time. */
  readonly mtimeMs: number
  /** Import completion time in Unix epoch milliseconds. */
  readonly importedAt: number
  /** Credential replacements applied before the log was written. */
  readonly redactions: number
  /** Source records and entries skipped as unreadable, unrecognized, or unhistorical. */
  readonly skippedRecords: number
  /** Source lines dropped whole for exceeding the per-line size cap. */
  readonly oversizedRecords: number
  /** Project directory the source conversation ran in; the imported session's
   *  header cwd is the shared import-group directory instead. */
  readonly sourceWorkspaceDir?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Log-only provenance for a session whose history was imported from an
     * external code agent's store. Exactly one per imported session, at seq 1;
     * `redactions` counts credential replacements applied before the log was
     * written and `skippedRecords` counts source records that were dropped.
     * @dshScopeScan unsupported
     */
    'session-import/source': SessionImportSourceEventData
  }
}
