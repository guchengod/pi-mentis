import {
  operationId,
  stableHash,
  systemClock,
  type Clock,
  type OperationOptions,
} from "@pi-mentis/pi-mentis-core";
import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { offloadToolResult } from "./offload.js";
import type {
  OffloadedToolResult,
  OutcomeStatus,
  PiEpisode,
  PiEvent,
  PiEvidenceStore,
  PiScopeContext,
  TaskGraphService,
  ToolResultEnvelope,
  ToolResultOffloadPolicy,
} from "./types.js";

const VERIFICATION_COMMAND =
  /(?:^|\s)(?:test|typecheck|lint|check|build|verify|go\s+test|cargo\s+test|pytest|vitest|jest|tsc)(?:\s|$)/i;
const MAX_RECOVERED_TOOL_RESULT_BYTES = 256 * 1024 * 1024;
const PI_BASH_OUTPUT_FILE = /^pi-bash-[a-f0-9]{16}\.log$/;

function objectValue(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function sourceReportedBytes(details: unknown): number | undefined {
  const totalBytes = objectValue(objectValue(details, "truncation"), "totalBytes");
  return typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes >= 0
    ? totalBytes
    : undefined;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function recoveredIntegrity(
  capturedBytes: number,
  reportedBytes: number | undefined,
): NonNullable<ToolResultEnvelope["captureIntegrity"]> {
  return {
    complete: reportedBytes === undefined || capturedBytes >= reportedBytes,
    lossy: reportedBytes !== undefined && capturedBytes < reportedBytes,
    ...(reportedBytes === undefined ? {} : { sourceReportedBytes: reportedBytes }),
    capturedBytes,
    ...(reportedBytes !== undefined && capturedBytes < reportedBytes
      ? { truncationStage: "host" as const }
      : {}),
  };
}

/**
 * Pi's read tool tells the model to continue in chunks once its output limit
 * is reached. The original call has already authorized this exact path, so we
 * reconstruct the selected line range once instead of requiring many repeats.
 */
async function recoverFullReadResult(
  envelope: ToolResultEnvelope,
  reportedBytes: number | undefined,
): Promise<ToolResultEnvelope> {
  const capturedBytes = Buffer.byteLength(envelope.text, "utf8");
  const requestedPath = envelope.input["path"];
  if (typeof requestedPath !== "string") {
    return {
      ...envelope,
      captureIntegrity: {
        complete: false,
        lossy: true,
        ...(reportedBytes === undefined ? {} : { sourceReportedBytes: reportedBytes }),
        capturedBytes,
        truncationStage: "host",
      },
    };
  }
  try {
    const resolved = await realpath(path.resolve(envelope.cwd, requestedPath));
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size > MAX_RECOVERED_TOOL_RESULT_BYTES) {
      throw new Error("Pi read output is not a bounded regular file");
    }
    const fileText = await readFile(resolved, "utf8");
    const lines = fileText.split("\n");
    const offset = envelope.input["offset"];
    const limit = envelope.input["limit"];
    const startLine = typeof offset === "number" ? Math.max(0, offset - 1) : 0;
    if (startLine >= lines.length) throw new Error("Pi read offset is outside the file");
    const endLine =
      typeof limit === "number"
        ? Math.min(startLine + Math.max(0, limit), lines.length)
        : lines.length;
    const text = lines.slice(startLine, endLine).join("\n");
    return {
      ...envelope,
      text,
      captureIntegrity: recoveredIntegrity(Buffer.byteLength(text, "utf8"), reportedBytes),
    };
  } catch {
    return {
      ...envelope,
      captureIntegrity: {
        complete: false,
        lossy: true,
        ...(reportedBytes === undefined ? {} : { sourceReportedBytes: reportedBytes }),
        capturedBytes,
        truncationStage: "host",
      },
    };
  }
}

/**
 * Pi's bash tool keeps the complete output in a process-owned temporary file when
 * the text returned to extensions is truncated. Recover only that narrowly
 * identified file; arbitrary paths supplied by tools remain untrusted data.
 */
export async function recoverFullToolResult(
  envelope: ToolResultEnvelope,
): Promise<ToolResultEnvelope> {
  const capturedBytes = Buffer.byteLength(envelope.text, "utf8");
  const reportedBytes = sourceReportedBytes(envelope.details);
  const truncation = objectValue(envelope.details, "truncation");
  const hostTruncated = objectValue(truncation, "truncated") === true;
  const fullOutputPath = objectValue(envelope.details, "fullOutputPath");
  if (envelope.toolName === "read" && hostTruncated) {
    return recoverFullReadResult(envelope, reportedBytes);
  }
  if (
    envelope.toolName !== "bash" ||
    !hostTruncated ||
    typeof fullOutputPath !== "string" ||
    !PI_BASH_OUTPUT_FILE.test(path.basename(fullOutputPath))
  ) {
    return {
      ...envelope,
      captureIntegrity: hostTruncated
        ? {
            complete: false,
            lossy: true,
            ...(reportedBytes === undefined ? {} : { sourceReportedBytes: reportedBytes }),
            capturedBytes,
            truncationStage: "host",
          }
        : { complete: true, lossy: false, capturedBytes },
    };
  }
  try {
    const [temporaryRoot, resolved] = await Promise.all([
      realpath(tmpdir()),
      realpath(fullOutputPath),
    ]);
    if (!isInside(temporaryRoot, resolved)) throw new Error("Pi bash output is outside tmpdir");
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size > MAX_RECOVERED_TOOL_RESULT_BYTES) {
      throw new Error("Pi bash output is not a bounded regular file");
    }
    const text = await readFile(resolved, "utf8");
    const recoveredBytes = Buffer.byteLength(text, "utf8");
    return {
      ...envelope,
      text,
      captureIntegrity: {
        complete: reportedBytes === undefined || recoveredBytes >= reportedBytes,
        lossy: reportedBytes !== undefined && recoveredBytes < reportedBytes,
        ...(reportedBytes === undefined ? {} : { sourceReportedBytes: reportedBytes }),
        capturedBytes: recoveredBytes,
        ...(reportedBytes !== undefined && recoveredBytes < reportedBytes
          ? { truncationStage: "host" as const }
          : {}),
      },
    };
  } catch {
    return {
      ...envelope,
      captureIntegrity: {
        complete: false,
        lossy: true,
        ...(reportedBytes === undefined ? {} : { sourceReportedBytes: reportedBytes }),
        capturedBytes,
        truncationStage: "host",
      },
    };
  }
}

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
  readonly #taskGraph: TaskGraphService | undefined;
  readonly #clock: Clock;
  readonly #events: PiEvent[] = [];
  readonly #toolTaskNodes = new Map<string, string>();
  #episode?: PiEpisode;
  #taskNamespace?: string;
  #rootTaskNodeId?: string;
  #goalEventId: string | undefined;
  #sequence = 0;
  #previousGoal?: string;
  #lastExecutionFailed = false;
  #verificationStatus: OutcomeStatus["verificationStatus"] = "not_run";

  constructor(
    evidence: PiEvidenceStore,
    policy: ToolResultOffloadPolicy,
    onFinished?: PiEpisodeFinishedHandler,
    taskGraph?: TaskGraphService,
    clock: Clock = systemClock,
  ) {
    this.#evidence = evidence;
    this.#policy = policy;
    this.#onFinished = onFinished;
    this.#taskGraph = taskGraph;
    this.#clock = clock;
  }

  get episode(): PiEpisode | undefined {
    return this.#episode;
  }

  get goalEventId(): string | undefined {
    return this.#goalEventId;
  }

  async start(input: StartPiEpisodeInput, options: OperationOptions = {}): Promise<PiEpisode> {
    if (this.#episode?.status === "running") {
      await this.finish("partial", options);
    }
    const startedAt = input.startedAt ?? this.#clock.now();
    const sessionId = input.scope.sessionId ?? "unknown-session";
    const runId = input.scope.runId ?? operationId("operation");
    const securityNamespace = [
      input.scope.tenantId,
      input.scope.userId,
      input.scope.appId,
      input.scope.agentId,
    ]
      .map(encodeURIComponent)
      .join(":");
    const id = stableHash(
      "pi-episode:v1",
      securityNamespace,
      sessionId,
      input.scope.branchId ?? "root",
      runId,
      String(startedAt),
    );
    this.#sequence = 0;
    this.#tools.clear();
    this.#toolTaskNodes.clear();
    this.#events.length = 0;
    this.#goalEventId = undefined;
    this.#lastExecutionFailed = false;
    this.#verificationStatus = "not_run";
    this.#previousGoal = input.goal;
    const episode: PiEpisode = {
      id,
      sessionId,
      securityNamespace,
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
    this.#taskNamespace = [
      input.scope.tenantId,
      input.scope.userId,
      input.scope.appId,
      input.scope.agentId,
    ]
      .map(encodeURIComponent)
      .join(":");
    this.#rootTaskNodeId = episode.id;
    if (this.#taskGraph !== undefined) {
      await this.#taskGraph.create({
        id: episode.id,
        namespace: this.#taskNamespace,
        goal: input.goal,
        ...(input.scope.branchId === undefined ? {} : { branchId: input.scope.branchId }),
      });
      const root = await this.#taskGraph.get(episode.id);
      if (root?.state === "pending" || root?.state === "failed" || root?.state === "blocked") {
        await this.#taskGraph.transition(episode.id, "running");
      }
    }
    await this.#evidence.createEpisode(episode, options);
    const goalEvent = await this.#append(
      "goal",
      { goal: input.goal },
      startedAt,
      undefined,
      options,
    );
    this.#goalEventId = goalEvent.id;
    return episode;
  }

  async steer(updatedGoal: string, options: OperationOptions = {}): Promise<void> {
    const episode = this.#episode;
    if (episode === undefined || episode.status !== "running") return;
    const invalidatedPlanIds = [...this.#toolTaskNodes.values()];
    if (this.#taskGraph !== undefined) {
      for (const taskNodeId of invalidatedPlanIds) {
        const node = await this.#taskGraph.get(taskNodeId);
        if (node?.state === "pending" || node?.state === "running" || node?.state === "blocked") {
          await this.#taskGraph.transition(taskNodeId, "aborted");
        }
      }
    }
    this.#toolTaskNodes.clear();
    await this.#append(
      "steering",
      {
        ...(this.#previousGoal === undefined ? {} : { previousGoal: this.#previousGoal }),
        updatedGoal,
        invalidatedPlanIds,
      },
      this.#clock.now(),
      undefined,
      options,
    );
    this.#previousGoal = updatedGoal;
  }

  async toolStarted(
    toolCallId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    timestamp?: number,
    options: OperationOptions = {},
  ): Promise<void> {
    if (this.#episode === undefined) return;
    const observedAt = timestamp ?? this.#clock.now();
    const event = await this.#append(
      "tool_call",
      { toolName, input },
      observedAt,
      toolCallId,
      options,
    );
    this.#tools.set(toolCallId, {
      toolName,
      input,
      startedAt: observedAt,
      callEventId: event.id,
    });
    if (
      this.#taskGraph !== undefined &&
      this.#taskNamespace !== undefined &&
      this.#rootTaskNodeId !== undefined
    ) {
      const taskNodeId = `task-node:${stableHash(
        "pi-tool-task:v1",
        this.#rootTaskNodeId,
        toolCallId,
      )}`;
      await this.#taskGraph.create({
        id: taskNodeId,
        namespace: this.#taskNamespace,
        goal: `${toolName}: ${this.#summarizeInput(input)}`,
        parentId: this.#rootTaskNodeId,
        ...(this.#episode.branchId === undefined ? {} : { branchId: this.#episode.branchId }),
      });
      const task = await this.#taskGraph.get(taskNodeId);
      if (task?.state === "pending" || task?.state === "failed" || task?.state === "blocked") {
        await this.#taskGraph.transition(taskNodeId, "running", [
          { kind: "event", id: event.id, observedAt: event.timestamp },
        ]);
      }
      this.#toolTaskNodes.set(toolCallId, taskNodeId);
    }
  }

  async toolResult(
    envelope: ToolResultEnvelope,
    options: OperationOptions = {},
  ): Promise<OffloadedToolResult | undefined> {
    const episode = this.#episode;
    if (episode === undefined) return undefined;
    const recoveredEnvelope = await recoverFullToolResult(envelope);
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
        ...recoveredEnvelope,
        ...(started?.startedAt === undefined ? {} : { startedAt: started.startedAt }),
      },
      this.#policy,
    );
    const resultEvent = await this.#append(
      envelope.toolName === "edit" || envelope.toolName === "write" ? "file_edit" : "tool_result",
      {
        input: envelope.input,
        result: result.symbolic,
        tokenAccounting: result.tokenAccounting,
        ...(result.mode === "inline" ? { inlineText: recoveredEnvelope.text } : {}),
      },
      envelope.completedAt,
      envelope.toolCallId,
      options,
      started?.callEventId,
      result.artifact,
      eventId,
    );
    const taskNodeId = this.#toolTaskNodes.get(envelope.toolCallId);
    if (taskNodeId !== undefined && this.#taskGraph !== undefined) {
      const task = await this.#taskGraph.get(taskNodeId);
      if (task?.state === "running") {
        await this.#taskGraph.transition(taskNodeId, envelope.isError ? "failed" : "succeeded", [
          { kind: "event", id: resultEvent.id, observedAt: resultEvent.timestamp },
        ]);
      }
      this.#toolTaskNodes.delete(envelope.toolCallId);
    }
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
      this.#clock.now(),
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
    const outcomeEvent = await this.#append(
      "outcome",
      { ...outcome },
      this.#clock.now(),
      undefined,
      options,
    );
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
      endedAt: this.#clock.now(),
      lastSequence: this.#sequence,
    };
    this.#episode = updated;
    await this.#evidence.updateEpisode(updated, options);
    if (this.#taskGraph !== undefined && this.#rootTaskNodeId !== undefined) {
      const root = await this.#taskGraph.get(this.#rootTaskNodeId);
      if (root?.state === "running") {
        await this.#taskGraph.transition(
          this.#rootTaskNodeId,
          outcome.taskStatus === "completed"
            ? "succeeded"
            : outcome.taskStatus === "aborted"
              ? "aborted"
              : outcome.taskStatus === "partial"
                ? "blocked"
                : "failed",
          [{ kind: "event", id: outcomeEvent.id, observedAt: outcomeEvent.timestamp }],
        );
      }
    }
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
      securityNamespace: episode.securityNamespace,
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

  #summarizeInput(input: Readonly<Record<string, unknown>>): string {
    const preferred = input["command"] ?? input["path"] ?? input["query"] ?? input["url"];
    const summary = typeof preferred === "string" ? preferred : JSON.stringify(input);
    return summary.length <= 160 ? summary : `${summary.slice(0, 157)}...`;
  }
}
