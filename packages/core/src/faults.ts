/**
 * Fault injection for Pi Mentis testing.
 *
 * ONLY active when PI_MENTIS_TEST_MODE=1.
 * In production mode, all fault injection functions are no-ops.
 */

const TEST_MODE = process.env["PI_MENTIS_TEST_MODE"] === "1";

export type FaultType =
  | "embedding_timeout"
  | "embedding_429"
  | "embedding_401"
  | "rerank_503"
  | "rerank_timeout"
  | "zvec_unavailable"
  | "job_crash_after_claim";

export function isFaultInjectionEnabled(): boolean {
  return TEST_MODE;
}

export function getActiveFault(): FaultType | undefined {
  if (!TEST_MODE) return undefined;

  const faultEmbedding = process.env["PI_MENTIS_FAULT_EMBEDDING"];
  if (faultEmbedding !== undefined) {
    if (faultEmbedding === "timeout") return "embedding_timeout";
    if (faultEmbedding === "429") return "embedding_429";
    if (faultEmbedding === "401") return "embedding_401";
  }

  const faultRerank = process.env["PI_MENTIS_FAULT_RERANK"];
  if (faultRerank !== undefined) {
    if (faultRerank === "503") return "rerank_503";
    if (faultRerank === "timeout") return "rerank_timeout";
  }

  if (process.env["PI_MENTIS_FAULT_ZVEC"] === "unavailable") return "zvec_unavailable";
  if (process.env["PI_MENTIS_FAULT_JOB"] === "crash_after_claim") return "job_crash_after_claim";

  return undefined;
}

export function shouldInjectFault(type: FaultType): boolean {
  if (!TEST_MODE) return false;
  return getActiveFault() === type;
}

/**
 * Inject a fault if the corresponding environment variable is set.
 * Throws an error with a FAULT_INJECTED prefix to distinguish from real errors.
 */
export function injectFault(type: FaultType): void {
  if (!shouldInjectFault(type)) return;
  switch (type) {
    case "embedding_timeout":
      throw new Error("FAULT_INJECTED: Embedding timeout");
    case "embedding_429":
      throw new Error("FAULT_INJECTED: Embedding rate limited (429)");
    case "embedding_401":
      throw new Error("FAULT_INJECTED: Embedding unauthorized (401)");
    case "rerank_503":
      throw new Error("FAULT_INJECTED: Rerank service unavailable (503)");
    case "rerank_timeout":
      throw new Error("FAULT_INJECTED: Rerank timeout");
    case "zvec_unavailable":
      throw new Error("FAULT_INJECTED: Zvec store unavailable");
    case "job_crash_after_claim":
      throw new Error("FAULT_INJECTED: Job crashed after claim");
  }
}
