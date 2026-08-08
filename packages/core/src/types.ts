export type Awaitable<T> = T | Promise<T>;

export interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly traceId?: string;
  readonly onProgress?: (event: OperationProgress) => Awaitable<void>;
}

export interface OperationProgress {
  readonly operation: string;
  readonly phase: string;
  readonly completed: number;
  readonly total?: number;
  readonly message?: string;
}

export interface JobReceipt {
  readonly jobId: string;
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly state: "queued" | "running";
}

export interface ComponentVersion {
  readonly id: string;
  readonly version: string;
}

export interface SourceLocation {
  readonly uri: string;
  readonly page?: number;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly sheet?: string;
  readonly symbol?: string;
}

export interface EvidenceRef {
  readonly kind:
    | "user"
    | "tool"
    | "knowledge"
    | "memory"
    | "capability"
    | "experience"
    | "episode"
    | "event"
    | "artifact";
  readonly id: string;
  readonly location?: SourceLocation;
  readonly observedAt: number;
}

export const EvidenceAuthority = {
  AssistantInference: 10,
  HistoricalSummary: 20,
  EpisodicMemory: 30,
  ProceduralMemory: 40,
  UserHistoricalStatement: 50,
  VerifiedToolObservation: 60,
  PiInstalledCapability: 70,
  UserKnowledge: 80,
  WorkspaceCurrent: 90,
  UserCurrentInstruction: 100,
} as const;

export type EvidenceAuthority = (typeof EvidenceAuthority)[keyof typeof EvidenceAuthority];

export interface SearchHit {
  readonly id: string;
  readonly kind: "knowledge" | "memory" | "capability";
  readonly text: string;
  readonly score: number;
  readonly tokenCount: number;
  readonly authority: EvidenceAuthority;
  readonly namespace: string;
  readonly contentHash: string;
  readonly embedding?: Float32Array;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SearchDiagnostics {
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly degraded: readonly string[];
  readonly stages: Readonly<Record<string, number>>;
  readonly traceOrder?: readonly string[];
  readonly rankings?: Readonly<{
    readonly rrf: readonly string[];
    readonly rerank: readonly string[];
    readonly mmr: readonly string[];
  }>;
  /** Per-candidate diversity-selection trace (MMR/set-completeness). */
  readonly diversity?: readonly Readonly<{
    readonly candidateId: string;
    readonly predicate?: string;
    readonly cardinality?: string;
    readonly setMemberKey?: string;
    readonly memberFactKey?: string;
    readonly pairwiseSimilarity: number;
    readonly structuralRelation: "same_member" | "set_sibling" | "unrelated";
    readonly mmrPenalty: number;
    readonly preservedBySetCompleteness: boolean;
    readonly selected: boolean;
    readonly dropReason?: string;
  }>[];
  readonly traceId?: string;
  readonly semanticQueryPlan?: Readonly<{
    readonly predicateCandidates: readonly Readonly<{
      readonly predicate: string;
      readonly confidence: number;
    }>[];
    readonly subjectCandidates: readonly Readonly<{
      readonly subject: string;
      readonly confidence: number;
    }>[];
    readonly temporalIntent: "current" | "historical" | "evolution" | "any";
    readonly retrievalMode: "focused" | "broad";
    readonly confidence: number;
    readonly memoryNeed: Readonly<{ readonly required: boolean; readonly confidence: number }>;
    readonly diagnostics?: Readonly<{
      readonly predicateMargin?: number;
      readonly predicateEntropy?: number;
      readonly plannerDegraded?: boolean;
    }>;
  }>;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly diagnostics: SearchDiagnostics;
}

export interface EmbeddingSpaceIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly normalization: "none" | "l2";
  readonly preprocessingVersion: string;
  readonly inputKindVersion: string;
}

export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error(`${operation} was cancelled`);
  }
}
