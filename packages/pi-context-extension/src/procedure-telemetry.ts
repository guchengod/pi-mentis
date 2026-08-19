import type { ProcedureLifecycleEvent } from "@pi-mentis/pi-mentis-memory-core";

export interface ForegroundProcedureTelemetryInput {
  readonly clientSessionId: string;
  readonly turnId: string;
  readonly candidateId: string;
  readonly familyKey: string;
  readonly memoryId: string;
  readonly rank: number;
  readonly score: number;
  readonly gateDecision: "allowed";
  readonly tokenCost: number;
}

export function foregroundProcedureLifecycleEvents(
  input: ForegroundProcedureTelemetryInput,
  timestamp = Date.now(),
): readonly ProcedureLifecycleEvent[] {
  const base = {
    candidateId: input.candidateId,
    familyKey: input.familyKey,
    sessionId: input.clientSessionId,
    taskEpisodeId: input.turnId,
    revision: 0,
    timestamp,
    memoryId: input.memoryId,
    turnId: input.turnId,
    rank: input.rank,
    score: input.score,
    gateDecision: input.gateDecision,
    tokenCost: input.tokenCost,
  } as const;
  return [
    { name: "procedure.retrieved", ...base },
    { name: "procedure.selected", ...base },
    { name: "procedure.injected", ...base },
  ];
}
