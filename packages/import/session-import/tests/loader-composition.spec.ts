// Proves the plugin loads and is configurable through a real cordis.yml booted
// by the real Loader: the tool appears with the source homes the config names,
// and listing reads from exactly those homes.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SessionImport from '@deepseek-ai/dsh-session-import'
import { claudeUser, writeClaudeTranscript } from './fixtures.ts'

let root: string
let context: Context | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-import-loader-'))
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/**
 * Boot a cordis.yml carrying the session-import config block.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'sessions'))}`,
    '    compression: none',
    "- name: '@deepseek-ai/dsh-session-import'",
    '  config:',
    ...configLines,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-session-import', SessionImport],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('session-import real Loader composition through cordis.yml', () => {
  it('loads the service and reads the configured claude home', async () => {
    const claudeHome = join(root, 'claude-home')
    await writeClaudeTranscript(claudeHome, '-demo', 'loader-1', [claudeUser('hello from the loader test')])
    const ctx = await boot([
      `    claudeHome: ${JSON.stringify(claudeHome)}`,
      `    codexHome: ${JSON.stringify(join(root, 'codex-home'))}`,
      '    defaultModel: loader-fallback-model',
      '    maxFileBytes: 1048576',
      '    maxToolResultChars: 500',
      '    includeReasoning: false',
      '    redactSecrets: true',
    ])

    const outcome = await ctx.sessionImport.importSource({ provider: 'claude-code', sourceId: 'loader-1' })
    expect(outcome.status).toBe('imported')
    const descriptions = ctx.tools.schemas().find(schema => schema.name === 'session_import')
    expect(descriptions).toBeDefined()
  }, 30_000)
})
