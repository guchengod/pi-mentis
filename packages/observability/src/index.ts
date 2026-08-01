import { contentHash } from "@pi-mentis/pi-mentis-core";

export const METRIC_NAMES = [
  "startup_duration_ms",
  "recall_gate_duration_ms",
  "auto_recall_duration_ms",
  "knowledge_search_duration_ms",
  "memory_search_duration_ms",
  "embedding_duration_ms",
  "embedding_batch_size",
  "embedding_cache_hit_ratio",
  "embedding_tokens",
  "rerank_duration_ms",
  "rerank_candidate_count",
  "rerank_input_tokens",
  "rerank_cache_hit_ratio",
  "rerank_fallback_count",
  "siliconflow_rate_limit_count",
  "siliconflow_error_count",
  "zvec_query_duration_ms",
  "queue_depth",
  "worker_utilization",
  "write_batch_size",
  "event_loop_lag_ms",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

interface Series {
  count: number;
  sum: number;
  minimum: number;
  maximum: number;
}

export interface MetricSnapshot extends Series {
  readonly average: number;
}

export interface TraceAttributes {
  readonly contentHash?: string;
  readonly tokenCount?: number;
  readonly documentCount?: number;
  readonly model?: string;
  readonly dimensions?: number;
  readonly durationMs?: number;
  readonly traceId?: string;
  readonly status?: string;
  readonly [key: string]: string | number | boolean | undefined;
}

export interface TraceRecord {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes: TraceAttributes;
}

export class InMemoryTelemetry {
  readonly #metrics = new Map<MetricName, Series>();
  readonly #traces: TraceRecord[] = [];
  readonly #maxTraces: number;

  constructor(maxTraces = 1_000) {
    this.#maxTraces = Math.max(1, maxTraces);
  }

  record(name: MetricName, value: number): void {
    if (!Number.isFinite(value)) return;
    const series = this.#metrics.get(name) ?? {
      count: 0,
      sum: 0,
      minimum: Number.POSITIVE_INFINITY,
      maximum: Number.NEGATIVE_INFINITY,
    };
    series.count++;
    series.sum += value;
    series.minimum = Math.min(series.minimum, value);
    series.maximum = Math.max(series.maximum, value);
    this.#metrics.set(name, series);
  }

  trace(name: string, attributes: TraceAttributes): void {
    const sanitized = Object.fromEntries(
      Object.entries(attributes).filter(
        ([key, value]) =>
          value !== undefined &&
          !/(api.?key|authorization|document.?text|content|prompt)/i.test(key),
      ),
    ) as TraceAttributes;
    this.#traces.push({ name, timestamp: Date.now(), attributes: sanitized });
    if (this.#traces.length > this.#maxTraces) this.#traces.shift();
  }

  snapshot(): Readonly<Record<MetricName, MetricSnapshot | undefined>> {
    return Object.fromEntries(
      METRIC_NAMES.map((name) => {
        const series = this.#metrics.get(name);
        return [
          name,
          series === undefined
            ? undefined
            : { ...series, average: series.count === 0 ? 0 : series.sum / series.count },
        ];
      }),
    ) as Readonly<Record<MetricName, MetricSnapshot | undefined>>;
  }

  traces(): readonly TraceRecord[] {
    return [...this.#traces];
  }
}

export function safeContentAttributes(
  text: string,
  extras: Omit<TraceAttributes, "contentHash"> = {},
): TraceAttributes {
  return { ...extras, contentHash: contentHash(text) };
}

export async function measure<T>(
  telemetry: InMemoryTelemetry,
  metric: MetricName,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    telemetry.record(metric, performance.now() - started);
  }
}
