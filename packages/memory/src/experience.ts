import {
  EvidenceAuthority,
  contentHash,
  stableHash,
  systemClock,
  throwIfAborted,
  type Clock,
  type OperationOptions,
} from "@pi-mentis/pi-mentis-core";
import { ZvecStore, type StoredRecord } from "@pi-mentis/pi-mentis-zvec";

import {
  betaSuccessEstimate,
  type ExperienceCandidate,
  type ExperienceLearningService,
  type ExperienceOutcome,
  type MemoryService,
} from "./types.js";
import { boundedText, lexicalTerms, securityNamespaceForScope } from "./cognitive-shared.js";

export interface CreateExperienceLearningServiceOptions {
  readonly store: ZvecStore;
  readonly memory: MemoryService;
  readonly minimumOutcomes?: number;
  readonly minimumSuccessEstimate?: number;
  readonly clock?: Clock;
}

function recordOf(candidate: ExperienceCandidate): StoredRecord {
  const namespace = candidate.scopeContext
    ? [
        candidate.scopeContext.tenantId,
        candidate.scopeContext.userId,
        candidate.scopeContext.appId,
        candidate.scopeContext.agentId,
      ]
        .map(encodeURIComponent)
        .join(":")
    : "local:local:pi:pi-mentis";
  return {
    id: candidate.id,
    kind: "experience-candidate",
    namespace,
    status: candidate.state,
    payload: candidate as unknown as Readonly<Record<string, unknown>>,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

export class DefaultExperienceLearningService implements ExperienceLearningService {
  readonly #store: ZvecStore;
  readonly #memory: MemoryService;
  readonly #minimumOutcomes: number;
  readonly #minimumSuccessEstimate: number;
  readonly #clock: Clock;

  constructor(options: CreateExperienceLearningServiceOptions) {
    this.#store = options.store;
    this.#memory = options.memory;
    this.#minimumOutcomes = options.minimumOutcomes ?? 3;
    this.#minimumSuccessEstimate = options.minimumSuccessEstimate ?? 0.7;
    this.#clock = options.clock ?? systemClock;
  }

  async observe(
    input: Omit<
      ExperienceCandidate,
      | "id"
      | "successes"
      | "failures"
      | "state"
      | "successEvidence"
      | "failureEvidence"
      | "createdAt"
      | "updatedAt"
    >,
    options: OperationOptions = {},
  ): Promise<ExperienceCandidate> {
    throwIfAborted(options.signal, "experience-observe");
    const v2 = input.version === 2 || (input.normalizedProblemCues?.length ?? 0) > 0;
    if (
      (!v2 && input.environment["embeddingModel"] === undefined) ||
      (!v2 && input.environment["embeddingDimensions"] === undefined) ||
      (!v2 && input.environment["rerankModel"] === undefined)
    ) {
      throw new Error(
        "Experience environment must include embeddingModel, embeddingDimensions, and rerankModel",
      );
    }
    const now = this.#clock.now();
    const namespace = input.scopeContext
      ? securityNamespaceForScope(input.scopeContext)
      : "local:local:pi:pi-mentis";
    const cueSignature = [
      ...new Set(
        (input.normalizedProblemCues ?? [input.goal]).flatMap((cue) => [...lexicalTerms(cue)]),
      ),
    ]
      .sort()
      .slice(0, 48)
      .join("|");
    const operationSignature = [
      ...new Set(
        (input.generalizedSteps ?? input.steps).flatMap((step) => [...lexicalTerms(step)]),
      ),
    ]
      .sort()
      .slice(0, 64)
      .join("|");
    const applicability =
      input.applicabilityContext ??
      Object.fromEntries(
        Object.entries(input.environment).filter(
          ([key]) => !/(embedding|rerank|model|generation)/iu.test(key),
        ),
      );
    const id = v2
      ? stableHash(
          "experience:v2",
          namespace,
          cueSignature,
          operationSignature,
          JSON.stringify(Object.entries(applicability).sort(([a], [b]) => a.localeCompare(b))),
        )
      : stableHash(
          "experience:v1",
          namespace,
          input.goal,
          JSON.stringify(Object.entries(input.environment).sort(([a], [b]) => a.localeCompare(b))),
          contentHash(input.steps.join("\n")),
        );
    const existing = await this.get(id, options);
    if (existing !== undefined) {
      if (!v2) return existing;
      const updated: ExperienceCandidate = {
        ...existing,
        rawEpisodeIds: [
          ...new Set([...(existing.rawEpisodeIds ?? []), ...(input.rawEpisodeIds ?? [])]),
        ].slice(-256),
        generationContext: [
          ...new Set([...existing.generationContext, ...input.generationContext]),
        ].slice(-64),
        updatedAt: now,
      };
      await this.#store.upsertScalar("relationships_v1", [recordOf(updated)]);
      return updated;
    }
    const candidate: ExperienceCandidate = {
      ...input,
      version: v2 ? 2 : (input.version ?? 1),
      id,
      successEvidence: [],
      failureEvidence: [],
      successes: 0,
      failures: 0,
      state: "observed",
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.upsertScalar("relationships_v1", [recordOf(candidate)]);
    return candidate;
  }

  async recordOutcome(
    id: string,
    outcome: ExperienceOutcome,
    options: OperationOptions = {},
  ): Promise<ExperienceCandidate> {
    throwIfAborted(options.signal, "experience-outcome");
    const candidate = await this.#required(id, options);
    if (candidate.state === "promoted" || candidate.state === "rejected") {
      throw new Error(`Experience ${id} is terminal (${candidate.state})`);
    }
    const comparableEnvironment =
      candidate.version === 2
        ? (candidate.applicabilityContext ?? candidate.environment)
        : candidate.environment;
    const sameEnvironment = Object.entries(comparableEnvironment).every(
      ([key, value]) => outcome.environment[key] === value,
    );
    if (!sameEnvironment) {
      throw new Error("Experience outcome environment does not match the candidate conditions");
    }
    const alreadyObserved = [...candidate.successEvidence, ...candidate.failureEvidence].some(
      (evidence) => evidence.kind === outcome.evidence.kind && evidence.id === outcome.evidence.id,
    );
    if (alreadyObserved) return candidate;
    const updated: ExperienceCandidate = {
      ...candidate,
      successes: candidate.successes + (outcome.succeeded ? 1 : 0),
      failures: candidate.failures + (outcome.succeeded ? 0 : 1),
      successEvidence: outcome.succeeded
        ? [...candidate.successEvidence, outcome.evidence]
        : candidate.successEvidence,
      failureEvidence: outcome.succeeded
        ? candidate.failureEvidence
        : [...candidate.failureEvidence, outcome.evidence],
      cost: candidate.cost + outcome.cost,
      durationMs: candidate.durationMs + outcome.durationMs,
      state: "evaluating",
      updatedAt: this.#clock.now(),
    };
    await this.#store.upsertScalar("relationships_v1", [recordOf(updated)]);
    return updated;
  }

  async qualify(id: string, options: OperationOptions = {}): Promise<ExperienceCandidate> {
    throwIfAborted(options.signal, "experience-qualify");
    const candidate = await this.#required(id, options);
    const outcomes = candidate.successes + candidate.failures;
    const estimate = betaSuccessEstimate(candidate);
    if (outcomes < this.#minimumOutcomes || estimate < this.#minimumSuccessEstimate) {
      throw new Error(
        `Experience ${id} has ${outcomes} outcomes and Beta estimate ${estimate.toFixed(3)}; qualification requires ${this.#minimumOutcomes} and ${this.#minimumSuccessEstimate}`,
      );
    }
    if (candidate.validationPlan.length === 0 || candidate.successEvidence.length === 0) {
      throw new Error("Experience qualification requires a validation plan and success evidence");
    }
    const qualified = {
      ...candidate,
      state: "qualified" as const,
      updatedAt: this.#clock.now(),
    };
    await this.#store.upsertScalar("relationships_v1", [recordOf(qualified)]);
    return qualified;
  }

  async promote(
    id: string,
    options: OperationOptions = {},
  ): Promise<Awaited<ReturnType<MemoryService["commit"]>>> {
    throwIfAborted(options.signal, "experience-promote");
    const candidate = await this.#required(id, options);
    if (candidate.state !== "qualified") {
      throw new Error(`Experience ${id} must be explicitly qualified before promotion`);
    }
    const steps = candidate.generalizedSteps ?? candidate.steps;
    const content = [
      `Goal: ${candidate.goal}`,
      `Applies when: ${candidate.appliesWhen.join("; ")}`,
      `Does not apply when: ${candidate.excludesWhen.join("; ")}`,
      "Prerequisites:",
      ...candidate.prerequisites.map((item) => `- ${item}`),
      "Procedure:",
      ...steps.map((item, index) => `${index + 1}. ${boundedText(item, 500)}`),
      ...(candidate.successCriteria === undefined
        ? []
        : [
            "Success criteria:",
            ...candidate.successCriteria.map((item) => `- ${boundedText(item, 400)}`),
          ]),
      `Validated environment: ${JSON.stringify(candidate.applicabilityContext ?? candidate.environment)}`,
      `Validation plan: ${candidate.validationPlan.join("; ")}`,
    ].join("\n");
    const result = await this.#memory.commit(
      {
        content,
        scope:
          candidate.version === 2 && candidate.scopeContext?.repositoryId !== undefined
            ? { kind: "repository", id: candidate.scopeContext.repositoryId }
            : candidate.version === 2 && candidate.scopeContext?.projectId !== undefined
              ? { kind: "project", id: candidate.scopeContext.projectId }
              : { kind: "user", id: "experience" },
        ...(candidate.scopeContext === undefined ? {} : { scopeContext: candidate.scopeContext }),
        provenance: {
          origin: "tool",
          epistemicState: "verified",
          ...(candidate.scopeContext?.branchId === undefined
            ? {}
            : { branchId: candidate.scopeContext.branchId }),
        },
        confidence: betaSuccessEstimate(candidate),
        importance: 0.7,
        authority: EvidenceAuthority.VerifiedToolObservation,
        evidenceRefs: [...candidate.successEvidence, ...candidate.failureEvidence],
      },
      options,
    );
    const promoted = {
      ...candidate,
      state: "promoted" as const,
      updatedAt: this.#clock.now(),
    };
    await this.#store.upsertScalar("relationships_v1", [recordOf(promoted)]);
    return result;
  }

  async get(id: string, options: OperationOptions = {}): Promise<ExperienceCandidate | undefined> {
    throwIfAborted(options.signal, "experience-get");
    const payload = (await this.#store.fetchScalar("relationships_v1", [id])).get(id);
    return payload as unknown as ExperienceCandidate | undefined;
  }

  async #required(id: string, options: OperationOptions): Promise<ExperienceCandidate> {
    const candidate = await this.get(id, options);
    if (candidate === undefined) throw new Error(`Unknown experience candidate ${id}`);
    return candidate;
  }
}

export function createExperienceLearningService(
  options: CreateExperienceLearningServiceOptions,
): ExperienceLearningService {
  return new DefaultExperienceLearningService(options);
}
