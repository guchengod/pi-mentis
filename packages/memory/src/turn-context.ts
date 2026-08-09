import { systemClock, type Clock } from "@pi-mentis/pi-mentis-core";

export interface ActiveTopicState {
  topicId: string | undefined;
  confidence: number;
  lastUpdatedTurn: number;
  updatedAt: number;
}

export interface ActiveTaskState {
  taskId: string | undefined;
  status: "none" | "active" | "completed" | "abandoned";
  confidence: number;
  lastUpdatedTurn: number;
  updatedAt: number;
}

export interface TurnRetrievalContext {
  readonly turnId: string;
  readonly normalizedQuery: string;
  readonly queryVector: Float32Array | undefined;
  readonly projectIdentityCacheHit: boolean;
  readonly topicReused: boolean;
  readonly taskReused: boolean;
  readonly createdAt: number;
}

export class TurnContextManager {
  readonly #clock: Clock;
  #activeTopic: ActiveTopicState;
  #activeTask: ActiveTaskState;
  #turnCount = 0;
  #queryVector: Float32Array | undefined;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
    this.#activeTopic = {
      topicId: undefined,
      confidence: 0,
      lastUpdatedTurn: -1,
      updatedAt: 0,
    };
    this.#activeTask = {
      taskId: undefined,
      status: "none",
      confidence: 0,
      lastUpdatedTurn: -1,
      updatedAt: 0,
    };
  }

  get activeTopic(): ActiveTopicState {
    return this.#activeTopic;
  }

  get activeTask(): ActiveTaskState {
    return this.#activeTask;
  }

  get queryVector(): Float32Array | undefined {
    return this.#queryVector;
  }

  get turnCount(): number {
    return this.#turnCount;
  }

  setQueryVector(vector: Float32Array): void {
    this.#queryVector = vector;
  }

  updateTopic(topicId: string | undefined, confidence: number): void {
    const now = this.#clock.now();
    this.#activeTopic = { topicId, confidence, lastUpdatedTurn: this.#turnCount, updatedAt: now };
  }

  updateTask(
    taskId: string | undefined,
    status: ActiveTaskState["status"],
    confidence: number,
  ): void {
    const now = this.#clock.now();
    this.#activeTask = {
      taskId,
      status,
      confidence,
      lastUpdatedTurn: this.#turnCount,
      updatedAt: now,
    };
  }

  shouldRefreshTopic(maxStaleTurns: number = 3): boolean {
    if (this.#activeTopic.lastUpdatedTurn < 0) return true;
    return this.#turnCount - this.#activeTopic.lastUpdatedTurn >= maxStaleTurns;
  }

  shouldRefreshTask(maxStaleTurns: number = 5): boolean {
    if (this.#activeTask.lastUpdatedTurn < 0) return true;
    return this.#turnCount - this.#activeTask.lastUpdatedTurn >= maxStaleTurns;
  }

  nextTurn(query: string): TurnRetrievalContext {
    this.#turnCount += 1;
    return {
      turnId: `turn:${this.#turnCount}`,
      normalizedQuery: query,
      queryVector: this.#queryVector,
      projectIdentityCacheHit: false,
      topicReused: false,
      taskReused: false,
      createdAt: this.#clock.now(),
    };
  }
}
