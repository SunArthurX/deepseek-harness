/**
 * Synthetic external-agent stores for tests: hand-built Claude Code and Codex
 * JSONL transcripts written into a temporary HOME-shaped directory. No fixture
 * is copied from a real transcript; every line is authored here.
 * @module tests/fixtures
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One Claude Code transcript line, JSON-serialized. */
export function claudeLine(value: object): string {
  return JSON.stringify(value)
}

/** A Claude Code user prompt line. */
export function claudeUser(text: string, timestamp = '2026-08-01T10:00:00.000Z', extra: object = {}): string {
  return claudeLine({
    type: 'user', uuid: `u-${Math.random()}`, timestamp, cwd: '/repo', message: { role: 'user', content: text }, ...extra,
  })
}

/** A Claude Code assistant line: text plus optional tool_use blocks. */
export function claudeAssistant(
  text: string,
  model = 'claude-test-model',
  toolUses: { id: string; name: string; input: object }[] = [],
  timestamp = '2026-08-01T10:00:05.000Z',
): string {
  const content: object[] = toolUses.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input }))
  if (text.length > 0) content.unshift({ type: 'text', text })
  return claudeLine({
    type: 'assistant', uuid: `a-${Math.random()}`, timestamp, message: { role: 'assistant', model, content },
  })
}

/** A Claude Code tool-result-carrying user line (harness traffic for earlier calls). */
export function claudeToolResult(results: { toolUseId: string; content: string }[], timestamp = '2026-08-01T10:00:06.000Z'): string {
  return claudeLine({
    type: 'user',
    uuid: `tr-${Math.random()}`,
    timestamp,
    message: {
      role: 'user',
      content: results.map(result => ({ type: 'tool_result', tool_use_id: result.toolUseId, content: result.content })),
    },
  })
}

/** A Claude Code assistant thinking-only block line. */
export function claudeThinking(thinking: string): string {
  return claudeLine({
    type: 'assistant', uuid: `t-${Math.random()}`, timestamp: '2026-08-01T10:00:04.000Z',
    message: { role: 'assistant', model: 'claude-test-model', content: [{ type: 'thinking', thinking }] },
  })
}

/** A Claude Code title line. */
export function claudeTitle(aiTitle: string): string {
  return claudeLine({ type: 'ai-title', aiTitle })
}

/** Write one Claude Code transcript under `<claudeHome>/projects/<project>/<id>.jsonl`. */
export async function writeClaudeTranscript(
  claudeHome: string,
  project: string,
  sessionId: string,
  lines: readonly string[],
): Promise<string> {
  const path = join(claudeHome, 'projects', project, `${sessionId}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`)
  return path
}

/** A Codex rollout first line (session metadata). */
export function codexMeta(sessionId: string, cwd: string): string {
  return JSON.stringify({ timestamp: '2026-08-02T09:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd, source: 'cli' } })
}

/** A Codex user or assistant message line. */
export function codexMessage(role: 'user' | 'assistant', text: string, contentType: 'input_text' | 'output_text' = role === 'user' ? 'input_text' : 'output_text'): string {
  return JSON.stringify({
    timestamp: '2026-08-02T09:00:05.000Z', type: 'response_item',
    payload: { type: 'message', role, content: [{ type: contentType, text }] },
  })
}

/** A Codex legacy function-call line. */
export function codexFunctionCall(name: string, args: object, callId: string): string {
  return JSON.stringify({
    timestamp: '2026-08-02T09:00:06.000Z', type: 'response_item',
    payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId },
  })
}

/** A Codex function-output line. */
export function codexFunctionOutput(callId: string, output: string): string {
  return JSON.stringify({
    timestamp: '2026-08-02T09:00:07.000Z', type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output },
  })
}

/** A Codex JS-bridge custom tool call line. */
export function codexCustomToolCall(jsInput: string, callId: string): string {
  return JSON.stringify({
    timestamp: '2026-08-02T09:00:08.000Z', type: 'response_item',
    payload: { type: 'custom_tool_call', input: jsInput, arguments: '', call_id: callId },
  })
}

/** A Codex turn-context line carrying the model id. */
export function codexTurnContext(model: string): string {
  return JSON.stringify({
    timestamp: '2026-08-02T09:00:01.000Z', type: 'turn_context',
    payload: { cwd: '/repo', model },
  })
}

/** Write one Codex rollout under `<codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`. */
export async function writeCodexRollout(
  codexHome: string,
  dayPath: string,
  fileName: string,
  lines: readonly string[],
): Promise<string> {
  const path = join(codexHome, 'sessions', dayPath, fileName)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`)
  return path
}

/** Write one Codex archived rollout under `<codexHome>/archived_sessions/`. */
export async function writeCodexArchivedRollout(
  codexHome: string,
  fileName: string,
  lines: readonly string[],
): Promise<string> {
  const path = join(codexHome, 'archived_sessions', fileName)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`)
  return path
}

/** A Codex named custom tool call line (e.g. apply_patch) with raw input. */
export function codexNamedCustomToolCall(name: string, input: string, callId: string): string {
  return JSON.stringify({
    timestamp: '2026-08-02T09:00:11.000Z', type: 'response_item',
    payload: { type: 'custom_tool_call', name, input, arguments: '', call_id: callId },
  })
}
