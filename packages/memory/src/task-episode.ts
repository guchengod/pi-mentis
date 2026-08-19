import {
  estimateModelTokens,
  stableHash,
  systemClock,
  type Clock,
  type EvidenceRef,
  type OperationOptions,
} from "@pi-mentis/pi-mentis-core";
import { ZvecStateStore, type ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import { boundedText, securityNamespaceForScope } from "./cognitive-shared.js";
import { safeSummary } from "./secret-detector.js";
import type { OutcomeStatus, PiEpisode, PiEvent, PiScopeContext } from "./types.js";
import type { WorkingMemoryState } from "./working-memory.js";

export type TaskEpisodeState = "active" | "completed" | "failed" | "aborted";

export interface TaskEpisodeTurn {
  readonly episodeId: string;
  readonly goal: string;
  readonly failures: readonly string[];
  readonly successfulActions: readonly string[];
  readonly verifications: readonly string[];
  readonly steeringEvents: readonly string[];
  readonly activeResources: readonly string[];
  readonly artifactIds: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly verifiedEvidenceIds?: readonly string[];
  readonly outcome: OutcomeStatus;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface TaskEpisode {
  readonly version: 1;
  readonly id: string;
  readonly namespace: string;
  readonly taskId: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
  readonly branchId: string;
  readonly parentBranchId?: string;
  readonly episodeIds: readonly string[];
  readonly state: TaskEpisodeState;
  readonly verification: "unknown" | "passed" | "failed";
  readonly turns: readonly TaskEpisodeTurn[];
  readonly recalledMemoryIds: readonly string[];
  readonly workingMemoryDecisions: readonly string[];
  readonly confirmedWorkingFacts: readonly string[];
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly endedAt?: number;
}

export interface TaskEpisodeDigestEvidence {
  readonly id: string;
  readonly kind: EvidenceRef["kind"];
  readonly text: string;
  readonly verified: boolean;
}

export interface TaskEpisodeDigest {
  readonly version: 1;
  readonly taskEpisodeId: string;
  readonly namespace: string;
  readonly taskId: string;
  readonly branchId: string;
  readonly state: TaskEpisodeState;
  readonly verification: TaskEpisode["verification"];
  readonly goals: readonly string[];
  readonly failures: readonly string[];
  readonly successfulActions: readonly string[];
  readonly verifications: readonly string[];
  readonly steeringEvents: readonly string[];
  readonly activeResources: readonly string[];
  readonly artifactIds: readonly string[];
  readonly recalledMemoryIds: readonly string[];
  readonly workingMemoryDecisions: readonly string[];
  readonly confirmedWorkingFacts: readonly string[];
  readonly episodeIds: readonly string[];
  readonly evidence: readonly TaskEpisodeDigestEvidence[];
  readonly serialized: string;
  readonly estimatedTokens: number;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function eventRef(event: PiEvent): EvidenceRef {
  return { kind: "event", id: event.id, observedAt: event.timestamp };
}

function resultStatus(event: PiEvent): "completed" | "failed" | undefined {
  const status = object(event.payload["result"])?.["status"];
  return status === "completed" || status === "failed" ? status : undefined;
}

function toolSummary(event: PiEvent): string | undefined {
  if (event.kind !== "tool_call") return undefined;
  const tool = event.payload["toolName"];
  const input = object(event.payload["input"]);
  if (typeof tool !== "string") return undefined;
  const subject =
    typeof input?.["path"] === "string"
      ? input["path"]
      : typeof input?.["command"] === "string"
        ? input["command"]
        : "";
  return safeSummary(boundedText(`${tool}${subject === "" ? "" : `: ${subject}`}`, 400), 400);
}

function turnFromEpisode(
  episode: PiEpisode,
  events: readonly PiEvent[],
  outcome: OutcomeStatus,
): TaskEpisodeTurn {
  const lastSteering =
    [...events].reverse().find((event) => event.kind === "steering")?.sequence ?? 0;
  const validPath = events.filter((event) => event.sequence > lastSteering);
  const calls = new Map(
    validPath
      .filter((event) => event.kind === "tool_call" && event.toolCallId !== undefined)
      .map((event) => [event.toolCallId as string, event]),
  );
  const successes: string[] = [];
  const failures: string[] = [];
  for (const event of validPath) {
    const status = resultStatus(event);
    if (status === undefined) continue;
    const call = event.toolCallId === undefined ? undefined : calls.get(event.toolCallId);
    const summary = call === undefined ? undefined : toolSummary(call);
    const value = summary ?? `tool ${event.toolCallId ?? event.id}`;
    if (status === "completed") successes.push(value);
    else failures.push(value);
  }
  const verifications = validPath
    .filter((event) => event.kind === "verification")
    .map((event) => {
      const command = event.payload["command"];
      const status = event.payload["status"];
      return safeSummary(
        boundedText(
          `${typeof command === "string" ? command : "verification"}: ${String(status)}`,
          400,
        ),
        400,
      );
    });
  const activeResources = validPath
    .map(toolSummary)
    .filter((value): value is string => value !== undefined);
  const artifactIds = validPath
    .map((event) => (event.artifactRef?.kind === "artifact" ? event.artifactRef.id : undefined))
    .filter((value): value is string => value !== undefined);
  return {
    episodeId: episode.id,
    goal: safeSummary(boundedText(episode.goal, 500), 500),
    failures: [...new Set(failures)].slice(-24),
    successfulActions: [...new Set(successes)].slice(-32),
    verifications: [...new Set(verifications)].slice(-16),
    steeringEvents: events
      .filter((event) => event.kind === "steering")
      .map((event) =>
        safeSummary(boundedText(String(event.payload["updatedGoal"] ?? "steering"), 300), 300),
      )
      .slice(-8),
    activeResources: [...new Set(activeResources)].slice(-32),
    artifactIds: [...new Set(artifactIds)].slice(-32),
    evidenceRefs: events.map(eventRef).slice(-128),
    verifiedEvidenceIds: validPath
      .filter((event) => event.kind === "verification" && event.payload["status"] === "passed")
      .map((event) => event.id)
      .slice(-16),
    outcome,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt ?? episode.startedAt,
  };
}

function stateForOutcome(outcome: OutcomeStatus): TaskEpisodeState {
  if (outcome.taskStatus === "completed" && outcome.verificationStatus === "passed")
    return "completed";
  if (outcome.taskStatus === "failed") return "failed";
  if (outcome.taskStatus === "aborted") return "aborted";
  return "active";
}

function taskEpisodeId(namespace: string, taskId: string, branchId: string): string {
  return stableHash("task-episode:v1", namespace, taskId, branchId);
}

export class TaskEpisodeService {
  readonly #state: ZvecStateStore;
  readonly #clock: Clock;

  constructor(store: ZvecStore, clock: Clock = systemClock) {
    this.#state = new ZvecStateStore(store);
    this.#clock = clock;
  }

  async append(input: {
    readonly taskId: string;
    readonly scopeContext: PiScopeContext;
    readonly episode: PiEpisode;
    readonly events: readonly PiEvent[];
    readonly outcome: OutcomeStatus;
    readonly workingMemory?: WorkingMemoryState;
  }): Promise<TaskEpisode> {
    const namespace = securityNamespaceForScope(input.scopeContext);
    const branchId = input.scopeContext.branchId ?? input.episode.branchId ?? "root";
    const id = taskEpisodeId(namespace, input.taskId, branchId);
    const existing = (await this.#state.get<TaskEpisode>(id))?.value;
    if (existing?.episodeIds.includes(input.episode.id)) return existing;
    const turn = turnFromEpisode(input.episode, input.events, input.outcome);
    const now = this.#clock.now();
    const state = stateForOutcome(input.outcome);
    const task: TaskEpisode = {
      version: 1,
      id,
      namespace,
      taskId: input.taskId,
      ...(input.scopeContext.repositoryId === undefined
        ? {}
        : { repositoryId: input.scopeContext.repositoryId }),
      ...(input.scopeContext.projectId === undefined
        ? {}
        : { projectId: input.scopeContext.projectId }),
      branchId,
      ...(input.scopeContext.parentBranchId === undefined
        ? {}
        : { parentBranchId: input.scopeContext.parentBranchId }),
      episodeIds: [...(existing?.episodeIds ?? []), input.episode.id].slice(-256),
      state,
      verification:
        input.outcome.verificationStatus === "passed"
          ? "passed"
          : input.outcome.verificationStatus === "failed"
            ? "failed"
            : (existing?.verification ?? "unknown"),
      turns: [...(existing?.turns ?? []), turn].slice(-128),
      recalledMemoryIds: [
        ...new Set([
          ...(existing?.recalledMemoryIds ?? []),
          ...(input.workingMemory?.recalledMemoryIds ?? []),
        ]),
      ].slice(-64),
      workingMemoryDecisions: [
        ...new Set([
          ...(existing?.workingMemoryDecisions ?? []),
          ...(input.workingMemory?.decisions
            .filter((entry) => entry.state === "active" || entry.state === "confirmed")
            .map((entry) => entry.text) ?? []),
        ]),
      ].slice(-32),
      confirmedWorkingFacts: [
        ...new Set([
          ...(existing?.confirmedWorkingFacts ?? []),
          ...(input.workingMemory?.confirmed
            .filter((entry) => entry.state === "confirmed")
            .map((entry) => entry.text) ?? []),
        ]),
      ].slice(-64),
      startedAt: existing?.startedAt ?? input.episode.startedAt,
      updatedAt: now,
      ...(state === "active" ? {} : { endedAt: input.episode.endedAt ?? now }),
    };
    await this.#state.put(
      { id, kind: "task-episode-v1", namespace, value: task },
      { status: task.state, now },
    );
    return task;
  }

  async get(namespace: string, taskId: string, branchId: string): Promise<TaskEpisode | undefined> {
    return (await this.#state.get<TaskEpisode>(taskEpisodeId(namespace, taskId, branchId)))?.value;
  }

  async checkpoint(task: TaskEpisode, options: OperationOptions = {}): Promise<void> {
    if (options.signal?.aborted) throw options.signal.reason;
    await this.#state.put(
      { id: task.id, kind: "task-episode-v1", namespace: task.namespace, value: task },
      { status: task.state, now: this.#clock.now() },
    );
  }
}

function unique(values: readonly string[], limit: number): string[] {
  return [...new Set(values)].slice(-limit);
}

export function createTaskEpisodeDigest(task: TaskEpisode, maxTokens: number): TaskEpisodeDigest {
  const mutable = {
    version: 1 as const,
    taskEpisodeId: task.id,
    namespace: task.namespace,
    taskId: task.taskId,
    branchId: task.branchId,
    state: task.state,
    verification: task.verification,
    goals: unique(
      task.turns.map((turn) => turn.goal),
      24,
    ),
    failures: unique(
      task.turns.flatMap((turn) => turn.failures),
      48,
    ),
    successfulActions: unique(
      task.turns.flatMap((turn) => turn.successfulActions),
      64,
    ),
    verifications: unique(
      task.turns.flatMap((turn) => turn.verifications),
      32,
    ),
    steeringEvents: unique(
      task.turns.flatMap((turn) => turn.steeringEvents),
      16,
    ),
    activeResources: unique(
      task.turns.flatMap((turn) => turn.activeResources),
      64,
    ),
    artifactIds: unique(
      task.turns.flatMap((turn) => turn.artifactIds),
      64,
    ),
    recalledMemoryIds: [...task.recalledMemoryIds],
    workingMemoryDecisions: [...task.workingMemoryDecisions],
    confirmedWorkingFacts: [...task.confirmedWorkingFacts],
    episodeIds: [...task.episodeIds],
    evidence: task.turns
      .flatMap((turn) =>
        turn.evidenceRefs.map((ref) => ({
          id: ref.id,
          kind: ref.kind,
          text: boundedText(
            [...turn.failures, ...turn.successfulActions, ...turn.verifications].join("; ") ||
              turn.goal,
            500,
          ),
          verified:
            turn.outcome.verificationStatus === "passed" &&
            (turn.verifiedEvidenceIds ?? []).includes(ref.id),
        })),
      )
      .filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index)
      .slice(-128),
  };
  const trimOrder: Array<keyof typeof mutable> = [
    "activeResources",
    "recalledMemoryIds",
    "steeringEvents",
    "failures",
    "successfulActions",
    "confirmedWorkingFacts",
    "workingMemoryDecisions",
    "goals",
    "evidence",
    "episodeIds",
    "artifactIds",
  ];
  let serialized = JSON.stringify(mutable);
  while (estimateModelTokens(serialized) > maxTokens) {
    const key = trimOrder.find((candidate) => {
      if (!Array.isArray(mutable[candidate])) return false;
      const minimum = ["verifications", "evidence", "episodeIds", "artifactIds"].includes(candidate)
        ? 1
        : 0;
      return (mutable[candidate] as readonly unknown[]).length > minimum;
    });
    if (key === undefined) break;
    const values = mutable[key] as unknown as unknown[];
    values.shift();
    serialized = JSON.stringify(mutable);
  }
  if (estimateModelTokens(serialized) > maxTokens) {
    throw new Error(`Task episode digest cannot fit configured ${maxTokens} token budget`);
  }
  return { ...mutable, serialized, estimatedTokens: estimateModelTokens(serialized) };
}
