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
  readonly sourceKind?: "user" | "tool" | "verification" | "manifest";
  readonly polarity?: "positive" | "negative";
  readonly firstPersonPreferenceEvidence?: boolean;
  readonly explicitCorrection?: boolean;
  readonly explicitCommitment?: boolean;
  readonly allowedScopeCeiling?: "task" | "repository" | "project" | "user";
  readonly authority?: EvidenceAuthority;
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
  readonly derivedAuthority?: EvidenceAuthority;
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
  readonly support?: readonly {
    readonly evidenceId: string;
    readonly relation: "entailed" | "contradicted" | "insufficient";
  }[];
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
    const rawSupport = entry?.["support"];
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
    if (
      !Array.isArray(rawSupport) ||
      rawSupport.length === 0 ||
      rawSupport.some((raw) => {
        const support = object(raw);
        return (
          typeof support?.["evidenceId"] !== "string" ||
          !["entailed", "contradicted", "insufficient"].includes(String(support?.["relation"]))
        );
      })
    ) {
      throw new Error("Memory candidate cognition returned invalid support judgments");
    }
    return {
      content: boundedText(content, options.maxCharacters),
      scopeHint: scopeHint as MemoryCandidateProposal["scopeHint"],
      confidence,
      durability,
      evidenceIds: evidenceIds as readonly string[],
      support: rawSupport.map((raw) => {
        const support = object(raw) as Readonly<Record<string, unknown>>;
        return {
          evidenceId: support["evidenceId"] as string,
          relation: support["relation"] as "entailed" | "contradicted" | "insufficient",
        };
      }),
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
      sourceKind: entry.sourceKind,
      polarity: entry.polarity ?? claimPolarity(entry.text),
      firstPersonPreferenceEvidence: entry.firstPersonPreferenceEvidence === true,
      explicitCorrection: entry.explicitCorrection === true,
      explicitCommitment: entry.explicitCommitment === true,
      allowedScopeCeiling: entry.allowedScopeCeiling ?? "task",
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

const NEGATIVE_CLAIM =
  /(?:\b(?:not|never|no|without|fail(?:ed|s|ing)?)\b|不(?:是|会|能|再|通过|喜欢)?|未|无|失败)/iu;

function claimPolarity(text: string): "positive" | "negative" {
  return NEGATIVE_CLAIM.test(text) ? "negative" : "positive";
}

const SCOPE_RANK = { task: 0, repository: 1, project: 2, user: 3 } as const;

function scopeCeiling(evidence: readonly CandidateEvidence[]): keyof typeof SCOPE_RANK {
  return evidence.reduce<keyof typeof SCOPE_RANK>((ceiling, entry) => {
    const next = entry.allowedScopeCeiling ?? "task";
    return SCOPE_RANK[next] < SCOPE_RANK[ceiling] ? next : ceiling;
  }, "user");
}

function proposedScope(
  source: MemoryCandidateObservationSource,
  proposal: MemoryCandidateProposal,
  context: PiScopeContext,
  evidence: readonly CandidateEvidence[],
): MemoryScope {
  const ceiling = scopeCeiling(evidence);
  if (
    source === "user_statement" &&
    isUserPreference(proposal.content) &&
    proposal.scopeHint === "user" &&
    ceiling === "user" &&
    evidence.some((entry) => entry.firstPersonPreferenceEvidence === true)
  ) {
    return { kind: "user", id: context.userId };
  }
  if (source === "verified_tool" || source === "episode_consolidation") {
    if (ceiling !== "task" && context.repositoryId !== undefined)
      return { kind: "repository", id: context.repositoryId };
    if (SCOPE_RANK[ceiling] >= SCOPE_RANK.project && context.projectId !== undefined)
      return { kind: "project", id: context.projectId };
    return { kind: "task", id: context.taskId ?? context.sessionId ?? context.userId };
  }
  if (source === "user_commitment" || source === "user_correction") {
    if (
      proposal.scopeHint === "repository" &&
      SCOPE_RANK[ceiling] >= SCOPE_RANK.repository &&
      context.repositoryId !== undefined
    ) {
      return { kind: "repository", id: context.repositoryId };
    }
    if (
      proposal.scopeHint === "project" &&
      SCOPE_RANK[ceiling] >= SCOPE_RANK.project &&
      context.projectId !== undefined
    ) {
      return { kind: "project", id: context.projectId };
    }
    if (
      proposal.scopeHint === "user" &&
      ceiling === "user" &&
      isUserPreference(proposal.content) &&
      evidence.some((entry) => entry.firstPersonPreferenceEvidence === true)
    ) {
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
  const independentObservations = new Set(
    candidate.observations.map((entry) =>
      entry.sessionId !== undefined
        ? `session:${entry.sessionId}`
        : entry.taskId !== undefined
          ? `task:${entry.taskId}`
          : `evidence:${[...entry.evidenceIds].sort().join(",")}`,
    ),
  ).size;
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
    independentObservations >= policy.minimumPreferenceObservations
  ) {
    return "eligible";
  }
  if (
    sources.has("repeated_behavior") &&
    independentObservations >= policy.minimumBehaviorObservations &&
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
      independentObservations >= 2)
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
    const support = input.proposal.support ?? [];
    const supportById = new Map(support.map((entry) => [entry.evidenceId, entry.relation]));
    if (
      support.some((entry) => entry.relation === "contradicted") ||
      !selectedEvidence.some((entry) => supportById.get(entry.id) === "entailed")
    ) {
      return { outcome: "rejected", reason: "candidate_not_entailed_by_evidence" };
    }
    const polarity = claimPolarity(content);
    if (
      selectedEvidence.some((entry) => (entry.polarity ?? claimPolarity(entry.text)) !== polarity)
    ) {
      return { outcome: "rejected", reason: "candidate_polarity_conflicts_with_evidence" };
    }
    if (
      isUserPreference(content) &&
      !selectedEvidence.some((entry) => entry.firstPersonPreferenceEvidence === true)
    ) {
      return { outcome: "rejected", reason: "preference_not_explicit_in_source_evidence" };
    }
    if (selectedEvidence.every((entry) => lexicalOverlap(content, entry.text) < 0.35)) {
      return { outcome: "rejected", reason: "candidate_not_grounded_in_evidence" };
    }
    if (
      (input.source === "verified_tool" || input.source === "episode_consolidation") &&
      !selectedEvidence.some((entry) => entry.verified || entry.structural === true)
    ) {
      return { outcome: "rejected", reason: "unverified_tool_evidence" };
    }
    const scope = proposedScope(input.source, input.proposal, input.scopeContext, selectedEvidence);
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
    const candidateId =
      existing?.id ??
      stableHash("memory-candidate:v1", namespace, scope.kind, scope.id, normalizedContent);
    const stored = await this.#state.mutate<MemoryCandidate>({
      id: candidateId,
      kind: "memory-candidate-v1",
      namespace,
      reduce: (record) => {
        const current = record?.value ?? existing;
        if (
          current?.state === "promoted" ||
          current?.state === "rejected" ||
          current?.state === "expired"
        ) {
          return { value: current, status: current.state, now: current.lastObservedAt };
        }
        if (current?.observations.some((entry) => entry.id === observation.id)) {
          return { value: current, status: current.state, now: current.lastObservedAt };
        }
        const observations = [...(current?.observations ?? []), observation].slice(-64);
        const evidenceRefs = [
          ...(current?.evidenceRefs ?? []),
          ...selectedEvidence.map((entry) => entry.ref),
        ]
          .filter(
            (ref, index, all) =>
              all.findIndex((item) => item.kind === ref.kind && item.id === ref.id) === index,
          )
          .slice(-64);
        const base: MemoryCandidate = {
          version: 1,
          id: candidateId,
          namespace,
          content,
          normalizedContent,
          proposedScope: scope,
          scopeContext: input.scopeContext,
          state: "observed",
          observations,
          evidenceRefs,
          explicitness: Math.max(current?.explicitness ?? 0, explicitness(input.source)),
          stability: Math.max(
            current?.stability ?? 0,
            Math.max(0, Math.min(1, input.proposal.durability)),
          ),
          utility: Math.max(current?.utility ?? 0, Math.min(1, 0.4 + observations.length * 0.15)),
          confidence: Math.max(
            current?.confidence ?? 0,
            Math.max(0, Math.min(1, input.proposal.confidence)),
          ),
          derivedAuthority: Math.min(
            current?.derivedAuthority ?? EvidenceAuthority.VerifiedToolObservation,
            ...selectedEvidence.map((entry) => entry.authority ?? EvidenceAuthority.EpisodicMemory),
            selectedEvidence.some((entry) => entry.sourceKind === "user")
              ? EvidenceAuthority.UserHistoricalStatement
              : EvidenceAuthority.VerifiedToolObservation,
          ) as EvidenceAuthority,
          firstObservedAt: current?.firstObservedAt ?? now,
          lastObservedAt: now,
          expiresAt: now + this.#policy.candidateTtlMs,
          ...(current?.promotedMemoryId === undefined
            ? {}
            : { promotedMemoryId: current.promotedMemoryId }),
        };
        const candidate = { ...base, state: eligibility(base, this.#policy) };
        return { value: candidate, status: candidate.state, now };
      },
    });
    let candidate = stored.value;
    if (candidate.state === "promoted") return { outcome: "promoted", candidate };
    if (candidate.state === "rejected" || candidate.state === "expired") {
      return { outcome: "rejected", reason: `candidate_is_${candidate.state}` };
    }
    if (candidate.state === "eligible" && this.#policy.autoPromotion) {
      candidate = await this.promote(candidate.id, options);
      return { outcome: "promoted", candidate };
    }
    return {
      outcome:
        existing === undefined && candidate.observations.length === 1 ? "created" : "reinforced",
      candidate,
    };
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
        authority: Math.min(
          candidate.derivedAuthority ?? EvidenceAuthority.EpisodicMemory,
          userGrounded
            ? EvidenceAuthority.UserHistoricalStatement
            : EvidenceAuthority.VerifiedToolObservation,
        ) as EvidenceAuthority,
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
    const now = this.#clock.now();
    const stored = await this.#state.mutate<MemoryCandidate>({
      id: candidate.id,
      kind: "memory-candidate-v1",
      namespace: candidate.namespace,
      reduce: (record) => {
        const current = record?.value ?? candidate;
        const promoted: MemoryCandidate = {
          ...current,
          state:
            result.outcome === "rejected" || result.outcome === "rejected_sensitive"
              ? "rejected"
              : "promoted",
          lastObservedAt: now,
          ...(result.record?.id === undefined ? {} : { promotedMemoryId: result.record.id }),
        };
        return { value: promoted, status: promoted.state, now };
      },
    });
    return stored.value;
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
        const expired = await this.#state.mutate<MemoryCandidate>({
          id: candidate.id,
          kind: "memory-candidate-v1",
          namespace: candidate.namespace,
          reduce: (current) => {
            const latest = current?.value ?? candidate;
            if (
              latest.expiresAt > now ||
              latest.state === "promoted" ||
              latest.state === "rejected"
            ) {
              return { value: latest, status: latest.state, now: latest.lastObservedAt };
            }
            const value: MemoryCandidate = { ...latest, state: "expired", lastObservedAt: now };
            return { value, status: value.state, now };
          },
        });
        candidate = expired.value;
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
}
