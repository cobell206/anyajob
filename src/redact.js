// src/redact.js
// Aggressive redaction for log lines exposed via the /api/logs endpoint
// and the /api/diagnostic bundle.
//
// We treat anything that smells like a credential, email address, file path,
// or long opaque token as redactable. This makes logs less useful for
// debugging niche issues (you can't see exactly which file path failed) but
// dramatically reduces leakage if the endpoint is compromised.
//
// The redact function is content-agnostic — it operates on whole strings,
// so it works on raw log text, JSON-stringified objects, error messages,
// anything. It's intentionally regex-based and approximate; false positives
// are preferable to false negatives.
//
// IMPORTANT: redaction is a defense-in-depth measure, not a security
// boundary. The real security boundary is Cloudflare Access. Don't rely
// on redaction to make logs safe to leak — rely on auth.

// Order matters: more specific patterns first. Once a substring is replaced
// with a placeholder, the placeholder text shouldn't itself match a later
// pattern (so we use distinctive `[REDACTED-*]` markers).
const PATTERNS = [
  // Anthropic API keys: sk-ant-...
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED-ANTHROPIC-KEY]' },
  // OpenAI API keys: sk-...
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED-API-KEY]' },
  // AWS access key IDs: AKIA / ASIA + 16 chars
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: '[REDACTED-AWS-KEY]' },
  // AWS secret access keys: 40-char base64-ish (after `secret` or alone)
  // Conservative: only redact when it looks like a secret context
  { re: /(secret[_-]?access[_-]?key["':\s=]+)[A-Za-z0-9/+=]{40}/gi, replacement: '$1[REDACTED-AWS-SECRET]' },
  // GitHub tokens
  { re: /\bghp_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED-GH-TOKEN]' },
  { re: /\bghs_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED-GH-TOKEN]' },
  // JWT-like (three base64 segments separated by dots)
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: '[REDACTED-JWT]' },
  // Bearer tokens in headers
  { re: /(Bearer\s+)[A-Za-z0-9._-]{20,}/gi, replacement: '$1[REDACTED-BEARER]' },
  // Email addresses
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[REDACTED-EMAIL]' },
  // Absolute Unix paths (/home/..., /var/..., /Users/...)
  // Match starting at / through to whitespace or end-of-quote.
  { re: /\/(?:home|Users|var|opt|etc|root|tmp|mnt)\/[^\s"'`,)\]}]+/g, replacement: '[REDACTED-PATH]' },
  // Long opaque tokens that look like credentials: 32+ chars of mixed
  // alphanumerics with no whitespace. Last because it's the most aggressive.
  // Skip strings that are clearly just hashes or IDs we've stamped (16-char
  // fingerprints, short hex IDs). Lower bound 32 to skip our fingerprints.
  { re: /\b[A-Za-z0-9_-]{40,}\b/g, replacement: '[REDACTED-TOKEN]' },
];

/**
 * Redact secrets from a string. Returns a new string with all matches
 * replaced by labeled placeholders.
 */
export function redact(text) {
  if (text == null) return text;
  let out = String(text);
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Redact all string values inside a JSON-serializable object, recursively.
 * Returns a new object — does not mutate input. Numbers, booleans, null
 * pass through unchanged.
 */
export function redactObject(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redact(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactObject);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = redactObject(v);
  }
  return out;
}

/**
 * Take a raw log file (newline-delimited pino JSON or plaintext) and return
 * a redacted version line-by-line. Each line is parsed as JSON if possible
 * (so we can redact field values structurally) and falls back to string
 * redaction otherwise.
 */
export function redactLogText(rawText) {
  return rawText
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      try {
        const parsed = JSON.parse(line);
        return JSON.stringify(redactObject(parsed));
      } catch {
        return redact(line);
      }
    })
    .join('\n');
}
