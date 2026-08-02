import { stableHash, systemClock, type Clock, type SearchHit } from "@pi-mentis/pi-mentis-core";
import { ZvecStateStore, type StoredRecord, type ZvecStore } from "@pi-mentis/pi-mentis-zvec";
import type { PolicyReplayCandidate, PolicyReplayCase } from "./policy.js";

export interface RetrievalTrace {
  readonly id: string;
  readonly traceId: string;
  readonly queryHash: string;
  readonly contextSnapshotId?: string;
  readonly exposedMemoryIds: readonly string[];
  readonly exposedKnowledgeIds: readonly string[];
  readonly exposedViewIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly candidateFeatures: readonly PolicyReplayCandidate[];
  readonly usedMemoryIds: readonly string[];
  readonly rejectedIds: readonly string[];
  readonly rejectionReasons: Readonly<Record<string, readonly string[]>>;
  readonly exposureReasons: Readonly<Record<string, readonly string[]>>;
  readonly durationMs: number;
  readonly stages: Readonly<Record<string, number>>;
  readonly policyId: string;
  readonly createdAt: number;
}

export interface TaskOutcomeObservation {
  readonly traceId: string;
  readonly execution: "success" | "failed" | "partial";
  readonly verification: "passed" | "failed" | "not_run" | "unknown";
  readonly userConfirmation?: "confirmed" | "corrected" | "none";
  readonly toolArgumentMemoryIds?: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly observedAt?: number;
}

export interface MemoryUtility {
  readonly memoryId: string;
  readonly exposures: number;
  readonly uses: number;
  readonly successes: number;
  readonly failures: number;
  readonly corrections: number;
  readonly alpha: number;
  readonly beta: number;
  readonly utility: number;
  readonly confidence: number;
  readonly updatedAt: number;
}

export interface EffectivenessDiagnostic {
  readonly code:
    | "high-recall-low-use"
    | "high-use-high-failure"
    | "high-correction"
    | "project-mismatch"
    | "rerank-no-benefit"
    | "view-high-use";
  readonly message: string;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface EffectivenessSummary {
  readonly samples: number;
  readonly verificationFailureRate: number;
  readonly correctionRate: number;
  readonly p95LatencyMs: number;
  readonly projectMismatchRate: number;
}

interface BufferedTrace extends RetrievalTrace {
  readonly namespace: string;
}

function replayTerms(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .normalize("NFKC")
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_./:-]+/u)
        .filter((term) => term.length > 1)
        .map((term) => stableHash("retrieval-replay-term:v1", term)),
    ),
  ].slice(0, 128);
}

export class EffectivenessService {
  readonly #store: ZvecStore;
  readonly #state: ZvecStateStore;
  readonly #clock: Clock;
  readonly #buffer: BufferedTrace[] = [];
  readonly #maxBatch: number;
  readonly #maxBuffered: number;
  readonly #flushIntervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushing: Promise<void> | undefined;
  #droppedTraces = 0;

  constructor(
    store: ZvecStore,
    options: {
      readonly clock?: Clock;
      readonly maxBatch?: number;
      readonly maxBuffered?: number;
      readonly flushIntervalMs?: number;
    } = {},
  ) {
    this.#store = store;
    this.#state = new ZvecStateStore(store);
    this.#clock = options.clock ?? systemClock;
    this.#maxBatch = options.maxBatch ?? 64;
    this.#maxBuffered = Math.max(this.#maxBatch, options.maxBuffered ?? 4_096);
    this.#flushIntervalMs = options.flushIntervalMs ?? 250;
  }

  /** O(1) foreground append. Storage I/O is deliberately deferred. */
  recordRetrieval(input: {
    readonly namespace: string;
    readonly traceId?: string;
    readonly query: string;
    readonly contextSnapshotId?: string;
    readonly hits: readonly SearchHit[];
    readonly candidateHits?: readonly SearchHit[];
    readonly rejectedIds?: readonly string[];
    readonly rejectionReasons?: Readonly<Record<string, readonly string[]>>;
    readonly durationMs: number;
    readonly stages: Readonly<Record<string, number>>;
    readonly policyId: string;
  }): RetrievalTrace {
    const createdAt = this.#clock.now();
    const traceId =
      input.traceId ??
      `trace:${stableHash("retrieval-trace-id:v1", input.namespace, input.query, String(createdAt))}`;
    const trace: BufferedTrace = {
      id: `retrieval-trace:${stableHash("retrieval-trace:v1", traceId)}`,
      traceId,
      namespace: input.namespace,
      queryHash: stableHash("retrieval-query:v1", input.query),
      ...(input.contextSnapshotId === undefined
        ? {}
        : { contextSnapshotId: input.contextSnapshotId }),
      exposedMemoryIds: [
        ...new Set(
          input.hits
            .filter((hit) => hit.kind === "memory")
            .flatMap((hit) =>
              hit.metadata?.["derivedView"] === true &&
              Array.isArray(hit.metadata["memberMemoryIds"])
                ? (hit.metadata["memberMemoryIds"] as string[])
                : [hit.id],
            ),
        ),
      ],
      exposedKnowledgeIds: input.hits
        .filter((hit) => hit.kind === "knowledge")
        .map((hit) => hit.id),
      exposedViewIds: input.hits
        .filter((hit) => hit.metadata?.["derivedView"] === true)
        .map((hit) => hit.id),
      candidateIds: (input.candidateHits ?? input.hits).flatMap((hit) =>
        hit.kind === "memory" &&
        hit.metadata?.["derivedView"] === true &&
        Array.isArray(hit.metadata["memberMemoryIds"])
          ? (hit.metadata["memberMemoryIds"] as string[])
          : [hit.id],
      ),
      candidateFeatures: (input.candidateHits ?? input.hits).flatMap((hit) => {
        const ids =
          hit.kind === "memory" &&
          hit.metadata?.["derivedView"] === true &&
          Array.isArray(hit.metadata["memberMemoryIds"])
            ? (hit.metadata["memberMemoryIds"] as string[])
            : [hit.id];
        return ids.map((id) => ({
          id,
          kind: hit.kind,
          score: hit.score,
          tokenCount: Math.max(1, Math.ceil(hit.tokenCount / ids.length)),
          authority: hit.authority,
          termHashes: replayTerms(hit.text),
        }));
      }),
      usedMemoryIds: [],
      rejectedIds: input.rejectedIds ?? [],
      rejectionReasons: input.rejectionReasons ?? {},
      exposureReasons: Object.fromEntries(
        input.hits.flatMap((hit) => {
          const gate = hit.metadata?.["gate"];
          if (typeof gate !== "object" || gate === null) return [];
          const reasons = (gate as { readonly reasons?: unknown }).reasons;
          return Array.isArray(reasons)
            ? [[hit.id, reasons.filter((reason): reason is string => typeof reason === "string")]]
            : [];
        }),
      ),
      durationMs: input.durationMs,
      stages: input.stages,
      policyId: input.policyId,
      createdAt,
    };
    if (this.#buffer.length >= this.#maxBuffered) {
      this.#buffer.shift();
      this.#droppedTraces++;
    }
    this.#buffer.push(trace);
    if (this.#buffer.length >= this.#maxBatch) void this.flush().catch(() => undefined);
    else this.#scheduleFlush();
    return trace;
  }

  async recordOutcome(namespace: string, outcome: TaskOutcomeObservation): Promise<void> {
    await this.flush();
    const traceId = `retrieval-trace:${stableHash("retrieval-trace:v1", outcome.traceId)}`;
    const payload = (await this.#store.fetchScalar("events_v1", [traceId])).get(traceId);
    if (payload === undefined) return;
    const trace = payload as unknown as RetrievalTrace;
    const used = new Set(outcome.toolArgumentMemoryIds ?? []);
    const success =
      outcome.execution === "success" &&
      (outcome.verification === "passed" || outcome.userConfirmation === "confirmed");
    const failed = outcome.verification === "failed" || outcome.execution === "failed";
    const corrected = outcome.userConfirmation === "corrected";
    for (const memoryId of trace.exposedMemoryIds) {
      const id = this.#state.id("memory-utility", namespace, memoryId);
      const current = await this.#state.get<MemoryUtility>(id);
      const wasUsed = used.has(memoryId);
      const exposureCredit = wasUsed ? 1 : 0.1;
      const alpha = (current?.value.alpha ?? 1) + (success ? exposureCredit : 0);
      const beta = (current?.value.beta ?? 1) + (failed ? exposureCredit : 0);
      const observations = alpha + beta;
      const utility: MemoryUtility = {
        memoryId,
        exposures: (current?.value.exposures ?? 0) + 1,
        uses: (current?.value.uses ?? 0) + (wasUsed ? 1 : 0),
        successes: (current?.value.successes ?? 0) + (success ? 1 : 0),
        failures: (current?.value.failures ?? 0) + (failed ? 1 : 0),
        corrections: (current?.value.corrections ?? 0) + (corrected ? 1 : 0),
        alpha,
        beta,
        utility: alpha / observations,
        confidence: Math.min(1, Math.max(0, (observations - 2) / 20)),
        updatedAt: outcome.observedAt ?? this.#clock.now(),
      };
      await this.#state.put(
        {
          id,
          kind: "memory-utility",
          namespace,
          value: utility as unknown as Readonly<Record<string, unknown>>,
        },
        { now: this.#clock.now() },
      );
    }
    const now = outcome.observedAt ?? this.#clock.now();
    const updatedTrace: RetrievalTrace = {
      ...trace,
      usedMemoryIds: [...used].filter((id) => trace.exposedMemoryIds.includes(id)),
    };
    await this.#store.upsertScalar("events_v1", [
      {
        id: trace.id,
        kind: "retrieval-trace",
        namespace,
        status: "attributed",
        payload: updatedTrace as unknown as Readonly<Record<string, unknown>>,
        createdAt: trace.createdAt,
        updatedAt: now,
      },
    ]);
    const record: StoredRecord = {
      id: `retrieval-outcome:${stableHash("retrieval-outcome:v1", outcome.traceId, String(now))}`,
      kind: "retrieval-outcome",
      namespace,
      status: "observed",
      payload: {
        ...outcome,
        policyId: trace.policyId,
        success,
        failed,
        corrected,
        observedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.upsertScalar("events_v1", [record]);
  }

  async utility(namespace: string, memoryId: string): Promise<MemoryUtility | undefined> {
    return (
      await this.#state.get<MemoryUtility>(this.#state.id("memory-utility", namespace, memoryId))
    )?.value;
  }

  bufferStatus(): {
    readonly buffered: number;
    readonly flushing: boolean;
    readonly droppedTraces: number;
  } {
    return {
      buffered: this.#buffer.length,
      flushing: this.#flushing !== undefined,
      droppedTraces: this.#droppedTraces,
    };
  }

  async replayCases(namespace: string, limit = 1_000): Promise<readonly PolicyReplayCase[]> {
    await this.flush();
    const traces = await this.#store.filterScalar(
      "events_v1",
      `kind = "retrieval-trace" AND namespace = "${namespace.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" AND status = "attributed"`,
      limit,
    );
    return traces.flatMap((document) => {
      const raw = document.fields["payload"];
      if (typeof raw !== "string") return [];
      const trace = JSON.parse(raw) as RetrievalTrace;
      if (trace.usedMemoryIds.length === 0) return [];
      return [
        {
          id: trace.id,
          positiveMemoryIds: trace.usedMemoryIds,
          negativeMemoryIds: trace.rejectedIds,
          requiredEvidenceIds: trace.exposedKnowledgeIds,
          candidateMemoryIds: trace.exposedMemoryIds,
          candidateIds: trace.candidateIds ?? [
            ...trace.exposedMemoryIds,
            ...trace.exposedKnowledgeIds,
          ],
          ...(trace.candidateFeatures === undefined
            ? {}
            : { candidateFeatures: trace.candidateFeatures }),
        },
      ];
    });
  }

  async summary(
    namespace: string,
    limit = 1_000,
    policyId?: string,
  ): Promise<EffectivenessSummary> {
    await this.flush();
    const escaped = namespace.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const [traces, outcomes] = await Promise.all([
      this.#store.filterScalar(
        "events_v1",
        `kind = "retrieval-trace" AND namespace = "${escaped}"`,
        limit,
      ),
      this.#store.filterScalar(
        "events_v1",
        `kind = "retrieval-outcome" AND namespace = "${escaped}"`,
        limit,
      ),
    ]);
    const parsedTraces = traces
      .flatMap((document) => {
        const raw = document.fields["payload"];
        return typeof raw === "string" ? [JSON.parse(raw) as RetrievalTrace] : [];
      })
      .filter((trace) => policyId === undefined || trace.policyId === policyId);
    const durations = parsedTraces
      .map((trace) => trace.durationMs)
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    const observations = outcomes
      .flatMap((document) => {
        const raw = document.fields["payload"];
        return typeof raw === "string"
          ? [
              JSON.parse(raw) as {
                readonly policyId?: string;
                readonly failed?: boolean;
                readonly corrected?: boolean;
              },
            ]
          : [];
      })
      .filter((item) => policyId === undefined || item.policyId === policyId);
    const projectMismatches = parsedTraces.filter((trace) =>
      Object.values(trace.exposureReasons ?? {}).some((reasons) =>
        reasons.some((reason) => /project.*mismatch|repository.*mismatch/i.test(reason)),
      ),
    ).length;
    const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
    return {
      samples: observations.length,
      verificationFailureRate:
        observations.filter((item) => item.failed === true).length /
        Math.max(1, observations.length),
      correctionRate:
        observations.filter((item) => item.corrected === true).length /
        Math.max(1, observations.length),
      p95LatencyMs: durations[p95Index] ?? 0,
      projectMismatchRate: projectMismatches / Math.max(1, parsedTraces.length),
    };
  }

  diagnose(input: {
    readonly recall: number;
    readonly useRate: number;
    readonly failureRate: number;
    readonly correctionRate: number;
    readonly projectMismatchRate: number;
    readonly rerankGain: number;
    readonly viewUseRate: number;
  }): readonly EffectivenessDiagnostic[] {
    const diagnostics: EffectivenessDiagnostic[] = [];
    const add = (
      code: EffectivenessDiagnostic["code"],
      message: string,
      metrics: Readonly<Record<string, number>>,
    ) => diagnostics.push({ code, message, metrics });
    if (input.recall >= 0.8 && input.useRate < 0.2)
      add("high-recall-low-use", "Recall is high but retrieved memories are rarely used", {
        recall: input.recall,
        useRate: input.useRate,
      });
    if (input.useRate >= 0.5 && input.failureRate > 0.2)
      add(
        "high-use-high-failure",
        "Frequently used memories correlate with verification failures",
        { useRate: input.useRate, failureRate: input.failureRate },
      );
    if (input.correctionRate > 0.1)
      add("high-correction", "User correction rate exceeds the safe threshold", {
        correctionRate: input.correctionRate,
      });
    if (input.projectMismatchRate > 0.005)
      add("project-mismatch", "Cross-project candidates exceeded the mismatch budget", {
        projectMismatchRate: input.projectMismatchRate,
      });
    if (input.rerankGain <= 0)
      add("rerank-no-benefit", "Rerank did not improve labeled ordering", {
        rerankGain: input.rerankGain,
      });
    if (input.viewUseRate >= 0.5)
      add("view-high-use", "Materialized views satisfy a large share of retrievals", {
        viewUseRate: input.viewUseRate,
      });
    return diagnostics;
  }

  async flush(): Promise<void> {
    if (this.#flushing !== undefined) return this.#flushing;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = this.#buffer.splice(0, this.#maxBatch);
    if (batch.length === 0) return;
    this.#flushing = (async () => {
      const records: StoredRecord[] = batch.map(({ namespace, ...trace }) => ({
        id: trace.id,
        kind: "retrieval-trace",
        namespace,
        status: "recorded",
        payload: trace as unknown as Readonly<Record<string, unknown>>,
        createdAt: trace.createdAt,
        updatedAt: trace.createdAt,
      }));
      await this.#store.upsertScalar("events_v1", records);
    })().finally(() => {
      this.#flushing = undefined;
      if (this.#buffer.length > 0) this.#scheduleFlush();
    });
    return this.#flushing;
  }

  async close(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    while (this.#buffer.length > 0 || this.#flushing !== undefined) await this.flush();
  }

  #scheduleFlush(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush().catch(() => undefined);
    }, this.#flushIntervalMs);
    this.#timer.unref?.();
  }
}
