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
  type PiScopeContext,
  type ProcedureFamily,
} from "./types.js";
import {
  boundedText,
  lexicalOverlap,
  lexicalTerms,
  securityNamespaceForScope,
} from "./cognitive-shared.js";
import { canonicalProcedureFamily, procedureFamilyKey } from "./procedure-family.js";

export type ProcedureLifecycleEventName =
  | "procedure.observed"
  | "procedure.outcome_recorded"
  | "procedure.outcome_deduped"
  | "procedure.qualification_rejected"
  | "procedure.qualified"
  | "procedure.promotion_rejected"
  | "procedure.promoted"
  | "procedure.retrieved"
  | "procedure.selected"
  | "procedure.injected";

export type ProcedureQualificationRejectionReason =
  | "insufficient_outcomes"
  | "success_rate"
  | "missing_validation_plan"
  | "missing_success_evidence"
  | "applicability_mismatch"
  | "invalid_state";

export interface ProcedureLifecycleEvent {
  readonly name: ProcedureLifecycleEventName;
  readonly candidateId: string;
  readonly familyKey: string;
  readonly sessionId: string;
  readonly taskEpisodeId: string;
  readonly revision: number;
  readonly timestamp: number;
  readonly evidenceId?: string;
  readonly reason?: ProcedureQualificationRejectionReason | "memory_rejected" | "commit_failed";
  readonly memoryId?: string;
  readonly turnId?: string;
  readonly rank?: number;
  readonly score?: number;
  readonly gateDecision?: "allowed" | "rejected";
  readonly tokenCost?: number;
}

export interface CreateExperienceLearningServiceOptions {
  readonly store: ZvecStore;
  readonly memory: MemoryService;
  readonly minimumOutcomes?: number;
  readonly minimumSuccessEstimate?: number;
  readonly clock?: Clock;
  readonly onLifecycleEvent?: (event: ProcedureLifecycleEvent) => void;
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
    return new Set(
      candidate.outcomes?.map((outcome) => `${outcome.sessionId}\u0000${outcome.taskEpisodeId}`),
    ).size;
  }
  return new Set(
    [...candidate.successEvidence, ...candidate.failureEvidence].map(
      (evidence) => `${evidence.kind}:${evidence.id}`,
    ),
  ).size;
}

function independentSuccessCount(candidate: ExperienceCandidate): number {
  return new Set(
    (candidate.outcomes ?? [])
      .filter((outcome) => outcome.succeeded)
      .map((outcome) => `${outcome.sessionId}\u0000${outcome.taskEpisodeId}`),
  ).size;
}

function eventIdentity(candidate: ExperienceCandidate): {
  readonly sessionId: string;
  readonly taskEpisodeId: string;
} {
  const latest = candidate.outcomes?.at(-1);
  return {
    sessionId: latest?.sessionId ?? candidate.scopeContext?.sessionId ?? "unknown-session",
    taskEpisodeId: latest?.taskEpisodeId ?? candidate.scopeContext?.taskId ?? "unknown-task",
  };
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
  readonly #onLifecycleEvent: ((event: ProcedureLifecycleEvent) => void) | undefined;

  constructor(options: CreateExperienceLearningServiceOptions) {
    this.#store = options.store;
    this.#state = new ZvecStateStore(options.store);
    this.#memory = options.memory;
    this.#minimumOutcomes = options.minimumOutcomes ?? 3;
    this.#minimumSuccessEstimate = options.minimumSuccessEstimate ?? 0.7;
    this.#clock = options.clock ?? systemClock;
    this.#onLifecycleEvent = options.onLifecycleEvent;
  }

  #emit(
    candidate: ExperienceCandidate,
    event: Omit<ProcedureLifecycleEvent, "candidateId" | "familyKey" | "revision" | "timestamp">,
  ): void {
    try {
      this.#onLifecycleEvent?.({
        ...event,
        candidateId: candidate.id,
        familyKey: candidate.familyKey ?? `legacy:${candidate.id}`,
        revision: candidate.revision ?? 0,
        timestamp: this.#clock.now(),
      });
    } catch {
      // Telemetry is diagnostic and must never change learning behavior.
    }
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
    const family = input.family === undefined ? undefined : canonicalProcedureFamily(input.family);
    const familyKey = family === undefined ? input.familyKey : procedureFamilyKey(family);
    const familyScopeKey =
      input.scopeContext?.repositoryId === undefined
        ? input.scopeContext?.projectId === undefined
          ? "user"
          : `project:${input.scopeContext.projectId}`
        : `repository:${input.scopeContext.repositoryId}`;
    const proposedId =
      familyKey === undefined
        ? stableHash(
            v2 ? "experience:v3" : "experience:v1",
            namespace,
            cueSignature,
            operationPattern.join("->"),
            JSON.stringify(Object.entries(applicability).sort(([a], [b]) => a.localeCompare(b))),
          )
        : stableHash("experience-family:v1", namespace, familyScopeKey, familyKey);
    const familyCandidates = v2
      ? await this.#state.list<ExperienceCandidate>({
          kind: "experience-candidate-v3",
          namespace,
          limit: 1_000,
        })
      : [];
    const matchedFamily =
      familyKey === undefined
        ? familyCandidates
            .map((record) => record.value)
            .filter(
              (candidate) =>
                JSON.stringify(candidate.applicabilityContext ?? {}) ===
                  JSON.stringify(applicability) &&
                JSON.stringify(candidate.operationPattern ?? []) ===
                  JSON.stringify(operationPattern),
            )
            .map((candidate) => ({
              candidate,
              overlap: lexicalOverlap(
                (candidate.normalizedProblemCues ?? [candidate.goal]).join(" "),
                (input.normalizedProblemCues ?? [input.goal]).join(" "),
              ),
            }))
            .filter((entry) => entry.overlap >= 0.5)
            .sort((left, right) => right.overlap - left.overlap)[0]?.candidate
        : familyCandidates
            .map((record) => record.value)
            .find(
              (candidate) =>
                candidate.familyKey === familyKey &&
                candidate.scopeContext?.repositoryId === input.scopeContext?.repositoryId &&
                candidate.scopeContext?.projectId === input.scopeContext?.projectId,
            );
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
            ...(family === undefined ? {} : { family }),
            ...(familyKey === undefined ? {} : { familyKey }),
            rawEpisodeIds: [
              ...new Set([...(existing.rawEpisodeIds ?? []), ...(input.rawEpisodeIds ?? [])]),
            ].slice(-256),
            generationContext: [
              ...new Set([...existing.generationContext, ...input.generationContext]),
            ].slice(-64),
            updatedAt: now,
            revision: (existing.revision ?? 0) + 1,
          };
          return { value, status: value.state, now };
        }
        const value: ExperienceCandidate = {
          ...input,
          version: v2 ? 2 : (input.version ?? 1),
          id,
          ...(family === undefined ? {} : { family }),
          ...(familyKey === undefined ? {} : { familyKey }),
          applicabilityContext: applicability,
          operationPattern,
          successEvidence: [],
          failureEvidence: [],
          outcomes: [],
          successes: 0,
          failures: 0,
          state: "observed",
          knowledgeRevision: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        return { value, status: value.state, now };
      },
    });
    this.#emit(stored.value, {
      name: "procedure.observed",
      sessionId: input.scopeContext?.sessionId ?? "unknown-session",
      taskEpisodeId: input.scopeContext?.taskId ?? "unknown-task",
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
    let deduped = false;
    let applicabilityMismatch = false;
    let stored;
    try {
      stored = await this.#state.mutate<ExperienceCandidate>({
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
            applicabilityMismatch = true;
            throw new Error(
              "Experience outcome environment does not match the candidate conditions",
            );
          }
          const outcomes = candidate.outcomes ?? [];
          if (
            outcomes.some(
              (entry) =>
                entry.outcomeId === outcome.outcomeId ||
                (entry.sessionId === outcome.sessionId &&
                  entry.taskEpisodeId === outcome.taskEpisodeId),
            ) ||
            [...candidate.successEvidence, ...candidate.failureEvidence].some(
              (evidence) =>
                evidence.kind === outcome.evidence.kind && evidence.id === outcome.evidence.id,
            )
          ) {
            deduped = true;
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
            revision: (candidate.revision ?? 0) + 1,
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
    } catch (error) {
      if (applicabilityMismatch) {
        this.#emit(initial, {
          name: "procedure.qualification_rejected",
          sessionId: outcome.sessionId,
          taskEpisodeId: outcome.taskEpisodeId,
          evidenceId: outcome.evidence.id,
          reason: "applicability_mismatch",
        });
      }
      throw error;
    }
    this.#emit(stored.value, {
      name: deduped ? "procedure.outcome_deduped" : "procedure.outcome_recorded",
      sessionId: outcome.sessionId,
      taskEpisodeId: outcome.taskEpisodeId,
      evidenceId: outcome.evidence.id,
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
    let rejectionReason: ProcedureQualificationRejectionReason | undefined;
    let stored;
    try {
      stored = await this.#state.mutate<ExperienceCandidate>({
        id,
        kind: "experience-candidate-v3",
        namespace,
        reduce: (record) => {
          const candidate = record?.value ?? initial;
          if (candidate.state === "promoted") {
            rejectionReason = "invalid_state";
            throw new Error(`Experience ${id} is already promoted`);
          }
          if (candidate.state === "rejected") {
            rejectionReason = "invalid_state";
            throw new Error(`Experience ${id} is rejected`);
          }
          const outcomes = distinctOutcomeCount(candidate);
          const estimate = betaSuccessEstimate(candidate);
          if (outcomes < this.#minimumOutcomes) {
            rejectionReason = "insufficient_outcomes";
            throw new Error(
              `Experience ${id} has ${outcomes} independent outcomes; qualification requires ${this.#minimumOutcomes}`,
            );
          }
          if (estimate < this.#minimumSuccessEstimate) {
            rejectionReason = "success_rate";
            throw new Error(
              `Experience ${id} has ${outcomes} independent outcomes and Beta estimate ${estimate.toFixed(3)}; qualification requires ${this.#minimumOutcomes} and ${this.#minimumSuccessEstimate}`,
            );
          }
          if (candidate.validationPlan.length === 0) {
            rejectionReason = "missing_validation_plan";
            throw new Error("Experience qualification requires a validation plan");
          }
          if (candidate.successEvidence.length === 0) {
            rejectionReason = "missing_success_evidence";
            throw new Error("Experience qualification requires success evidence");
          }
          const value: ExperienceCandidate = {
            ...candidate,
            state: "qualified",
            updatedAt: now,
            revision: (candidate.revision ?? 0) + 1,
          };
          return { value, status: value.state, now };
        },
      });
    } catch (error) {
      this.#emit(initial, {
        name: "procedure.qualification_rejected",
        ...eventIdentity(initial),
        reason: rejectionReason ?? "invalid_state",
      });
      throw error;
    }
    this.#emit(stored.value, {
      name: "procedure.qualified",
      ...eventIdentity(stored.value),
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
    const family: ProcedureFamily = candidate.family ?? {
      domain: "legacy",
      failureMode: "unknown",
      trigger: "unknown",
      semanticRole: "unknown",
      intendedBehavior: "unknown",
    };
    const familyKey = candidate.familyKey ?? `legacy:${candidate.id}`;
    const reusableScopeContext =
      candidate.scopeContext === undefined
        ? undefined
        : ({
            tenantId: candidate.scopeContext.tenantId,
            userId: candidate.scopeContext.userId,
            appId: candidate.scopeContext.appId,
            agentId: candidate.scopeContext.agentId,
            ...(candidate.scopeContext.workspacePath === undefined
              ? {}
              : { workspacePath: candidate.scopeContext.workspacePath }),
            ...(candidate.scopeContext.repositoryId === undefined
              ? {}
              : { repositoryId: candidate.scopeContext.repositoryId }),
            ...(candidate.scopeContext.projectId === undefined
              ? {}
              : { projectId: candidate.scopeContext.projectId }),
            ...(candidate.scopeContext.interactionMode === undefined
              ? {}
              : { interactionMode: candidate.scopeContext.interactionMode }),
          } satisfies PiScopeContext);
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
    let result;
    try {
      result = await this.#memory.commit(
        {
          content,
          scope:
            candidate.version === 2 && candidate.scopeContext?.repositoryId !== undefined
              ? { kind: "repository", id: candidate.scopeContext.repositoryId }
              : candidate.version === 2 && candidate.scopeContext?.projectId !== undefined
                ? { kind: "project", id: candidate.scopeContext.projectId }
                : { kind: "user", id: "experience" },
          ...(reusableScopeContext === undefined ? {} : { scopeContext: reusableScopeContext }),
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
          role: "procedure",
          procedure: {
            candidateId: candidate.id,
            familyKey,
            family,
            independentSuccesses: independentSuccessCount(candidate),
            trigger: candidate.appliesWhen[0] ?? family.trigger,
            firstCheck: steps[0] ?? "Inspect the verified failure path before changing behavior.",
            validatedSteps: steps,
            successCriteria: candidate.successCriteria ?? candidate.validationPlan,
            excludesWhen: candidate.excludesWhen,
            lifecycle: "promoted",
          },
          evidenceRefs: [...candidate.successEvidence, ...candidate.failureEvidence],
          idempotencyKey: `experience-promotion:${candidate.id}:${knowledgeRevision}`,
        },
        options,
      );
    } catch (error) {
      this.#emit(candidate, {
        name: "procedure.promotion_rejected",
        ...eventIdentity(candidate),
        reason: "commit_failed",
      });
      throw error;
    }
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
          revision: (current.revision ?? 0) + 1,
          ...(result.record?.id === undefined ? {} : { promotedMemoryId: result.record.id }),
          updatedAt: now,
        };
        return { value, status: value.state, now };
      },
    });
    const updated = await this.#required(id, options);
    if (result.outcome === "rejected" || result.outcome === "rejected_sensitive") {
      this.#emit(updated, {
        name: "procedure.promotion_rejected",
        ...eventIdentity(updated),
        reason: "memory_rejected",
      });
    } else {
      this.#emit(updated, {
        name: "procedure.promoted",
        ...eventIdentity(updated),
        ...(result.record?.id === undefined ? {} : { memoryId: result.record.id }),
      });
    }
    return result;
  }

  async listReusable(
    scopeContext: PiScopeContext,
    options: OperationOptions = {},
  ): Promise<readonly ExperienceCandidate[]> {
    throwIfAborted(options.signal, "experience-list-reusable");
    const namespace = securityNamespaceForScope(scopeContext);
    const records = await this.#state.list<ExperienceCandidate>({
      kind: "experience-candidate-v3",
      namespace,
      limit: 1_000,
    });
    return records
      .map((record) => record.value)
      .filter(
        (candidate) =>
          candidate.state === "promoted" &&
          candidate.promotedMemoryId !== undefined &&
          candidate.family !== undefined &&
          candidate.familyKey !== undefined &&
          (candidate.scopeContext?.repositoryId === undefined ||
            candidate.scopeContext.repositoryId === scopeContext.repositoryId) &&
          (candidate.scopeContext?.projectId === undefined ||
            candidate.scopeContext.projectId === scopeContext.projectId),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 64);
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
