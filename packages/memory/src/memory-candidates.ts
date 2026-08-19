import {
  EvidenceAuthority,
  estimateModelTokens,
  normalizeText,
  stableHash,
  systemClock,
  throwIfAborted,
  type Clock,
  type EvidenceRef,
  type OperationOptions,
} from "@pi-mentis/pi-mentis-core";
import { ZvecStateStore, type ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import {
  boundedText,
  fitTextToModelTokens,
  lexicalOverlap,
  securityNamespaceForScope,
} from "./cognitive-shared.js";
import { classifySensitivity, detectSecrets } from "./secret-detector.js";
import type { MemoryScope, MemoryService, PiScopeContext } from "./types.js";

export type MemoryCandidateState =
  "observed" | "reinforced" | "eligible" | "promoted" | "rejected" | "expired";

export type MemoryCandidateObservationSource =
  | "user_statement"
  | "user_correction"
  | "user_commitment"
  | "verified_tool"
  | "repeated_behavior"
  | "working_memory_decision"
  | "episode_consolidation"
  | "model_hypothesis";

export interface CandidateEvidence {
  readonly id: string;
  readonly ref: EvidenceRef;
  readonly namespace: string;
  readonly text: string;
  readonly verified: boolean;
  readonly structural?: boolean;
}

export interface MemoryCandidateObservation {
  readonly id: string;
  readonly source: MemoryCandidateObservationSource;
  readonly evidenceIds: readonly string[];
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly observedAt: number;
}

export interface MemoryCandidate {
  readonly version: 1;
  readonly id: string;
  readonly namespace: string;
  readonly content: string;
  readonly normalizedContent: string;
  readonly proposedScope: MemoryScope;
  readonly scopeContext: PiScopeContext;
  readonly state: MemoryCandidateState;
  readonly observations: readonly MemoryCandidateObservation[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly explicitness: number;
  readonly stability: number;
  readonly utility: number;
  readonly confidence: number;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
  readonly expiresAt: number;
  readonly promotedMemoryId?: string;
}

export interface MemoryCandidateProposal {
  readonly content: string;
  readonly scopeHint: "user" | "project" | "repository" | "task" | "topic";
  readonly confidence: number;
  readonly durability: number;
  readonly evidenceIds: readonly string[];
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function parseMemoryCandidateProposals(
  value: unknown,
  options: { readonly maximum: number; readonly maxCharacters: number },
): readonly MemoryCandidateProposal[] {
  const rawCandidates = object(value)?.["candidates"];
  if (!Array.isArray(rawCandidates) || rawCandidates.length > options.maximum) {
    throw new Error("Memory candidate cognition returned invalid candidates");
  }
  const scopes = new Set(["user", "project", "repository", "task", "topic"]);
  return rawCandidates.map((raw) => {
    const entry = object(raw);
    const content = entry?.["content"];
    const scopeHint = entry?.["scopeHint"];
    const confidence = entry?.["confidence"];
    const durability = entry?.["durability"];
    const evidenceIds = entry?.["evidenceIds"];
    if (
      typeof content !== "string" ||
      typeof scopeHint !== "string" ||
      !scopes.has(scopeHint) ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      typeof durability !== "number" ||
      !Number.isFinite(durability) ||
      durability < 0 ||
      durability > 1 ||
      !Array.isArray(evidenceIds) ||
      evidenceIds.length === 0 ||
      evidenceIds.length > 16 ||
      evidenceIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("Memory candidate cognition returned an invalid candidate");
    }
    return {
      content: boundedText(content, options.maxCharacters),
      scopeHint: scopeHint as MemoryCandidateProposal["scopeHint"],
      confidence,
      durability,
      evidenceIds: evidenceIds as readonly string[],
    };
  });
}

export interface CandidateTriggerSignals {
  readonly durable: boolean;
  readonly correction: boolean;
  readonly commitment: boolean;
  readonly speculative: boolean;
  readonly transient: boolean;
  readonly questionLike: boolean;
  readonly userPreference: boolean;
  readonly shouldAnalyze: boolean;
}

export interface MemoryFormationPolicy {
  readonly autoPromotion: boolean;
  readonly maxCandidatesPerTurn: number;
  readonly candidateMaxCharacters: number;
  readonly candidateTtlMs: number;
  readonly minimumPreferenceObservations: number;
  readonly minimumBehaviorObservations: number;
}

export interface ObserveMemoryCandidateInput {
  readonly proposal: MemoryCandidateProposal;
  readonly source: MemoryCandidateObservationSource;
  readonly scopeContext: PiScopeContext;
  readonly evidence: readonly CandidateEvidence[];
  readonly observationId: string;
  readonly observedAt?: number;
}

export type ObserveMemoryCandidateResult =
  | { readonly outcome: "created" | "reinforced" | "promoted"; readonly candidate: MemoryCandidate }
  | { readonly outcome: "rejected"; readonly reason: string };

const DURABLE = /(?:默认|以后|一直|通常|习惯|长期|always|normally|default|prefer)/iu;
const CORRECTION = /(?:不是|不对|改成|更新为|现在是|不再|changed\s+to|instead)/iu;
const COMMITMENT = /(?:统一使用|以后都|必须|固定使用|shall|always\s+use)/iu;
const SPECULATIVE = /(?:可能|也许|试试|考虑|maybe|perhaps|try)/iu;
const TRANSIENT = /(?:现在先|这次先|暂时|今天|today|for\s+now)/iu;
const USER_PREFERENCE =
  /(?:我(?:一般|通常|一直|更)?(?:喜欢|偏好|不喜欢)|i\s+(?:usually\s+)?prefer)/iu;

export function detectMemoryCandidateTrigger(statement: string): CandidateTriggerSignals {
  const text = boundedText(statement, 2_000);
  const durable = DURABLE.test(text);
  const correction = CORRECTION.test(text);
  const commitment = COMMITMENT.test(text);
  const speculative = SPECULATIVE.test(text);
  const transient = TRANSIENT.test(text);
  const questionLike =
    /[?？]\s*$/u.test(text) || /^(?:是否|能否|可以吗|why\b|how\b|what\b)/iu.test(text);
  const userPreference = USER_PREFERENCE.test(text);
  return {
    durable,
    correction,
    commitment,
    speculative,
    transient,
    questionLike,
    userPreference,
    shouldAnalyze:
      (durable || correction || commitment || userPreference) &&
      !speculative &&
      !transient &&
      !questionLike,
  };
}

export function candidateObservationSource(
  signals: CandidateTriggerSignals,
): MemoryCandidateObservationSource {
  if (signals.correction) return "user_correction";
  if (signals.commitment) return "user_commitment";
  return "user_statement";
}

export function buildCandidateCognitionInput(input: {
  readonly statement: string;
  readonly scopeContext: PiScopeContext;
  readonly signals: CandidateTriggerSignals;
  readonly evidence: readonly CandidateEvidence[];
  readonly maxTokens: number;
}): Readonly<Record<string, unknown>> {
  const payload = {
    statement: boundedText(input.statement, 2_000),
    scope: {
      ...(input.scopeContext.repositoryId === undefined
        ? {}
        : { repositoryId: input.scopeContext.repositoryId }),
      ...(input.scopeContext.projectId === undefined
        ? {}
        : { projectId: input.scopeContext.projectId }),
      ...(input.scopeContext.taskId === undefined ? {} : { taskId: input.scopeContext.taskId }),
    },
    signals: input.signals,
    evidence: input.evidence.slice(0, 8).map((entry) => ({
      id: entry.id,
      text: boundedText(entry.text, 500),
      verified: entry.verified,
      structural: entry.structural === true,
    })),
  };
  const serialized = fitTextToModelTokens(JSON.stringify(payload), input.maxTokens);
  return { serialized, estimatedTokens: estimateModelTokens(serialized) };
}

function canonicalAssertion(text: string): string {
  return normalizeText(text)
    .toLocaleLowerCase()
    .replace(/^(?:我|i)\s*/iu, "")
    .replace(/(?:一般|通常|normally|usually)/giu, "usually")
    .replace(/(?:以后|from\s+now\s+on)/giu, "")
    .replace(/[^\p{L}\p{N}._:/-]+/gu, " ")
    .trim();
}

function isUserPreference(text: string): boolean {
  return USER_PREFERENCE.test(text);
}

function proposedScope(
  source: MemoryCandidateObservationSource,
  proposal: MemoryCandidateProposal,
  context: PiScopeContext,
): MemoryScope {
  if (
    source === "user_statement" &&
    isUserPreference(proposal.content) &&
    proposal.scopeHint === "user"
  ) {
    return { kind: "user", id: context.userId };
  }
  if (source === "verified_tool" || source === "episode_consolidation") {
    if (context.repositoryId !== undefined) return { kind: "repository", id: context.repositoryId };
    if (context.projectId !== undefined) return { kind: "project", id: context.projectId };
    return { kind: "task", id: context.taskId ?? context.sessionId ?? context.userId };
  }
  if (source === "user_commitment" || source === "user_correction") {
    if (proposal.scopeHint === "repository" && context.repositoryId !== undefined) {
      return { kind: "repository", id: context.repositoryId };
    }
    if (proposal.scopeHint === "project" && context.projectId !== undefined) {
      return { kind: "project", id: context.projectId };
    }
    if (proposal.scopeHint === "user" && isUserPreference(proposal.content)) {
      return { kind: "user", id: context.userId };
    }
  }
  return { kind: "task", id: context.taskId ?? context.sessionId ?? context.userId };
}

function explicitness(source: MemoryCandidateObservationSource): number {
  if (source === "user_commitment" || source === "user_correction") return 1;
  if (source === "user_statement") return 0.8;
  if (source === "verified_tool" || source === "episode_consolidation") return 0.7;
  if (source === "working_memory_decision") return 0.6;
  if (source === "repeated_behavior") return 0.4;
  return 0;
}

function eligibility(
  candidate: MemoryCandidate,
  policy: MemoryFormationPolicy,
): MemoryCandidateState {
  const observations = candidate.observations.length;
  const sources = new Set(candidate.observations.map((entry) => entry.source));
  if (
    (sources.has("user_commitment") || sources.has("user_correction")) &&
    candidate.confidence >= 0.8 &&
    candidate.stability >= 0.75
  ) {
    return "eligible";
  }
  if (
    sources.has("user_statement") &&
    isUserPreference(candidate.content) &&
    observations >= policy.minimumPreferenceObservations
  ) {
    return "eligible";
  }
  if (
    sources.has("repeated_behavior") &&
    observations >= policy.minimumBehaviorObservations &&
    candidate.proposedScope.kind !== "user"
  ) {
    return "eligible";
  }
  if (
    (sources.has("verified_tool") || sources.has("episode_consolidation")) &&
    candidate.evidenceRefs.length >= 1 &&
    ((sources.has("episode_consolidation") &&
      candidate.confidence >= 0.9 &&
      candidate.stability >= 0.85) ||
      observations >= 2)
  ) {
    return "eligible";
  }
  return observations > 1 ? "reinforced" : "observed";
}

export class MemoryCandidateService {
  readonly #state: ZvecStateStore;
  readonly #memory: MemoryService;
  readonly #policy: MemoryFormationPolicy;
  readonly #clock: Clock;

  constructor(
    store: ZvecStore,
    memory: MemoryService,
    policy: MemoryFormationPolicy,
    clock: Clock = systemClock,
  ) {
    this.#state = new ZvecStateStore(store);
    this.#memory = memory;
    this.#policy = policy;
    this.#clock = clock;
  }

  async observe(
    input: ObserveMemoryCandidateInput,
    options: OperationOptions = {},
  ): Promise<ObserveMemoryCandidateResult> {
    throwIfAborted(options.signal, "memory-candidate-observe");
    if (input.source === "model_hypothesis") {
      return { outcome: "rejected", reason: "model_hypothesis_is_not_authoritative" };
    }
    const content = boundedText(input.proposal.content, this.#policy.candidateMaxCharacters);
    if (content === "") return { outcome: "rejected", reason: "empty_candidate" };
    const sensitivity = classifySensitivity(content).sensitivity;
    if (
      detectSecrets(content).sensitive ||
      sensitivity === "sensitive" ||
      sensitivity === "secret"
    ) {
      return { outcome: "rejected", reason: "sensitive_candidate" };
    }
    const namespace = securityNamespaceForScope(input.scopeContext);
    const evidenceById = new Map(input.evidence.map((entry) => [entry.id, entry]));
    if (
      input.proposal.evidenceIds.length === 0 ||
      input.proposal.evidenceIds.some((id) => evidenceById.get(id)?.namespace !== namespace)
    ) {
      return { outcome: "rejected", reason: "missing_or_cross_namespace_evidence" };
    }
    const selectedEvidence = input.proposal.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((entry): entry is CandidateEvidence => entry !== undefined);
    if (selectedEvidence.every((entry) => lexicalOverlap(content, entry.text) < 0.2)) {
      return { outcome: "rejected", reason: "candidate_not_grounded_in_evidence" };
    }
    if (
      (input.source === "verified_tool" || input.source === "episode_consolidation") &&
      !selectedEvidence.some((entry) => entry.verified || entry.structural === true)
    ) {
      return { outcome: "rejected", reason: "unverified_tool_evidence" };
    }
    const scope = proposedScope(input.source, input.proposal, input.scopeContext);
    const normalizedContent = canonicalAssertion(content);
    const candidates = await this.list(namespace, { includeTerminal: false });
    const existing = candidates
      .filter(
        (candidate) =>
          candidate.proposedScope.kind === scope.kind && candidate.proposedScope.id === scope.id,
      )
      .map((candidate) => ({
        candidate,
        overlap: lexicalOverlap(candidate.normalizedContent, normalizedContent),
      }))
      .filter(
        (entry) => entry.candidate.normalizedContent === normalizedContent || entry.overlap >= 0.65,
      )
      .sort((left, right) => right.overlap - left.overlap)[0]?.candidate;
    const now = input.observedAt ?? this.#clock.now();
    const observation: MemoryCandidateObservation = {
      id: input.observationId,
      source: input.source,
      evidenceIds: [...new Set(input.proposal.evidenceIds)].slice(0, 16),
      ...(input.scopeContext.sessionId === undefined
        ? {}
        : { sessionId: input.scopeContext.sessionId }),
      ...(input.scopeContext.taskId === undefined ? {} : { taskId: input.scopeContext.taskId }),
      observedAt: now,
    };
    if (existing?.observations.some((entry) => entry.id === observation.id)) {
      return {
        outcome: existing.state === "promoted" ? "promoted" : "reinforced",
        candidate: existing,
      };
    }
    const observations = [...(existing?.observations ?? []), observation].slice(-64);
    const evidenceRefs = [
      ...(existing?.evidenceRefs ?? []),
      ...selectedEvidence.map((entry) => entry.ref),
    ]
      .filter(
        (ref, index, all) =>
          all.findIndex((item) => item.kind === ref.kind && item.id === ref.id) === index,
      )
      .slice(-64);
    const base: MemoryCandidate = {
      version: 1,
      id:
        existing?.id ??
        stableHash("memory-candidate:v1", namespace, scope.kind, scope.id, normalizedContent),
      namespace,
      content,
      normalizedContent,
      proposedScope: scope,
      scopeContext: input.scopeContext,
      state: "observed",
      observations,
      evidenceRefs,
      explicitness: Math.max(existing?.explicitness ?? 0, explicitness(input.source)),
      stability: Math.max(
        existing?.stability ?? 0,
        Math.max(0, Math.min(1, input.proposal.durability)),
      ),
      utility: Math.max(existing?.utility ?? 0, Math.min(1, 0.4 + observations.length * 0.15)),
      confidence: Math.max(
        existing?.confidence ?? 0,
        Math.max(0, Math.min(1, input.proposal.confidence)),
      ),
      firstObservedAt: existing?.firstObservedAt ?? now,
      lastObservedAt: now,
      expiresAt: now + this.#policy.candidateTtlMs,
      ...(existing?.promotedMemoryId === undefined
        ? {}
        : { promotedMemoryId: existing.promotedMemoryId }),
    };
    let candidate: MemoryCandidate = { ...base, state: eligibility(base, this.#policy) };
    await this.#put(candidate);
    if (candidate.state === "eligible" && this.#policy.autoPromotion) {
      candidate = await this.promote(candidate.id, options);
      return { outcome: "promoted", candidate };
    }
    return { outcome: existing === undefined ? "created" : "reinforced", candidate };
  }

  async promote(id: string, options: OperationOptions = {}): Promise<MemoryCandidate> {
    throwIfAborted(options.signal, "memory-candidate-promote");
    const candidate = await this.get(id);
    if (candidate === undefined) throw new Error(`Unknown memory candidate ${id}`);
    if (candidate.state !== "eligible") {
      throw new Error(`Memory candidate ${id} is not eligible (${candidate.state})`);
    }
    if (candidate.evidenceRefs.length === 0 || detectSecrets(candidate.content).sensitive) {
      throw new Error("Memory candidate promotion requires safe source evidence");
    }
    const sources = new Set(candidate.observations.map((entry) => entry.source));
    const userGrounded = [...sources].some((source) =>
      ["user_statement", "user_correction", "user_commitment"].includes(source),
    );
    const verified = [...sources].some((source) =>
      ["verified_tool", "episode_consolidation"].includes(source),
    );
    const result = await this.#memory.commit(
      {
        content: candidate.content,
        scope: candidate.proposedScope,
        scopeContext: candidate.scopeContext,
        authority: userGrounded
          ? EvidenceAuthority.UserHistoricalStatement
          : EvidenceAuthority.VerifiedToolObservation,
        confidence: candidate.confidence,
        importance: Math.max(0.5, candidate.utility),
        evidenceRefs: candidate.evidenceRefs,
        idempotencyKey: `memory-candidate:${candidate.id}`,
        provenance: {
          origin: userGrounded ? "user" : "tool",
          epistemicState: verified ? "verified" : "asserted",
          ...(candidate.scopeContext.branchId === undefined
            ? {}
            : { branchId: candidate.scopeContext.branchId }),
        },
      },
      options,
    );
    const promoted: MemoryCandidate = {
      ...candidate,
      state:
        result.outcome === "rejected" || result.outcome === "rejected_sensitive"
          ? "rejected"
          : "promoted",
      lastObservedAt: this.#clock.now(),
      ...(result.record?.id === undefined ? {} : { promotedMemoryId: result.record.id }),
    };
    await this.#put(promoted);
    return promoted;
  }

  async get(id: string): Promise<MemoryCandidate | undefined> {
    return (await this.#state.get<MemoryCandidate>(id))?.value;
  }

  async list(
    namespace: string,
    options: { readonly includeTerminal?: boolean; readonly now?: number } = {},
  ): Promise<readonly MemoryCandidate[]> {
    const now = options.now ?? this.#clock.now();
    const records = await this.#state.list<MemoryCandidate>({
      kind: "memory-candidate-v1",
      namespace,
      limit: 1_000,
    });
    const candidates: MemoryCandidate[] = [];
    for (const record of records) {
      let candidate = record.value;
      if (
        candidate.expiresAt <= now &&
        candidate.state !== "promoted" &&
        candidate.state !== "rejected" &&
        candidate.state !== "expired"
      ) {
        candidate = { ...candidate, state: "expired", lastObservedAt: now };
        await this.#put(candidate);
      }
      if (
        options.includeTerminal === true ||
        (candidate.state !== "promoted" &&
          candidate.state !== "rejected" &&
          candidate.state !== "expired")
      ) {
        candidates.push(candidate);
      }
    }
    return candidates.sort((left, right) => right.lastObservedAt - left.lastObservedAt);
  }

  async #put(candidate: MemoryCandidate): Promise<void> {
    await this.#state.put(
      {
        id: candidate.id,
        kind: "memory-candidate-v1",
        namespace: candidate.namespace,
        value: candidate,
      },
      { status: candidate.state, now: candidate.lastObservedAt },
    );
  }
}
