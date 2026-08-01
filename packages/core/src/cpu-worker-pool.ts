import { Worker } from "node:worker_threads";

import { OperationCancelledError, QueueFullError } from "./errors.js";
import { operationId } from "./hash.js";

export type CpuWorkerTask =
  | { readonly operation: "content-hash"; readonly text: string }
  | { readonly operation: "normalize-text"; readonly text: string }
  | { readonly operation: "token-count"; readonly text: string };

interface PendingTask {
  readonly id: string;
  readonly task: CpuWorkerTask;
  readonly signal?: AbortSignal;
  readonly resolve: (value: string | number) => void;
  readonly reject: (error: unknown) => void;
  cancelled: boolean;
}

interface WorkerSlot {
  readonly worker: Worker;
  current: PendingTask | undefined;
}

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { createHash } = require("node:crypto");
parentPort.on("message", ({ id, task }) => {
  try {
    let value;
    if (task.operation === "content-hash") {
      value = createHash("sha256").update(task.text).digest("hex");
    } else if (task.operation === "normalize-text") {
      value = task.text.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
    } else if (task.operation === "token-count") {
      value = Math.max(1, Buffer.byteLength(task.text.normalize("NFKC"), "utf8"));
    } else {
      throw new Error("Unsupported CPU worker operation");
    }
    parentPort.postMessage({ id, value });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

export class CpuWorkerPool {
  readonly #workerCount: number;
  readonly #maxQueuedTasks: number;
  readonly #workers: WorkerSlot[] = [];
  readonly #queue: PendingTask[] = [];
  #closed = false;

  constructor(workerCount: number, maxQueuedTasks = 1_000) {
    this.#workerCount = Math.max(1, workerCount);
    this.#maxQueuedTasks = Math.max(1, maxQueuedTasks);
  }

  get started(): boolean {
    return this.#workers.length > 0;
  }

  get queuedTasks(): number {
    return this.#queue.length;
  }

  run(task: CpuWorkerTask, signal?: AbortSignal): Promise<string | number> {
    if (this.#closed) return Promise.reject(new OperationCancelledError("CPU pool is closed"));
    if (signal?.aborted === true) {
      return Promise.reject(new OperationCancelledError("CPU task was cancelled"));
    }
    if (this.#queue.length >= this.#maxQueuedTasks) {
      return Promise.reject(
        new QueueFullError("CPU worker queue is full", {
          operation: "cpu-worker-schedule",
          retryable: true,
        }),
      );
    }
    this.#startLazily();
    return new Promise<string | number>((resolve, reject) => {
      const pending: PendingTask = {
        id: operationId("operation"),
        task,
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
        cancelled: false,
      };
      signal?.addEventListener(
        "abort",
        () => {
          pending.cancelled = true;
          reject(new OperationCancelledError("CPU task was cancelled"));
        },
        { once: true },
      );
      this.#queue.push(pending);
      this.#drain();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const pending of this.#queue.splice(0)) {
      pending.reject(new OperationCancelledError("CPU pool closed before task execution"));
    }
    await Promise.all(this.#workers.map(async ({ worker }) => worker.terminate()));
    this.#workers.length = 0;
  }

  #startLazily(): void {
    if (this.#workers.length > 0) return;
    for (let index = 0; index < this.#workerCount; index++) {
      const worker = new Worker(WORKER_SOURCE, { eval: true });
      const slot: WorkerSlot = { worker, current: undefined };
      worker.on("message", (message: { id: string; value?: string | number; error?: string }) => {
        const pending = slot.current;
        slot.current = undefined;
        if (pending !== undefined && !pending.cancelled && pending.id === message.id) {
          if (message.error === undefined && message.value !== undefined) {
            pending.resolve(message.value);
          } else {
            pending.reject(new Error(message.error ?? "CPU worker returned no result"));
          }
        }
        this.#drain();
      });
      worker.on("error", (error) => {
        slot.current?.reject(error);
        slot.current = undefined;
        this.#drain();
      });
      this.#workers.push(slot);
    }
  }

  #drain(): void {
    for (const slot of this.#workers) {
      if (slot.current !== undefined) continue;
      let pending = this.#queue.shift();
      while (pending?.cancelled === true) pending = this.#queue.shift();
      if (pending === undefined) return;
      slot.current = pending;
      slot.worker.postMessage({ id: pending.id, task: pending.task });
    }
  }
}
