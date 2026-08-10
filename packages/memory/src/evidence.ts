import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  contentHash,
  stableHash,
  systemClock,
  throwIfAborted,
  type Clock,
  type EvidenceRef,
  type OperationOptions,
} from "@pi-mentis/pi-mentis-core";
import { decodeStoredPayload, type StoredRecord, ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import type {
  ArtifactReadOptions,
  ArtifactRecord,
  ArtifactRange,
  EvidenceReadOptions,
  EvidenceSearchMatch,
  PiEpisode,
  PiEvent,
  PiEvidenceStore,
  MentisSecurityMode,
  ResourceOwnership,
  RelevanceScope,
  ResourceAccessIntent,
  ArtifactQueryHit,
} from "./types.js";

const ARTIFACT_CHUNK_BYTES = 1024 * 1024;

function securityNamespace(options: EvidenceReadOptions): string | undefined {
  const scope = options.scopeContext;
  return scope === undefined
    ? undefined
    : [scope.tenantId, scope.userId, scope.appId, scope.agentId].map(encodeURIComponent).join(":");
}

function quoteFilter(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function scalarRecord(
  collectionKind: string,
  namespace: string,
  status: string,
  value: PiEpisode | PiEvent | ArtifactRecord,
): StoredRecord {
  const createdAt =
    "createdAt" in value
      ? value.createdAt
      : "startedAt" in value
        ? value.startedAt
        : value.timestamp;
  const updatedAt =
    "updatedAt" in value
      ? value.updatedAt
      : "endedAt" in value
        ? (value.endedAt ?? createdAt)
        : createdAt;
  return {
    id: value.id,
    kind: collectionKind,
    namespace,
    status,
    payload: value as unknown as Readonly<Record<string, unknown>>,
    createdAt,
    updatedAt,
  };
}

function isWithin(root: string, target: string): boolean {
  const relative = nodePath.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relative)
  );
}

// ─── Artifact Access Control ──────────────────────────────────────

export function authorizeArtifactAccess(params: {
  artifact: { ownership?: ResourceOwnership; relevance?: RelevanceScope };
  currentOwnership: ResourceOwnership;
  contextScope: { repositoryId?: string; projectId?: string; taskId?: string } | undefined;
  accessIntent: ResourceAccessIntent;
  securityMode: MentisSecurityMode;
  teamPolicy:
    | {
        canReadResource?(input: {
          actor: ResourceOwnership;
          resource: ResourceOwnership;
          relevance: RelevanceScope;
          accessIntent: ResourceAccessIntent;
        }): boolean;
      }
    | undefined;
}): { allowed: boolean; crossScope: boolean; deniedReason: string | undefined } {
  const { artifact, currentOwnership, accessIntent, securityMode, teamPolicy, contextScope } =
    params;
  const recordOwner = artifact.ownership ?? {
    tenantId: undefined,
    userId: "local",
    appId: undefined,
    agentId: undefined,
  };

  // Different user: always deny
  if (currentOwnership.userId !== recordOwner.userId) {
    return { allowed: false, crossScope: false, deniedReason: "different_owner" };
  }
  // Different tenant
  if ((currentOwnership.tenantId ?? "local") !== (recordOwner.tenantId ?? "local")) {
    return { allowed: false, crossScope: false, deniedReason: "different_tenant" };
  }

  // Cross-scope check
  const relevance = artifact.relevance;
  const isCrossScope = computeCrossScope(relevance, contextScope);

  // Multi-tenant: strict
  if (securityMode === "multi_tenant") {
    if (isCrossScope) return { allowed: false, crossScope: true, deniedReason: "not_found" };
    return { allowed: true, crossScope: false, deniedReason: undefined };
  }

  // Personal: explicit ID allows cross-project
  if (securityMode === "personal" || securityMode === undefined) {
    if (accessIntent === "automatic_recall" && isCrossScope) {
      return { allowed: false, crossScope: true, deniedReason: "not_found" };
    }
    if (accessIntent === "explicit_id") {
      return { allowed: true, crossScope: isCrossScope, deniedReason: undefined };
    }
    return { allowed: true, crossScope: isCrossScope, deniedReason: undefined };
  }

  // Team: default fail closed unless policy says otherwise
  if (securityMode === "team") {
    if (!isCrossScope) return { allowed: true, crossScope: false, deniedReason: undefined };
    if (accessIntent === "explicit_id" && teamPolicy?.canReadResource) {
      const ok = teamPolicy.canReadResource({
        actor: currentOwnership,
        resource: recordOwner,
        relevance: relevance ?? { kind: "global" },
        accessIntent,
      });
      return { allowed: ok, crossScope: true, deniedReason: ok ? undefined : "team_denied" };
    }
    return { allowed: false, crossScope: true, deniedReason: "team_denied" };
  }

  return { allowed: false, crossScope: false, deniedReason: "not_found" };
}

function computeCrossScope(
  relevance: RelevanceScope | undefined,
  scopeContext?: { repositoryId?: string; projectId?: string; taskId?: string },
): boolean {
  if (relevance === undefined) return false;
  if (relevance.kind === "global") return false;
  if (relevance.kind === "repository" && scopeContext?.repositoryId !== undefined) {
    return relevance.repositoryId !== scopeContext.repositoryId;
  }
  if (relevance.kind === "project" && scopeContext?.projectId !== undefined) {
    return relevance.projectId !== scopeContext.projectId;
  }
  if (relevance.kind === "task" && scopeContext?.taskId !== undefined) {
    return relevance.taskId !== scopeContext.taskId;
  }
  return true;
}

export function resolveLegacyOwner(
  record: {
    ownership?: ResourceOwnership;
    scopeContext?: { tenantId?: string; userId?: string; appId?: string; agentId?: string };
  },
  fallbackUserId?: string,
): { ownership: ResourceOwnership; source: "ownership" | "legacy_scope" | "missing" } {
  if (record.ownership?.userId !== undefined && record.ownership.userId !== "local") {
    return { ownership: record.ownership, source: "ownership" };
  }
  if (record.scopeContext?.userId !== undefined) {
    return {
      ownership: {
        tenantId: record.scopeContext.tenantId,
        userId: record.scopeContext.userId,
        appId: record.scopeContext.appId,
        agentId: record.scopeContext.agentId,
      },
      source: "legacy_scope",
    };
  }
  return {
    ownership: {
      tenantId: undefined,
      userId: fallbackUserId ?? "local",
      appId: undefined,
      agentId: undefined,
    },
    source: "missing",
  };
}

// ─── Evidence Store ────────────────────────────────────────────────

export class DefaultPiEvidenceStore implements PiEvidenceStore {
  readonly #store: ZvecStore;
  readonly #clock: Clock;

  constructor(store: ZvecStore, clock: Clock = systemClock) {
    this.#store = store;
    this.#clock = clock;
  }

  async createEpisode(episode: PiEpisode, options: OperationOptions = {}): Promise<void> {
    throwIfAborted(options.signal, "episode-create");
    await this.#store.upsertScalar("episodes_v1", [
      scalarRecord("episode", episode.securityNamespace, episode.status, episode),
    ]);
  }

  async updateEpisode(episode: PiEpisode, options: OperationOptions = {}): Promise<void> {
    return this.createEpisode(episode, options);
  }

  async appendEvent(event: PiEvent, options: OperationOptions = {}): Promise<void> {
    throwIfAborted(options.signal, "event-append");
    await this.#store.upsertScalar("events_v1", [
      scalarRecord("event", event.securityNamespace, event.kind, event),
    ]);
  }

  async writeArtifact(
    input: Omit<
      ArtifactRecord,
      | "id"
      | "contentHash"
      | "relativePath"
      | "byteLength"
      | "state"
      | "chunks"
      | "failure"
      | "createdAt"
      | "updatedAt"
      | "securityNamespace"
    > & {
      readonly content: string;
      readonly ownership?: ResourceOwnership;
      readonly relevance?: RelevanceScope;
      readonly sourceSessionId?: string;
      readonly sourceToolName?: string;
    },
    options: OperationOptions = {},
  ): Promise<ArtifactRecord> {
    throwIfAborted(options.signal, "artifact-write");
    const episode = await this.getEpisode(input.episodeId, options);
    if (episode === undefined)
      throw new Error(`Artifact episode ${input.episodeId} does not exist`);
    const hash = contentHash(input.content);
    const id = stableHash(
      "artifact:v1",
      episode.securityNamespace,
      input.episodeId,
      input.toolCallId ?? "",
      hash,
    );
    const existing = await this.getArtifact(id, options);
    if (existing?.state === "ready" && existing.securityNamespace === episode.securityNamespace) {
      return existing;
    }
    const directory = nodePath.join("artifacts", id.slice(0, 2), id);
    const relativePath = nodePath.join(directory, "manifest.json");
    const targetDirectory = nodePath.join(this.#store.rootDir, directory);
    if (!isWithin(this.#store.rootDir, targetDirectory)) {
      throw new Error("Artifact path escaped storage root");
    }
    const now = this.#clock.now();
    const base: ArtifactRecord = {
      id,
      episodeId: input.episodeId,
      securityNamespace: episode.securityNamespace,
      ownership: input.ownership ?? {
        tenantId: undefined,
        userId: "local",
        appId: undefined,
        agentId: undefined,
      },
      ...(input.relevance === undefined ? {} : { relevance: input.relevance }),
      ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
      ...(input.sourceToolName === undefined ? {} : { sourceToolName: input.sourceToolName }),
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      mediaType: input.mediaType,
      byteLength: Buffer.byteLength(input.content, "utf8"),
      contentHash: hash,
      relativePath,
      state: "pending",
      chunks: [],
      ...(input.captureIntegrity === undefined ? {} : { captureIntegrity: input.captureIntegrity }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#persistArtifact(base);
    const persisting = { ...base, state: "persisting" as const, updatedAt: this.#clock.now() };
    await this.#persistArtifact(persisting);
    try {
      await mkdir(nodePath.join(targetDirectory, "chunks"), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(input.content, "utf8");
      const chunks = [];
      for (let offset = 0, ordinal = 0; offset < bytes.length; ordinal++) {
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + ARTIFACT_CHUNK_BYTES));
        const chunkRelativePath = nodePath.join(
          directory,
          "chunks",
          `${String(ordinal).padStart(6, "0")}.bin`,
        );
        const chunkTarget = nodePath.join(this.#store.rootDir, chunkRelativePath);
        const temporary = `${chunkTarget}.${process.pid}.tmp`;
        await writeFile(temporary, chunk, { mode: 0o600 });
        await rename(temporary, chunkTarget);
        chunks.push({
          ordinal,
          relativePath: chunkRelativePath,
          byteOffset: offset,
          byteLength: chunk.length,
          contentHash: contentHash(chunk),
        });
        offset += chunk.length;
      }
      const ready: ArtifactRecord = {
        ...persisting,
        state: "ready",
        chunks,
        updatedAt: this.#clock.now(),
      };
      const manifestTarget = nodePath.join(this.#store.rootDir, relativePath);
      const temporaryManifest = `${manifestTarget}.${process.pid}.tmp`;
      await writeFile(temporaryManifest, JSON.stringify(ready), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryManifest, manifestTarget);
      await this.#persistArtifact(ready);
      return ready;
    } catch (error: unknown) {
      await this.#persistArtifact({
        ...persisting,
        state: "failed",
        failure: error instanceof Error ? error.message : String(error),
        updatedAt: this.#clock.now(),
      });
      throw error;
    }
  }

  async getEpisode(id: string, options: EvidenceReadOptions = {}): Promise<PiEpisode | undefined> {
    throwIfAborted(options.signal, "episode-get");
    const episode = (await this.#store.fetchScalar("episodes_v1", [id])).get(id) as
      PiEpisode | undefined;
    const expected = securityNamespace(options);
    return expected === undefined || episode?.securityNamespace === expected ? episode : undefined;
  }

  async getEvent(id: string, options: EvidenceReadOptions = {}): Promise<PiEvent | undefined> {
    throwIfAborted(options.signal, "event-get");
    const event = (await this.#store.fetchScalar("events_v1", [id])).get(id) as PiEvent | undefined;
    const expected = securityNamespace(options);
    return expected === undefined || event?.securityNamespace === expected ? event : undefined;
  }

  async getArtifact(
    id: string,
    options: EvidenceReadOptions = {},
  ): Promise<ArtifactRecord | undefined> {
    throwIfAborted(options.signal, "artifact-get");
    const payload = (await this.#store.fetchScalar("artifacts_v1", [id])).get(id) as
      ArtifactRecord | undefined;
    const expected = securityNamespace(options);
    if (expected !== undefined && payload?.securityNamespace !== expected) return undefined;
    if (payload === undefined || payload.state !== undefined) return payload;
    return { ...payload, state: "ready", chunks: [], updatedAt: payload.createdAt };
  }

  async getArtifactWithAccess(
    id: string,
    params: {
      currentOwnership: ResourceOwnership;
      contextScope?: { repositoryId?: string; projectId?: string; taskId?: string };
      accessIntent: ResourceAccessIntent;
      securityMode: MentisSecurityMode;
      teamPolicy:
        | {
            canReadResource?(input: {
              actor: ResourceOwnership;
              resource: ResourceOwnership;
              relevance: RelevanceScope;
              accessIntent: ResourceAccessIntent;
            }): boolean;
          }
        | undefined;
    },
    options: ArtifactReadOptions = {},
  ): Promise<{
    artifact: ArtifactRecord | undefined;
    crossScope: boolean;
    deniedReason: string | undefined;
  }> {
    throwIfAborted(options.signal, "artifact-access");
    const artifact = await this.getArtifact(id, options);

    if (artifact === undefined)
      return { artifact: undefined, crossScope: false, deniedReason: "not_found" };
    if (artifact.state !== "ready")
      return { artifact: undefined, crossScope: false, deniedReason: "not_found" };

    const result = authorizeArtifactAccess({
      artifact,
      currentOwnership: params.currentOwnership,
      contextScope: params.contextScope,
      accessIntent: params.accessIntent,
      securityMode: params.securityMode,
      teamPolicy: params.teamPolicy,
    });

    if (!result.allowed) {
      return {
        artifact: undefined,
        crossScope: result.crossScope,
        deniedReason: result.deniedReason,
      };
    }

    return { artifact, crossScope: result.crossScope, deniedReason: undefined };
  }

  async searchArtifactContent(
    id: string,
    query: string,
    params: {
      currentOwnership: ResourceOwnership;
      contextScope?: { repositoryId?: string; projectId?: string; taskId?: string };
      accessIntent: ResourceAccessIntent;
      securityMode: MentisSecurityMode;
    },
    options: ArtifactReadOptions = {},
  ): Promise<{
    hits: readonly ArtifactQueryHit[];
    crossScope: boolean;
    deniedReason: string | undefined;
  }> {
    const access = await this.getArtifactWithAccess(
      id,
      { ...params, teamPolicy: undefined },
      options,
    );
    if (access.artifact === undefined) {
      return { hits: [], crossScope: false, deniedReason: access.deniedReason };
    }
    const artifact = access.artifact;
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    if (terms.length === 0)
      return { hits: [], crossScope: access.crossScope, deniedReason: undefined };

    const hits: ArtifactQueryHit[] = [];
    let carry = "";

    const inspectChunk = (bytes: Buffer, chunkIndex: number, pieceOffset: number): void => {
      const text = carry + bytes.toString("utf8");
      const lower = text.toLocaleLowerCase();
      if (terms.every((term) => lower.includes(term))) {
        const positions = terms.map((t) => lower.indexOf(t)).filter((o) => o >= 0);
        const position = Math.min(...positions);
        const start = Math.max(0, position - 240);
        const end = Math.min(text.length, position + 760);
        hits.push({
          resourceType: "artifact",
          artifactId: id,
          chunkIndex,
          byteStart: Math.max(
            0,
            pieceOffset -
              Buffer.byteLength(carry, "utf8") +
              Buffer.byteLength(text.slice(0, start), "utf8"),
          ),
          byteEnd: Math.max(
            0,
            pieceOffset -
              Buffer.byteLength(carry, "utf8") +
              Buffer.byteLength(text.slice(0, end), "utf8"),
          ),
          match: "lexical",
          content: text.slice(start, end),
        });
      }
      carry = text.slice(-2048);
    };

    if (artifact.chunks.length === 0) {
      const target = nodePath.join(this.#store.rootDir, artifact.relativePath);
      if (!isWithin(this.#store.rootDir, target))
        return { hits: [], crossScope: access.crossScope, deniedReason: undefined };
      const bytes = await readFile(target);
      if (bytes.length !== artifact.byteLength || contentHash(bytes) !== artifact.contentHash) {
        throw new Error(`Artifact ${id} failed full-content integrity validation`);
      }
      inspectChunk(bytes, 0, 0);
    } else {
      const ordered = [...artifact.chunks].sort((left, right) => left.ordinal - right.ordinal);
      for (const chunk of ordered) {
        const target = nodePath.join(this.#store.rootDir, chunk.relativePath);
        if (!isWithin(this.#store.rootDir, target)) continue;
        const bytes = await readFile(target);
        if (bytes.length !== chunk.byteLength || contentHash(bytes) !== chunk.contentHash) {
          throw new Error(`Artifact ${id} chunk ${chunk.ordinal} failed integrity validation`);
        }
        inspectChunk(bytes, chunk.ordinal, chunk.byteOffset);
        if (hits.length >= 8) break;
      }
    }
    return { hits, crossScope: access.crossScope, deniedReason: undefined };
  }

  async readArtifact(id: string, options: ArtifactReadOptions = {}): Promise<string | undefined> {
    return (await this.readArtifactRange(id, options))?.content;
  }

  async readArtifactRange(
    id: string,
    options: ArtifactReadOptions = {},
  ): Promise<ArtifactRange | undefined> {
    throwIfAborted(options.signal, "artifact-read");
    const artifact = await this.getArtifact(id, options);
    if (artifact === undefined || artifact.state !== "ready") return undefined;
    if (artifact.expiresAt !== undefined && artifact.expiresAt <= this.#clock.now())
      return undefined;
    const requestedOffset = Math.min(artifact.byteLength, Math.max(0, options.offset ?? 0));
    const requestedLength =
      options.length === undefined
        ? artifact.byteLength - requestedOffset
        : Math.max(0, options.length);
    const ranged =
      options.offset === undefined && options.length === undefined
        ? await this.#readArtifactBytes(artifact, options)
        : await this.#readArtifactRangeBytes(artifact, requestedOffset, requestedLength, options);
    if (ranged === undefined) return undefined;
    const complete = Buffer.isBuffer(ranged) ? ranged : ranged.bytes;
    const baseOffset = Buffer.isBuffer(ranged) ? 0 : ranged.baseOffset;
    let offset = 0;
    while (
      offset < complete.length &&
      complete[offset] !== undefined &&
      ((complete[offset] as number) & 0xc0) === 0x80
    )
      offset++;
    let end =
      options.length === undefined ? complete.length : Math.min(complete.length, requestedLength);
    while (
      end > offset &&
      end < complete.length &&
      complete[end] !== undefined &&
      ((complete[end] as number) & 0xc0) === 0x80
    )
      end--;
    return {
      content: complete.subarray(offset, end).toString("utf8"),
      offset: baseOffset + offset,
      nextOffset: baseOffset + end,
      byteLength: end - offset,
      eof: baseOffset + end >= artifact.byteLength,
    };
  }

  async #readArtifactRangeBytes(
    artifact: ArtifactRecord,
    offset: number,
    length: number,
    options: OperationOptions,
  ): Promise<{ bytes: Buffer; baseOffset: number } | undefined> {
    const end = Math.min(artifact.byteLength, offset + length);
    if (offset >= end) return { bytes: Buffer.alloc(0), baseOffset: offset };
    if (artifact.chunks.length === 0) {
      const legacy = nodePath.join(this.#store.rootDir, artifact.relativePath);
      if (!isWithin(this.#store.rootDir, legacy)) return undefined;
      const complete = await readFile(legacy);
      if (
        complete.length !== artifact.byteLength ||
        contentHash(complete) !== artifact.contentHash
      ) {
        throw new Error(`Artifact ${artifact.id} failed full-content integrity validation`);
      }
      return { bytes: complete.subarray(offset, end), baseOffset: offset };
    }
    const ordered = [...artifact.chunks].sort((left, right) => left.ordinal - right.ordinal);
    let expectedOffset = 0;
    const buffers: Buffer[] = [];
    for (const [expectedOrdinal, chunk] of ordered.entries()) {
      if (chunk.ordinal !== expectedOrdinal || chunk.byteOffset !== expectedOffset) {
        throw new Error(`Artifact ${artifact.id} chunk manifest is not contiguous`);
      }
      expectedOffset += chunk.byteLength;
      const chunkEnd = chunk.byteOffset + chunk.byteLength;
      if (chunkEnd <= offset || chunk.byteOffset >= end) continue;
      throwIfAborted(options.signal, "artifact-range-read");
      const target = nodePath.join(this.#store.rootDir, chunk.relativePath);
      if (!isWithin(this.#store.rootDir, target)) return undefined;
      const bytes = await readFile(target);
      if (bytes.length !== chunk.byteLength || contentHash(bytes) !== chunk.contentHash) {
        throw new Error(
          `Artifact ${artifact.id} chunk ${chunk.ordinal} failed integrity validation`,
        );
      }
      const startInChunk = Math.max(0, offset - chunk.byteOffset);
      const endInChunk = Math.min(bytes.length, end - chunk.byteOffset);
      buffers.push(bytes.subarray(startInChunk, endInChunk));
    }
    if (expectedOffset !== artifact.byteLength) {
      throw new Error(`Artifact ${artifact.id} chunk manifest length is invalid`);
    }
    return { bytes: Buffer.concat(buffers), baseOffset: offset };
  }

  async #readArtifactBytes(
    artifact: ArtifactRecord,
    options: OperationOptions,
  ): Promise<Buffer | undefined> {
    const buffers: Buffer[] = [];
    if (artifact.byteLength === 0) {
      buffers.push(Buffer.alloc(0));
    } else if (artifact.chunks.length === 0) {
      const legacy = nodePath.join(this.#store.rootDir, artifact.relativePath);
      if (!isWithin(this.#store.rootDir, legacy)) return undefined;
      buffers.push(await readFile(legacy));
    } else {
      let expectedOffset = 0;
      const ordered = [...artifact.chunks].sort((left, right) => left.ordinal - right.ordinal);
      for (const [expectedOrdinal, chunk] of ordered.entries()) {
        throwIfAborted(options.signal, "artifact-read");
        if (chunk.ordinal !== expectedOrdinal || chunk.byteOffset !== expectedOffset) {
          throw new Error(`Artifact ${artifact.id} chunk manifest is not contiguous`);
        }
        const target = nodePath.join(this.#store.rootDir, chunk.relativePath);
        if (!isWithin(this.#store.rootDir, target)) return undefined;
        const bytes = await readFile(target);
        if (bytes.length !== chunk.byteLength || contentHash(bytes) !== chunk.contentHash) {
          throw new Error(
            `Artifact ${artifact.id} chunk ${chunk.ordinal} failed integrity validation`,
          );
        }
        buffers.push(bytes);
        expectedOffset += bytes.length;
      }
    }
    const complete = Buffer.concat(buffers);
    if (complete.length !== artifact.byteLength || contentHash(complete) !== artifact.contentHash) {
      throw new Error(`Artifact ${artifact.id} failed full-content integrity validation`);
    }
    return complete;
  }

  async recoverArtifacts(options: OperationOptions = {}) {
    const documents = await this.#store.filterScalar(
      "artifacts_v1",
      'kind = "artifact" AND (status = "pending" OR status = "persisting")',
      10_000,
    );
    let recovered = 0;
    let failed = 0;
    for (const document of documents) {
      throwIfAborted(options.signal, "artifact-recover");
      const payload = document.fields["payload"];
      if (typeof payload !== "string") {
        failed++;
        continue;
      }
      const artifact = JSON.parse(payload) as ArtifactRecord;
      try {
        const manifestPath = nodePath.join(this.#store.rootDir, artifact.relativePath);
        if (!isWithin(this.#store.rootDir, manifestPath))
          throw new Error("Artifact manifest escaped storage root");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ArtifactRecord;
        if (
          manifest.id !== artifact.id ||
          manifest.episodeId !== artifact.episodeId ||
          manifest.securityNamespace !== artifact.securityNamespace ||
          manifest.state !== "ready" ||
          !Array.isArray(manifest.chunks)
        ) {
          throw new Error("Artifact manifest identity or state is invalid");
        }
        const content = await this.#readArtifactBytes(manifest, options);
        if (content === undefined) throw new Error("Artifact manifest is incomplete");
        await this.#persistArtifact({ ...manifest, state: "ready", updatedAt: this.#clock.now() });
        recovered++;
      } catch (error: unknown) {
        await this.#persistArtifact({
          ...artifact,
          state: "failed",
          failure: error instanceof Error ? error.message : String(error),
          updatedAt: this.#clock.now(),
        });
        failed++;
      }
    }
    return { inspected: documents.length, recovered, failed };
  }

  async deleteArtifact(id: string, options: ArtifactReadOptions = {}): Promise<boolean> {
    throwIfAborted(options.signal, "artifact-delete");
    const artifact = await this.getArtifact(id, options);
    if (artifact === undefined) return false;
    const target = nodePath.join(this.#store.rootDir, artifact.relativePath);
    const expectedDirectory = nodePath.join(this.#store.rootDir, "artifacts", id.slice(0, 2), id);
    const chunked = artifact.chunks.length > 0 || nodePath.basename(target) === "manifest.json";
    if (chunked) {
      if (!isWithin(expectedDirectory, target)) return false;
    } else if (
      !isWithin(nodePath.join(this.#store.rootDir, "artifacts"), target) ||
      !nodePath.basename(target).startsWith(id)
    )
      return false;
    await this.#persistArtifact({ ...artifact, state: "deleted", updatedAt: this.#clock.now() });
    await rm(chunked ? expectedDirectory : target, { recursive: chunked, force: true });
    return true;
  }

  async collectExpiredArtifacts(now?: number, options: OperationOptions = {}): Promise<number> {
    const cutoff = now ?? this.#clock.now();
    const documents = await this.#store.filterScalar("artifacts_v1", 'status = "ready"', 10_000);
    let removed = 0;
    for (const document of documents) {
      throwIfAborted(options.signal, "artifact-gc");
      const payload = document.fields["payload"];
      if (typeof payload !== "string") continue;
      const artifact = JSON.parse(payload) as ArtifactRecord;
      if (artifact.expiresAt === undefined || artifact.expiresAt > cutoff) continue;
      await this.#persistArtifact({ ...artifact, state: "expired", updatedAt: cutoff });
      if (await this.deleteArtifact(artifact.id, options)) removed++;
    }
    return removed;
  }

  async readEvidence(
    refs: readonly EvidenceRef[],
    options: EvidenceReadOptions = {},
  ): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    const visited = new Set<string>();
    const visit = async (ref: EvidenceRef): Promise<void> => {
      throwIfAborted(options.signal, "evidence-read");
      const key = `${ref.kind}:${ref.id}`;
      if (visited.has(key)) return;
      visited.add(key);
      if (ref.kind === "episode") {
        const episode = await this.getEpisode(ref.id, options);
        if (episode === undefined) return;
        values.push(episode);
        const documents = await this.#store.filterScalar(
          "events_v1",
          `kind = "event" AND namespace = ${quoteFilter(episode.securityNamespace)}`,
          10_000,
        );
        const events = documents
          .map((d) => decodeStoredPayload(d) as unknown as PiEvent)
          .filter((e) => e.episodeId === episode.id)
          .sort((l, r) => l.sequence - r.sequence);
        for (const event of events)
          await visit({ kind: "event", id: event.id, observedAt: event.timestamp });
      } else if (ref.kind === "event") {
        const event = await this.getEvent(ref.id, options);
        if (event === undefined) return;
        values.push(event);
        if (event.parentEventId !== undefined)
          await visit({ kind: "event", id: event.parentEventId, observedAt: event.timestamp });
        if (event.artifactRef !== undefined) await visit(event.artifactRef);
      } else if (ref.kind === "artifact") {
        const artifact = await this.getArtifact(ref.id, options);
        if (artifact === undefined) return;
        const maxBytes = Math.max(
          1,
          Math.min(options.artifactMaxBytes ?? artifact.byteLength, 1_048_576),
        );
        const content = await this.readArtifact(ref.id, {
          ...options,
          offset: 0,
          length: maxBytes,
        });
        if (content !== undefined)
          values.push({
            ...artifact,
            content,
            contentTruncated: artifact.byteLength > Buffer.byteLength(content, "utf8"),
          });
      }
    };
    for (const ref of refs) await visit(ref);
    return values.filter((v) => v !== undefined);
  }

  async searchEvidence(
    refs: readonly EvidenceRef[],
    query: string,
    options: EvidenceReadOptions = {},
  ): Promise<readonly EvidenceSearchMatch[]> {
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    if (terms.length === 0) return [];
    const evidence = await this.readEvidence(refs, { ...options, artifactMaxBytes: 1 });
    const matches: EvidenceSearchMatch[] = [];
    const artifacts = new Set<string>();
    for (const item of evidence) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const value = item as Readonly<Record<string, unknown>>;
      if (typeof value["artifactRef"] === "object" && value["artifactRef"] !== null) {
        const id = (value["artifactRef"] as Readonly<Record<string, unknown>>)["id"];
        if (typeof id === "string") artifacts.add(id);
      }
      const isArtifact =
        typeof value["mediaType"] === "string" && typeof value["relativePath"] === "string";
      if (isArtifact && typeof value["id"] === "string") artifacts.add(value["id"]);
      const text = JSON.stringify(value);
      const lower = text.toLocaleLowerCase();
      if (
        !isArtifact &&
        typeof value["sequence"] === "number" &&
        terms.every((t) => lower.includes(t)) &&
        typeof value["id"] === "string"
      ) {
        matches.push({ kind: "event", id: value["id"], text: text.slice(0, 2_000) });
      }
    }
    for (const artifactId of artifacts) {
      matches.push(...(await this.#searchArtifact(artifactId, terms, options)));
      if (matches.length >= 32) break;
    }
    return matches.slice(0, 32);
  }

  async #searchArtifact(
    id: string,
    terms: readonly string[],
    options: EvidenceReadOptions,
  ): Promise<readonly EvidenceSearchMatch[]> {
    const artifact = await this.getArtifact(id, options);
    if (artifact === undefined || artifact.state !== "ready") return [];
    const matches: EvidenceSearchMatch[] = [];
    let carry = "";
    const inspect = (bytes: Buffer, pieceOffset: number): void => {
      const text = carry + bytes.toString("utf8");
      const lower = text.toLocaleLowerCase();
      if (terms.every((t) => lower.includes(t))) {
        const positions = terms.map((t) => lower.indexOf(t)).filter((o) => o >= 0);
        const position = Math.min(...positions);
        const start = Math.max(0, position - 240);
        const end = Math.min(text.length, position + 760);
        const carryBytes = Buffer.byteLength(carry, "utf8");
        matches.push({
          kind: "artifact",
          id,
          text: text.slice(start, end),
          artifactOffset: Math.max(
            0,
            pieceOffset - carryBytes + Buffer.byteLength(text.slice(0, start), "utf8"),
          ),
        });
      }
      carry = text.slice(-1024);
    };
    if (artifact.chunks.length === 0) {
      const target = nodePath.join(this.#store.rootDir, artifact.relativePath);
      if (!isWithin(this.#store.rootDir, target)) return [];
      const bytes = await readFile(target);
      if (bytes.length !== artifact.byteLength || contentHash(bytes) !== artifact.contentHash)
        throw new Error(`Artifact ${id} failed full-content integrity validation`);
      inspect(bytes, 0);
    } else {
      const ordered = [...artifact.chunks].sort((left, right) => left.ordinal - right.ordinal);
      let expectedOffset = 0;
      for (const [expectedOrdinal, chunk] of ordered.entries()) {
        throwIfAborted(options.signal, "artifact-search");
        if (chunk.ordinal !== expectedOrdinal || chunk.byteOffset !== expectedOffset)
          throw new Error(`Artifact ${id} chunk manifest is not contiguous`);
        const target = nodePath.join(this.#store.rootDir, chunk.relativePath);
        if (!isWithin(this.#store.rootDir, target)) return [];
        const bytes = await readFile(target);
        if (bytes.length !== chunk.byteLength || contentHash(bytes) !== chunk.contentHash)
          throw new Error(`Artifact ${id} chunk ${chunk.ordinal} failed integrity validation`);
        inspect(bytes, chunk.byteOffset);
        expectedOffset += bytes.length;
        if (matches.length >= 8) break;
      }
    }
    return matches;
  }

  async #persistArtifact(record: ArtifactRecord): Promise<void> {
    await this.#store.upsertScalar("artifacts_v1", [
      scalarRecord("artifact", record.securityNamespace, record.state, record),
    ]);
  }
}

export function createPiEvidenceStore(
  store: ZvecStore,
  clock: Clock = systemClock,
): PiEvidenceStore {
  return new DefaultPiEvidenceStore(store, clock);
}
