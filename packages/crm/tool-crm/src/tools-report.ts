/**
 * Analytics-facing crm_report tool: one tool, four report kinds over the
 * read-model aggregations (pipeline, book, tasks, suitability audit).
 * @module @deepseek-ai/dsh-tool-crm/src/tools-report
 */

import type { Context } from '@deepseek-ai/cordis'
import { AdvisorId, isBlockingVerdict, PROFILE_EXPIRY_WARNING_MS } from '@deepseek-ai/dsh-crm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  bookReportWireSchema,
  pipelineReportWireSchema,
  suitabilityAuditWireSchema,
  taskLoadReportWireSchema,
} from './schemas.ts'
import type { SuitabilityVerdict } from '@deepseek-ai/dsh-crm/types'
import { fmtAmount, toIso, wireBook, wirePipeline, wireTaskLoad } from './wire.ts'

/** One flattened audit row; the entry schema minus the shared field shapes it already owns. */
const auditRow = suitabilityAuditWireSchema

/**
 * Register the report tool on `ctx.tools`.
 * @param ctx - Registrant context carrying the tool registry and `ctx.crm`.
 */
export function registerReportTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'crm_report',
    description:
      'Run one CRM report. pipeline: per-stage counts, amounts, weighted forecast, and win rate. '
      + 'book: client distribution by lifecycle and risk tolerance, AUM totals, and risk assessments '
      + 'expiring within 30 days or already expired. tasks: open-task load per advisor with overdue '
      + 'counts and the next due items. suitability: the flattened audit trail of product verdicts '
      + 'from recorded consultations.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['pipeline', 'book', 'tasks', 'suitability'],
        description: 'Which report to run.',
      },
      advisorId: { type: 'string', description: 'Restrict the report to one advisor.' },
      limit: { type: 'integer', description: 'Maximum suitability entries (default 50, max 200; suitability only).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['pipeline', 'book', 'tasks', 'suitability'], required: true },
          pipeline: pipelineReportWireSchema,
          book: bookReportWireSchema,
          tasks: taskLoadReportWireSchema,
          audit: { type: 'array', items: auditRow },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: describeReport(args.kind, value),
      }],
    },
    execute(args) {
      const advisorId = args.advisorId === undefined ? undefined : AdvisorId(args.advisorId)
      if (args.kind === 'pipeline') {
        return Promise.resolve({ kind: 'pipeline', pipeline: wirePipeline(ctx.crm.pipelineSnapshot(advisorId)) })
      }
      if (args.kind === 'book') {
        return Promise.resolve({ kind: 'book', book: wireBook(ctx.crm.bookSnapshot(advisorId)) })
      }
      if (args.kind === 'tasks') {
        return Promise.resolve({ kind: 'tasks', tasks: wireTaskLoad(ctx.crm.taskLoad(advisorId)) })
      }
      const audit = ctx.crm.suitabilityAudit(undefined, args.limit, advisorId)
      return Promise.resolve({
        kind: 'suitability',
        audit: audit.map(entry => ({
          clientId: entry.clientId,
          clientName: entry.clientName,
          consultationId: entry.consultationId,
          occurredAt: toIso(entry.occurredAt),
          product: { name: entry.product.name, kind: entry.product.kind, riskLevel: entry.product.riskLevel },
          verdict: entry.verdict,
          rationale: entry.rationale,
        })),
      })
    },
    presentCall: args => ({ card: 'generic', title: `Run CRM report: ${args.kind}`, kind: 'read', rawInput: args }),
  }))
}

/** The warning window in whole days, derived from the service constant. */
const WARNING_WINDOW_DAYS = Math.round(PROFILE_EXPIRY_WARNING_MS / 86_400_000)

/** The pipeline figures the render reads. */
type PipelineRender = { openCount: number; weightedForecast: number; wonCount: number; lostCount: number; winRate: number | null }

/** The book figures the render reads. */
type BookRender = { totalClients: number; totalAum: number; expiringProfiles: unknown[]; expiredProfiles: unknown[] }

/** The task-load figures the render reads. */
type TasksRender = { open: number; overdue: number }

/**
 * One prose line per report kind, for the model-facing render.
 * @param kind - Which report ran.
 * @param payload - That kind's payload; absent when a caller inspects a foreign kind.
 * @returns the human-readable summary line.
 */
export function describeReport(
  kind: 'pipeline' | 'book' | 'tasks' | 'suitability',
  payload: {
    pipeline?: PipelineRender
    book?: BookRender
    tasks?: TasksRender
    audit?: readonly { verdict: SuitabilityVerdict }[]
  },
): string {
  const { pipeline, book, tasks, audit } = payload
  if (kind === 'pipeline' && pipeline !== undefined) {
    return `Pipeline: ${pipeline.openCount} open deals, weighted forecast ${fmtAmount(pipeline.weightedForecast)}, `
      + `${pipeline.wonCount} won, ${pipeline.lostCount} lost, `
      + `win rate ${pipeline.winRate === null ? 'n/a' : `${pipeline.winRate}%`}.`
  }
  if (kind === 'book' && book !== undefined) {
    return `Book: ${book.totalClients} clients, AUM ${fmtAmount(book.totalAum)}, `
      + `${book.expiringProfiles.length} assessments expiring within ${String(WARNING_WINDOW_DAYS)} days, `
      + `${book.expiredProfiles.length} expired.`
  }
  if (kind === 'tasks' && tasks !== undefined) {
    return `Tasks: ${tasks.open} open, ${tasks.overdue} overdue.`
  }
  const rows = audit ?? []
  const blocked = rows.filter(entry => isBlockingVerdict(entry.verdict)).length
  return `Suitability audit: ${rows.length} entries, ${blocked} with a blocking verdict.`
}
