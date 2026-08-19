import {
  EvidenceAuthority,
  stableHash,
  systemClock,
  throwIfAborted,
  type Clock,
  type OperationOptions,
} from "@pi-mentis/pi-mentis-core";
import { ZvecStateStore, type ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import {
  betaSuccessEstimate,
  type ExperienceCandidate,
  type ExperienceLearningService,
  type ExperienceOutcome,
  type MemoryService,
} from "./types.js";
import {
  boundedText,
  lexicalOverlap,
  lexicalTerms,
  securityNamespaceForScope,
} from "./cognitive-shared.js";

export interface CreateExperienceLearningServiceOptions {
  readonly store: ZvecStore;
  readonly memory: MemoryService;
  readonly minimumOutcomes?: number;
  readonly minimumSuccessEstimate?: number;
  readonly clock?: Clock;
}

function normalizedOperationPattern(steps: readonly string[]): readonly string[] {
  return steps.slice(0, 16).map((step) => [...lexicalTerms(step)].slice(0, 12).sort().join(":"));
}

function semanticApplicability(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const values: Array<readonly [string, string]> = Object.entries(input)
    .filter(([key]) => !/(embedding|rerank|model|generation|runtimeVersion)/iu.test(key))
    .map(([key, value]) => [key, value] as const);
  const runtimeVersion = input["runtimeVersion"];
  if (runtimeVersion !== undefined) {
    const major = runtimeVersion.replace(/^v/u, "").split(".")[0];
    values.push([
      "runtimeConstraint",
      `${input["runtime"] ?? "runtime"}>=${major ?? runtimeVersion}`,
    ]);
  }
  return Object.fromEntries(values);
}

function distinctOutcomeCount(candidate: ExperienceCandidate): number {
  if ((candidate.outcomes?.length ?? 0) > 0) {
    return new Set(candidate.outcomes?.map((outcome) => outcome.taskEpisodeId)).size;
  }
  return new Set(
    [...candidate.successEvidence, ...candidate.failureEvidence].map(
      (evidence) => `${evidence.kind}:${evidence.id}`,
    ),
  ).size;
}

function experienceStateAfterOutcome(
  candidate: ExperienceCandidate,
  minimumSuccessEstimate: number,
  minimumOutcomes: number,
): ExperienceCandidate["state"] {
  const estimate = betaSuccessEstimate(candidate);
  const outcomes = distinctOutcomeCount(candidate);
  if (candidate.state === "promoted" && estimate < minimumSuccessEstimate - 0.15) {
    return "degraded";
  }
  if (
    (candidate.state === "degraded" || candidate.state === "retired") &&
    outcomes >= minimumOutcomes &&
    estimate >= minimumSuccessEstimate
  ) {
    return "qualified";
  }
  if (
    candidate.state === "degraded" &&
    outcomes >= minimumOutcomes &&
    estimate < minimumSuccessEstimate - 0.3
  ) {
    return "retired";
  }
  return candidate.state === "observed" ? "evaluating" : candidate.state;
}

export class DefaultExperienceLearningService implements ExperienceLearningService {
  readonly #store: ZvecStore;
  readonly #state: ZvecStateStore;
  readonly #memory: MemoryService;
  readonly #minimumOutcomes: number;
  readonly #minimumSuccessEstimate: number;
  readonly #clock: Clock;

  constructor(options: CreateExperienceLearningServiceOptions) {
    this.#store = options.store;
    this.#state = new ZvecStateStore(options.store);
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
    const cueSignature = [...new Set(input.normalizedProblemCues ?? [input.goal])]
      .flatMap((cue) => [...lexicalTerms(cue)])
      .sort()
      .slice(0, 48)
      .join("|");
    const steps = input.generalizedSteps ?? input.steps;
    const operationPattern = normalizedOperationPattern(steps);
    const applicability = semanticApplicability(input.applicabilityContext ?? input.environment);
    const proposedId = stableHash(
      v2 ? "experience:v3" : "experience:v1",
      namespace,
      cueSignature,
      operationPattern.join("->"),
      JSON.stringify(Object.entries(applicability).sort(([a], [b]) => a.localeCompare(b))),
    );
    const familyCandidates = v2
      ? await this.#state.list<ExperienceCandidate>({
          kind: "experience-candidate-v3",
          namespace,
          limit: 1_000,
        })
      : [];
    const matchedFamily = familyCandidates
      .map((record) => record.value)
      .filter(
        (candidate) =>
          JSON.stringify(candidate.applicabilityContext ?? {}) === JSON.stringify(applicability) &&
          JSON.stringify(candidate.operationPattern ?? []) === JSON.stringify(operationPattern),
      )
      .map((candidate) => ({
        candidate,
        overlap: lexicalOverlap(
          (candidate.normalizedProblemCues ?? [candidate.goal]).join(" "),
          (input.normalizedProblemCues ?? [input.goal]).join(" "),
        ),
      }))
      .filter((entry) => entry.overlap >= 0.5)
      .sort((left, right) => right.overlap - left.overlap)[0]?.candidate;
    const id = matchedFamily?.id ?? proposedId;
    const legacy = await this.get(id, options);
    const stored = await this.#state.mutate<ExperienceCandidate>({
      id,
      kind: "experience-candidate-v3",
      namespace,
      reduce: (record) => {
        const existing = record?.value ?? matchedFamily ?? legacy;
        if (existing !== undefined) {
          const value: ExperienceCandidate = {
            ...existing,
            rawEpisodeIds: [
              ...new Set([...(existing.rawEpisodeIds ?? []), ...(input.rawEpisodeIds ?? [])]),
            ].slice(-256),
            generationContext: [
              ...new Set([...existing.generationContext, ...input.generationContext]),
            ].slice(-64),
            updatedAt: now,
          };
          return { value, status: value.state, now };
        }
        const value: ExperienceCandidate = {
          ...input,
          version: v2 ? 2 : (input.version ?? 1),
          id,
          applicabilityContext: applicability,
          operationPattern,
          successEvidence: [],
          failureEvidence: [],
          outcomes: [],
          successes: 0,
          failures: 0,
          state: "observed",
          knowledgeRevision: 0,
          createdAt: now,
          updatedAt: now,
        };
        return { value, status: value.state, now };
      },
    });
    return stored.value;
  }

  async recordOutcome(
    id: string,
    outcome: ExperienceOutcome,
    options: OperationOptions = {},
  ): Promise<ExperienceCandidate> {
    throwIfAborted(options.signal, "experience-outcome");
    const initial = await this.#required(id, options);
    if (initial.state === "rejected") throw new Error(`Experience ${id} is rejected`);
    const namespace = initial.scopeContext
      ? securityNamespaceForScope(initial.scopeContext)
      : "local:local:pi:pi-mentis";
    const now = this.#clock.now();
    const stored = await this.#state.mutate<ExperienceCandidate>({
      id,
      kind: "experience-candidate-v3",
      namespace,
      reduce: (record) => {
        const candidate = record?.value ?? initial;
        const comparableEnvironment =
          candidate.version === 2
            ? (candidate.applicabilityContext ?? candidate.environment)
            : candidate.environment;
        const outcomeEnvironment = semanticApplicability(outcome.environment);
        const sameEnvironment = Object.entries(comparableEnvironment).every(
          ([key, value]) => outcomeEnvironment[key] === value,
        );
        if (!sameEnvironment) {
          throw new Error("Experience outcome environment does not match the candidate conditions");
        }
        const outcomes = candidate.outcomes ?? [];
        if (
          outcomes.some(
            (entry) =>
              entry.outcomeId === outcome.outcomeId ||
              entry.taskEpisodeId === outcome.taskEpisodeId,
          ) ||
          [...candidate.successEvidence, ...candidate.failureEvidence].some(
            (evidence) =>
              evidence.kind === outcome.evidence.kind && evidence.id === outcome.evidence.id,
          )
        ) {
          return { value: candidate, status: candidate.state, now: candidate.updatedAt };
        }
        const updatedBase: ExperienceCandidate = {
          ...candidate,
          successes: candidate.successes + (outcome.succeeded ? 1 : 0),
          failures: candidate.failures + (outcome.succeeded ? 0 : 1),
          successEvidence: outcome.succeeded
            ? [...candidate.successEvidence, outcome.evidence]
            : candidate.successEvidence,
          failureEvidence: outcome.succeeded
            ? candidate.failureEvidence
            : [...candidate.failureEvidence, outcome.evidence],
          outcomes: [...outcomes, outcome].slice(-256),
          cost: candidate.cost + outcome.cost,
          durationMs: candidate.durationMs + outcome.durationMs,
          updatedAt: now,
        };
        const value: ExperienceCandidate = {
          ...updatedBase,
          state: experienceStateAfterOutcome(
            updatedBase,
            this.#minimumSuccessEstimate,
            this.#minimumOutcomes,
          ),
        };
        return { value, status: value.state, now };
      },
    });
    if (stored.value.state === "degraded" && initial.state !== "degraded") {
      await this.#memory.commit(
        {
          content: `Procedure reliability degraded: ${stored.value.goal}. Revalidate before reuse.`,
          scope:
            stored.value.scopeContext?.repositoryId !== undefined
              ? { kind: "repository", id: stored.value.scopeContext.repositoryId }
              : stored.value.scopeContext?.projectId !== undefined
                ? { kind: "project", id: stored.value.scopeContext.projectId }
                : { kind: "user", id: "experience" },
          ...(stored.value.scopeContext === undefined
            ? {}
            : { scopeContext: stored.value.scopeContext }),
          confidence: betaSuccessEstimate(stored.value),
          importance: 0.8,
          authority: EvidenceAuthority.ProceduralMemory,
          evidenceRefs: stored.value.failureEvidence,
          idempotencyKey: `experience-degraded:${stored.value.id}:${stored.value.knowledgeRevision ?? 0}`,
          provenance: { origin: "tool", epistemicState: "verified" },
        },
        options,
      );
    }
    if (
      stored.value.state === "retired" &&
      initial.state !== "retired" &&
      stored.value.promotedMemoryId !== undefined
    ) {
      await this.#memory.tombstone(stored.value.promotedMemoryId, {
        scopeContext: stored.value.scopeContext ?? {
          tenantId: "local",
          userId: "local",
          appId: "pi",
          agentId: "pi-mentis",
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    return stored.value;
  }

  async qualify(id: string, options: OperationOptions = {}): Promise<ExperienceCandidate> {
    throwIfAborted(options.signal, "experience-qualify");
    const initial = await this.#required(id, options);
    const namespace = initial.scopeContext
      ? securityNamespaceForScope(initial.scopeContext)
      : "local:local:pi:pi-mentis";
    const now = this.#clock.now();
    const stored = await this.#state.mutate<ExperienceCandidate>({
      id,
      kind: "experience-candidate-v3",
      namespace,
      reduce: (record) => {
        const candidate = record?.value ?? initial;
        if (candidate.state === "promoted") {
          throw new Error(`Experience ${id} is already promoted`);
        }
        if (candidate.state === "rejected") {
          throw new Error(`Experience ${id} is rejected`);
        }
        const outcomes = distinctOutcomeCount(candidate);
        const estimate = betaSuccessEstimate(candidate);
        if (outcomes < this.#minimumOutcomes || estimate < this.#minimumSuccessEstimate) {
          throw new Error(
            `Experience ${id} has ${outcomes} independent outcomes and Beta estimate ${estimate.toFixed(3)}; qualification requires ${this.#minimumOutcomes} and ${this.#minimumSuccessEstimate}`,
          );
        }
        if (candidate.validationPlan.length === 0 || candidate.successEvidence.length === 0) {
          throw new Error(
            "Experience qualification requires a validation plan and success evidence",
          );
        }
        const value: ExperienceCandidate = { ...candidate, state: "qualified", updatedAt: now };
        return { value, status: value.state, now };
      },
    });
    return stored.value;
  }

  async promote(
    id: string,
    options: OperationOptions = {},
  ): Promise<Awaited<ReturnType<MemoryService["commit"]>>> {
    throwIfAborted(options.signal, "experience-promote");
    const candidate = await this.#required(id, options);
    if (candidate.state !== "qualified" && candidate.state !== "degraded") {
      throw new Error(`Experience ${id} must be qualified or degraded before promotion`);
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
      `Validated conditions: ${JSON.stringify(candidate.applicabilityContext ?? candidate.environment)}`,
      `Validation plan: ${candidate.validationPlan.join("; ")}`,
    ].join("\n");
    const knowledgeRevision = (candidate.knowledgeRevision ?? 0) + 1;
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
        importance: candidate.state === "degraded" ? 0.4 : 0.7,
        authority: EvidenceAuthority.ProceduralMemory,
        evidenceRefs: [...candidate.successEvidence, ...candidate.failureEvidence],
        idempotencyKey: `experience-promotion:${candidate.id}:${knowledgeRevision}`,
      },
      options,
    );
    const namespace = candidate.scopeContext
      ? securityNamespaceForScope(candidate.scopeContext)
      : "local:local:pi:pi-mentis";
    const now = this.#clock.now();
    await this.#state.mutate<ExperienceCandidate>({
      id,
      kind: "experience-candidate-v3",
      namespace,
      reduce: (record) => {
        const current = record?.value ?? candidate;
        const rejected = result.outcome === "rejected" || result.outcome === "rejected_sensitive";
        const value: ExperienceCandidate = {
          ...current,
          state: rejected ? "rejected" : "promoted",
          knowledgeRevision,
          ...(result.record?.id === undefined ? {} : { promotedMemoryId: result.record.id }),
          updatedAt: now,
        };
        return { value, status: value.state, now };
      },
    });
    return result;
  }

  async get(id: string, options: OperationOptions = {}): Promise<ExperienceCandidate | undefined> {
    throwIfAborted(options.signal, "experience-get");
    const current = await this.#state.get<ExperienceCandidate>(id);
    if (current !== undefined) return current.value;
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
