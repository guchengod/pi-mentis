import { describe, expect, it } from "vitest";

import {
  PiCaptureSession,
  classifyToolResult,
  deriveExperienceObservation,
  offloadToolResult,
  type ArtifactRecord,
  type PiEpisode,
  type PiEvent,
  type PiEvidenceStore,
} from "../src/index.js";

const policy = {
  inlineMaxBytes: 8,
  truncateMaxBytes: 32,
  previewBytes: 8,
};

class FakeEvidenceStore implements PiEvidenceStore {
  readonly episodes = new Map<string, PiEpisode>();
  readonly events: PiEvent[] = [];
  readonly artifacts = new Map<string, ArtifactRecord & { content: string }>();

  async createEpisode(episode: PiEpisode): Promise<void> {
    this.episodes.set(episode.id, episode);
  }

  async updateEpisode(episode: PiEpisode): Promise<void> {
    this.episodes.set(episode.id, episode);
  }

  async appendEvent(event: PiEvent): Promise<void> {
    this.events.push(event);
  }

  async writeArtifact(
    input: Omit<
      ArtifactRecord,
      "id" | "contentHash" | "relativePath" | "byteLength" | "createdAt"
    > & {
      readonly content: string;
    },
  ): Promise<ArtifactRecord> {
    const record = {
      id: `artifact-${this.artifacts.size + 1}`,
      episodeId: input.episodeId,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      mediaType: input.mediaType,
      byteLength: Buffer.byteLength(input.content),
      contentHash: "hash",
      relativePath: "artifact.txt",
      createdAt: 10,
    };
    this.artifacts.set(record.id, { ...record, content: input.content });
    return record;
  }

  async getEpisode(id: string): Promise<PiEpisode | undefined> {
    return this.episodes.get(id);
  }

  async getEvent(id: string): Promise<PiEvent | undefined> {
    return this.events.find((event) => event.id === id);
  }

  async getArtifact(id: string): Promise<ArtifactRecord | undefined> {
    return this.artifacts.get(id);
  }

  async readEvidence(): Promise<readonly unknown[]> {
    return [];
  }
}

describe("Pi-aware tool result offloading", () => {
  it("uses byte-only fast-path thresholds without inference", () => {
    expect(classifyToolResult(8, policy)).toBe("inline");
    expect(classifyToolResult(9, policy)).toBe("truncated");
    expect(classifyToolResult(33, policy)).toBe("artifact");
  });

  it("keeps the original artifact and returns a structured bash failure", async () => {
    const evidence = new FakeEvidenceStore();
    const output = "src/index.ts:42 error Type mismatch\n".repeat(4);
    const result = await offloadToolResult(
      evidence,
      "episode-1",
      "event-1",
      {
        toolCallId: "tool-1",
        toolName: "bash",
        input: { command: "pnpm build" },
        text: output,
        details: { exitCode: 1 },
        isError: true,
        cwd: "/workspace/pi-mentis",
        startedAt: 100,
        completedAt: 140,
      },
      policy,
    );
    expect(result.mode).toBe("artifact");
    expect(result.symbolic).toMatchObject({
      tool: "bash",
      status: "failed",
      command: "pnpm build",
      cwd: "/workspace/pi-mentis",
      exitCode: 1,
      errorCount: 4,
      artifactId: "artifact-1",
      truncated: true,
    });
    expect(evidence.artifacts.get("artifact-1")?.content).toBe(output);
    expect(result.modelText).not.toContain(output);
  });
});

describe("Pi episode capture", () => {
  it("records steering, tool evidence, verification, and conservative outcome state", async () => {
    const evidence = new FakeEvidenceStore();
    const capture = new PiCaptureSession(evidence, policy);
    const episode = await capture.start({
      goal: "implement SQLite",
      startedAt: 1,
      scope: {
        tenantId: "tenant",
        userId: "user",
        appId: "pi",
        agentId: "agent",
        sessionId: "session",
        branchId: "branch",
        runId: "run",
        projectId: "project",
        contextSnapshotId: "context-1",
        taskId: "task-1",
        topicIds: ["topic:memory"],
        interactionMode: "coding",
      },
    });
    await capture.steer("do not use SQLite");
    await capture.toolStarted("tool-1", "bash", { command: "pnpm test" }, 10);
    await capture.toolResult({
      toolCallId: "tool-1",
      toolName: "bash",
      input: { command: "pnpm test" },
      text: "passed",
      details: { exitCode: 0 },
      isError: false,
      cwd: "/workspace",
      completedAt: 20,
    });
    const outcome = await capture.finish();

    expect(outcome).toEqual({
      executionStatus: "success",
      verificationStatus: "passed",
      taskStatus: "completed",
    });
    expect(evidence.events.map((event) => event.kind)).toEqual([
      "goal",
      "steering",
      "tool_call",
      "tool_result",
      "verification",
      "outcome",
    ]);
    expect(evidence.episodes.get(episode.id)).toMatchObject({
      status: "completed",
      firstSequence: 1,
      lastSequence: 6,
      contextSnapshotId: "context-1",
      taskId: "task-1",
      topicIds: ["topic:memory"],
      interactionMode: "coding",
    });
  });

  it("derives learning only from a post-steering failure, recovery, and verification chain", async () => {
    const evidence = new FakeEvidenceStore();
    let derived: ReturnType<typeof deriveExperienceObservation>;
    const capture = new PiCaptureSession(evidence, policy, (episode, events, outcome) => {
      derived = deriveExperienceObservation(episode, events, outcome, {
        embeddingModel: "embedding",
        embeddingDimensions: "1024",
        rerankModel: "rerank",
      });
    });
    await capture.start({
      goal: "repair build",
      startedAt: 1,
      scope: {
        tenantId: "tenant",
        userId: "user",
        appId: "pi",
        agentId: "agent",
        sessionId: "session",
        runId: "run",
        repositoryId: "repo",
      },
    });
    await capture.toolStarted("discarded", "bash", { command: "npm build" }, 2);
    await capture.toolResult({
      toolCallId: "discarded",
      toolName: "bash",
      input: { command: "npm build" },
      text: "error old plan",
      isError: true,
      cwd: "/workspace",
      completedAt: 3,
    });
    await capture.steer("use pnpm instead");
    await capture.toolStarted("failed", "bash", { command: "pnpm build" }, 4);
    await capture.toolResult({
      toolCallId: "failed",
      toolName: "bash",
      input: { command: "pnpm build" },
      text: "error type mismatch",
      isError: true,
      cwd: "/workspace",
      completedAt: 5,
    });
    await capture.toolStarted("recovery", "edit", { path: "src/index.ts" }, 6);
    await capture.toolResult({
      toolCallId: "recovery",
      toolName: "edit",
      input: { path: "src/index.ts" },
      text: "updated",
      isError: false,
      cwd: "/workspace",
      completedAt: 7,
    });
    await capture.toolStarted("verify", "bash", { command: "pnpm test" }, 8);
    await capture.toolResult({
      toolCallId: "verify",
      toolName: "bash",
      input: { command: "pnpm test" },
      text: "passed",
      isError: false,
      cwd: "/workspace",
      completedAt: 9,
    });
    await capture.finish();

    expect(derived?.outcome.succeeded).toBe(true);
    expect(derived?.candidate.steps).toEqual([
      'bash: {"command":"pnpm build"}',
      'edit: {"path":"src/index.ts"}',
      'bash: {"command":"pnpm test"}',
    ]);
    expect(derived?.candidate.excludesWhen).toEqual([
      "plans invalidated before the last steering event",
    ]);
  });
});
