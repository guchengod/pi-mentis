import { describe, expect, it, vi } from "vitest";

import { MentisSerialWorkQueue } from "../src/index.js";

describe("MentisSerialWorkQueue", () => {
  it("returns from enqueue without waiting and preserves lifecycle order", async () => {
    const queue = new MentisSerialWorkQueue();
    const order: string[] = [];
    let releaseStart: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });

    queue.enqueue(async () => {
      order.push("start");
      await blocked;
      order.push("started");
    });
    queue.enqueue(async () => {
      order.push("tool");
    });

    await Promise.resolve();
    expect(order).toEqual(["start"]);
    releaseStart?.();
    await queue.drain();
    expect(order).toEqual(["start", "started", "tool"]);
  });

  it("isolates a failed capture operation from later work", async () => {
    const logError = vi.fn();
    const queue = new MentisSerialWorkQueue({ logError });
    const later = vi.fn();

    queue.enqueue(async () => {
      throw new Error("capture failed");
    });
    queue.enqueue(async () => {
      later();
    });

    await queue.drain();
    expect(logError).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
  });
});
