/**
 * Public Projection — safe projection of internal Memory/Artifact records
 * for public use paths (search_memory, recall, context injection, tool results).
 *
 * Separates internal MemoryRecord from what external callers can see.
 * Secrets are never returned in plaintext through public paths.
 */

import type {
  MemoryRecord,
  ArtifactRecord,
  ArtifactQueryHit,
  RelevanceScope,
  Sensitivity,
} from "./types.js";

// ─── Public result types ──────────────────────────────────────────

export interface PublicMemoryResult {
  readonly id: string;
  readonly content: string;
  readonly sensitivity: Sensitivity;
  readonly sanitized: boolean;
  readonly memoryType: string | undefined;
  readonly predicate: string | undefined;
  readonly temporalState: string | undefined;
  readonly crossScope: boolean;
  readonly sourceScopeKind: RelevanceScope["kind"] | undefined;
  readonly sourceScopeLabel: string | undefined;
  readonly secretMetadata: SecretMetadata | undefined;
}

export interface SecretMetadata {
  readonly category: string | undefined;
  readonly service: string | undefined;
  readonly label: string | undefined;
  readonly safeFingerprint: string | undefined;
}

export interface PublicArtifactResult {
  readonly found: boolean;
  readonly resourceType: "artifact" | "unknown";
  readonly anchored: true;

  readonly artifactId?: string;
  readonly status?: string;

  readonly captureIntegrity?: ArtifactRecord["captureIntegrity"];

  readonly crossScope?: boolean;
  readonly sourceScopeKind?: RelevanceScope["kind"];
  readonly sourceScopeLabel?: string;

  readonly hits?: readonly ArtifactQueryHit[];
  readonly reason?: "not_found" | "not_ready" | "expired";
}

export interface ProjectionContext {
  readonly currentUserId: string;
  readonly currentTenant?: string;
  readonly crossScope: boolean;
  readonly sourceScopeKind?: RelevanceScope["kind"];
  readonly sourceScopeLabel?: string;
}

// ─── Secret metadata extraction ────────────────────────────────────

function extractSecretMetadata(
  record: Omit<MemoryRecord, "embedding">,
): PublicMemoryResult["secretMetadata"] | undefined {
  if (record.sensitivity !== "secret") return undefined;

  let category: string | undefined;
  if (record.factKey?.includes("api_key") || record.content.includes("API")) {
    category = "api_key";
  } else if (record.content.includes("token") || record.content.includes("Token")) {
    category = "access_token";
  } else if (record.content.includes("password") || record.content.includes("密码")) {
    category = "password";
  } else if (record.content.includes("private key") || record.content.includes("BEGIN")) {
    category = "private_key";
  }

  let service: string | undefined;
  if (record.content.includes("GitHub") || record.content.includes("github")) {
    service = "github";
  } else if (record.content.includes("OpenAI") || record.content.includes("openai")) {
    service = "openai";
  }

  const safeFingerprint = record.contentHash.slice(0, 8);

  let label: string | undefined;
  if (
    record.content.length <= 80 &&
    !record.content.includes("sk-") &&
    !record.content.includes("ghp_")
  ) {
    label = record.content.slice(0, 60);
  }

  const hasAny = category !== undefined || service !== undefined || label !== undefined;
  if (!hasAny) return undefined;

  return { category, service, label, safeFingerprint };
}

// ─── Safe scope label generation ────────────────────────────────────

function safeScopeLabel(
  relevance: RelevanceScope | undefined,
  context: ProjectionContext,
): string | undefined {
  if (context.sourceScopeLabel !== undefined) return context.sourceScopeLabel;
  if (relevance === undefined) return undefined;
  if (relevance.kind === "global") return undefined;
  if (relevance.kind === "repository") return relevance.repositoryId.split(":").pop()?.slice(0, 40);
  if (relevance.kind === "project") return relevance.projectId.split(":").pop()?.slice(0, 40);
  if (relevance.kind === "topic") return relevance.topicId.slice(0, 40);
  return undefined;
}

// ─── Main projection function ──────────────────────────────────────

export function projectMemoryForPublicUse(
  record: Omit<MemoryRecord, "embedding">,
  context: ProjectionContext,
): PublicMemoryResult {
  const predicate = record.factKey?.split("/").pop();
  const scopeLabel = safeScopeLabel(record.relevance, context);

  // Secret: never expose original content in public projection
  if (record.sensitivity === "secret") {
    const secretMeta = extractSecretMetadata(record);
    return {
      id: record.id,
      content: `已保存一个${secretMeta?.service ? ` ${secretMeta?.service}` : ""}${secretMeta?.category ? ` ${describeCategory(secretMeta.category)}` : "凭据"}。`,
      sensitivity: "secret",
      sanitized: true,
      memoryType: record.type,
      predicate,
      temporalState: record.temporalState,
      crossScope: context.crossScope,
      sourceScopeKind: context.sourceScopeKind,
      sourceScopeLabel: scopeLabel,
      secretMetadata: secretMeta,
    };
  }

  // Sensitive: redact high-confidence secrets in content
  let content = record.content;
  let sanitized = false;
  if (record.sensitivity === "sensitive") {
    content = redactSensitiveContent(content);
    sanitized = true;
  }

  return {
    id: record.id,
    content: content.length > 500 ? content.slice(0, 497) + "..." : content,
    sensitivity: record.sensitivity ?? "public",
    sanitized,
    memoryType: record.type,
    predicate,
    temporalState: record.temporalState,
    crossScope: context.crossScope,
    sourceScopeKind: context.sourceScopeKind,
    sourceScopeLabel: scopeLabel,
    secretMetadata: undefined,
  };
}

export function projectArtifactForPublicUse(
  artifact: ArtifactRecord,
  context: ProjectionContext,
  additional: {
    hits?: readonly ArtifactQueryHit[];
    reason?: "not_found" | "not_ready" | "expired";
  } = {},
): PublicArtifactResult {
  const scopeLabel = safeScopeLabel(artifact.relevance, context);

  return {
    found: true,
    resourceType: "artifact",
    anchored: true,
    artifactId: artifact.id,
    status: artifact.state,
    ...(artifact.captureIntegrity === undefined
      ? {}
      : { captureIntegrity: artifact.captureIntegrity }),
    ...(context.crossScope ? { crossScope: true } : {}),
    ...(context.sourceScopeKind === undefined ? {} : { sourceScopeKind: context.sourceScopeKind }),
    ...(scopeLabel === undefined ? {} : { sourceScopeLabel: scopeLabel }),
    ...(additional.hits === undefined ? {} : { hits: additional.hits }),
    ...(additional.reason === undefined ? {} : { reason: additional.reason }),
  };
}

export function notFoundArtifactResult(): PublicArtifactResult {
  return {
    found: false,
    resourceType: "unknown",
    anchored: true,
    reason: "not_found",
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function describeCategory(category: string): string {
  switch (category) {
    case "api_key":
      return "API 密钥";
    case "access_token":
      return "访问令牌";
    case "password":
      return "密码";
    case "private_key":
      return "私钥";
    default:
      return category;
  }
}

function redactSensitiveContent(content: string): string {
  return content
    .replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, "sk-****")
    .replace(/\bghp_[a-zA-Z0-9]{20,}\b/g, "ghp_****")
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, "AKIA****")
    .replace(/\bBearer\s+[a-zA-Z0-9._\-+=/]{10,}\b/gi, "Bearer ****")
    .replace(/(?:password|passwd|密码)\s*[:=]\s*\S+/gi, "$1: ****");
}

/**
 * Check if a record should be excluded from automatic recall.
 * Secret records are never included. Sensitive records may be included
 * with redacted content.
 */
export function shouldExcludeFromAutomaticRecall(record: Omit<MemoryRecord, "embedding">): boolean {
  return record.sensitivity === "secret";
}

/**
 * Sanitize a value for logs/trace — redacts sensitive patterns.
 */
export function sanitizeForLog(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return redactSensitiveContent(value);
}
