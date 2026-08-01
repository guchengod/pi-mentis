import { operationId, stableHash, type OperationOptions } from "@pi-mentis/pi-mentis-core";

import { offloadToolResult } from "./offload.js";
import type {
  OffloadedToolResult,
  OutcomeStatus,
  PiEpisode,
  PiEvent,
  PiEvidenceStore,
  PiScopeContext,
  ToolResultEnvelope,
  ToolResultOffloadPolicy,
} from "./types.js";

const VERIFICATION_COMMAND =
  /(?:^|\s)(?:test|typecheck|lint|check|build|verify|go\s+test|cargo\s+test|pytest|vitest|jest|tsc)(?:\s|$)/i;

export interface StartPiEpisodeInput {
  readonly goal: string;
  readonly scope: PiScopeContext;
  readonly startedAt?: number;
}

export type PiEpisodeFinishedHandler = (
  episode: PiEpisode,
  events: readonly PiEvent[],
  outcome: OutcomeStatus,
) => void;

interface StartedTool {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
  readonly callEventId: string;
}

export class PiCaptureSession {
  readonly #evidence: PiEvidenceStore;
  readonly #policy: ToolResultOffloadPolicy;
  readonly #tools = new Map<string, StartedTool>();
  readonly #onFinished: PiEpisodeFinishedHandler | undefined;
  readonly #events: PiEvent[] = [];
  #episode?: PiEpisode;
  #sequence = 0;
  #previousGoal?: string;
  #lastExecutionFailed = false;
  #verificationStatus: OutcomeStatus["verificationStatus"] = "not_run";

  constructor(
    evidence: PiEvidenceStore,
    policy: ToolResultOffloadPolicy,
    onFinished?: PiEpisodeFinishedHandler,
  ) {
    this.#evidence = evidence;
    this.#policy = policy;
    this.#onFinished = onFinished;
  }

  get episode(): PiEpisode | undefined {
    return this.#episode;
  }

  async start(input: StartPiEpisodeInput, options: OperationOptions = {}): Promise<PiEpisode> {
    if (this.#episode?.status === "running") {
      await this.finish("partial", options);
    }
    const startedAt = input.startedAt ?? Date.now();
    const sessionId = input.scope.sessionId ?? "unknown-session";
    const runId = input.scope.runId ?? operationId("operation");
    const id = stableHash(
      "pi-episode:v1",
      sessionId,
      input.scope.branchId ?? "root",
      runId,
      String(startedAt),
    );
    this.#sequence = 0;
    this.#tools.clear();
    this.#events.length = 0;
    this.#lastExecutionFailed = false;
    this.#verificationStatus = "not_run";
    this.#previousGoal = input.goal;
    const episode: PiEpisode = {
      id,
      sessionId,
      ...(input.scope.branchId === undefined ? {} : { branchId: input.scope.branchId }),
      ...(input.scope.parentBranchId === undefined
        ? {}
        : { parentBranchId: input.scope.parentBranchId }),
      runId,
      ...(input.scope.projectId === undefined ? {} : { projectId: input.scope.projectId }),
      ...(input.scope.repositoryId === undefined ? {} : { repositoryId: input.scope.repositoryId }),
      ...(input.scope.workspacePath === undefined
        ? {}
        : { workspacePath: input.scope.workspacePath }),
      ...(input.scope.contextSnapshotId === undefined
        ? {}
        : { contextSnapshotId: input.scope.contextSnapshotId }),
      ...(input.scope.taskId === undefined ? {} : { taskId: input.scope.taskId }),
      topicIds: input.scope.topicIds ?? [],
      ...(input.scope.interactionMode === undefined
        ? {}
        : { interactionMode: input.scope.interactionMode }),
      goal: input.goal,
      startedAt,
      status: "running",
      firstSequence: 1,
      lastSequence: 1,
    };
    this.#episode = episode;
    await this.#evidence.createEpisode(episode, options);
    await this.#append("goal", { goal: input.goal }, startedAt, undefined, options);
    return episode;
  }

  async steer(updatedGoal: string, options: OperationOptions = {}): Promise<void> {
    const episode = this.#episode;
    if (episode === undefined || episode.status !== "running") return;
    await this.#append(
      "steering",
      {
        ...(this.#previousGoal === undefined ? {} : { previousGoal: this.#previousGoal }),
        updatedGoal,
        invalidatedPlanIds: [],
      },
      Date.now(),
      undefined,
      options,
    );
    this.#previousGoal = updatedGoal;
  }

  async toolStarted(
    toolCallId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    timestamp = Date.now(),
    options: OperationOptions = {},
  ): Promise<void> {
    if (this.#episode === undefined) return;
    const event = await this.#append(
      "tool_call",
      { toolName, input },
      timestamp,
      toolCallId,
      options,
    );
    this.#tools.set(toolCallId, { toolName, input, startedAt: timestamp, callEventId: event.id });
  }

  async toolResult(
    envelope: ToolResultEnvelope,
    options: OperationOptions = {},
  ): Promise<OffloadedToolResult | undefined> {
    const episode = this.#episode;
    if (episode === undefined) return undefined;
    const started = this.#tools.get(envelope.toolCallId);
    const eventId = stableHash(
      "pi-event:v1",
      episode.id,
      String(this.#sequence + 1),
      "tool_result",
      envelope.toolCallId,
    );
    const result = await offloadToolResult(
      this.#evidence,
      episode.id,
      eventId,
      {
        ...envelope,
        ...(started?.startedAt === undefined ? {} : { startedAt: started.startedAt }),
      },
      this.#policy,
    );
    await this.#append(
      envelope.toolName === "edit" || envelope.toolName === "write" ? "file_edit" : "tool_result",
      {
        input: envelope.input,
        result: result.symbolic,
        ...(result.mode === "inline" ? { inlineText: envelope.text } : {}),
      },
      envelope.completedAt,
      envelope.toolCallId,
      options,
      started?.callEventId,
      result.artifact,
      eventId,
    );
    this.#lastExecutionFailed = envelope.isError;
    const command = typeof envelope.input["command"] === "string" ? envelope.input["command"] : "";
    if (envelope.toolName === "bash" && VERIFICATION_COMMAND.test(command)) {
      this.#verificationStatus = envelope.isError ? "failed" : "passed";
      await this.#append(
        "verification",
        { command, status: this.#verificationStatus, toolCallId: envelope.toolCallId },
        envelope.completedAt,
        envelope.toolCallId,
        options,
        eventId,
      );
    }
    return result;
  }

  async compact(
    summary: string,
    reason: "manual" | "threshold" | "overflow",
    willRetry: boolean,
    options: OperationOptions = {},
  ): Promise<void> {
    if (this.#episode === undefined) return;
    await this.#append(
      "compaction",
      { summary, reason, willRetry, longTermCandidate: false },
      Date.now(),
      undefined,
      options,
    );
  }

  async finish(
    requestedStatus?: PiEpisode["status"],
    options: OperationOptions = {},
  ): Promise<OutcomeStatus | undefined> {
    const episode = this.#episode;
    if (episode === undefined || episode.status !== "running") return undefined;
    const outcome: OutcomeStatus = {
      executionStatus: this.#lastExecutionFailed ? "failed" : "success",
      verificationStatus: this.#verificationStatus,
      taskStatus:
        requestedStatus === "aborted"
          ? "aborted"
          : this.#verificationStatus === "passed"
            ? "completed"
            : this.#lastExecutionFailed
              ? "failed"
              : "partial",
    };
    await this.#append("outcome", { ...outcome }, Date.now(), undefined, options);
    const status =
      requestedStatus ??
      (outcome.taskStatus === "completed"
        ? "completed"
        : outcome.taskStatus === "failed"
          ? "failed"
          : outcome.taskStatus === "aborted"
            ? "aborted"
            : "partial");
    const updated: PiEpisode = {
      ...episode,
      status,
      endedAt: Date.now(),
      lastSequence: this.#sequence,
    };
    this.#episode = updated;
    await this.#evidence.updateEpisode(updated, options);
    this.#onFinished?.(updated, [...this.#events], outcome);
    return outcome;
  }

  async #append(
    kind: Parameters<PiEvidenceStore["appendEvent"]>[0]["kind"],
    payload: Readonly<Record<string, unknown>>,
    timestamp: number,
    toolCallId: string | undefined,
    options: OperationOptions,
    parentEventId?: string,
    artifact?: { readonly id: string; readonly createdAt: number },
    forcedId?: string,
  ): Promise<Parameters<PiEvidenceStore["appendEvent"]>[0]> {
    const episode = this.#episode;
    if (episode === undefined) throw new Error("No active Pi episode");
    const sequence = ++this.#sequence;
    const event = {
      id:
        forcedId ?? stableHash("pi-event:v1", episode.id, String(sequence), kind, toolCallId ?? ""),
      episodeId: episode.id,
      sequence,
      kind,
      timestamp,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(parentEventId === undefined ? {} : { parentEventId }),
      ...(artifact === undefined
        ? {}
        : {
            artifactRef: {
              kind: "artifact" as const,
              id: artifact.id,
              observedAt: artifact.createdAt,
            },
          }),
      payload,
    };
    await this.#evidence.appendEvent(event, options);
    this.#events.push(event);
    this.#episode = { ...episode, lastSequence: sequence };
    return event;
  }
}
