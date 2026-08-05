/**
 * SecretDetector: identifies credentials and sensitive data in text.
 *
 * Detection methods:
 *   - High-confidence format rules (API key patterns, JWT, private key headers)
 *   - Entropy-based detection (high-randomness strings)
 *   - Keyword field-name heuristics
 *   - Context semantic signals
 *
 * Does NOT extract or return detected values — only marks spans and sensitivity.
 */

export interface SecretSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: SecretKind;
}

export type SecretKind =
  | "api_key"
  | "access_token"
  | "password"
  | "private_key"
  | "cookie"
  | "authorization"
  | "certificate";

export interface SecretDetection {
  readonly sensitive: boolean;
  readonly kinds: SecretKind[];
  readonly confidence: number;
  readonly spans: SecretSpan[];
}

// ─── High-confidence format rules ─────────────────────────────────

interface FormatRule {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
  readonly confidence: number;
}

const FORMAT_RULES: readonly FormatRule[] = [
  // GitHub personal access tokens
  { kind: "access_token", pattern: /\bghp_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },
  { kind: "access_token", pattern: /\bgho_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },
  { kind: "access_token", pattern: /\bghu_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },
  { kind: "access_token", pattern: /\bghs_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },
  { kind: "access_token", pattern: /\bghr_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },

  // OpenAI API keys
  { kind: "api_key", pattern: /\bsk-[a-zA-Z0-9]{32,}\b/g, confidence: 0.95 },
  { kind: "api_key", pattern: /\bsk-admin-[a-zA-Z0-9]{32,}\b/g, confidence: 0.95 },
  { kind: "api_key", pattern: /\bsk-proj-[a-zA-Z0-9]{32,}\b/g, confidence: 0.95 },

  // Anthropic API keys
  { kind: "api_key", pattern: /\bsk-ant-[a-zA-Z0-9]{32,}\b/g, confidence: 0.95 },

  // HuggingFace tokens
  { kind: "access_token", pattern: /\bhf_[a-zA-Z0-9]{34}\b/g, confidence: 0.9 },

  // NPM access tokens
  { kind: "access_token", pattern: /\bnpm_[a-zA-Z0-9]{36}\b/g, confidence: 0.9 },

  // Slack tokens
  { kind: "access_token", pattern: /\bxox[bpras]-[a-zA-Z0-9-]+\b/g, confidence: 0.9 },

  // AWS access keys
  { kind: "api_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, confidence: 0.9 },
  { kind: "api_key", pattern: /\bASIA[0-9A-Z]{16}\b/g, confidence: 0.9 },

  // Generic `sk-` API keys (many providers)
  { kind: "api_key", pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g, confidence: 0.7 },

  // JWT tokens
  {
    kind: "access_token",
    pattern: /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\b/g,
    confidence: 0.85,
  },

  // Private key headers
  {
    kind: "private_key",
    pattern: /-{5}BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)\s+PRIVATE\s+KEY-{5}/g,
    confidence: 0.98,
  },

  // Authorization header values
  { kind: "authorization", pattern: /\bBearer\s+[a-zA-Z0-9._\-+=/]{20,}\b/gi, confidence: 0.75 },
  { kind: "authorization", pattern: /\bBasic\s+[a-zA-Z0-9+/=]{10,}\b/gi, confidence: 0.75 },
];

// ─── Field name heuristics ────────────────────────────────────────

const SENSITIVE_FIELD_PATTERNS: readonly (readonly [string, SecretKind])[] = [
  ["api[_-]?key", "api_key"],
  ["apikey", "api_key"],
  ["secret[_-]?key", "api_key"],
  ["access[_-]?token", "access_token"],
  ["auth[_-]?token", "access_token"],
  ["oauth[_-]?token", "access_token"],
  ["bearer[_-]?token", "access_token"],
  ["refresh[_-]?token", "access_token"],
  ["id[_-]?token", "access_token"],
  ["password", "password"],
  ["passwd", "password"],
  ["pwd", "password"],
  ["secret", "password"],
  ["credential", "password"],
  ["private[_-]?key", "private_key"],
  ["privkey", "private_key"],
  ["signing[_-]?key", "private_key"],
  ["cookie", "cookie"],
  ["session[_-]?ticket", "cookie"],
  ["certificate", "certificate"],
  ["authorization", "authorization"],
  ["认证", "authorization"],
  ["密码", "password"],
  ["密钥", "private_key"],
  ["凭据", "password"],
];

// ─── Entropy detection ────────────────────────────────────────────

function shannonEntropy(str: string): number {
  if (str.length === 0) return 0;
  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / str.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/**
 * High-entropy tokens (like random base64 strings) are suspicious.
 */
function detectHighEntropySpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  // Look for contiguous sequences of alphanumeric/symbol characters >= 20 chars
  const tokenRegex = /[A-Za-z0-9+/=_-]{20,}/g;
  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    const token = match[0];
    // Skip if it looks like a file path, URL, or common identifier
    if (/^(?:https?|file):/i.test(token)) continue;
    if (/^\d+$/.test(token)) continue; // All digits not a secret
    // Check: does the token have mixed case + digits? (strong indicator of randomness)
    const hasUpper = /[A-Z]/.test(token);
    const hasLower = /[a-z]/.test(token);
    const hasDigit = /\d/.test(token);
    const entropy = shannonEntropy(token);
    // High entropy (>3.5 bits/char) and has variety of characters
    if (entropy > 3.5 && ((hasUpper && hasLower && hasDigit) || entropy > 4.0)) {
      spans.push({
        start: match.index,
        end: match.index + token.length,
        kind: "api_key",
      });
    }
  }
  return spans;
}

// ─── Context semantic signals ─────────────────────────────────────

function detectContextSignals(text: string): SecretKind[] {
  const kinds: SecretKind[] = [];
  const lower = text.toLowerCase();

  // Check if the text looks like credential assignment
  if (/\b(?:token|key|secret|password|credential)\s*[:=]\s*\S{8,}/i.test(lower)) {
    if (!kinds.includes("api_key")) kinds.push("api_key");
  }

  // Check for field-setting patterns
  for (const [pattern, kind] of SENSITIVE_FIELD_PATTERNS) {
    const fieldRegex = new RegExp(`\\b${pattern}\\s*[:=]\\s*['"]?\\S{6,}`, "i");
    if (fieldRegex.test(lower)) {
      if (!kinds.includes(kind)) kinds.push(kind);
    }
  }

  return kinds;
}

// ─── Main detection ───────────────────────────────────────────────

export function detectSecrets(input: string): SecretDetection {
  const spans: SecretSpan[] = [];
  const kindSet = new Set<SecretKind>();
  let maxConfidence = 0;

  // 1. Format rules (high precision)
  for (const rule of FORMAT_RULES) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match;
    while ((match = regex.exec(input)) !== null) {
      // For private key headers, capture the entire preamble
      const start = match.index;
      const end = match.index + match[0].length;
      if (!spans.some((s) => s.start <= start && s.end >= end && s.kind === rule.kind)) {
        spans.push({ start, end, kind: rule.kind });
        kindSet.add(rule.kind);
        maxConfidence = Math.max(maxConfidence, rule.confidence);
      }
    }
  }

  // 2. Entropy detection (lower precision for unknown formats)
  const entropySpans = detectHighEntropySpans(input);
  for (const span of entropySpans) {
    if (!spans.some((s) => s.start <= span.start && s.end >= span.end)) {
      spans.push(span);
      kindSet.add(span.kind);
    }
  }
  if (entropySpans.length > 0) {
    maxConfidence = Math.max(maxConfidence, 0.5);
  }

  // 3. Field name / context detection (boosts confidence if format rules hit)
  const contextKinds = detectContextSignals(input);
  for (const kind of contextKinds) {
    kindSet.add(kind);
    // Don't set confidence purely based on context — it's too noisy
  }

  return {
    sensitive: spans.length > 0,
    kinds: [...kindSet],
    confidence: maxConfidence,
    spans: spans.sort((a, b) => a.start - b.start),
  };
}

/**
 * Quick check: is the text sensitive enough to reject outright?
 * Returns true for high-confidence format matches or private key material.
 */
export function shouldReject(input: string): boolean {
  const detection = detectSecrets(input);
  if (!detection.sensitive) return false;
  // Reject if any high-confidence (>0.8) format rule matched
  if (detection.confidence >= 0.8) return true;
  // Reject private key material at any confidence level
  if (detection.kinds.includes("private_key")) return true;
  return false;
}

/**
 * Create a safe summary of content that may contain secrets.
 * Strips detected span regions and replaces with [REDACTED].
 */
export function safeSummary(input: string, maxLength = 80): string {
  const detection = detectSecrets(input);
  if (!detection.sensitive) return input.slice(0, maxLength);

  let result = input.slice(0, maxLength);
  // Replace spans from end to start to preserve indices
  for (let i = detection.spans.length - 1; i >= 0; i--) {
    const span = detection.spans[i];
    if (span === undefined) continue;
    const part = result.slice(span.start, span.end);
    if (part.length >= 6) {
      result =
        result.slice(0, span.start) + `[${span.kind.toUpperCase()}]` + result.slice(span.end);
    }
  }
  return result;
}
