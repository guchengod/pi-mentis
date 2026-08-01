import type { BackgroundScheduler } from "@pi-mentis/pi-mentis-core";
import { TaskPriority, operationId } from "@pi-mentis/pi-mentis-core";

import type { CapturedToolEvent, TurnCapture } from "./types.js";

export class TurnCaptureBuffer {
  readonly #eventLimit: number;
  readonly #recentFileLimit: number;
  readonly #recentSymbolLimit: number;
  readonly #events: CapturedToolEvent[] = [];
  readonly #recentFiles: string[] = [];
  readonly #recentSymbols: string[] = [];
  #turnIndex = 0;

  constructor(eventLimit = 256, recentFileLimit = 64, recentSymbolLimit = 128) {
    this.#eventLimit = eventLimit;
    this.#recentFileLimit = recentFileLimit;
    this.#recentSymbolLimit = recentSymbolLimit;
  }

  startTurn(turnIndex: number): void {
    this.#turnIndex = turnIndex;
    this.#events.length = 0;
  }

  capture(event: CapturedToolEvent): void {
    // This method intentionally performs no remote inference, Zvec access, or I/O.
    if (this.#events.length >= this.#eventLimit) this.#events.shift();
    this.#events.push({
      ...event,
      ...(event.filePaths === undefined
        ? {}
        : { filePaths: event.filePaths.slice(0, this.#recentFileLimit) }),
      ...(event.symbols === undefined
        ? {}
        : { symbols: event.symbols.slice(0, this.#recentSymbolLimit) }),
    });
    for (const filename of event.filePaths ?? []) {
      this.#recentFiles.push(filename);
      if (this.#recentFiles.length > this.#recentFileLimit) this.#recentFiles.shift();
    }
    for (const symbol of event.symbols ?? []) {
      this.#recentSymbols.push(symbol);
      if (this.#recentSymbols.length > this.#recentSymbolLimit) this.#recentSymbols.shift();
    }
  }

  seal(): TurnCapture {
    return {
      turnIndex: this.#turnIndex,
      events: [...this.#events],
      sealedAt: Date.now(),
    };
  }
}

export class CaptureProcessor {
  readonly #scheduler: BackgroundScheduler;
  readonly #process: (capture: TurnCapture, signal: AbortSignal) => Promise<void>;

  constructor(
    scheduler: BackgroundScheduler,
    process: (capture: TurnCapture, signal: AbortSignal) => Promise<void>,
  ) {
    this.#scheduler = scheduler;
    this.#process = process;
  }

  enqueue(capture: TurnCapture): void {
    if (capture.events.length === 0) return;
    const id = operationId("job");
    const scheduled = this.#scheduler.schedule({
      id,
      deduplicationKey: `turn-capture:${capture.turnIndex}:${capture.sealedAt}`,
      priority: TaskPriority.SessionMaintenance,
      estimatedBytes: Buffer.byteLength(JSON.stringify(capture), "utf8"),
      run: (signal) => this.#process(capture, signal),
    });
    void scheduled.promise.catch(() => undefined);
  }
}
