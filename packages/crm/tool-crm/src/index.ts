/**
 * Model-facing CRM tools (`crm_*`) over `ctx.crm`: client book, advisor
 * roster, interactions, suitability-audited consultations, the opportunity
 * pipeline, follow-up tasks, and read-model reports. The tool layer owns
 * wire conversion (ISO 8601, enum vocabularies) only; business rules live
 * in the service.
 * @module @deepseek-ai/dsh-tool-crm
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerClientTools } from './tools-client.ts'
import { registerEngagementTools } from './tools-engagement.ts'
import { registerPipelineTools } from './tools-pipeline.ts'
import { registerReportTool } from './tools-report.ts'

export const name = 'tool-crm'
export const inject = ['tools', 'crm']

/**
 * Register every crm_* tool on `ctx.tools`.
 * @param ctx - Registrant context carrying the tool registry and the CRM service.
 */
export function apply(ctx: Context): void {
  registerClientTools(ctx)
  registerEngagementTools(ctx)
  registerPipelineTools(ctx)
  registerReportTool(ctx)
}
