import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { formatPiToolJson, normalizePiPathArgument, notifyWhenUiAvailable } from "../src/index.js";

describe("Pi extension support", () => {
  it("formats small tool results without a truncation notice", () => {
    expect(formatPiToolJson({ ok: true })).toBe('{\n  "ok": true\n}');
  });

  it("keeps large tool results inside Pi's output limits", () => {
    const output = formatPiToolJson({
      rows: Array.from({ length: 4_000 }, (_, index) => ({ index })),
    });

    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(output.split("\n")).toHaveLength(DEFAULT_MAX_LINES);
    expect(output).toContain("[Output truncated:");
    expect(output).toContain("Full data remains in Pi Mentis");
  });

  it("normalizes only the leading path marker", () => {
    expect(normalizePiPathArgument("@/tmp/book.md")).toBe("/tmp/book.md");
    expect(normalizePiPathArgument("@@scope/file.md")).toBe("@scope/file.md");
    expect(normalizePiPathArgument("/tmp/@book.md")).toBe("/tmp/@book.md");
  });

  it("does not call UI notifications in headless modes", () => {
    const notify = vi.fn();

    expect(notifyWhenUiAvailable({ hasUI: false, ui: { notify } }, "hidden", "info")).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(notifyWhenUiAvailable({ hasUI: true, ui: { notify } }, "visible", "info")).toBe(true);
    expect(notify).toHaveBeenCalledWith("visible", "info");
  });
});
