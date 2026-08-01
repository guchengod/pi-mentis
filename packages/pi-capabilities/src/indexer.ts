import { EvidenceAuthority, contentHash, type OperationOptions } from "@pi-mentis/pi-mentis-core";
import {
  embeddingSpaceId,
  type EmbeddingProvider,
  type EmbeddingSpaceIdentity,
} from "@pi-mentis/pi-mentis-inference";
import type { KnowledgeService } from "@pi-mentis/pi-mentis-knowledge-core";
import { ZvecStore, type StoredRecord, type StoredVectorRecord } from "@pi-mentis/pi-mentis-zvec";

import type {
  CapabilityPlan,
  CapabilityPlanner,
  CapabilityRecord,
  CapabilityRequest,
} from "./types.js";

export interface CapabilityIndexerOptions {
  readonly store: ZvecStore;
  readonly embedding: EmbeddingProvider;
  readonly embeddingSpace: EmbeddingSpaceIdentity;
  readonly dimensions: number;
}

export class CapabilityIndexer {
  readonly #store: ZvecStore;
  readonly #embedding: EmbeddingProvider;
  readonly #embeddingSpaceId: string;
  readonly #dimensions: number;

  constructor(options: CapabilityIndexerOptions) {
    this.#store = options.store;
    this.#embedding = options.embedding;
    this.#embeddingSpaceId = embeddingSpaceId(options.embeddingSpace);
    this.#dimensions = options.dimensions;
  }

  async sync(
    fingerprint: string,
    records: readonly CapabilityRecord[],
    options: OperationOptions = {},
  ): Promise<{ readonly indexed: number; readonly unchanged: boolean }> {
    const fingerprintId = "capability-installation-fingerprint";
    const existing = (await this.#store.fetchScalar("relationships_v1", [fingerprintId])).get(
      fingerprintId,
    );
    if (existing?.["fingerprint"] === fingerprint) return { indexed: 0, unchanged: true };
    const vectors: StoredVectorRecord[] = [];
    for (let offset = 0; offset < records.length; offset += 32) {
      const batch = records.slice(offset, offset + 32);
      const response = await this.#embedding.embed(
        {
          inputs: batch.map(
            (record) =>
              `${record.kind} ${record.qualifiedName}\n${record.description}\n${record.constraints.join("\n")}`,
          ),
          inputKind: "capability",
          dimensions: this.#dimensions,
          truncate: "reject",
        },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          priority: "background",
        },
      );
      for (const [index, record] of batch.entries()) {
        const vector = response.vectors[index];
        if (vector === undefined) throw new Error("Capability Embedding batch is incomplete");
        const text = `${record.qualifiedName}\n${record.description}`;
        const now = Date.now();
        vectors.push({
          id: record.id,
          kind: "capability",
          namespace: "pi:0.83.0",
          status: "active",
          payload: {
            ...record,
            embeddingSpaceId: this.#embeddingSpaceId,
            updatedAt: now,
          } as unknown as Readonly<Record<string, unknown>>,
          searchableText: text,
          contentHash: contentHash(text),
          sourceId: record.packageName,
          documentId: record.id,
          authority: EvidenceAuthority.PiInstalledCapability,
          tokenCount: Math.max(1, Buffer.byteLength(text, "utf8")),
          revision: 1,
          embedding: vector.values,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    // Native Zvec rejects writes larger than 1024 documents. Keep headroom for
    // SDK changes and make large Pi API scans restart-safe at the write layer.
    for (let offset = 0; offset < vectors.length; offset += 512) {
      await this.#store.upsertVectors("capability", vectors.slice(offset, offset + 512));
    }
    const now = Date.now();
    const fingerprintRecord: StoredRecord = {
      id: fingerprintId,
      kind: "capability-fingerprint",
      namespace: "pi:0.83.0",
      status: "active",
      payload: { fingerprint, recordCount: records.length, updatedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.upsertScalar("relationships_v1", [fingerprintRecord]);
    return { indexed: records.length, unchanged: false };
  }
}

export class DefaultCapabilityPlanner implements CapabilityPlanner {
  readonly #records: readonly CapabilityRecord[];
  readonly #knowledge: KnowledgeService | undefined;

  constructor(records: readonly CapabilityRecord[], knowledge?: KnowledgeService) {
    this.#records = records;
    this.#knowledge = knowledge;
  }

  async analyze(
    request: CapabilityRequest,
    options: OperationOptions = {},
  ): Promise<CapabilityPlan> {
    const terms = new Set(
      request.goal
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter((term) => term.length > 2),
    );
    const scored = this.#records
      .map((record) => ({
        record,
        score: [...terms].filter((term) =>
          `${record.qualifiedName} ${record.description}`.toLowerCase().includes(term),
        ).length,
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);
    const reusable = scored
      .filter((item) => item.score >= Math.max(2, Math.ceil(terms.size * 0.5)))
      .map((item) => item.record)
      .slice(0, 10);
    const partial = scored
      .filter((item) => !reusable.includes(item.record))
      .map((item) => item.record)
      .slice(0, 10);
    const knowledgeEvidence =
      this.#knowledge === undefined
        ? []
        : (
            await this.#knowledge.search(
              { text: request.goal, limit: 5 },
              {
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                timeoutMs: 2_000,
              },
            )
          ).hits;
    const gaps =
      reusable.length > 0
        ? []
        : [
            `No installed Pi v0.83.0 capability directly satisfies: ${request.goal}`,
            ...(knowledgeEvidence.length === 0
              ? ["No supporting user or project knowledge was retrieved"]
              : []),
          ];
    const recommendation: CapabilityPlan["recommendation"] =
      gaps.length === 0
        ? "reuse"
        : /\b(?:external|service|api|server)\b/i.test(request.goal)
          ? "mcp"
          : /\b(?:workflow|instruction|prompt)\b/i.test(request.goal)
            ? "skill"
            : partial.length > 0
              ? "combination"
              : "extension";
    return {
      reusable,
      partial,
      gaps,
      recommendation,
      implementationConstraints: [
        "Use only Pi v0.83.0 Extension API",
        ...(request.constraints ?? []),
      ],
      validationPlan: [
        "Load the generated artifact in Pi v0.83.0",
        "Verify declared tools and commands",
        "Exercise success, failure, cancellation, and shutdown paths",
        "Require evidence before promotion; do not modify the running extension automatically",
      ],
    };
  }
}
