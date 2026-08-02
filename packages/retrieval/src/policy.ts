import { stableHash, systemClock, type Clock } from "@pi-mentis/pi-mentis-core";
import { ZvecStateStore, type ZvecStore } from "@pi-mentis/pi-mentis-zvec";

export interface RetrievalPolicyParameters {
  readonly topK: number;
  readonly rerankCandidateLimit: number;
  readonly minimumAuthority: number;
  readonly affinityWeight: number;
  readonly freshnessWeight: number;
  readonly diversityLambda: number;
  readonly contextTokens: number;
}

export interface PolicyInvariants {
  readonly securityScopeEnabled: true;
  readonly instructionSafetyEnabled: true;
  readonly evidenceRequiredForAuthority: true;
  readonly deletionRulesAdaptive: false;
  readonly minimumTrustFloor: number;
}

export interface AdaptivePolicy {
  readonly id: string;
  readonly parentId?: string;
  readonly state: "draft" | "shadow" | "canary" | "active" | "degraded" | "fallback" | "retired";
  readonly parameters: RetrievalPolicyParameters;
  readonly invariants: PolicyInvariants;
  readonly createdAt: number;
  readonly activatedAt?: number;
  readonly reason?: string;
}

export interface PolicyReplayCase {
  readonly id: string;
  readonly positiveMemoryIds: readonly string[];
  readonly negativeMemoryIds: readonly string[];
  readonly requiredEvidenceIds: readonly string[];
  readonly candidateMemoryIds?: readonly string[];
  readonly candidateIds?: readonly string[];
  readonly candidateFeatures?: readonly PolicyReplayCandidate[];
}

export interface PolicyReplayCandidate {
  readonly id: string;
  readonly kind: "knowledge" | "memory" | "capability";
  readonly score: number;
  readonly tokenCount: number;
  readonly authority: number;
  readonly termHashes: readonly string[];
}

function replaySimilarity(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter((term) => b.has(term)).length;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Deterministic local approximation of the live candidate-limit, MMR, and context-budget path. */
export function evaluateReplayCandidate(
  policy: AdaptivePolicy,
  item: PolicyReplayCase,
): readonly string[] {
  if (item.candidateFeatures === undefined) {
    return (item.candidateIds ?? item.candidateMemoryIds ?? []).slice(0, policy.parameters.topK);
  }
  const remaining = item.candidateFeatures
    .filter((candidate) => candidate.authority >= policy.parameters.minimumAuthority)
    .slice(0, policy.parameters.rerankCandidateLimit);
  const selected: PolicyReplayCandidate[] = [];
  while (selected.length < policy.parameters.topK && remaining.length > 0) {
    let bestIndex = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (const [index, candidate] of remaining.entries()) {
      const redundancy = selected.reduce(
        (maximum, chosen) =>
          Math.max(maximum, replaySimilarity(candidate.termHashes, chosen.termHashes)),
        0,
      );
      const utility =
        policy.parameters.diversityLambda * candidate.score -
        (1 - policy.parameters.diversityLambda) * redundancy;
      if (utility > bestUtility) {
        bestUtility = utility;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen !== undefined) selected.push(chosen);
  }
  let tokens = 0;
  return [...selected]
    .sort(
      (left, right) =>
        right.score / Math.max(1, right.tokenCount) - left.score / Math.max(1, left.tokenCount),
    )
    .flatMap((candidate) => {
      if (tokens + candidate.tokenCount > policy.parameters.contextTokens) return [];
      tokens += candidate.tokenCount;
      return [candidate.id];
    });
}

export interface PolicyReplayResult {
  readonly policyId: string;
  readonly score: number;
  readonly recall: number;
  readonly forbiddenExposure: number;
  readonly evidenceCoverage: number;
  readonly caseCount: number;
}

export interface CanaryMetrics {
  readonly verificationFailureRate: number;
  readonly projectMismatchRate: number;
  readonly p95LatencyMs: number;
  readonly correctionRate: number;
}

export interface AdaptivePolicyStatus {
  readonly active: AdaptivePolicy;
  readonly fallback: AdaptivePolicy;
  readonly shadow?: AdaptivePolicy;
  readonly canary?: AdaptivePolicy;
  readonly ewma?: CanaryMetrics;
  readonly cooldownUntil: number;
}

interface PolicyControlState {
  readonly ewma?: CanaryMetrics;
  readonly cooldownUntil: number;
}

const DEFAULT_INVARIANTS: PolicyInvariants = {
  securityScopeEnabled: true,
  instructionSafetyEnabled: true,
  evidenceRequiredForAuthority: true,
  deletionRulesAdaptive: false,
  minimumTrustFloor: 20,
};

const DEFAULT_PARAMETERS: RetrievalPolicyParameters = {
  topK: 20,
  rerankCandidateLimit: 40,
  minimumAuthority: 20,
  affinityWeight: 1,
  freshnessWeight: 0.1,
  diversityLambda: 0.75,
  contextTokens: 1_600,
};

function validateParameters(
  parameters: RetrievalPolicyParameters,
  invariants: PolicyInvariants,
): void {
  const bounded = (name: string, value: number, minimum: number, maximum: number): void => {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`Policy ${name} must be within ${minimum}..${maximum}`);
    }
  };
  bounded("topK", parameters.topK, 1, 100);
  bounded("rerankCandidateLimit", parameters.rerankCandidateLimit, 1, 100);
  bounded("minimumAuthority", parameters.minimumAuthority, invariants.minimumTrustFloor, 100);
  bounded("affinityWeight", parameters.affinityWeight, 0, 2);
  bounded("freshnessWeight", parameters.freshnessWeight, 0, 1);
  bounded("diversityLambda", parameters.diversityLambda, 0.5, 1);
  bounded("contextTokens", parameters.contextTokens, 128, 16_000);
}

export function validatePolicy(policy: AdaptivePolicy): AdaptivePolicy {
  if (
    policy.invariants.securityScopeEnabled !== true ||
    policy.invariants.instructionSafetyEnabled !== true ||
    policy.invariants.evidenceRequiredForAuthority !== true ||
    policy.invariants.deletionRulesAdaptive !== false ||
    policy.invariants.minimumTrustFloor < DEFAULT_INVARIANTS.minimumTrustFloor
  ) {
    throw new Error("Policy attempts to modify a protected safety invariant");
  }
  validateParameters(policy.parameters, policy.invariants);
  return policy;
}

export class AdaptivePolicyService {
  readonly #state: ZvecStateStore;
  readonly #clock: Clock;
  readonly #namespace: string;
  readonly #cooldownMs: number;
  #active: AdaptivePolicy;
  #fallback: AdaptivePolicy;
  #ewma: CanaryMetrics | undefined;
  #cooldownUntil = 0;
  #shadow: AdaptivePolicy | undefined;
  #canary: AdaptivePolicy | undefined;

  constructor(
    store: ZvecStore,
    namespace: string,
    options: { readonly clock?: Clock; readonly cooldownMs?: number } = {},
  ) {
    this.#state = new ZvecStateStore(store);
    this.#clock = options.clock ?? systemClock;
    this.#namespace = namespace;
    this.#cooldownMs = options.cooldownMs ?? 30 * 60_000;
    const createdAt = this.#clock.now();
    this.#active = {
      id: "policy:default",
      state: "active",
      parameters: DEFAULT_PARAMETERS,
      invariants: DEFAULT_INVARIANTS,
      createdAt,
      activatedAt: createdAt,
    };
    this.#fallback = { ...this.#active, id: "policy:fallback", state: "fallback" };
  }

  async initialize(): Promise<void> {
    const pointer = await this.#state.get<{
      readonly activeId: string;
      readonly fallbackId: string;
    }>(this.#pointerId());
    if (pointer !== undefined) {
      const [active, fallback] = await Promise.all([
        this.#state.get<AdaptivePolicy>(pointer.value.activeId),
        this.#state.get<AdaptivePolicy>(pointer.value.fallbackId),
      ]);
      if (active !== undefined) this.#active = validatePolicy(active.value);
      if (fallback !== undefined) this.#fallback = validatePolicy(fallback.value);
      const [shadow] = await this.#state.list<AdaptivePolicy>({
        kind: "adaptive-policy",
        namespace: this.#namespace,
        status: "shadow",
        limit: 1,
      });
      const [canary] = await this.#state.list<AdaptivePolicy>({
        kind: "adaptive-policy",
        namespace: this.#namespace,
        status: "canary",
        limit: 1,
      });
      this.#shadow = shadow === undefined ? undefined : validatePolicy(shadow.value);
      this.#canary = canary === undefined ? undefined : validatePolicy(canary.value);
      const control = await this.#state.get<PolicyControlState>(this.#controlId());
      this.#ewma = control?.value.ewma;
      this.#cooldownUntil = control?.value.cooldownUntil ?? 0;
      return;
    }
    await this.#persist(this.#active);
    await this.#persist(this.#fallback);
    await this.#writePointer();
    await this.#persistControl();
  }

  active(): AdaptivePolicy {
    return this.#active;
  }

  fallback(): AdaptivePolicy {
    return this.#fallback;
  }

  shadow(): AdaptivePolicy | undefined {
    return this.#shadow;
  }

  canary(): AdaptivePolicy | undefined {
    return this.#canary;
  }

  status(): AdaptivePolicyStatus {
    return {
      active: this.#active,
      fallback: this.#fallback,
      ...(this.#shadow === undefined ? {} : { shadow: this.#shadow }),
      ...(this.#canary === undefined ? {} : { canary: this.#canary }),
      ...(this.#ewma === undefined ? {} : { ewma: this.#ewma }),
      cooldownUntil: this.#cooldownUntil,
    };
  }

  forRequest(key: string, canaryPercent = 10): AdaptivePolicy {
    if (this.#canary === undefined) return this.#active;
    const bucket =
      Number.parseInt(stableHash("policy-canary-bucket:v1", key).slice(0, 8), 16) % 100;
    return bucket < canaryPercent ? this.#canary : this.#active;
  }

  async createCandidate(
    change: Partial<RetrievalPolicyParameters>,
    state: "draft" | "shadow" = "draft",
  ): Promise<AdaptivePolicy> {
    const changedKeys = Object.keys(change) as Array<keyof RetrievalPolicyParameters>;
    if (changedKeys.length !== 1) {
      throw new Error("Coordinate descent candidates must change exactly one parameter");
    }
    const parameters = { ...this.#active.parameters, ...change };
    const createdAt = this.#clock.now();
    const policy = validatePolicy({
      id: `policy:${stableHash("adaptive-policy:v1", this.#active.id, JSON.stringify(change), String(createdAt))}`,
      parentId: this.#active.id,
      state,
      parameters,
      invariants: this.#active.invariants,
      createdAt,
    });
    await this.#persist(policy);
    if (state === "shadow") this.#shadow = policy;
    return policy;
  }

  async replay(
    policy: AdaptivePolicy,
    cases: readonly PolicyReplayCase[],
    evaluate: (policy: AdaptivePolicy, item: PolicyReplayCase) => readonly string[],
  ): Promise<PolicyReplayResult> {
    validatePolicy(policy);
    let positives = 0;
    let required = 0;
    let forbidden = 0;
    let evidence = 0;
    let requiredEvidence = 0;
    for (const item of cases) {
      const result = evaluate(policy, item);
      const selected = new Set(result);
      positives += item.positiveMemoryIds.filter((id) => selected.has(id)).length;
      required += item.positiveMemoryIds.length;
      forbidden += item.negativeMemoryIds.filter((id) => selected.has(id)).length;
      evidence += item.requiredEvidenceIds.filter((id) => selected.has(id)).length;
      requiredEvidence += item.requiredEvidenceIds.length;
    }
    const recall = required === 0 ? 1 : positives / required;
    const forbiddenExposure = forbidden / Math.max(1, cases.length);
    const evidenceCoverage = requiredEvidence === 0 ? 1 : evidence / requiredEvidence;
    return {
      policyId: policy.id,
      score: recall * 0.6 + evidenceCoverage * 0.4 - forbiddenExposure,
      recall,
      forbiddenExposure,
      evidenceCoverage,
      caseCount: cases.length,
    };
  }

  async optimize(
    cases: readonly PolicyReplayCase[],
    evaluate: (policy: AdaptivePolicy, item: PolicyReplayCase) => readonly string[],
  ): Promise<{
    readonly baseline: PolicyReplayResult;
    readonly candidate?: AdaptivePolicy;
    readonly result?: PolicyReplayResult;
  }> {
    const baseline = await this.replay(this.#active, cases, evaluate);
    if (
      cases.length === 0 ||
      baseline.forbiddenExposure > 0 ||
      this.#clock.now() < this.#cooldownUntil
    ) {
      return { baseline };
    }
    const coordinates: ReadonlyArray<Partial<RetrievalPolicyParameters>> = [
      { topK: Math.min(100, this.#active.parameters.topK + 2) },
      { topK: Math.max(1, this.#active.parameters.topK - 2) },
      {
        rerankCandidateLimit: Math.min(100, this.#active.parameters.rerankCandidateLimit + 5),
      },
      {
        rerankCandidateLimit: Math.max(1, this.#active.parameters.rerankCandidateLimit - 5),
      },
      { diversityLambda: Math.min(1, this.#active.parameters.diversityLambda + 0.05) },
      { diversityLambda: Math.max(0.5, this.#active.parameters.diversityLambda - 0.05) },
      { contextTokens: Math.min(16_000, this.#active.parameters.contextTokens + 256) },
      { contextTokens: Math.max(128, this.#active.parameters.contextTokens - 256) },
    ];
    let bestPolicy: AdaptivePolicy | undefined;
    let bestResult: PolicyReplayResult | undefined;
    const evaluated: AdaptivePolicy[] = [];
    for (const coordinate of coordinates) {
      const draft = await this.createCandidate(coordinate, "draft");
      evaluated.push(draft);
      const result = await this.replay(draft, cases, evaluate);
      if (
        result.forbiddenExposure === 0 &&
        result.evidenceCoverage >= baseline.evidenceCoverage &&
        result.score > (bestResult?.score ?? baseline.score)
      ) {
        bestPolicy = draft;
        bestResult = result;
      }
    }
    for (const draft of evaluated) {
      if (draft.id !== bestPolicy?.id) {
        await this.#persist({
          ...draft,
          state: "retired",
          reason: "offline replay did not improve the active policy",
        });
      }
    }
    if (bestPolicy === undefined || bestResult === undefined) return { baseline };
    const shadow = { ...bestPolicy, state: "shadow" as const };
    validatePolicy(shadow);
    this.#shadow = shadow;
    await this.#persist(shadow);
    return { baseline, candidate: shadow, result: bestResult };
  }

  async promoteToCanary(policy: AdaptivePolicy): Promise<AdaptivePolicy> {
    if (policy.state !== "shadow") throw new Error("Only a Shadow policy can enter Canary");
    if (this.#clock.now() < this.#cooldownUntil) {
      throw new Error("Adaptive policy is in rollback cooldown");
    }
    const canary = validatePolicy({ ...policy, state: "canary" });
    if (this.#shadow?.id === policy.id) this.#shadow = undefined;
    this.#canary = canary;
    this.#ewma = undefined;
    await this.#persist(canary);
    await this.#persistControl();
    return canary;
  }

  async activate(policy: AdaptivePolicy): Promise<AdaptivePolicy> {
    if (policy.state !== "canary") throw new Error("Only a Canary policy can become active");
    validatePolicy(policy);
    const previous = { ...this.#active, state: "fallback" as const };
    const active = {
      ...policy,
      state: "active" as const,
      activatedAt: this.#clock.now(),
    };
    this.#fallback = previous;
    this.#active = active;
    this.#canary = undefined;
    this.#ewma = undefined;
    await Promise.all([this.#persist(previous), this.#persist(active)]);
    await this.#writePointer();
    await this.#persistControl();
    return active;
  }

  async observeCanary(
    policy: AdaptivePolicy,
    metrics: CanaryMetrics,
  ): Promise<"continue" | "rollback"> {
    if (policy.state !== "canary" && policy.id !== this.#active.id) {
      throw new Error("Metrics can only be applied to Canary or active policies");
    }
    const alpha = 0.25;
    this.#ewma =
      this.#ewma === undefined
        ? metrics
        : {
            verificationFailureRate:
              alpha * metrics.verificationFailureRate +
              (1 - alpha) * this.#ewma.verificationFailureRate,
            projectMismatchRate:
              alpha * metrics.projectMismatchRate + (1 - alpha) * this.#ewma.projectMismatchRate,
            p95LatencyMs: alpha * metrics.p95LatencyMs + (1 - alpha) * this.#ewma.p95LatencyMs,
            correctionRate:
              alpha * metrics.correctionRate + (1 - alpha) * this.#ewma.correctionRate,
          };
    const unsafe =
      this.#ewma.verificationFailureRate > 0.1 ||
      this.#ewma.projectMismatchRate > 0.005 ||
      this.#ewma.p95LatencyMs > 1_200 ||
      this.#ewma.correctionRate > 0.1;
    await this.#persistControl();
    if (!unsafe) return "continue";
    if (policy.state === "active" && this.#clock.now() < this.#cooldownUntil) {
      return "continue";
    }
    const reason = `EWMA regression: verification=${this.#ewma.verificationFailureRate.toFixed(4)}, mismatch=${this.#ewma.projectMismatchRate.toFixed(4)}, p95=${this.#ewma.p95LatencyMs.toFixed(1)}, correction=${this.#ewma.correctionRate.toFixed(4)}`;
    if (policy.state === "canary") {
      await this.#persist({ ...policy, state: "degraded", reason });
      this.#canary = undefined;
      this.#cooldownUntil = this.#clock.now() + this.#cooldownMs;
      await this.#persistControl();
      return "rollback";
    }
    await this.rollback(reason);
    return "rollback";
  }

  async rollback(reason: string): Promise<AdaptivePolicy> {
    const degraded = { ...this.#active, state: "degraded" as const, reason };
    const restored = {
      ...this.#fallback,
      state: "active" as const,
      activatedAt: this.#clock.now(),
    };
    this.#active = restored;
    this.#fallback = degraded;
    this.#canary = undefined;
    this.#cooldownUntil = this.#clock.now() + this.#cooldownMs;
    await Promise.all([this.#persist(degraded), this.#persist(restored)]);
    await this.#writePointer();
    await this.#persistControl();
    return restored;
  }

  #pointerId(): string {
    return this.#state.id("policy-pointer", this.#namespace, "retrieval");
  }

  #controlId(): string {
    return this.#state.id("policy-control", this.#namespace, "retrieval");
  }

  async #persist(policy: AdaptivePolicy): Promise<void> {
    await this.#state.put(
      {
        id: policy.id,
        kind: "adaptive-policy",
        namespace: this.#namespace,
        value: policy as unknown as Readonly<Record<string, unknown>>,
      },
      { status: policy.state, now: this.#clock.now() },
    );
  }

  async #writePointer(): Promise<void> {
    await this.#state.put(
      {
        id: this.#pointerId(),
        kind: "policy-pointer",
        namespace: this.#namespace,
        value: { activeId: this.#active.id, fallbackId: this.#fallback.id },
      },
      { now: this.#clock.now() },
    );
  }

  async #persistControl(): Promise<void> {
    await this.#state.put(
      {
        id: this.#controlId(),
        kind: "policy-control",
        namespace: this.#namespace,
        value: {
          ...(this.#ewma === undefined ? {} : { ewma: this.#ewma }),
          cooldownUntil: this.#cooldownUntil,
        },
      },
      { now: this.#clock.now() },
    );
  }
}
