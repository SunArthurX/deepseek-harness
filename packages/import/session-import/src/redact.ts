/**
 * Secret redaction for imported transcript text. Imported history is replayed
 * into later DeepSeek Harness requests, so credentials copied through an
 * external agent's log would leave the machine on the next turn. Redaction
 * runs before translation and its count is recorded in the import provenance
 * event, so altered content is always visible in the durable log.
 * @module @deepseek-ai/dsh-session-import/redact
 */

/** One redaction rule: a credential family and its match pattern. */
interface RedactRule {
  readonly kind: string
  readonly pattern: RegExp
}

/**
 * Built-in credential families, modeled on widely used token formats. Patterns
 * are deliberately shape-strict to keep false positives out of user prose.
 */
const RULES: readonly RedactRule[] = [
  { kind: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255}/g },
  { kind: 'npm-token', pattern: /npm_[A-Za-z0-9]{36,255}/g },
  { kind: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,250}/g },
  { kind: 'openai-api-key', pattern: /sk-proj-[A-Za-z0-9_-]{20,255}|sk-[A-Za-z0-9]{20,}/g },
  { kind: 'anthropic-api-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,255}/g },
  { kind: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

/** Outcome of redacting one text: the safe replacement and how many matches were made. */
export interface RedactionOutcome {
  readonly text: string
  readonly redactions: number
}

/**
 * Replace credential-shaped substrings with `[REDACTED:<kind>]` markers.
 * @param text - the source text, any length.
 * @returns the redacted text and the number of replaced matches.
 */
export function redactText(text: string): RedactionOutcome {
  let redactions = 0
  let output = text
  for (const rule of RULES) {
    output = output.replace(rule.pattern, () => {
      redactions++
      return `[REDACTED:${rule.kind}]`
    })
  }
  return { text: output, redactions }
}
