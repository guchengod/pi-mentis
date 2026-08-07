/**
 * SecretDetector: identifies credentials and sensitive data in text.
 *
 * Detection methods:
 *   - High-confidence format rules (API key patterns, JWT, private key headers)
 *   - Entropy-based detection (high-randomness strings)
 *   - Keyword field-name heuristics
 *   - Benign identifier exclusion (e.g., MENTIS_CASE_... identifiers)
 *
 * Design principle: classify locally, filter remotely.
 * Local storage preserves original content. Remote providers receive safe copies.
 */

import type {
  Sensitivity,
  SensitiveClassification,
  RemoteContentPolicy,
  RemoteSafeContent,
} from "./types.js";

export type { Sensitivity, SensitiveClassification, RemoteContentPolicy, RemoteSafeContent };

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

// ─── Benign identifier patterns ────────────────────────────────────

const BENIGN_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /^MENTIS_[A-Z]+_\d{14}_[a-f0-9]{8,}$/,
  /^MENTIS_CASE_\d{8}_[a-f0-9]{8,}$/,
  /^TRACE_\d{8}_[a-f0-9]{8,}$/,
  /^BUILD_[A-Z]+_\d{8}_[a-f0-9]{8,}$/,
  /^CASE_[A-Z_]+_\d{3,}$/,
  /^DEPLOY_[A-Z]+_\d{8}_[a-f0-9]{4,}$/,
  /^LOG_\d{8}_[a-f0-9]{4,}$/,
  /^EVENT_[A-Z]+_\d{4,}$/,
  /^SESSION_[A-Z]+_[a-f0-9]{8,}$/,
  // Test/development identifiers
  /^TEST_[A-Z_0-9]+$/,
  /^DEV_[A-Z_0-9]+$/,
  /^STAGING_[A-Z_0-9]+$/,
];

function isBenignIdentifier(token: string): boolean {
  if (token.length < 6 || token.length > 80) return false;
  if (/^(?:https?|file):/i.test(token)) return false;
  if (!token.includes("_")) return false;
  if (!/^[A-Z]/.test(token)) return false;
  const clean = token.endsWith("-") ? token.slice(0, -1) : token;
  return BENIGN_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(clean));
}

// ─── High-confidence format rules ─────────────────────────────────

interface FormatRule {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
  readonly confidence: number;
}

const FORMAT_RULES: readonly FormatRule[] = [
  { kind: "access_token", pattern: /\bghp_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },
  { kind: "access_token", pattern: /\bgho_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },
  { kind: "access_token", pattern: /\bghu_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },
  { kind: "access_token", pattern: /\bghs_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },
  { kind: "access_token", pattern: /\bghr_[a-zA-Z0-9]{36}\b/g, confidence: 0.95 },
  { kind: "api_key", pattern: /\bsk-[a-zA-Z0-9]{32,}\b/g, confidence: 0.95 },
  { kind: "api_key", pattern: /\bsk-admin-[a-zA-Z0-9]{32,}\b/g, confidence: 0.95 },
  { kind: "api_key", pattern: /\bsk-proj-[a-zA-Z0-9]{32,}\b/g, confidence: 0.95 },
  { kind: "api_key", pattern: /\bsk-ant-[a-zA-Z0-9]{32,}\b/g, confidence: 0.95 },
  { kind: "access_token", pattern: /\bhf_[a-zA-Z0-9]{34}\b/g, confidence: 0.9 },
  { kind: "access_token", pattern: /\bnpm_[a-zA-Z0-9]{36}\b/g, confidence: 0.9 },
  { kind: "access_token", pattern: /\bxox[bpras]-[a-zA-Z0-9-]+\b/g, confidence: 0.9 },
  { kind: "api_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, confidence: 0.9 },
  { kind: "api_key", pattern: /\bASIA[0-9A-Z]{16}\b/g, confidence: 0.9 },
  { kind: "api_key", pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g, confidence: 0.7 },
  {
    kind: "access_token",
    pattern: /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\b/g,
    confidence: 0.85,
  },
  {
    kind: "private_key",
    pattern: /-{5}BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)\s+PRIVATE\s+KEY-{5}/g,
    confidence: 0.98,
  },
  { kind: "authorization", pattern: /\bBearer\s+[a-zA-Z0-9._\-+=/]{20,}\b/gi, confidence: 0.75 },
  { kind: "authorization", pattern: /\bBasic\s+[a-zA-Z0-9+/=]{10,}\b/gi, confidence: 0.75 },
];

const SENSITIVE_FIELD_PATTERNS: readonly (readonly [string, SecretKind])[] = [
  ["api[_-]?key", "api_key"],
  ["apikey", "api_key"],
  ["secret[_-]?key", "api_key"],
  ["access[_-]?token", "access_token"],
  ["auth[_-]?token", "access_token"],
  ["oauth[_-]?token", "access_token"],
  ["bearer[_-]?token", "access_token"],
  ["refresh[_-]?token", "access_token"],
  ["password", "password"],
  ["passwd", "password"],
  ["pwd", "password"],
  ["secret", "password"],
  ["credential", "password"],
  ["private[_-]?key", "private_key"],
  ["privkey", "private_key"],
  ["signing[_-]?key", "private_key"],
  ["cookie", "cookie"],
  ["certificate", "certificate"],
  ["authorization", "authorization"],
  ["认证", "authorization"],
  ["密码", "password"],
  ["密钥", "private_key"],
  ["凭据", "password"],
];

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

function detectHighEntropySpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  const tokenRegex = /[A-Za-z0-9+/=_-]{20,}/g;
  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    const token = match[0];
    if (/^(?:https?|file):/i.test(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (isBenignIdentifier(token)) continue;
    const hasUpper = /[A-Z]/.test(token);
    const hasLower = /[a-z]/.test(token);
    const hasDigit = /\d/.test(token);
    const entropy = shannonEntropy(token);
    if (entropy > 3.5 && ((hasUpper && hasLower && hasDigit) || entropy > 4.0)) {
      spans.push({ start: match.index, end: match.index + token.length, kind: "api_key" });
    }
  }
  return spans;
}

function detectContextSignals(text: string): SecretKind[] {
  const kinds: SecretKind[] = [];
  const lower = text.toLowerCase();
  if (/\b(?:token|key|secret|password|credential)\s*[:=]\s*\S{8,}/i.test(lower)) {
    if (!kinds.includes("api_key")) kinds.push("api_key");
  }
  for (const [pattern, kind] of SENSITIVE_FIELD_PATTERNS) {
    const fieldRegex = new RegExp(`\\b${pattern}\\s*[:=]\\s*['\"]?\\S{6,}`, "i");
    if (fieldRegex.test(lower)) {
      if (!kinds.includes(kind)) kinds.push(kind);
    }
  }
  return kinds;
}

function benignIdentifierScore(text: string): number {
  const tokens = text.match(/[A-Z_][A-Z0-9_]{8,}/g);
  if (tokens === null || tokens.length === 0) return 0;
  const benignCount = tokens.filter((t) => isBenignIdentifier(t)).length;
  return Math.min(0.9, benignCount * 0.3);
}

// ─── Main detection ───────────────────────────────────────────────

export function detectSecrets(input: string): SecretDetection {
  const spans: SecretSpan[] = [];
  const kindSet = new Set<SecretKind>();
  let maxConfidence = 0;
  const benignScore = benignIdentifierScore(input);

  for (const rule of FORMAT_RULES) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match;
    while ((match = regex.exec(input)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      const matched = match[0];
      if (rule.confidence < 0.9 && isBenignIdentifier(matched)) continue;
      if (!spans.some((s) => s.start <= start && s.end >= end && s.kind === rule.kind)) {
        spans.push({ start, end, kind: rule.kind });
        kindSet.add(rule.kind);
        maxConfidence = Math.max(maxConfidence, rule.confidence);
      }
    }
  }

  const entropySpans = detectHighEntropySpans(input);
  for (const span of entropySpans) {
    if (!spans.some((s) => s.start <= span.start && s.end >= span.end)) {
      spans.push(span);
      kindSet.add(span.kind);
    }
  }
  if (entropySpans.length > 0) maxConfidence = Math.max(maxConfidence, 0.5);

  const contextKinds = detectContextSignals(input);
  for (const kind of contextKinds) kindSet.add(kind);

  maxConfidence = Math.max(0, maxConfidence - benignScore);

  return {
    sensitive: spans.length > 0 && maxConfidence >= 0.3,
    kinds: [...kindSet],
    confidence: maxConfidence,
    spans: spans.sort((a, b) => a.start - b.start),
  };
}

// ─── Sensitivity Classification (classify, don't destroy) ─────────

const SECRET_KINDS = ["private_key", "password", "certificate"] as const;

function kindToSensitivity(kind: SecretKind, confidence: number): Sensitivity {
  if ((SECRET_KINDS as readonly string[]).includes(kind)) return "secret";
  if (confidence >= 0.9) return "secret";
  if (confidence >= 0.7) return "sensitive";
  if (confidence >= 0.5) return "internal";
  return "public";
}

export function classifySensitivity(input: string): SensitiveClassification {
  const detection = detectSecrets(input);
  if (!detection.sensitive || detection.kinds.length === 0) {
    return { sensitivity: "public", categories: [], confidence: 0 };
  }
  const categories = [...new Set(detection.kinds)];
  const maxSensitivity = categories.reduce<Sensitivity>((worst, kind) => {
    const s = kindToSensitivity(kind, detection.confidence);
    const order: Sensitivity[] = ["public", "internal", "sensitive", "secret"];
    return order.indexOf(s) > order.indexOf(worst) ? s : worst;
  }, "public");
  return { sensitivity: maxSensitivity, categories, confidence: detection.confidence };
}

// ─── Remote Safety Gates ──────────────────────────────────────────

function defaultRemotePolicy(sensitivity: Sensitivity): RemoteContentPolicy {
  switch (sensitivity) {
    case "public":
      return "allow";
    case "internal":
      return "allow";
    case "sensitive":
      return "redact";
    case "secret":
      return "local_only";
  }
}

export function toRemoteSafe(input: string): RemoteSafeContent {
  const classification = classifySensitivity(input);
  const policy = defaultRemotePolicy(classification.sensitivity);
  if (policy === "allow") {
    return {
      originalSensitivity: classification.sensitivity,
      policy,
      text: input,
      redacted: false,
    };
  }
  if (policy === "local_only" || policy === "drop") {
    return {
      originalSensitivity: classification.sensitivity,
      policy,
      text: undefined,
      redacted: true,
    };
  }
  // redact: produce a safe version
  const detection = detectSecrets(input);
  let redacted = input;
  for (let i = detection.spans.length - 1; i >= 0; i--) {
    const span = detection.spans[i];
    if (span === undefined) continue;
    const part = redacted.slice(span.start, span.end);
    if (part.length >= 6) {
      redacted =
        redacted.slice(0, span.start) + `[${span.kind.toUpperCase()}]` + redacted.slice(span.end);
    }
  }
  return {
    originalSensitivity: classification.sensitivity,
    policy,
    text: redacted,
    redacted: true,
  };
}

// ─── Legacy helpers (kept for backward compat) ────────────────────

/**
 * Quick check: is the text sensitive enough to reject outright?
 * @deprecated Prefer classifySensitivity() for local storage, toRemoteSafe() for remote.
 */
export function shouldReject(input: string): boolean {
  const detection = detectSecrets(input);
  if (!detection.sensitive) return false;
  if (detection.confidence >= 0.8) return true;
  if (detection.kinds.includes("private_key")) return true;
  return false;
}

/**
 * @deprecated Prefer toRemoteSafe() for remote provider gating.
 */
export function sensitiveRemotePolicy(input: string): "allow" | "redact" | "drop" | "local_only" {
  const safe = toRemoteSafe(input);
  if (safe.policy === "local_only") return "local_only";
  if (safe.policy === "drop") return "drop";
  if (safe.policy === "redact") return "redact";
  return "allow";
}

export function safeSummary(input: string, maxLength = 80): string {
  const detection = detectSecrets(input);
  if (!detection.sensitive) return input.slice(0, maxLength);
  let result = input.slice(0, maxLength);
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
