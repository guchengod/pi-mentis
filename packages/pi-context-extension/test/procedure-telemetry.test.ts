import { describe, expect, it } from "vitest";

import { foregroundProcedureLifecycleEvents } from "../src/procedure-telemetry.js";

describe("procedure foreground telemetry", () => {
  it("links retrieved, selected, and injected stages to one family, memory, and turn", () => {
    const events = foregroundProcedureLifecycleEvents(
      {
        clientSessionId: "session:new",
        turnId: "turn:4",
        candidateId: "candidate:optional-config",
        familyKey: "procedure-family:optional-config",
        memoryId: "memory:optional-config-procedure",
        rank: 1,
        score: 42.4,
        gateDecision: "allowed",
        tokenCost: 156,
      },
      1_234,
    );
    expect(events.map((event) => event.name)).toEqual([
      "procedure.retrieved",
      "procedure.selected",
      "procedure.injected",
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: "candidate:optional-config",
          familyKey: "procedure-family:optional-config",
          memoryId: "memory:optional-config-procedure",
          turnId: "turn:4",
          rank: 1,
          score: 42.4,
          gateDecision: "allowed",
          tokenCost: 156,
          timestamp: 1_234,
        }),
      ]),
    );
  });
});
