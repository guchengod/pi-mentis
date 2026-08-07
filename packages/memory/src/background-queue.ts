export interface MentisBackgroundJob {
  readonly kind:
    | "capture.persist"
    | "topic.refresh"
    | "task.refresh"
    | "snapshot.checkpoint"
    | "memory.consolidate"
    | "experience.extract";
  readonly execute: () => Promise<void>;
  readonly coalesceKey?: string;
}

export interface MentisBackgroundQueueOptions {
  readonly maxConcurrency?: number;
  readonly maxQueueLength?: number;
  readonly logError?: (err: unknown, job: MentisBackgroundJob) => void;
}

export class MentisBackgroundQueue {
  readonly #queue: MentisBackgroundJob[] = [];
  readonly #maxConcurrency: number;
  readonly #maxQueueLength: number;
  readonly #logError: (err: unknown, job: MentisBackgroundJob) => void;
  #running = 0;
  #draining = false;
  #drainPromise: Promise<void> | undefined;

  constructor(options: MentisBackgroundQueueOptions = {}) {
    this.#maxConcurrency = options.maxConcurrency ?? 2;
    this.#maxQueueLength = options.maxQueueLength ?? 128;
    this.#logError = options.logError ?? (() => {});
  }

  enqueue(job: MentisBackgroundJob): void {
    if (this.#draining) return;
    if (job.coalesceKey !== undefined) {
      const idx = this.#queue.findLastIndex((q) => q.coalesceKey === job.coalesceKey);
      if (idx >= 0) {
        this.#queue[idx] = job;
        return;
      }
    }
    if (this.#queue.length >= this.#maxQueueLength) {
      this.#queue.shift();
    }
    this.#queue.push(job);
    this.#drain();
  }

  get pendingCount(): number {
    return this.#queue.length;
  }

  get runningCount(): number {
    return this.#running;
  }

  async drain(): Promise<void> {
    this.#draining = true;
    this.#drainPromise ??= this.#drainAll();
    return this.#drainPromise;
  }

  #drain(): void {
    while (this.#running < this.#maxConcurrency && this.#queue.length > 0 && !this.#draining) {
      const job = this.#queue.shift();
      if (job === undefined) break;
      this.#running += 1;
      job
        .execute()
        .catch((err) => this.#logError(err, job))
        .finally(() => {
          this.#running -= 1;
          if (!this.#draining) this.#drain();
        });
    }
  }

  async #drainAll(): Promise<void> {
    const remaining = [...this.#queue];
    this.#queue.length = 0;
    const results = remaining.map((job) =>
      job.execute().catch((err) => this.#logError(err, job)),
    );
    await Promise.allSettled(results);
    while (this.#running > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
}
