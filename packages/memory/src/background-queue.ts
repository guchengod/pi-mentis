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

export interface MentisBackgroundDrainOptions {
  /** Maximum time to wait for already-running work. Omit for an unbounded drain. */
  readonly timeoutMs?: number;
  /** Drop queued work instead of starting it. Durable jobs remain recoverable from storage. */
  readonly cancelPending?: boolean;
}

export class MentisBackgroundQueue {
  readonly #queue: MentisBackgroundJob[] = [];
  readonly #maxConcurrency: number;
  readonly #maxQueueLength: number;
  readonly #logError: (err: unknown, job: MentisBackgroundJob) => void;
  readonly #active = new Set<Promise<void>>();
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

  async drain(options: MentisBackgroundDrainOptions = {}): Promise<boolean> {
    this.#draining = true;
    this.#drainPromise ??= this.#drainAll(options.cancelPending ?? false);
    if (options.timeoutMs === undefined) {
      await this.#drainPromise;
      return true;
    }
    const timeoutMs = Math.max(0, options.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#drainPromise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #drain(): void {
    while (this.#running < this.#maxConcurrency && this.#queue.length > 0 && !this.#draining) {
      const job = this.#queue.shift();
      if (job === undefined) break;
      this.#start(job);
    }
  }

  #start(job: MentisBackgroundJob): Promise<void> {
    this.#running += 1;
    const execution = job
      .execute()
      .catch((err) => this.#logError(err, job))
      .finally(() => {
        this.#active.delete(execution);
        this.#running -= 1;
        if (!this.#draining) this.#drain();
      });
    this.#active.add(execution);
    return execution;
  }

  async #drainAll(cancelPending: boolean): Promise<void> {
    const remaining = [...this.#queue];
    this.#queue.length = 0;
    const started = cancelPending ? [] : remaining.map((job) => this.#start(job));
    await Promise.allSettled([...this.#active, ...started]);
  }
}
