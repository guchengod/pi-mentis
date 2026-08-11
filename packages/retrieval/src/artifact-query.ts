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

import { throwIfAborted } from "@pi-mentis/pi-mentis-core";
import type { PiEvidenceStore, EvidenceReadOptions } from "@pi-mentis/pi-mentis-memory-core";
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
  readonly entityFound: boolean;
  readonly artifactId: string;
  readonly hits: readonly ArtifactQueryHit[];
  readonly summary?: string;
  readonly diagnostics: ArtifactQueryDiagnostics;
}

export interface ArtifactQueryDiagnostics {
  readonly artifactBytes: number;
  readonly chunksScanned: number;
  readonly bytesRead: number;
  readonly returnedBytes: number;
  readonly estimatedReturnedTokens: number;
  readonly durationMs: number;
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
const CONTEXT_BEFORE = 240;
const CONTEXT_AFTER = 1000;
const MAX_HITS = 5;
const MAX_OCCURRENCES_PER_TOKEN_AND_CHUNK = 8;
const MAX_CANDIDATES = 256;

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

function extractWindow(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - CONTEXT_BEFORE);
  const end = Math.min(text.length, matchIndex + matchLength + CONTEXT_AFTER);
  return text.slice(start, end);
}

interface RankedMatch {
  readonly index: number;
  readonly length: number;
  readonly match: "exact" | "lexical";
  readonly score: number;
}

interface RankedArtifactHit extends ArtifactQueryHit {
  readonly score: number;
}

function queryTokens(query: string): readonly string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  return [
    ...new Set(
      [...normalized.matchAll(/[\p{L}\p{N}_-]+/gu)]
        .map((match) => match[0])
        .filter((token) => token !== undefined && token.length >= 2),
    ),
  ].sort((left, right) => right.length - left.length);
}

function tokenWeight(token: string): number {
  return Math.min(96, Math.max(2, [...token].length));
}

/**
 * Produce bounded, relevance-ranked matches for one chunk window. Exact query
 * matches dominate. Lexical fallback rewards distinctive terms and local
 * multi-term coverage instead of accepting the first common token seen.
 */
function rankedLexicalSearch(text: string, query: string): readonly RankedMatch[] {
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = query.normalize("NFKC").toLocaleLowerCase().trim();
  if (lowerQuery === "") return [];

  const exact: RankedMatch[] = [];
  let exactPosition = 0;
  while (
    exact.length < MAX_OCCURRENCES_PER_TOKEN_AND_CHUNK &&
    (exactPosition = lowerText.indexOf(lowerQuery, exactPosition)) !== -1
  ) {
    exact.push({
      index: exactPosition,
      length: lowerQuery.length,
      match: "exact",
      score: 1_000_000 + lowerQuery.length,
    });
    exactPosition += Math.max(1, lowerQuery.length);
  }
  if (exact.length > 0) return exact;

  const tokens = queryTokens(query);
  const candidates: RankedMatch[] = [];
  for (const token of tokens) {
    let position = 0;
    let occurrences = 0;
    while (
      occurrences < MAX_OCCURRENCES_PER_TOKEN_AND_CHUNK &&
      (position = lowerText.indexOf(token, position)) !== -1
    ) {
      const windowStart = Math.max(0, position - CONTEXT_BEFORE);
      const windowEnd = Math.min(lowerText.length, position + token.length + CONTEXT_AFTER);
      const localWindow = lowerText.slice(windowStart, windowEnd);
      const covered = tokens.filter((candidate) => localWindow.includes(candidate));
      const coverageWeight = covered.reduce(
        (total, candidate) => total + tokenWeight(candidate),
        0,
      );
      candidates.push({
        index: position,
        length: token.length,
        match: "lexical",
        score: coverageWeight + (covered.length / Math.max(1, tokens.length)) * 100,
      });
      occurrences += 1;
      position += Math.max(1, token.length);
    }
  }

  return candidates.sort((left, right) => right.score - left.score).slice(0, MAX_HITS * 2);
}

function diagnostics(
  started: number,
  input: {
    artifactBytes?: number;
    chunksScanned?: number;
    bytesRead?: number;
    hits?: readonly ArtifactQueryHit[];
  } = {},
): ArtifactQueryDiagnostics {
  const returnedBytes = (input.hits ?? []).reduce(
    (total, hit) => total + Buffer.byteLength(hit.content, "utf8"),
    0,
  );
  return {
    artifactBytes: input.artifactBytes ?? 0,
    chunksScanned: input.chunksScanned ?? 0,
    bytesRead: input.bytesRead ?? 0,
    returnedBytes,
    estimatedReturnedTokens: Math.ceil(returnedBytes / 4),
    durationMs: performance.now() - started,
  };
}

export interface ArtifactQueryServices {
  getEvidence(): PiEvidenceStore | undefined;
}

export class DefaultArtifactQueryService implements ArtifactQueryService {
  readonly #services: ArtifactQueryServices;

  constructor(services: ArtifactQueryServices) {
    this.#services = services;
  }

  async query(
    artifactId: string,
    query: string,
    context: ArtifactQueryContext,
  ): Promise<ArtifactQueryResult> {
    const started = performance.now();
    const evidence = this.#services.getEvidence();
    if (evidence === undefined) {
      return {
        found: false,
        entityFound: false,
        artifactId,
        hits: [],
        summary: "Evidence store unavailable",
        diagnostics: diagnostics(started),
      };
    }
    const opts = evidenceReadOptions(context);
    const artifact = await evidence.getArtifact(artifactId, opts).catch(() => undefined);
    throwIfAborted(context.signal, "artifact-query");

    if (artifact === undefined || artifact.state !== "ready") {
      return {
        found: false,
        entityFound: artifact !== undefined,
        artifactId,
        hits: [],
        summary: artifact === undefined ? "Artifact not found" : "Artifact not ready",
        diagnostics: diagnostics(
          started,
          artifact === undefined ? {} : { artifactBytes: artifact.byteLength },
        ),
      };
    }

    if (artifact.expiresAt !== undefined && artifact.expiresAt <= Date.now()) {
      return {
        found: false,
        entityFound: true,
        artifactId,
        hits: [],
        summary: "Artifact expired",
        diagnostics: diagnostics(started, { artifactBytes: artifact.byteLength }),
      };
    }

    const rankedHits: RankedArtifactHit[] = [];
    let chunksScanned = 0;
    let bytesRead = 0;

    if (artifact.byteLength <= SMALL_ARTIFACT_THRESHOLD) {
      // Small artifact: read full content and search
      const content = await evidence.readArtifact(artifactId, opts).catch(() => undefined);
      if (content === undefined) {
        return {
          found: false,
          entityFound: true,
          artifactId,
          hits: [],
          summary: "Failed to read artifact content",
          diagnostics: diagnostics(started, { artifactBytes: artifact.byteLength }),
        };
      }

      chunksScanned = Math.max(1, artifact.chunks.length);
      bytesRead = Buffer.byteLength(content, "utf8");
      const matches = rankedLexicalSearch(content, query);
      for (const match of matches) {
        const windowStart = Math.max(0, match.index - CONTEXT_BEFORE);
        const windowEnd = Math.min(content.length, match.index + match.length + CONTEXT_AFTER);
        const windowText = extractWindow(content, match.index, match.length);
        const { text: sanitized, sanitized: wasSanitized } = sanitizeContent(windowText);
        rankedHits.push({
          artifactId,
          chunkIndex: 0,
          byteStart: Buffer.byteLength(content.slice(0, windowStart), "utf8"),
          byteEnd: Buffer.byteLength(content.slice(0, windowEnd), "utf8"),
          content: sanitized,
          match: match.match,
          sanitized: wasSanitized,
          score: match.score,
        });
      }
    } else {
      // Large artifact: scan only this artifact's child chunks and rank across
      // the complete artifact. Do not stop after early, low-specificity hits.
      const chunks = [...artifact.chunks].sort((a, b) => a.ordinal - b.ordinal);
      let carry = "";

      for (const chunk of chunks) {
        throwIfAborted(context.signal, "artifact-query");
        chunksScanned += 1;
        const range = await evidence
          .readArtifactRange(artifactId, {
            ...opts,
            offset: chunk.byteOffset,
            length: chunk.byteLength,
          })
          .catch(() => undefined);
        throwIfAborted(context.signal, "artifact-query");

        if (range === undefined) continue;
        bytesRead += Buffer.byteLength(range.content, "utf8");

        const combined = carry + range.content;
        if (combined.length === 0) continue;

        const matches = rankedLexicalSearch(combined, query);
        for (const match of matches) {
          const windowStart = Math.max(0, match.index - CONTEXT_BEFORE);
          const windowEnd = Math.min(combined.length, match.index + match.length + CONTEXT_AFTER);
          const windowText = extractWindow(combined, match.index, match.length);
          const { text: sanitized, sanitized: wasSanitized } = sanitizeContent(windowText);
          const carryBytes = Buffer.byteLength(carry, "utf8");
          const combinedBase = range.offset - carryBytes;
          rankedHits.push({
            artifactId,
            chunkIndex: chunk.ordinal,
            byteStart: Math.max(
              0,
              combinedBase + Buffer.byteLength(combined.slice(0, windowStart), "utf8"),
            ),
            byteEnd: Math.min(
              artifact.byteLength,
              combinedBase + Buffer.byteLength(combined.slice(0, windowEnd), "utf8"),
            ),
            content: sanitized,
            match: match.match,
            sanitized: wasSanitized,
            score: match.score,
          });
        }
        if (rankedHits.length > MAX_CANDIDATES) {
          rankedHits.sort((left, right) => right.score - left.score);
          rankedHits.length = MAX_CANDIDATES;
        }
        // Carry last 1024 chars for cross-chunk matching
        carry = range.content.slice(-1024);
      }
    }

    const seenRanges = new Set<string>();
    const queryHits: ArtifactQueryHit[] = rankedHits
      .sort((left, right) => right.score - left.score || left.byteStart - right.byteStart)
      .filter((hit) => {
        const key = `${hit.byteStart}:${hit.byteEnd}`;
        if (seenRanges.has(key)) return false;
        seenRanges.add(key);
        return true;
      })
      .slice(0, MAX_HITS)
      .map((hit) => ({
        artifactId: hit.artifactId,
        chunkIndex: hit.chunkIndex,
        byteStart: hit.byteStart,
        byteEnd: hit.byteEnd,
        content: hit.content,
        match: hit.match,
        sanitized: hit.sanitized,
      }));

    if (queryHits.length === 0) {
      return {
        found: false,
        entityFound: true,
        artifactId,
        hits: [],
        summary: "No matches found in artifact",
        diagnostics: diagnostics(started, {
          artifactBytes: artifact.byteLength,
          chunksScanned,
          bytesRead,
        }),
      };
    }

    return {
      found: true,
      entityFound: true,
      artifactId,
      hits: queryHits,
      summary: `Found ${queryHits.length} match(es) in artifact`,
      diagnostics: diagnostics(started, {
        artifactBytes: artifact.byteLength,
        chunksScanned,
        bytesRead,
        hits: queryHits,
      }),
    };
  }
}
