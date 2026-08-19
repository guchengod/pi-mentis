import type { WorkingMemorySnapshot } from "@pi-mentis/pi-mentis-memory-core";

export function shouldAcceptActiveContext(
  current: WorkingMemorySnapshot | undefined,
  incomingSessionId: string,
  incoming: WorkingMemorySnapshot,
  expected: {
    readonly sessionId?: string;
    readonly branchId: string;
    readonly branchGeneration: number;
  },
): boolean {
  if (
    incomingSessionId !== expected.sessionId ||
    incoming.sessionId !== expected.sessionId ||
    incoming.branchId !== expected.branchId ||
    (incoming.branchGeneration ?? 0) !== expected.branchGeneration
  ) {
    return false;
  }
  return (
    current === undefined ||
    current.stateId !== incoming.stateId ||
    incoming.revision > current.revision
  );
}
