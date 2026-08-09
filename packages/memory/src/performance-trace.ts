export interface BeforeAgentStartTiming {
  totalMs: number;

  projectIdentityMs: number;
  topicMs: number;
  taskMs: number;

  embeddingMs: number;
  rerankMs: number;
  recallMs: number;

  zvecMs: number;
  snapshotReadMs: number;
  snapshotWriteMs: number;
  captureMs: number;

  remoteCallCount: number;
  embeddingCallCount: number;
  rerankCallCount: number;

  projectCacheHit: boolean;
  topicReused: boolean;
  taskReused: boolean;
}

export class PerformanceTrace {
  readonly #timings = new Map<string, number>();
  #remoteCallCount = 0;
  #embeddingCallCount = 0;
  #rerankCallCount = 0;

  start(): void {
    this.#timings.set("start", performance.now());
  }

  mark(name: string): void {
    this.#timings.set(name, performance.now());
  }

  incrementRemoteCalls(): void {
    this.#remoteCallCount += 1;
  }

  incrementEmbeddingCalls(): void {
    this.#embeddingCallCount += 1;
  }

  incrementRerankCalls(): void {
    this.#rerankCallCount += 1;
  }

  snapshot(options: {
    projectCacheHit: boolean;
    topicReused: boolean;
    taskReused: boolean;
  }): BeforeAgentStartTiming {
    const start = this.#timings.get("start") ?? performance.now();
    const now = performance.now();
    const get = (name: string, fallback: string): number =>
      (this.#timings.get(name) ?? this.#timings.get(fallback) ?? start) -
      (this.#timings.get(fallback) ?? start);

    return {
      totalMs: Math.round((now - start) * 100) / 100,
      projectIdentityMs: Math.round(get("projectIdentity", "start") * 100) / 100,
      topicMs: Math.round(get("topic", "projectIdentity") * 100) / 100,
      taskMs: Math.round(get("task", "topic") * 100) / 100,
      embeddingMs: Math.round(get("embedding", "task") * 100) / 100,
      rerankMs: Math.round(get("rerank", "embedding") * 100) / 100,
      recallMs: Math.round(get("recall", "rerank") * 100) / 100,
      zvecMs: Math.round(get("zvec", "recall") * 100) / 100,
      snapshotReadMs: Math.round(get("snapshotRead", "zvec") * 100) / 100,
      snapshotWriteMs: Math.round(get("snapshotWrite", "snapshotRead") * 100) / 100,
      captureMs: Math.round(get("capture", "snapshotWrite") * 100) / 100,
      remoteCallCount: this.#remoteCallCount,
      embeddingCallCount: this.#embeddingCallCount,
      rerankCallCount: this.#rerankCallCount,
      projectCacheHit: options.projectCacheHit,
      topicReused: options.topicReused,
      taskReused: options.taskReused,
    };
  }
}
