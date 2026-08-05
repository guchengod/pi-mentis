/**
 * Artifact Query Service — anchored search strictly within a single Artifact.
 *
 * NEVER searches outside the specified artifact, never falls back to
 * Memory/Knowledge/global search.
 *
 * Small artifacts (<1MB): read all chunks, combine, do lexical search.
 * Large artifacts (>=1MB): chunk-level FTS with context windows.
 *
 * All results pass through secret detection before return.
 */

import type {
  PiEvidenceStore,
  EvidenceReadOptions,
} from "@pi-mentis/pi-mentis-memory-core";
import { detectSecrets, safeSummary } from "@pi-mentis/pi-mentis-memory-core";

export interface ArtifactQueryHit {
  readonly artifactId: string;
  readonly chunkIndex: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly content: string;
  /** Lexical matching only — no embedding-based semantic search on artifacts. */
  readonly match: "exact" | "lexical";
  readonly sanitized: boolean;
}

export interface ArtifactQueryResult {
  readonly found: boolean;
  readonly artifactId: string;
  readonly hits: readonly ArtifactQueryHit[];
  readonly summary?: string;
}

export interface ArtifactQueryContext {
  readonly scopeContext?: EvidenceReadOptions["scopeContext"];
  readonly signal?: AbortSignal;
}

export interface ArtifactQueryService {
  query(
    artifactId: string,
    query: string,
    context: ArtifactQueryContext,
  ): Promise<ArtifactQueryResult>;
}

const SMALL_ARTIFACT_THRESHOLD = 1_048_576; // 1MB
const CONTEXT_BEFORE = 500;
const CONTEXT_AFTER = 1000;
const MAX_HITS = 5;

function evidenceReadOptions(context: ArtifactQueryContext): EvidenceReadOptions {
  const { signal, scopeContext } = context;
  if (signal !== undefined && scopeContext !== undefined) return { signal, scopeContext };
  if (signal !== undefined) return { signal };
  return scopeContext !== undefined ? { scopeContext } : {};
}

function sanitizeContent(text: string): { text: string; sanitized: boolean } {
  const detection = detectSecrets(text);
  if (!detection.sensitive) return { text, sanitized: false };
  return { text: safeSummary(text, text.length), sanitized: true };
}

function extractWindow(
  text: string,
  matchIndex: number,
  matchLength: number,
): string {
  const start = Math.max(0, matchIndex - CONTEXT_BEFORE);
  const end = Math.min(text.length, matchIndex + matchLength + CONTEXT_AFTER);
  return text.slice(start, end);
}

/**
 * Lexical search within a full text string. Supports exact substring
 * and case-insensitive token matching.
 */
function lexicalSearch(
  text: string,
  query: string,
): { index: number; length: number; match: "exact" | "lexical" }[] {
  const results: { index: number; length: number; match: "exact" | "lexical" }[] = [];

  // Exact match (case-insensitive)
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let pos = 0;
  while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
    results.push({ index: pos, length: lowerQuery.length, match: "exact" });
    pos += lowerQuery.length;
  }

  // If no exact match, try token-level lexical
  if (results.length === 0) {
    const tokens = lowerQuery.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length > 0) {
      for (const token of tokens) {
        let tpos = 0;
        while ((tpos = lowerText.indexOf(token, tpos)) !== -1) {
          // Avoid duplicates with exact matches
          if (!results.some((r) => r.index <= tpos && tpos < r.index + r.length)) {
            results.push({ index: tpos, length: token.length, match: "lexical" });
          }
          tpos += token.length;
        }
      }
    }
  }

  return results;
}

export class DefaultArtifactQueryService implements ArtifactQueryService {
  readonly #evidence: PiEvidenceStore;

  constructor(evidence: PiEvidenceStore) {
    this.#evidence = evidence;
  }

  async query(
    artifactId: string,
    query: string,
    context: ArtifactQueryContext,
  ): Promise<ArtifactQueryResult> {
    const opts = evidenceReadOptions(context);
    const artifact = await this.#evidence.getArtifact(artifactId, opts).catch(() => undefined);

    if (artifact === undefined || artifact.state !== "ready") {
      return {
        found: false,
        artifactId,
        hits: [],
        summary: artifact === undefined ? "Artifact not found" : "Artifact not ready",
      };
    }

    if (artifact.expiresAt !== undefined && artifact.expiresAt <= Date.now()) {
      return { found: false, artifactId, hits: [], summary: "Artifact expired" };
    }

    const queryHits: ArtifactQueryHit[] = [];

    if (artifact.byteLength <= SMALL_ARTIFACT_THRESHOLD) {
      // Small artifact: read full content and search
      const content = await this.#evidence.readArtifact(artifactId, opts).catch(() => undefined);
      if (content === undefined) {
        return { found: false, artifactId, hits: [], summary: "Failed to read artifact content" };
      }

      const matches = lexicalSearch(content, query);
      for (const match of matches.slice(0, MAX_HITS)) {
        const windowText = extractWindow(content, match.index, match.length);
        const { text: sanitized, sanitized: wasSanitized } = sanitizeContent(windowText);
        queryHits.push({
          artifactId,
          chunkIndex: 0,
          byteStart: Math.max(0, match.index - CONTEXT_BEFORE),
          byteEnd: Math.min(content.length, match.index + match.length + CONTEXT_AFTER),
          content: sanitized,
          match: match.match,
          sanitized: wasSanitized,
        });
      }
    } else {
      // Large artifact: chunk-level search
      const chunks = [...artifact.chunks].sort((a, b) => a.ordinal - b.ordinal);
      let carry = "";

      for (const chunk of chunks) {
        if (queryHits.length >= MAX_HITS) break;

        const range = await this.#evidence
          .readArtifactRange(artifactId, {
            ...opts,
            offset: chunk.byteOffset,
            length: chunk.byteLength,
          })
          .catch(() => undefined);

        if (range === undefined) continue;

        const combined = carry + range.content;
        if (combined.length === 0) continue;

        const matches = lexicalSearch(combined, query);
        for (const match of matches) {
          if (queryHits.length >= MAX_HITS) break;
          const windowText = extractWindow(combined, match.index, match.length);
          const { text: sanitized, sanitized: wasSanitized } = sanitizeContent(windowText);
          const carryBytes = Buffer.byteLength(carry, "utf8");
          queryHits.push({
            artifactId,
            chunkIndex: chunk.ordinal,
            byteStart: range.offset + Math.max(0, match.index - carryBytes - CONTEXT_BEFORE),
            byteEnd: range.offset + match.index - carryBytes + match.length + CONTEXT_AFTER,
            content: sanitized,
            match: match.match,
            sanitized: wasSanitized,
          });
        }
        // Carry last 1024 chars for cross-chunk matching
        carry = range.content.slice(-1024);
      }
    }

    if (queryHits.length === 0) {
      return {
        found: false,
        artifactId,
        hits: [],
        summary: "No matches found in artifact",
      };
    }

    return {
      found: true,
      artifactId,
      hits: queryHits,
      summary: `Found ${queryHits.length} match(es) in artifact`,
    };
  }
}
