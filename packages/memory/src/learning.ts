import type { EvidenceRef } from "@pi-mentis/pi-mentis-core";

import type {
  ExperienceCandidate,
  ExperienceOutcome,
  OutcomeStatus,
  PiEpisode,
  PiEvent,
  PiScopeContext,
} from "./types.js";
import type { ProcedureProposal } from "./semantic-consolidation.js";
import type { TaskEpisode, TaskEpisodeDigest } from "./task-episode.js";

type CandidateInput = Omit<
  ExperienceCandidate,
  | "id"
  | "successes"
  | "failures"
  | "state"
  | "successEvidence"
  | "failureEvidence"
  | "createdAt"
  | "updatedAt"
>;

export interface DerivedExperienceObservation {
  readonly candidate: CandidateInput;
  readonly outcome: ExperienceOutcome;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function resultStatus(event: PiEvent): "completed" | "failed" | undefined {
  const result = object(event.payload["result"]);
  const status = result?.["status"];
  return status === "completed" || status === "failed" ? status : undefined;
}

function step(event: PiEvent): string | undefined {
  if (event.kind !== "tool_call") return undefined;
  const toolName = event.payload["toolName"];
  const input = event.payload["input"];
  if (typeof toolName !== "string") return undefined;
  const serialized = JSON.stringify(input ?? {});
  return `${toolName}: ${serialized.length > 1_000 ? `${serialized.slice(0, 1_000)}…` : serialized}`;
}

export function deriveExperienceObservation(
  episode: PiEpisode,
  events: readonly PiEvent[],
  outcome: OutcomeStatus,
  environment: Readonly<Record<string, string>>,
  scopeContext?: PiScopeContext,
): DerivedExperienceObservation | undefined {
  const lastSteering =
    [...events].reverse().find((event) => event.kind === "steering")?.sequence ?? 0;
  const relevant = events.filter((event) => event.sequence > lastSteering);
  const failedIndex = relevant.findIndex((event) => resultStatus(event) === "failed");
  if (failedIndex < 0) return undefined;
  const recovery = relevant
    .slice(failedIndex + 1)
    .find((event) => resultStatus(event) === "completed");
  const verification = [...relevant].reverse().find((event) => event.kind === "verification");
  if (recovery === undefined || verification === undefined) return undefined;
  const steps = relevant.map(step).filter((value): value is string => value !== undefined);
  if (steps.length === 0) return undefined;
  const evidence: EvidenceRef = {
    kind: "event",
    id: verification.id,
    observedAt: verification.timestamp,
  };
  const verificationCommand = verification.payload["command"];
  return {
    candidate: {
      goal: episode.goal,
      ...(scopeContext === undefined ? {} : { scopeContext }),
      environment,
      prerequisites: [],
      steps,
      cost: 0,
      durationMs: Math.max(0, (episode.endedAt ?? episode.startedAt) - episode.startedAt),
      appliesWhen: [
        ...(episode.repositoryId === undefined ? [] : [`repository=${episode.repositoryId}`]),
        ...(episode.projectId === undefined ? [] : [`project=${episode.projectId}`]),
        ...(episode.workspacePath === undefined ? [] : [`workspace=${episode.workspacePath}`]),
        ...episode.topicIds.map((topicId) => `topic=${topicId}`),
        ...(episode.taskId === undefined ? [] : [`task=${episode.taskId}`]),
      ],
      excludesWhen: lastSteering === 0 ? [] : ["plans invalidated before the last steering event"],
      capabilityGaps: [],
      generationContext: ["pi-event-rules-v1", `episode=${episode.id}`],
      validationPlan: [
        typeof verificationCommand === "string"
          ? `Run ${verificationCommand} and require a successful tool result`
          : "Repeat the captured verification and require a successful tool result",
      ],
    },
    outcome: {
      succeeded: outcome.executionStatus === "success" && outcome.verificationStatus === "passed",
      evidence,
      cost: 0,
      durationMs: Math.max(0, (episode.endedAt ?? episode.startedAt) - episode.startedAt),
      environment,
    },
  };
}

export function deriveTaskEpisodeExperienceObservation(
  task: TaskEpisode,
  digest: TaskEpisodeDigest,
  procedure: ProcedureProposal,
  environment: Readonly<Record<string, string>>,
  scopeContext: PiScopeContext,
): DerivedExperienceObservation | undefined {
  if (task.state === "aborted" || digest.verification === "unknown") return undefined;
  const evidence = digest.evidence.find(
    (entry) => procedure.evidenceIds.includes(entry.id) && entry.verified,
  );
  if (evidence === undefined && digest.verification === "passed") return undefined;
  const fallbackEvidence = digest.evidence.find((entry) =>
    procedure.evidenceIds.includes(entry.id),
  );
  const selected = evidence ?? fallbackEvidence;
  if (selected === undefined) return undefined;
  const evidenceRef: EvidenceRef = {
    kind: selected.kind,
    id: selected.id,
    observedAt: task.updatedAt,
  };
  const applicabilityContext = {
    ...(task.repositoryId === undefined ? {} : { repositoryId: task.repositoryId }),
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => !/(embedding|rerank|model)/iu.test(key)),
    ),
  };
  return {
    candidate: {
      version: 2,
      goal: procedure.problemCues.join("; "),
      scopeContext,
      environment,
      prerequisites: procedure.prerequisites,
      steps: procedure.generalizedSteps,
      generalizedSteps: procedure.generalizedSteps,
      normalizedProblemCues: procedure.problemCues,
      rawEpisodeIds: task.episodeIds,
      successCriteria: procedure.successCriteria,
      applicabilityContext,
      cost: 0,
      durationMs: Math.max(0, (task.endedAt ?? task.updatedAt) - task.startedAt),
      appliesWhen: procedure.appliesWhen,
      excludesWhen: procedure.excludesWhen,
      capabilityGaps: [],
      generationContext: ["pi-task-episode-cognition-v1", `taskEpisode=${task.id}`],
      validationPlan: procedure.successCriteria,
    },
    outcome: {
      succeeded: task.state === "completed" && digest.verification === "passed",
      evidence: evidenceRef,
      cost: 0,
      durationMs: Math.max(0, (task.endedAt ?? task.updatedAt) - task.startedAt),
      environment,
    },
  };
}
