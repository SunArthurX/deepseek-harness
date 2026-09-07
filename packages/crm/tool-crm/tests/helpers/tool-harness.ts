/**
 * Shared tool-layer test harness: boots the real storage stack + CRM service +
 * tool runtime (optionally in a non-default presentation mode) with optional
 * backend routing, seeds the enterprise book, and exposes a tool-call helper.
 */

import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { seedCrm } from '../../../crm/tests/helpers/seed.ts'
import type { SeedResult } from '../../../crm/tests/helpers/seed.ts'
import { crmHarness } from '../../../crm/tests/helpers/harness.ts'
import * as ToolCrm from '../../src/index.ts'

export interface ToolHarnessOptions {
  /** Presentation mode for the tool runtime; defaults to native. */
  mode?: 'native' | 'ptc' | 'both'
  /** Seed the enterprise book after boot; defaults to true. */
  seed?: boolean
  /** Test clock setter for seeding (`ms => vi.setSystemTime(ms)`); required when seeding. */
  setTime?: (ms: number) => void
}

export interface ToolHarness {
  ctx: Context
  seed: SeedResult | undefined
  /** Execute one tool call through the real pipeline. */
  call: (name: string, args: unknown) => Promise<{ isError: boolean; value?: unknown; text: string }>
  /** Resolve a registered tool definition for presenter checks. */
  def: (name: string) => ToolDefinition
  dispose: () => Promise<void>
}

/** Boot the full tool surface over the real service and storage stack. */
export async function toolHarness(options: ToolHarnessOptions = {}): Promise<ToolHarness> {
  // The service-side harness owns the storage boot; this layer only adds the
  // tool surface on top.
  const base = await crmHarness()
  const ctx = base.ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, options.mode === undefined ? undefined : { mode: options.mode })
  await ctx.plugin(ToolCrm)
  if (options.seed !== false && options.setTime === undefined) {
    throw new Error('toolHarness: seeding requires a setTime clock setter')
  }
  const seed = options.seed === false ? undefined : await seedCrm(ctx.crm, options.setTime!)
  let counter = 0
  return {
    ctx,
    seed,
    call: async (name, args) => {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`harness-${++counter}`),
        name,
        arguments: args,
      })
      return {
        isError: result.isError,
        ...(result.isError ? {} : { value: result.value }),
        text: result.content.filter(block => block.type === 'text').map(block => 'text' in block ? block.text : '').join(''),
      }
    },
    def: (name) => {
      const tool = ctx.tools.get(name)
      if (tool === undefined) throw new Error(`tool ${name} not registered`)
      return tool
    },
    dispose: async () => {
      await base.dispose()
    },
  }
}
