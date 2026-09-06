/**
 * The model-facing `session_import` tool: list discoverable external agent
 * conversations and import one as a continuable harness session. The tool is
 * read/import only — driving an imported session is the service's
 * `continueSession`, a composition decision, not a model decision.
 * @module @deepseek-ai/dsh-session-import/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionImportService } from './index.ts'
import { targetIdFor } from './service.ts'

/** The canonical output value of one `session_import` call. */
interface ImportToolValue {
  readonly action: 'list' | 'import'
  readonly status: 'listed' | 'imported' | 'up-to-date' | 'conflict'
  readonly sessionId?: string
  readonly sessions?: {
    readonly provider: string
    readonly sourceId: string
    readonly imported: boolean
    readonly sizeBytes: number
    readonly mtimeMs: number
  }[]
  readonly detail?: string
}

/**
 * Register the `session_import` tool on the composing context's tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param service - the owning import service the tool delegates to.
 */
export function registerImportTool(ctx: Context, service: SessionImportService): void {
  ctx.tools.register(defineTool({
    name: 'session_import',
    description:
      'Discover conversations recorded by other coding agents (Claude Code, Codex, ZCode) on this machine and '
      + 'import one into this harness as a fully continuable session. Use `list` to enumerate sources, '
      + 'then `import` with the chosen provider and sourceId. Importing is idempotent: an unchanged '
      + 'source reports up-to-date, and an existing target is never overwritten.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'import'],
        description: '`list` enumerates discoverable external conversations; `import` converts one into a harness session.',
      },
      provider: {
        type: 'string',
        enum: ['claude-code', 'codex'],
        description: 'The source agent. Optional for `list` (scans every supported store); required for `import`.',
      },
      sourceId: {
        type: 'string',
        description: 'The external conversation id from a previous `list`. Required for `import`.',
      },
      force: {
        type: 'boolean',
        description: 'For `import` with an existing target: re-import the current source into a fresh versioned session instead of reporting conflict.',
      },
      limit: {
        type: 'integer',
        description: 'For `list`: at most this many rows, newest first. Omit for every discovered conversation.',
      },
      query: {
        type: 'string',
        description: 'For `list`: keep only conversations whose transcript contains this substring (case-insensitive).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['list', 'import'] },
          status: { type: 'string', required: true, enum: ['listed', 'imported', 'up-to-date', 'conflict'] },
          sessionId: { type: 'string' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                sourceId: { type: 'string', required: true },
                imported: { type: 'boolean', required: true },
                sessionId: { type: 'string' },
                sizeBytes: { type: 'integer', required: true },
                mtimeMs: { type: 'integer', required: true },
              },
            },
          },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.action === 'list'
          ? `Discovered ${value.sessions?.length ?? 0} external conversation(s).`
          : `Import ${value.status}: ${value.sessionId ?? ''}${value.detail !== undefined ? ` — ${value.detail}` : ''}`,
      }],
    },
    isConcurrencySafe: args => args.action === 'list',
    async execute(args): Promise<ImportToolValue> {
      if (args.action === 'list') {
        return {
          action: 'list',
          status: 'listed',
          sessions: (await service.listSources({
            ...(args.provider !== undefined ? { provider: args.provider } : {}),
            ...(args.limit !== undefined ? { limit: Math.max(0, args.limit) } : {}),
            ...(args.query !== undefined ? { query: args.query } : {}),
          })).map(row => ({
            provider: row.provider,
            sourceId: row.sourceId,
            imported: row.imported,
            ...(row.imported ? { sessionId: targetIdFor(row.provider, row.sourceId) } : {}),
            sizeBytes: row.sizeBytes,
            mtimeMs: row.mtimeMs,
          })),
        }
      }
      if (args.provider === undefined || args.sourceId === undefined) {
        throw new Error('session_import import requires `provider` and `sourceId`')
      }
      const outcome = await service.importSource({
        provider: args.provider,
        sourceId: args.sourceId,
        ...(args.force === true ? { force: true } : {}),
      })
      return {
        action: 'import',
        status: outcome.status,
        sessionId: outcome.sessionId,
        ...(outcome.title !== undefined ? { detail: outcome.title } : {}),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.action === 'list' ? 'List external agent conversations' : 'Import an external agent conversation',
      kind: 'other',
      rawInput: args,
    }),
  }))
}
