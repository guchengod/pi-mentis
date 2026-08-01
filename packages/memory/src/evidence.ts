import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  contentHash,
  stableHash,
  throwIfAborted,
  type EvidenceRef,
  type OperationOptions,
} from "@pi-mentis/pi-mentis-core";
import { type StoredRecord, ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import type { ArtifactRecord, PiEpisode, PiEvent, PiEvidenceStore } from "./types.js";

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
  const updatedAt = "endedAt" in value ? (value.endedAt ?? createdAt) : createdAt;
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
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class DefaultPiEvidenceStore implements PiEvidenceStore {
  readonly #store: ZvecStore;

  constructor(store: ZvecStore) {
    this.#store = store;
  }

  async createEpisode(episode: PiEpisode, options: OperationOptions = {}): Promise<void> {
    throwIfAborted(options.signal, "episode-create");
    await this.#store.upsertScalar("episodes_v1", [
      scalarRecord("episode", episode.projectId ?? episode.sessionId, episode.status, episode),
    ]);
  }

  async updateEpisode(episode: PiEpisode, options: OperationOptions = {}): Promise<void> {
    return this.createEpisode(episode, options);
  }

  async appendEvent(event: PiEvent, options: OperationOptions = {}): Promise<void> {
    throwIfAborted(options.signal, "event-append");
    await this.#store.upsertScalar("events_v1", [
      scalarRecord("event", event.episodeId, event.kind, event),
    ]);
  }

  async writeArtifact(
    input: Omit<
      ArtifactRecord,
      "id" | "contentHash" | "relativePath" | "byteLength" | "createdAt"
    > & { readonly content: string },
    options: OperationOptions = {},
  ): Promise<ArtifactRecord> {
    throwIfAborted(options.signal, "artifact-write");
    const hash = contentHash(input.content);
    const id = stableHash("artifact:v1", input.episodeId, input.toolCallId ?? "", hash);
    const relativePath = path.join("artifacts", id.slice(0, 2), `${id}.txt`);
    const target = path.join(this.#store.rootDir, relativePath);
    if (!isWithin(this.#store.rootDir, target))
      throw new Error("Artifact path escaped storage root");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, input.content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    const record: ArtifactRecord = {
      id,
      episodeId: input.episodeId,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      mediaType: input.mediaType,
      byteLength: Buffer.byteLength(input.content, "utf8"),
      contentHash: hash,
      relativePath,
      createdAt: Date.now(),
    };
    await this.#store.upsertScalar("artifacts_v1", [
      scalarRecord("artifact", input.episodeId, "active", record),
    ]);
    return record;
  }

  async getEpisode(id: string, options: OperationOptions = {}): Promise<PiEpisode | undefined> {
    throwIfAborted(options.signal, "episode-get");
    return (await this.#store.fetchScalar("episodes_v1", [id])).get(id) as PiEpisode | undefined;
  }

  async getEvent(id: string, options: OperationOptions = {}): Promise<PiEvent | undefined> {
    throwIfAborted(options.signal, "event-get");
    return (await this.#store.fetchScalar("events_v1", [id])).get(id) as PiEvent | undefined;
  }

  async getArtifact(
    id: string,
    options: OperationOptions = {},
  ): Promise<ArtifactRecord | undefined> {
    throwIfAborted(options.signal, "artifact-get");
    return (await this.#store.fetchScalar("artifacts_v1", [id])).get(id) as
      ArtifactRecord | undefined;
  }

  async readEvidence(
    refs: readonly EvidenceRef[],
    options: OperationOptions = {},
  ): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    for (const ref of refs) {
      throwIfAborted(options.signal, "evidence-read");
      if (ref.kind === "episode") values.push(await this.getEpisode(ref.id, options));
      else if (ref.kind === "event") values.push(await this.getEvent(ref.id, options));
      else if (ref.kind === "artifact") {
        const artifact = await this.getArtifact(ref.id, options);
        if (artifact === undefined) continue;
        const target = path.join(this.#store.rootDir, artifact.relativePath);
        if (!isWithin(this.#store.rootDir, target)) continue;
        values.push({ ...artifact, content: await readFile(target, "utf8") });
      }
    }
    return values.filter((value) => value !== undefined);
  }
}

export function createPiEvidenceStore(store: ZvecStore): PiEvidenceStore {
  return new DefaultPiEvidenceStore(store);
}
