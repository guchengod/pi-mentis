import {
  EvidenceAuthority,
  contentHash,
  stableHash,
  throwIfAborted,
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

export interface CreateExperienceLearningServiceOptions {
  readonly store: ZvecStore;
  readonly memory: MemoryService;
  readonly minimumOutcomes?: number;
  readonly minimumSuccessEstimate?: number;
}

function recordOf(candidate: ExperienceCandidate): StoredRecord {
  return {
    id: candidate.id,
    kind: "experience-candidate",
    namespace: "experience",
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

  constructor(options: CreateExperienceLearningServiceOptions) {
    this.#store = options.store;
    this.#memory = options.memory;
    this.#minimumOutcomes = options.minimumOutcomes ?? 3;
    this.#minimumSuccessEstimate = options.minimumSuccessEstimate ?? 0.7;
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
    if (
      input.environment["embeddingModel"] === undefined ||
      input.environment["embeddingDimensions"] === undefined ||
      input.environment["rerankModel"] === undefined
    ) {
      throw new Error(
        "Experience environment must include embeddingModel, embeddingDimensions, and rerankModel",
      );
    }
    const now = Date.now();
    const id = stableHash(
      "experience:v1",
      input.goal,
      JSON.stringify(Object.entries(input.environment).sort(([a], [b]) => a.localeCompare(b))),
      contentHash(input.steps.join("\n")),
    );
    const existing = await this.get(id, options);
    if (existing !== undefined) return existing;
    const candidate: ExperienceCandidate = {
      ...input,
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
    const sameEnvironment = Object.entries(candidate.environment).every(
      ([key, value]) => outcome.environment[key] === value,
    );
    if (!sameEnvironment) {
      throw new Error("Experience outcome environment does not match the candidate conditions");
    }
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
      updatedAt: Date.now(),
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
    const qualified = { ...candidate, state: "qualified" as const, updatedAt: Date.now() };
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
    const content = [
      `Goal: ${candidate.goal}`,
      `Applies when: ${candidate.appliesWhen.join("; ")}`,
      `Does not apply when: ${candidate.excludesWhen.join("; ")}`,
      "Prerequisites:",
      ...candidate.prerequisites.map((item) => `- ${item}`),
      "Procedure:",
      ...candidate.steps.map((item, index) => `${index + 1}. ${item}`),
      `Validated environment: ${JSON.stringify(candidate.environment)}`,
      `Validation plan: ${candidate.validationPlan.join("; ")}`,
    ].join("\n");
    const result = await this.#memory.commit(
      {
        content,
        type: "procedural",
        domain: "procedure",
        scope: { kind: "user", id: "experience" },
        confidence: betaSuccessEstimate(candidate),
        importance: 0.7,
        authority: EvidenceAuthority.VerifiedToolObservation,
        evidenceRefs: [...candidate.successEvidence, ...candidate.failureEvidence],
      },
      options,
    );
    const promoted = { ...candidate, state: "promoted" as const, updatedAt: Date.now() };
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
