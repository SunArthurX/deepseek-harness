/**
 * Direct unit coverage for the adapter-shared guards and sanitizers: malformed
 * tool-result content, missing call ids, non-JSON arguments, and the
 * string-aware Codex JS-bridge scanner.
 * @module tests/shared
 */

import { describe, expect, it } from 'vitest'
import {
  argumentsJsonOf,
  callIdOf,
  isCodexInjectedContext,
  isRecord,
  parseCodexJsBridge,
  promptTitleOf,
  stringField,
  stripClaudeInjectedMarkup,
  toolResultTextOf,
} from '../src/adapters/shared.ts'

describe('promptTitleOf', () => {
  it('strips command prefixes and markdown links, bounds to whole words and bytes', () => {
    expect(promptTitleOf('/goal 1. 给我整理西游记角色，至少200个')).toBe('给我整理西游记角色，至少200个')
    expect(promptTitleOf('[简历.md](./9.career/简历.md) 优化一下')).toBe('简历.md 优化一下')
    expect(promptTitleOf('```markdown # Java 架构师 JD 提取')).toBe('# Java 架构师 JD 提取')
    expect(promptTitleOf('   ')).toBeUndefined()
    const thirteen = Array.from({ length: 13 }, (_, i) => 'word' + String(i)).join(' ')
    expect(promptTitleOf(thirteen)).toBe(Array.from({ length: 12 }, (_, i) => 'word' + String(i)).join(' '))
  })
})

describe('isRecord and stringField', () => {
  it('accepts plain objects and rejects arrays, null, and primitives', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('reads a non-empty string field and rejects other shapes', () => {
    expect(stringField({ k: 'v' }, 'k')).toBe('v')
    expect(stringField({}, 'k')).toBeUndefined()
    expect(stringField({ k: '' }, 'k')).toBeUndefined()
    expect(stringField({ k: 5 }, 'k')).toBeUndefined()
  })
})

describe('isCodexInjectedContext', () => {
  it.each([
    '<environment_context>env</environment_context>',
    '<user_instructions>rules</user_instructions>',
    '<recommended_plugins>list</recommended_plugins>',
    '<turn_context>c</turn_context>',
    '<turn_aborted>reason</turn_aborted>',
    '<runtime_credentials>token</runtime_credentials>',
    '<IDE_INFORMATION>editor</IDE_INFORMATION>',
    '<ENVIRONMENT var=1>',
    '# AGENTS.md\nbody',
    '<system-reminder>note</system-reminder>',
  ])('treats %s as injected runtime context', (text) => {
    expect(isCodexInjectedContext(text)).toBe(true)
  })

  it('keeps ordinary prompts', () => {
    expect(isCodexInjectedContext('please fix the bug')).toBe(false)
    expect(isCodexInjectedContext('')).toBe(false)
  })
})

describe('stripClaudeInjectedMarkup', () => {
  it('removes every injected strip and keeps surrounding prose', () => {
    expect(stripClaudeInjectedMarkup('run <command-name>/review</command-name> now'))
      .toBe('run  now')
    expect(stripClaudeInjectedMarkup('<command-message>review</command-message>go'))
      .toBe('go')
    expect(stripClaudeInjectedMarkup('args: <command-args>--all</command-args>'))
      .toBe('args:')
    expect(stripClaudeInjectedMarkup('out <local-command-stdout>noise</local-command-stdout>'))
      .toBe('out')
    expect(stripClaudeInjectedMarkup('  <system-reminder>n</system-reminder>  ')).toBe('')
  })
})

describe('toolResultTextOf', () => {
  it('passes strings through', () => {
    expect(toolResultTextOf('plain')).toBe('plain')
  })

  it('joins text blocks from an array, dropping non-text entries', () => {
    expect(toolResultTextOf([
      { type: 'text', text: 'first' },
      { type: 'image', url: 'x' },
      'bare string',
      { type: 'text', text: 'second' },
      42,
    ])).toBe('first\nsecond')
  })

  it('reads an object output field', () => {
    expect(toolResultTextOf({ output: 'stdout text' })).toBe('stdout text')
  })

  it('falls back to object text and content fields', () => {
    expect(toolResultTextOf({ text: 'text field' })).toBe('text field')
    expect(toolResultTextOf({ content: 'content field' })).toBe('content field')
  })

  it('stringifies an object with no readable text field', () => {
    expect(toolResultTextOf({ code: 7 })).toBe('{"code":7}')
  })

  it('stringifies other primitives', () => {
    expect(toolResultTextOf(12)).toBe('12')
    expect(toolResultTextOf(null)).toBe('null')
  })
})

describe('callIdOf', () => {
  it('returns a present non-empty id unchanged', () => {
    expect(callIdOf('call-7')).toBe('call-7')
  })

  it('synthesizes a stable substitute for missing or empty ids', () => {
    const first = callIdOf(undefined)
    const second = callIdOf('')
    expect(first).toMatch(/^imported-call-\d+$/)
    expect(Number.parseInt(first.slice('imported-call-'.length), 10))
      .toBe(Number.parseInt(second.slice('imported-call-'.length), 10) - 1)
  })
})

describe('argumentsJsonOf', () => {
  it('passes a parseable JSON string through unchanged', () => {
    expect(argumentsJsonOf('{"a":1}')).toBe('{"a":1}')
  })

  it('wraps an unparseable string so later requests can parse it', () => {
    expect(argumentsJsonOf('not json')).toBe(JSON.stringify({ raw: 'not json' }))
  })

  it('returns an empty object for absent arguments', () => {
    expect(argumentsJsonOf(undefined)).toBe('{}')
    expect(argumentsJsonOf(null)).toBe('{}')
  })

  it('serializes a non-string value directly', () => {
    expect(argumentsJsonOf({ a: 1 })).toBe('{"a":1}')
    expect(argumentsJsonOf('')).toBe('""')
  })
})

describe('parseCodexJsBridge', () => {
  it('extracts the name and JSON arguments from a bridge call', () => {
    expect(parseCodexJsBridge('await tools.update_plan({"plan":["a"]})'))
      .toEqual({ name: 'update_plan', arguments: '{"plan":["a"]}' })
  })

  it('wraps a JavaScript (non-JSON) body so later requests can parse it', () => {
    expect(parseCodexJsBridge('tools.update_plan({ plan: ["a"] })'))
      .toEqual({ name: 'update_plan', arguments: JSON.stringify({ raw: '{ plan: ["a"] }' }) })
  })

  it('scans past quoted strings containing brackets and parens', () => {
    const input = 'tools.write({"body":"a (paren) and [bracket] {brace}"})'
    expect(parseCodexJsBridge(input))
      .toEqual({ name: 'write', arguments: '{"body":"a (paren) and [bracket] {brace}"}' })
  })

  it('honors escaped quotes inside strings', () => {
    const input = 'tools.echo({"text":"a \\" b"})'
    expect(parseCodexJsBridge(input))
      .toEqual({ name: 'echo', arguments: '{"text":"a \\" b"}' })
  })

  it('defaults an empty argument body to an empty object', () => {
    expect(parseCodexJsBridge('tools.ping()')).toEqual({ name: 'ping', arguments: '{}' })
  })

  it('wraps the whole input when the call is never closed', () => {
    const input = 'tools.hang({ open: "yes'
    expect(parseCodexJsBridge(input)).toEqual({ name: 'hang', arguments: JSON.stringify({ raw: input }) })
  })

  it('returns undefined for input that is not a bridge call', () => {
    expect(parseCodexJsBridge('not a bridge call at all')).toBeUndefined()
    expect(parseCodexJsBridge('tools.()')).toBeUndefined()
  })
})
