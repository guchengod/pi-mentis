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
  /** Fresh user-facing work preempts recovery backlog, with bounded fairness. */
  readonly priority?: "fresh" | "normal";
}

export interface MentisBackgroundQueueOptions {
  readonly maxConcurrency?: number;
  readonly maxQueueLength?: number;
  /** Maximum fresh jobs selected before one normal/backlog job must run. */
  readonly freshBurstLimit?: number;
  readonly logError?: (err: unknown, job: MentisBackgroundJob) => void;
}

export interface MentisBackgroundQueueSnapshot {
  readonly queueDepth: number;
  readonly freshQueueDepth: number;
  readonly recoveryQueueDepth: number;
  readonly running: number;
}

export interface MentisBackgroundDrainOptions {
  /** Maximum time to wait for already-running work. Omit for an unbounded drain. */
  readonly timeoutMs?: number;
  /** Drop queued work instead of starting it. Durable jobs remain recoverable from storage. */
  readonly cancelPending?: boolean;
}

export class MentisBackgroundQueue {
  readonly #freshQueue: MentisBackgroundJob[] = [];
  readonly #normalQueue: MentisBackgroundJob[] = [];
  readonly #maxConcurrency: number;
  readonly #maxQueueLength: number;
  readonly #freshBurstLimit: number;
  readonly #logError: (err: unknown, job: MentisBackgroundJob) => void;
  readonly #active = new Set<Promise<void>>();
  #running = 0;
  #freshSelections = 0;
  #draining = false;
  #drainPromise: Promise<void> | undefined;

  constructor(options: MentisBackgroundQueueOptions = {}) {
    this.#maxConcurrency = options.maxConcurrency ?? 2;
    this.#maxQueueLength = options.maxQueueLength ?? 128;
    this.#freshBurstLimit = Math.max(1, options.freshBurstLimit ?? 4);
    this.#logError = options.logError ?? (() => {});
  }

  enqueue(job: MentisBackgroundJob): void {
    if (this.#draining) return;
    if (job.coalesceKey !== undefined) {
      const existing = this.#findCoalesced(job.coalesceKey);
      if (existing !== undefined) {
        existing.queue.splice(existing.index, 1);
        this.#queueFor(job).push(job);
        return;
      }
    }
    if (this.pendingCount >= this.#maxQueueLength) {
      if (this.#normalQueue.length > 0) this.#normalQueue.shift();
      else this.#freshQueue.shift();
    }
    this.#queueFor(job).push(job);
    this.#drain();
  }

  get pendingCount(): number {
    return this.#freshQueue.length + this.#normalQueue.length;
  }

  get runningCount(): number {
    return this.#running;
  }

  snapshot(): MentisBackgroundQueueSnapshot {
    return {
      queueDepth: this.pendingCount,
      freshQueueDepth: this.#freshQueue.length,
      recoveryQueueDepth: this.#normalQueue.length,
      running: this.#running,
    };
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
    while (this.#running < this.#maxConcurrency && this.pendingCount > 0 && !this.#draining) {
      const job = this.#dequeue();
      if (job === undefined) break;
      this.#start(job);
    }
  }

  #dequeue(): MentisBackgroundJob | undefined {
    if (
      this.#freshQueue.length > 0 &&
      (this.#normalQueue.length === 0 || this.#freshSelections < this.#freshBurstLimit)
    ) {
      this.#freshSelections += 1;
      return this.#freshQueue.shift();
    }
    if (this.#normalQueue.length > 0) {
      this.#freshSelections = 0;
      return this.#normalQueue.shift();
    }
    this.#freshSelections = 0;
    return this.#freshQueue.shift();
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
    const remaining = [...this.#freshQueue, ...this.#normalQueue];
    this.#freshQueue.length = 0;
    this.#normalQueue.length = 0;
    const started = cancelPending ? [] : remaining.map((job) => this.#start(job));
    await Promise.allSettled([...this.#active, ...started]);
  }

  #queueFor(job: MentisBackgroundJob): MentisBackgroundJob[] {
    return job.priority === "fresh" ? this.#freshQueue : this.#normalQueue;
  }

  #findCoalesced(
    coalesceKey: string,
  ): { readonly queue: MentisBackgroundJob[]; readonly index: number } | undefined {
    for (const queue of [this.#freshQueue, this.#normalQueue]) {
      const index = queue.findLastIndex((job) => job.coalesceKey === coalesceKey);
      if (index >= 0) return { queue, index };
    }
    return undefined;
  }
}

export interface MentisSerialWorkQueueOptions {
  readonly logError?: (err: unknown) => void;
}

/**
 * FIFO work for lifecycle capture that must preserve ordering without making the
 * Pi event handler wait for persistence. `enqueue` is fire-and-forget; `run`
 * joins the same sequence when a later handler needs the produced value.
 */
export class MentisSerialWorkQueue {
  readonly #logError: (err: unknown) => void;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: MentisSerialWorkQueueOptions = {}) {
    this.#logError = options.logError ?? (() => {});
  }

  enqueue(execute: () => Promise<void>): void {
    void this.run(execute).catch(() => undefined);
  }

  run<T>(execute: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(execute);
    this.#tail = result.then(
      () => undefined,
      (err: unknown) => {
        this.#logError(err);
      },
    );
    return result;
  }

  async drain(timeoutMs?: number): Promise<boolean> {
    const pending = this.#tail;
    if (timeoutMs === undefined) {
      await pending;
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
