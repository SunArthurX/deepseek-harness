/**
 * Pipeline-facing crm_* tools: opportunity create/move/list and task
 * create/list/complete/cancel/reschedule.
 * @module @deepseek-ai/dsh-tool-crm/src/tools-pipeline
 */

import type { Context } from '@deepseek-ai/cordis'
import { AdvisorId, ClientId, OpportunityId, TaskId } from '@deepseek-ai/dsh-crm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { opportunityWireSchema, taskWireSchema } from './schemas.ts'
import {
  fmtAmount,
  listPreview,
  OPEN_STAGES,
  PRIORITIES,
  PRODUCT_KINDS,
  STAGES,
  TASK_KINDS,
  TASK_STATUSES,
  parseWhen,
  wireOpportunity,
  wireTask,
} from './wire.ts'

/** The `{ opportunity }` result wrapper shared by create and move. */
const opportunityOutputSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: { opportunity: { ...opportunityWireSchema, required: true as const } },
} as const

/** The `{ task }` result wrapper shared by the five task tools. */
const taskOutputSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: { task: { ...taskWireSchema, required: true as const } },
} as const

/**
 * Register the pipeline tools on `ctx.tools`.
 * @param ctx - Registrant context carrying the tool registry and `ctx.crm`.
 */
export function registerPipelineTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'crm_opportunity_create',
    description:
      'Open one deal in the pipeline: a client, a product category, and the deal value. Probability '
      + 'defaults to the opening stage\'s value (10% at new).',
    parameters: {
      clientId: { type: 'string', required: true, description: 'Client pursued.' },
      productKind: { type: 'string', required: true, enum: [...PRODUCT_KINDS], description: 'Product category.' },
      amount: { type: 'number', required: true, description: 'Deal value; positive.' },
      productName: { type: 'string', description: 'Specific product name when known.' },
      advisorId: { type: 'string', description: 'Owning advisor; defaults to the client\'s owner.' },
      stage: { type: 'string', enum: [...OPEN_STAGES], description: 'Opening stage; defaults to new. Terminal stages are reached only through crm_opportunity_move.' },
      currency: { type: 'string', description: 'ISO 4217 upper-case code; defaults to CNY.' },
      probability: { type: 'integer', description: 'Win probability 0–100; defaults to the stage\'s value.' },
      expectedCloseAt: { type: 'string', description: 'Planned close time, ISO 8601.' },
      notes: { type: 'string', description: 'Free-text notes.' },
    },
    output: {
      schema: opportunityOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Opened opportunity ${value.opportunity.id} for client ${value.opportunity.clientId}: `
          + `${value.opportunity.productName ?? value.opportunity.productKind} at ${fmtAmount(value.opportunity.amount)} ${value.opportunity.currency} (${value.opportunity.stage}, ${value.opportunity.probability}%).`,
      }],
    },
    execute(args) {
      return ctx.crm.createOpportunity({
        clientId: ClientId(args.clientId),
        productKind: args.productKind,
        amount: args.amount,
        ...(args.productName === undefined ? {} : { productName: args.productName }),
        ...(args.advisorId === undefined ? {} : { advisorId: AdvisorId(args.advisorId) }),
        ...(args.stage === undefined ? {} : { stage: args.stage }),
        ...(args.currency === undefined ? {} : { currency: args.currency }),
        ...(args.probability === undefined ? {} : { probability: args.probability }),
        ...(args.expectedCloseAt === undefined ? {} : { expectedCloseAt: parseWhen(args.expectedCloseAt, 'expectedCloseAt') }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      }).then(record => ({ opportunity: wireOpportunity(record) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Open CRM opportunity', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_opportunity_move',
    description:
      'Move one deal through the pipeline. won/lost/abandoned are terminal; lost and abandoned require '
      + 'a closeReason; entering a terminal stage stamps the close time and forces its probability '
      + '(won 100, lost/abandoned 0).',
    parameters: {
      opportunityId: { type: 'string', required: true, description: 'Deal to move.' },
      to: { type: 'string', required: true, enum: [...STAGES], description: 'Target stage.' },
      probability: { type: 'integer', description: 'Win probability 0–100 for a non-terminal move; ignored entering a terminal stage.' },
      closeReason: { type: 'string', description: 'Why the deal closed or was abandoned; required entering lost or abandoned.' },
      notes: { type: 'string', description: 'Notes update.' },
    },
    output: {
      schema: opportunityOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Moved opportunity ${value.opportunity.id} to ${value.opportunity.stage}`
          + `${value.opportunity.closedAt === undefined ? '' : ` (closed ${value.opportunity.closedAt.slice(0, 10)})`}.`,
      }],
    },
    execute(args) {
      return ctx.crm.moveOpportunity({
        opportunityId: OpportunityId(args.opportunityId),
        to: args.to,
        ...(args.probability === undefined ? {} : { probability: args.probability }),
        ...(args.closeReason === undefined ? {} : { closeReason: args.closeReason }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      }).then(record => ({ opportunity: wireOpportunity(record) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Move CRM opportunity', kind: 'move', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_opportunity_list',
    description: 'List pipeline deals, newest-updated first.',
    parameters: {
      clientId: { type: 'string', description: 'Restrict to one client.' },
      stage: { type: 'string', enum: [...STAGES], description: 'Restrict to one stage.' },
      advisorId: { type: 'string', description: 'Restrict to one advisor.' },
      limit: { type: 'integer', description: 'Maximum rows (default 20, max 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          opportunities: { type: 'array', items: opportunityWireSchema, required: true },
          returned: { type: 'integer', required: true, description: 'Rows in this response.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.opportunities.length === 0
          ? 'No matching opportunities.'
          : `${value.opportunities.length} deals: ${listPreview(value.opportunities.map(deal => `${deal.productName ?? deal.productKind}/${deal.stage}/${fmtAmount(deal.amount)} ${deal.currency}`))}.`,
      }],
    },
    execute(args) {
      const records = ctx.crm.listOpportunities({
        ...(args.clientId === undefined ? {} : { clientId: ClientId(args.clientId) }),
        ...(args.stage === undefined ? {} : { stage: args.stage }),
        ...(args.advisorId === undefined ? {} : { advisorId: AdvisorId(args.advisorId) }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return Promise.resolve({ opportunities: records.map(wireOpportunity), returned: records.length })
    },
    presentCall: args => ({ card: 'generic', title: 'List CRM opportunities', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_task_create',
    description:
      'Schedule one follow-up task. The owning advisor resolves from the explicit field, else the '
      + 'named client\'s owner, else the named opportunity\'s owner.',
    parameters: {
      title: { type: 'string', required: true, description: 'One-line description of the work.' },
      dueAt: { type: 'string', required: true, description: 'Due time, ISO 8601.' },
      clientId: { type: 'string', description: 'Client concerned, when task-specific.' },
      opportunityId: { type: 'string', description: 'Opportunity concerned, when deal-specific.' },
      advisorId: { type: 'string', description: 'Advisor who owes the work; defaults to the client or opportunity owner.' },
      kind: { type: 'string', enum: [...TASK_KINDS], description: 'Task category; defaults to follow_up.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'Urgency; defaults to normal.' },
      notes: { type: 'string', description: 'Free-text notes.' },
    },
    output: {
      schema: taskOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Scheduled task ${value.task.id}: ${value.task.title}, due ${value.task.dueAt} (${value.task.priority}).`,
      }],
    },
    execute(args) {
      return ctx.crm.createTask({
        title: args.title,
        dueAt: parseWhen(args.dueAt, 'dueAt'),
        ...(args.clientId === undefined ? {} : { clientId: ClientId(args.clientId) }),
        ...(args.opportunityId === undefined ? {} : { opportunityId: OpportunityId(args.opportunityId) }),
        ...(args.advisorId === undefined ? {} : { advisorId: AdvisorId(args.advisorId) }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      }).then(record => ({ task: wireTask(record, Date.now()) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Schedule CRM task', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_task_list',
    description:
      'List tasks by due time, soonest first. Without a status filter only open tasks are returned; '
      + 'overdue=true selects open tasks past due. Each row carries the derived overdue flag.',
    parameters: {
      advisorId: { type: 'string', description: 'Restrict to one advisor.' },
      clientId: { type: 'string', description: 'Restrict to one client.' },
      status: { type: 'string', enum: [...TASK_STATUSES], description: 'Lifecycle filter; omitting it lists open tasks only.' },
      kind: { type: 'string', enum: [...TASK_KINDS], description: 'Restrict to one task category.' },
      overdue: { type: 'boolean', description: 'Only open tasks past due now.' },
      dueBefore: { type: 'string', description: 'Only tasks due at or before this ISO 8601 timestamp.' },
      limit: { type: 'integer', description: 'Maximum rows (default 20, max 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: { type: 'array', items: taskWireSchema, required: true },
          returned: { type: 'integer', required: true, description: 'Rows in this response.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tasks.length === 0
          ? 'No matching tasks.'
          : `${value.tasks.length} tasks: ${listPreview(value.tasks.map(task => `${task.overdue ? 'OVERDUE ' : ''}${task.title} due ${task.dueAt.slice(0, 10)}`))}.`,
      }],
    },
    execute(args) {
      const records = ctx.crm.listTasks({
        ...(args.advisorId === undefined ? {} : { advisorId: AdvisorId(args.advisorId) }),
        ...(args.clientId === undefined ? {} : { clientId: ClientId(args.clientId) }),
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.overdue === undefined ? {} : { overdue: args.overdue }),
        ...(args.dueBefore === undefined ? {} : { dueBefore: parseWhen(args.dueBefore, 'dueBefore') }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      const now = Date.now()
      return Promise.resolve({ tasks: records.map(record => wireTask(record, now)), returned: records.length })
    },
    presentCall: args => ({ card: 'generic', title: 'List CRM tasks', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_task_complete',
    description: 'Mark one open task done, stamping its completion time.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task to complete.' },
    },
    output: {
      schema: taskOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Completed task ${value.task.id}: ${value.task.title}.`,
      }],
    },
    execute(args) {
      return ctx.crm.completeTask(TaskId(args.taskId)).then(record => ({ task: wireTask(record, Date.now()) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Complete CRM task', kind: 'execute', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_task_cancel',
    description: 'Cancel one open task; cancelled tasks stay in the record for audit.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task to cancel.' },
    },
    output: {
      schema: taskOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Cancelled task ${value.task.id}: ${value.task.title}.`,
      }],
    },
    execute(args) {
      return ctx.crm.cancelTask(TaskId(args.taskId)).then(record => ({ task: wireTask(record, Date.now()) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Cancel CRM task', kind: 'delete', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'crm_task_reschedule',
    description: 'Move one open task\'s due time.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task to reschedule.' },
      dueAt: { type: 'string', required: true, description: 'New due time, ISO 8601.' },
    },
    output: {
      schema: taskOutputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Rescheduled task ${value.task.id} to ${value.task.dueAt}.`,
      }],
    },
    execute(args) {
      return ctx.crm.rescheduleTask(TaskId(args.taskId), parseWhen(args.dueAt, 'dueAt'))
        .then(record => ({ task: wireTask(record, Date.now()) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Reschedule CRM task', kind: 'move', rawInput: args }),
  }))
}
