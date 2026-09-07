/**
 * Minimal scripted LLM adapter for service tests: streams one canned text
 * response per request and records the requests it received. A scripted
 * response may also be gated: its stream parks mid-turn until the test calls
 * {@link FakeAdapter.release}, standing in for a real model still streaming.
 * @module tests/fake-adapter
 */

import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** A scripted response whose stream pauses mid-turn at a test-controlled gate. */
export interface GatedResponse {
  /** Full text of the completed block; must start with {@link GATED_PREFIX}. */
  readonly text: string
}

/** The text every gated response streams before parking at its gate. */
const GATED_PREFIX = 'partial'

/** An adapter whose responses are fixed in advance, one per call. */
export class FakeAdapter extends LlmAdapter {
  /** Every request the adapter received, in order. */
  readonly requests: GenerateOptions[] = []

  /**
   * Resolves once a gated response's stream is parked at its gate, so the test
   * can only then issue the followup it wants delivered mid-turn. Single-shot:
   * one gated response per adapter. The boolean is a pure signal; it is unused.
   */
  readonly gated: Promise<boolean>

  /** Opens the parked gate; undefined while no stream is waiting. */
  private openGate: (() => void) | undefined
  private readonly responses: readonly (string | GatedResponse)[]
  private readonly markGated: (value: boolean) => void

  /**
   * @param responses - one entry per scripted call: a plain text response, or a
   *   {@link GatedResponse} that parks mid-stream; an empty list fails the next call.
   */
  constructor(responses: readonly (string | GatedResponse)[]) {
    super()
    this.responses = responses
    const { promise, resolve } = Promise.withResolvers<boolean>()
    this.gated = promise
    this.markGated = resolve
  }

  /** Complete the parked gated stream; a no-op while no stream is parked. */
  release(): void {
    this.openGate?.()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses[this.requests.length - 1]
    if (response === undefined) throw new Error('FakeAdapter: script exhausted')
    if (typeof response === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: response }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: response.length } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (!response.text.startsWith(GATED_PREFIX)) {
      // A gated response whose remainder is mis-scripted would stream deltas
      // that never sum to the block-end text — fail the script loudly instead.
      throw new Error(`FakeAdapter: gated response ${this.requests.length - 1} must start with "${GATED_PREFIX}"`)
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: GATED_PREFIX }
    this.markGated(true)
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        this.openGate = undefined
        reject(new Error('aborted'))
      }
      if (options.signal?.aborted) {
        abort()
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      this.openGate = (): void => {
        options.signal?.removeEventListener('abort', abort)
        this.openGate = undefined
        resolve()
      }
    })
    const rest = response.text.slice(GATED_PREFIX.length)
    if (rest.length > 0) yield { type: 'text-delta', index: 0, text: rest }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response.text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: response.text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
