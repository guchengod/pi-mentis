import { availableParallelism } from "node:os";

import { OperationCancelledError, QueueFullError } from "./errors.js";
import { systemClock, type Clock } from "./clock.js";

export const TaskPriority = {
  Interactive: 100,
  UserRequested: 80,
  SessionMaintenance: 50,
  BackgroundSync: 30,
  Migration: 20,
  GarbageCollection: 10,
} as const;

export interface DeferredIdleWorkOptions {
  /** Quiet period after the agent settles before cold/background work may start. */
  readonly delayMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Holds one-shot startup work until Pi has completed an interactive turn and
 * the terminal has stayed quiet for a short period. New input cancels the
 * timer; the next `settled()` call arms it again.
 */
export class DeferredIdleWork {
  readonly #delayMs: number;
  readonly #onError: (error: unknown) => void;
  #work: (() => void | Promise<void>) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DeferredIdleWorkOptions = {}) {
    this.#delayMs = Math.max(0, options.delayMs ?? 750);
    this.#onError = options.onError ?? (() => undefined);
  }

  set(work: () => void | Promise<void>): void {
    this.cancelTimer();
    this.#work = work;
  }

  activity(): void {
    this.cancelTimer();
  }

  settled(): void {
    if (this.#work === undefined || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const work = this.#work;
      this.#work = undefined;
      if (work !== undefined) void Promise.resolve().then(work).catch(this.#onError);
    }, this.#delayMs);
    this.#timer.unref?.();
  }

  cancel(): void {
    this.cancelTimer();
    this.#work = undefined;
  }

  get pending(): boolean {
    return this.#work !== undefined;
  }

  private cancelTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export interface QueueLimits {
  readonly maxQueuedTasks: number;
  readonly maxQueuedBytes: number;
  readonly maxActiveTasks: number;
  readonly maxPendingEmbeddingTokens: number;
  readonly maxPendingRerankTokens: number;
  readonly maxQueuedTaskAgeMs?: number;
}

export interface ScheduledTask<T> {
  readonly id: string;
  readonly deduplicationKey?: string;
  readonly priority: TaskPriority;
  readonly estimatedBytes: number;
  readonly signal?: AbortSignal;
  run(signal: AbortSignal): Promise<T>;
}

interface QueueEntry<T> {
  readonly sequence: number;
  readonly enqueuedAt: number;
  readonly task: ScheduledTask<T>;
  readonly controller: AbortController;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export class PriorityHeap<T> {
  readonly #items: T[] = [];
  readonly #compare: (left: T, right: T) => number;

  constructor(compare: (left: T, right: T) => number) {
    this.#compare = compare;
  }

  get size(): number {
    return this.#items.length;
  }

  peek(): T | undefined {
    return this.#items[0];
  }

  push(item: T): void {
    this.#items.push(item);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentItem = this.#items[parent];
      if (parentItem === undefined || this.#compare(parentItem, item) >= 0) break;
      this.#items[index] = parentItem;
      index = parent;
    }
    this.#items[index] = item;
  }

  pop(): T | undefined {
    const first = this.#items[0];
    const last = this.#items.pop();
    if (first === undefined || last === undefined || this.#items.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let candidate = index;
      const leftItem = this.#items[left];
      const rightItem = this.#items[right];
      const candidateItem = candidate === index ? last : this.#items[candidate];
      if (
        leftItem !== undefined &&
        candidateItem !== undefined &&
        this.#compare(leftItem, candidateItem) > 0
      ) {
        candidate = left;
      }
      const nextCandidate = candidate === index ? last : this.#items[candidate];
      if (
        rightItem !== undefined &&
        nextCandidate !== undefined &&
        this.#compare(rightItem, nextCandidate) > 0
      ) {
        candidate = right;
      }
      if (candidate === index) break;
      const moved = this.#items[candidate];
      if (moved === undefined) break;
      this.#items[index] = moved;
      index = candidate;
    }
    this.#items[index] = last;
    return first;
  }
}

export interface SchedulerSnapshot {
  readonly queuedTasks: number;
  readonly queuedBytes: number;
  readonly activeTasks: number;
}

export class BackgroundScheduler {
  readonly #limits: QueueLimits;
  readonly #clock: Clock;
  readonly #heap = new PriorityHeap<QueueEntry<unknown>>(
    (left, right) => left.task.priority - right.task.priority || right.sequence - left.sequence,
  );
  readonly #deduplicated = new Map<string, Promise<unknown>>();
  readonly #controllers = new Map<string, AbortController>();
  #queuedBytes = 0;
  #active = 0;
  #sequence = 0;
  #closed = false;

  constructor(limits: QueueLimits, clock: Clock = systemClock) {
    this.#limits = limits;
    this.#clock = clock;
  }

  snapshot(): SchedulerSnapshot {
    return {
      queuedTasks: this.#heap.size,
      queuedBytes: this.#queuedBytes,
      activeTasks: this.#active,
    };
  }

  schedule<T>(task: ScheduledTask<T>): {
    readonly promise: Promise<T>;
    readonly deduplicated: boolean;
  } {
    if (this.#closed) {
      return {
        promise: Promise.reject(new OperationCancelledError("Scheduler is closed")),
        deduplicated: false,
      };
    }
    const key = task.deduplicationKey;
    const existing = key === undefined ? undefined : this.#deduplicated.get(key);
    if (existing !== undefined) {
      return { promise: existing as Promise<T>, deduplicated: true };
    }
    const background = task.priority < TaskPriority.UserRequested;
    const backgroundTaskLimit = Math.max(1, Math.floor(this.#limits.maxQueuedTasks * 0.8));
    const backgroundByteLimit = Math.max(1, Math.floor(this.#limits.maxQueuedBytes * 0.8));
    if (
      this.#heap.size >= this.#limits.maxQueuedTasks ||
      this.#queuedBytes + task.estimatedBytes > this.#limits.maxQueuedBytes ||
      (background &&
        (this.#heap.size >= backgroundTaskLimit ||
          this.#queuedBytes + task.estimatedBytes > backgroundByteLimit))
    ) {
      return {
        promise: Promise.reject(
          new QueueFullError(`Queue capacity exceeded for task ${task.id}`, {
            operation: "schedule",
            retryable: true,
          }),
        ),
        deduplicated: false,
      };
    }
    const controller = new AbortController();
    if (task.signal !== undefined) {
      if (task.signal.aborted) controller.abort(task.signal.reason);
      else {
        task.signal.addEventListener("abort", () => controller.abort(task.signal?.reason), {
          once: true,
        });
      }
    }
    let resolvePromise: (value: T) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const entry: QueueEntry<T> = {
      sequence: this.#sequence++,
      enqueuedAt: this.#clock.now(),
      task,
      controller,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.#queuedBytes += task.estimatedBytes;
    this.#controllers.set(task.id, controller);
    this.#heap.push(entry as QueueEntry<unknown>);
    if (key !== undefined) {
      this.#deduplicated.set(key, promise);
      void promise.then(
        () => this.#deduplicated.delete(key),
        () => this.#deduplicated.delete(key),
      );
    }
    queueMicrotask(() => this.#drain());
    return { promise, deduplicated: false };
  }

  cancel(taskId: string, reason = "Task cancelled"): boolean {
    const controller = this.#controllers.get(taskId);
    if (controller === undefined) return false;
    controller.abort(new OperationCancelledError(reason));
    return true;
  }

  async close(timeoutMs = 5_000): Promise<void> {
    this.#closed = true;
    const startedAt = Date.now();
    const graceMs = Math.min(2_500, Math.max(0, timeoutMs / 2));
    while (this.#heap.size > 0) {
      const entry = this.#heap.pop();
      if (entry === undefined) break;
      entry.controller.abort();
      this.#controllers.delete(entry.task.id);
      entry.reject(new OperationCancelledError(`Task ${entry.task.id} was cancelled`));
    }
    while (this.#active > 0 && Date.now() - startedAt < graceMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    if (this.#active > 0) {
      for (const controller of this.#controllers.values()) {
        controller.abort(new OperationCancelledError("Scheduler is shutting down"));
      }
    }
    while (this.#active > 0 && Date.now() - startedAt < timeoutMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  #drain(): void {
    while (this.#active < this.#limits.maxActiveTasks) {
      const next = this.#heap.peek();
      if (next === undefined) return;
      const reservesInteractiveLane =
        this.#limits.maxActiveTasks > 1 && next.task.priority < TaskPriority.UserRequested;
      if (reservesInteractiveLane && this.#active >= this.#limits.maxActiveTasks - 1) return;
      const entry = this.#heap.pop();
      if (entry === undefined) return;
      this.#queuedBytes -= entry.task.estimatedBytes;
      if (
        entry.task.priority < TaskPriority.UserRequested &&
        this.#limits.maxQueuedTaskAgeMs !== undefined &&
        this.#clock.now() - entry.enqueuedAt > this.#limits.maxQueuedTaskAgeMs
      ) {
        this.#controllers.delete(entry.task.id);
        entry.reject(new OperationCancelledError(`Task ${entry.task.id} expired in the queue`));
        continue;
      }
      if (entry.controller.signal.aborted) {
        this.#controllers.delete(entry.task.id);
        entry.reject(new OperationCancelledError(`Task ${entry.task.id} was cancelled`));
        continue;
      }
      this.#active++;
      void entry.task
        .run(entry.controller.signal)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.#controllers.delete(entry.task.id);
          this.#active--;
          this.#drain();
        });
    }
  }
}

export class ForegroundExecutor {
  async execute<T>(
    operation: string,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`${operation} exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    parentSignal?.addEventListener("abort", () => controller.abort(parentSignal.reason), {
      once: true,
    });
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function defaultCpuWorkerCount(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

export interface ProviderRateLimits {
  readonly requestsPerSecond?: number;
  readonly concurrentRequests: number;
  readonly tokensPerMinute?: number;
}

export class AsyncSemaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(concurrency: number) {
    this.#available = Math.max(1, concurrency);
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw new OperationCancelledError("Semaphore acquire cancelled");
    if (this.#available > 0) {
      this.#available--;
      return () => this.#release();
    }
    await new Promise<void>((resolve, reject) => {
      let queuedWaiter: (() => void) | undefined;
      const onAbort = (): void => {
        const index = queuedWaiter === undefined ? -1 : this.#waiters.indexOf(queuedWaiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new OperationCancelledError("Semaphore acquire cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queuedWaiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.#waiters.push(queuedWaiter);
    });
    return () => this.#release();
  }

  #release(): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter();
    else this.#available++;
  }
}
