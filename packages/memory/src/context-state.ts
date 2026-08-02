import {
  contextFingerprint,
  normalizeText,
  stableHash,
  systemClock,
  type Clock,
  type ContextResolution,
  type FastMentisContext,
  type MentisContextSnapshot,
  type TopicIdentity,
  type TopicResolution,
} from "@pi-mentis/pi-mentis-core";
import { ZvecStateStore, type ZvecStore } from "@pi-mentis/pi-mentis-zvec";

export interface PersistedTopicIdentity extends TopicIdentity {
  readonly namespace: string;
  readonly state: "candidate" | "active" | "merged" | "rejected";
  readonly aliases: readonly string[];
  readonly terms: readonly string[];
  readonly sampleCount: number;
  readonly scoreMean: number;
  readonly scoreM2: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function topicTerms(text: string): readonly string[] {
  const normalized = normalizeText(text).toLocaleLowerCase();
  const stop = new Set([
    "about",
    "with",
    "from",
    "this",
    "that",
    "what",
    "how",
    "please",
    "帮我",
    "一下",
    "这个",
    "那个",
    "可以",
    "需要",
  ]);
  const words = normalized
    .split(/[^\p{L}\p{N}_+-]+/u)
    .filter((term) => term.length >= 2 && !stop.has(term));
  const han = [...normalized.matchAll(/[\p{Script=Han}]{3,}/gu)].flatMap((match) =>
    Array.from({ length: Math.min(8, match[0].length - 1) }, (_, index) =>
      match[0].slice(index, index + 2),
    ),
  );
  return [...new Set([...words, ...han])].slice(0, 24);
}

function topicSimilarity(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter((term) => b.has(term)).length;
  const denominator = Math.min(a.size, b.size);
  return denominator === 0 ? 0 : intersection / denominator;
}

export interface TaskIdentity {
  readonly taskId: string;
  readonly namespace: string;
  readonly goal: string;
  readonly normalizedGoal: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
  readonly topicIds: readonly string[];
  readonly state: "active" | "completed" | "failed" | "aborted";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CapabilityState<T extends Readonly<Record<string, unknown>>> {
  readonly snapshotId: string;
  readonly fingerprint: string;
  readonly value: T;
  readonly state: "active" | "stale" | "refreshing" | "failed";
  readonly lastSeenAt: number;
  readonly lastAttemptAt: number;
  readonly failure?: string;
}

export function taskIdentityId(input: {
  readonly namespace: string;
  readonly goal: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
  readonly topicIds?: readonly string[];
}): string {
  const normalizedGoal = normalizeText(input.goal).toLocaleLowerCase();
  const affinity = input.repositoryId ?? input.projectId ?? input.topicIds?.join(",") ?? "general";
  return `task:${stableHash("mentis-task:v1", input.namespace, affinity, normalizedGoal)}`;
}

function lexicalTaskSimilarity(left: string, right: string): number {
  const tokenize = (value: string) =>
    new Set(
      normalizeText(value)
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter((term) => term.length >= 2),
    );
  const a = tokenize(left);
  const b = tokenize(right);
  const intersection = [...a].filter((term) => b.has(term)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function snapshotNamespace(snapshot: MentisContextSnapshot): string {
  const { tenantId, userId, appId, agentId } = snapshot.identity;
  return [tenantId, userId, appId, agentId].map(encodeURIComponent).join(":");
}

/** Persistent P8 state. Foreground resolution remains local; durable writes can be scheduled. */
export class ContextStateService {
  readonly #state: ZvecStateStore;
  readonly #clock: Clock;
  readonly #topicCache = new Map<string, Map<string, PersistedTopicIdentity>>();

  constructor(store: ZvecStore, clock: Clock = systemClock) {
    this.#state = new ZvecStateStore(store);
    this.#clock = clock;
  }

  async persistSnapshot(snapshot: MentisContextSnapshot): Promise<void> {
    await this.#state.put(
      {
        id: snapshot.id,
        kind: "context-snapshot",
        namespace: snapshotNamespace(snapshot),
        value: snapshot as unknown as Readonly<Record<string, unknown>>,
      },
      { now: this.#clock.now() },
    );
    await this.#state.put(
      {
        id: this.#state.id(
          "context-latest",
          snapshotNamespace(snapshot),
          snapshot.conversation.sessionId,
        ),
        kind: "context-latest",
        namespace: snapshotNamespace(snapshot),
        value: {
          snapshotId: snapshot.id,
          runtimeKey: snapshot.conversation.sessionId,
          fingerprint: snapshot.fingerprint,
          revision: snapshot.revision,
        },
      },
      { now: this.#clock.now() },
    );
  }

  async getSnapshot(id: string): Promise<MentisContextSnapshot | undefined> {
    const state = await this.#state.get<Readonly<Record<string, unknown>>>(id);
    return state?.value as unknown as MentisContextSnapshot | undefined;
  }

  async latestSnapshot(
    identity: FastMentisContext["identity"],
    sessionId: string,
  ): Promise<MentisContextSnapshot | undefined> {
    const namespace = [identity.tenantId, identity.userId, identity.appId, identity.agentId]
      .map(encodeURIComponent)
      .join(":");
    const pointer = await this.#state.get<{ readonly snapshotId: string }>(
      this.#state.id("context-latest", namespace, sessionId),
    );
    return pointer === undefined ? undefined : this.getSnapshot(pointer.value.snapshotId);
  }

  /** Restores the previous revision before resolving so restarts keep monotonic snapshot history. */
  resolveFromPersistent(
    input: FastMentisContext,
    previous: MentisContextSnapshot | undefined,
  ): ContextResolution {
    const { runtimeKey, ...facets } = input;
    const fingerprint = contextFingerprint(facets);
    if (previous?.fingerprint === fingerprint) return { snapshot: previous, reused: true };
    const revision = (previous?.revision ?? 0) + 1;
    const snapshot: MentisContextSnapshot = {
      id: stableHash("mentis-context-snapshot:v1", runtimeKey, String(revision), fingerprint),
      revision,
      ...facets,
      createdAt: this.#clock.now(),
      fingerprint,
    };
    return { snapshot, reused: false };
  }

  async persistTopic(
    namespace: string,
    resolution: TopicResolution,
    observedScore?: number,
  ): Promise<PersistedTopicIdentity | undefined> {
    if (resolution.decision === "pending" && resolution.candidate === undefined) return undefined;
    const topic =
      resolution.decision === "pending" ? resolution.candidate?.topic : resolution.topic;
    if (topic === undefined) return undefined;
    const id = this.#state.id("topic", namespace, topic.topicId);
    const existing = await this.#state.get<PersistedTopicIdentity>(id);
    const resolutionScore =
      resolution.decision === "pending" ? resolution.candidate?.score : topic.confidence;
    const score = observedScore ?? resolutionScore;
    const value = score ?? topic.confidence;
    const sampleCount = (existing?.value.sampleCount ?? 0) + 1;
    const previousMean = existing?.value.scoreMean ?? 0;
    const delta = value - previousMean;
    const mean = previousMean + delta / sampleCount;
    const m2 = (existing?.value.scoreM2 ?? 0) + delta * (value - mean);
    const now = this.#clock.now();
    const persisted: PersistedTopicIdentity = {
      ...topic,
      namespace,
      state: resolution.decision === "reuse" ? "active" : "candidate",
      aliases: [...new Set([...(existing?.value.aliases ?? []), topic.label])],
      terms: [...new Set([...(existing?.value.terms ?? []), ...topicTerms(topic.label)])],
      sampleCount,
      scoreMean: mean,
      scoreM2: m2,
      createdAt: existing?.value.createdAt ?? now,
      updatedAt: now,
    };
    await this.#state.put(
      {
        id,
        kind: "topic-identity",
        namespace,
        value: persisted as unknown as Readonly<Record<string, unknown>>,
      },
      { now },
    );
    this.#cacheTopic(namespace, persisted);
    return persisted;
  }

  async observeTopicLabel(namespace: string, label: string): Promise<PersistedTopicIdentity> {
    const normalized = normalizeText(label).toLocaleLowerCase();
    const topicId = `topic:${stableHash("mentis-topic:v1", namespace, normalized)}`;
    const id = this.#state.id("topic", namespace, topicId);
    const existing = await this.#state.get<PersistedTopicIdentity>(id);
    const now = this.#clock.now();
    const sampleCount = (existing?.value.sampleCount ?? 0) + 1;
    const topic: PersistedTopicIdentity = {
      topicId,
      label,
      confidence: Math.min(1, 0.45 + sampleCount * 0.2),
      namespace,
      state: sampleCount >= 2 ? "active" : "candidate",
      aliases: [...new Set([...(existing?.value.aliases ?? []), label])],
      terms: [...new Set([...(existing?.value.terms ?? []), ...topicTerms(label)])],
      sampleCount,
      scoreMean: existing?.value.scoreMean ?? 0,
      scoreM2: existing?.value.scoreM2 ?? 0,
      createdAt: existing?.value.createdAt ?? now,
      updatedAt: now,
    };
    await this.#state.put(
      {
        id,
        kind: "topic-identity",
        namespace,
        value: topic as unknown as Readonly<Record<string, unknown>>,
      },
      { now },
    );
    this.#cacheTopic(namespace, topic);
    return topic;
  }

  async inferTopic(namespace: string, text: string): Promise<PersistedTopicIdentity | undefined> {
    const terms = topicTerms(text);
    if (terms.length === 0) return undefined;
    const topics = await this.#topics(namespace);
    const best = topics
      .filter((topic) => topic.value.state === "active" || topic.value.state === "candidate")
      .map((topic) => ({
        topic,
        score: topicSimilarity(topic.value.terms ?? topicTerms(topic.value.label), terms),
      }))
      .sort((left, right) => right.score - left.score)[0];
    if (best !== undefined && best.score >= 0.25) {
      const latest = await this.#state.get<PersistedTopicIdentity>(best.topic.id);
      const current = latest?.value ?? best.topic.value;
      const sampleCount = current.sampleCount + 1;
      const delta = best.score - current.scoreMean;
      const scoreMean = current.scoreMean + delta / sampleCount;
      const scoreM2 = current.scoreM2 + delta * (best.score - scoreMean);
      const updated: PersistedTopicIdentity = {
        ...current,
        state:
          current.state === "active" || (sampleCount >= 2 && best.score >= 0.35)
            ? "active"
            : "candidate",
        confidence: Math.min(1, Math.max(current.confidence, best.score)),
        terms: [...new Set([...(current.terms ?? []), ...terms])].slice(0, 48),
        sampleCount,
        scoreMean,
        scoreM2,
        updatedAt: this.#clock.now(),
      };
      await this.#state.put(
        {
          id: best.topic.id,
          kind: "topic-identity",
          namespace,
          value: updated as unknown as Readonly<Record<string, unknown>>,
        },
        {
          ...(latest === undefined ? {} : { expectedRevision: latest.revision }),
          now: this.#clock.now(),
        },
      );
      this.#cacheTopic(namespace, updated);
      return updated;
    }
    const signature = [...terms].sort().slice(0, 6);
    const topicId = `topic:${stableHash("mentis-inferred-topic:v1", namespace, signature.join("|"))}`;
    const now = this.#clock.now();
    const candidate: PersistedTopicIdentity = {
      topicId,
      label: normalizeText(text).slice(0, 80),
      confidence: 0.35,
      namespace,
      state: "candidate",
      aliases: [],
      terms,
      sampleCount: 1,
      scoreMean: 0,
      scoreM2: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.#state.put(
      {
        id: this.#state.id("topic", namespace, topicId),
        kind: "topic-identity",
        namespace,
        value: candidate as unknown as Readonly<Record<string, unknown>>,
      },
      { now },
    );
    this.#cacheTopic(namespace, candidate);
    return candidate;
  }

  async #topics(namespace: string) {
    const cached = this.#topicCache.get(namespace);
    if (cached !== undefined) {
      return [...cached.values()].map((value) => ({
        id: this.#state.id("topic", namespace, value.topicId),
        revision: 0,
        value,
      }));
    }
    const stored = await this.#state.list<PersistedTopicIdentity>({
      kind: "topic-identity",
      namespace,
      limit: 200,
    });
    this.#topicCache.set(
      namespace,
      new Map(stored.map((topic) => [topic.value.topicId, topic.value])),
    );
    return stored;
  }

  #cacheTopic(namespace: string, topic: PersistedTopicIdentity): void {
    const cached = this.#topicCache.get(namespace);
    if (cached !== undefined) cached.set(topic.topicId, topic);
  }

  async resolveTask(input: {
    readonly namespace: string;
    readonly goal: string;
    readonly repositoryId?: string;
    readonly projectId?: string;
    readonly topicIds?: readonly string[];
    readonly currentTaskId?: string;
  }): Promise<TaskIdentity> {
    const normalizedGoal = normalizeText(input.goal).toLocaleLowerCase();
    const taskId = taskIdentityId(input);
    const id = this.#state.id("task", input.namespace, taskId);
    let existing = await this.#state.get<TaskIdentity>(id);
    if (existing === undefined && input.currentTaskId !== undefined) {
      const current = await this.#state.get<TaskIdentity>(
        this.#state.id("task", input.namespace, input.currentTaskId),
      );
      const continuation = /^(?:继续|接着|然后|另外|再|now\b|next\b|continue\b|also\b)/i.test(
        normalizeText(input.goal),
      );
      const sameTopic =
        (input.topicIds ?? []).length > 0 &&
        (input.topicIds ?? []).some((topicId) => current?.value.topicIds.includes(topicId));
      if (
        current !== undefined &&
        (continuation || sameTopic || lexicalTaskSimilarity(current.value.goal, input.goal) >= 0.3)
      ) {
        existing = current;
      }
    }
    if (existing === undefined) {
      const active = await this.#state.list<TaskIdentity>({
        kind: "task-identity",
        namespace: input.namespace,
        limit: 200,
      });
      existing = active
        .filter(
          (candidate) =>
            (input.repositoryId === undefined ||
              candidate.value.repositoryId === input.repositoryId) &&
            (input.projectId === undefined || candidate.value.projectId === input.projectId),
        )
        .map((candidate) => ({
          candidate,
          score: lexicalTaskSimilarity(candidate.value.goal, input.goal),
        }))
        .filter((item) => item.score >= 0.3)
        .sort((left, right) => right.score - left.score)[0]?.candidate;
    }
    const now = this.#clock.now();
    const task: TaskIdentity = {
      taskId: existing?.value.taskId ?? taskId,
      namespace: input.namespace,
      goal: input.goal,
      normalizedGoal,
      ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      topicIds: input.topicIds ?? [],
      state: "active",
      createdAt: existing?.value.createdAt ?? now,
      updatedAt: now,
    };
    const persistedId = this.#state.id("task", input.namespace, task.taskId);
    await this.#state.put(
      {
        id: persistedId,
        kind: "task-identity",
        namespace: input.namespace,
        value: task as unknown as Readonly<Record<string, unknown>>,
      },
      { now },
    );
    return task;
  }

  async updateTaskState(
    taskId: string,
    namespace: string,
    state: TaskIdentity["state"],
  ): Promise<void> {
    const id = this.#state.id("task", namespace, taskId);
    const existing = await this.#state.get<TaskIdentity>(id);
    if (existing === undefined) throw new Error(`Unknown task ${taskId}`);
    await this.#state.put(
      {
        id,
        kind: "task-identity",
        namespace,
        value: { ...existing.value, state, updatedAt: this.#clock.now() } as unknown as Readonly<
          Record<string, unknown>
        >,
      },
      { status: state, expectedRevision: existing.revision, now: this.#clock.now() },
    );
  }

  async staleWhileRevalidate<T extends Readonly<Record<string, unknown>>>(input: {
    readonly namespace: string;
    readonly key: string;
    readonly maxAgeMs: number;
    readonly refresh: () => Promise<{ readonly fingerprint: string; readonly value: T }>;
  }): Promise<{
    readonly current?: CapabilityState<T>;
    readonly refresh: Promise<CapabilityState<T>>;
  }> {
    const id = this.#state.id("capability-snapshot", input.namespace, input.key);
    const existing = await this.#state.get<CapabilityState<T>>(id);
    const now = this.#clock.now();
    const current =
      existing === undefined
        ? undefined
        : {
            ...existing.value,
            state:
              now - existing.value.lastSeenAt > input.maxAgeMs
                ? ("stale" as const)
                : existing.value.state,
          };
    const refresh = input
      .refresh()
      .then(async ({ fingerprint, value }) => {
        const next: CapabilityState<T> = {
          snapshotId: `capability:${stableHash("mentis-capability-snapshot:v1", fingerprint)}`,
          fingerprint,
          value,
          state: "active",
          lastSeenAt: this.#clock.now(),
          lastAttemptAt: now,
        };
        await this.#state.put(
          {
            id,
            kind: "capability-snapshot",
            namespace: input.namespace,
            value: next as unknown as Readonly<Record<string, unknown>>,
          },
          { now: this.#clock.now() },
        );
        return next;
      })
      .catch(async (error: unknown) => {
        if (existing === undefined) throw error;
        const failed: CapabilityState<T> = {
          ...existing.value,
          state: "failed",
          lastAttemptAt: now,
          failure: error instanceof Error ? error.message : String(error),
        };
        await this.#state.put(
          {
            id,
            kind: "capability-snapshot",
            namespace: input.namespace,
            value: failed as unknown as Readonly<Record<string, unknown>>,
          },
          { now: this.#clock.now() },
        );
        return failed;
      });
    return { ...(current === undefined ? {} : { current }), refresh };
  }
}
