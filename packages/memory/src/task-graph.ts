import { stableHash, systemClock, type Clock, type EvidenceRef } from "@pi-mentis/pi-mentis-core";
import { ZvecStateStore, type ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import type { TaskGraphService, TaskNode, TaskNodeState } from "./types.js";

const transitions: Readonly<Record<TaskNodeState, readonly TaskNodeState[]>> = {
  pending: ["running", "blocked", "aborted"],
  running: ["succeeded", "failed", "blocked", "aborted"],
  succeeded: [],
  failed: ["pending", "running", "aborted"],
  blocked: ["pending", "running", "aborted"],
  aborted: [],
};

export class DefaultTaskGraphService implements TaskGraphService {
  readonly #state: ZvecStateStore;
  readonly #clock: Clock;

  constructor(store: ZvecStore, clock: Clock = systemClock) {
    this.#state = new ZvecStateStore(store, "relationships_v1");
    this.#clock = clock;
  }

  async create(input: {
    readonly namespace: string;
    readonly goal: string;
    readonly branchId?: string;
    readonly parentId?: string;
    readonly dependencies?: readonly string[];
    readonly id?: string;
  }): Promise<TaskNode> {
    const dependencies = [...new Set(input.dependencies ?? [])];
    for (const dependency of dependencies) {
      const target = await this.get(dependency);
      if (target === undefined) {
        throw new Error(`Task dependency ${dependency} does not exist`);
      }
      if (target.namespace !== input.namespace) {
        throw new Error(`Task dependency ${dependency} crosses a security namespace`);
      }
    }
    const now = this.#clock.now();
    const id =
      input.id ??
      `task-node:${stableHash("mentis-task-node:v1", input.namespace, input.goal, String(now))}`;
    const existing = await this.get(id);
    if (existing !== undefined) {
      if (existing.namespace !== input.namespace) {
        throw new Error(`Task node ${id} already belongs to another security namespace`);
      }
      return existing;
    }
    const node: TaskNode = {
      id,
      namespace: input.namespace,
      goal: input.goal,
      state: "pending",
      dependencies,
      ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      attempts: 0,
      evidenceRefs: [],
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    await this.#state.put(
      {
        id,
        kind: "task-node",
        namespace: input.namespace,
        value: node as unknown as Readonly<Record<string, unknown>>,
      },
      { status: node.state, now },
    );
    await this.#assertAcyclic(input.namespace);
    return node;
  }

  async transition(
    id: string,
    next: TaskNodeState,
    evidenceRefs: readonly EvidenceRef[] = [],
  ): Promise<TaskNode> {
    const stored = await this.#state.get<TaskNode>(id);
    if (stored === undefined) throw new Error(`Unknown task node ${id}`);
    if (!transitions[stored.value.state].includes(next)) {
      throw new Error(`Illegal task transition ${stored.value.state} -> ${next}`);
    }
    if (next === "running") {
      const dependencies = await Promise.all(
        stored.value.dependencies.map((dependency) => this.get(dependency)),
      );
      if (dependencies.some((dependency) => dependency?.state !== "succeeded")) {
        throw new Error(`Task ${id} has unfinished dependencies`);
      }
    }
    const now = this.#clock.now();
    const node: TaskNode = {
      ...stored.value,
      state: next,
      attempts: next === "running" ? stored.value.attempts + 1 : stored.value.attempts,
      evidenceRefs: [
        ...stored.value.evidenceRefs,
        ...evidenceRefs.filter(
          (candidate) =>
            !stored.value.evidenceRefs.some(
              (existing) => existing.kind === candidate.kind && existing.id === candidate.id,
            ),
        ),
      ],
      updatedAt: now,
      revision: stored.value.revision + 1,
    };
    await this.#state.put(
      {
        id,
        kind: "task-node",
        namespace: node.namespace,
        value: node as unknown as Readonly<Record<string, unknown>>,
      },
      { status: next, expectedRevision: stored.revision, now },
    );
    return node;
  }

  async addDependency(id: string, dependencyId: string): Promise<TaskNode> {
    const [stored, dependency] = await Promise.all([
      this.#state.get<TaskNode>(id),
      this.get(dependencyId),
    ]);
    if (stored === undefined) throw new Error(`Unknown task node ${id}`);
    if (dependency === undefined) throw new Error(`Unknown task dependency ${dependencyId}`);
    if (dependency.namespace !== stored.value.namespace) {
      throw new Error(`Task dependency ${dependencyId} crosses a security namespace`);
    }
    const updated: TaskNode = {
      ...stored.value,
      dependencies: [...new Set([...stored.value.dependencies, dependencyId])],
      updatedAt: this.#clock.now(),
      revision: stored.value.revision + 1,
    };
    await this.#state.put(
      {
        id,
        kind: "task-node",
        namespace: updated.namespace,
        value: updated as unknown as Readonly<Record<string, unknown>>,
      },
      { expectedRevision: stored.revision, now: this.#clock.now() },
    );
    try {
      await this.#assertAcyclic(updated.namespace);
      return updated;
    } catch (error: unknown) {
      const restored: TaskNode = {
        ...stored.value,
        updatedAt: this.#clock.now(),
        revision: stored.revision + 2,
      };
      await this.#state.put(
        {
          id,
          kind: "task-node",
          namespace: restored.namespace,
          value: restored as unknown as Readonly<Record<string, unknown>>,
        },
        { expectedRevision: stored.revision + 1, now: this.#clock.now() },
      );
      throw error;
    }
  }

  async get(id: string): Promise<TaskNode | undefined> {
    return (await this.#state.get<TaskNode>(id))?.value;
  }

  async list(namespace: string): Promise<readonly TaskNode[]> {
    return (await this.#state.list<TaskNode>({ kind: "task-node", namespace, limit: 10_000 })).map(
      (record) => record.value,
    );
  }

  async abortBranch(branchId: string, namespace: string): Promise<number> {
    const nodes = await this.list(namespace);
    let aborted = 0;
    for (const node of nodes) {
      if (
        node.branchId === branchId &&
        (node.state === "pending" || node.state === "running" || node.state === "blocked")
      ) {
        await this.transition(node.id, "aborted");
        aborted++;
      }
    }
    return aborted;
  }

  async mermaid(namespace: string): Promise<string> {
    const nodes = await this.list(namespace);
    const lines = ["graph TD"];
    for (const node of nodes) {
      lines.push(
        `  ${this.#mermaidId(node.id)}["${node.goal.replaceAll('"', "'")} (${node.state})"]`,
      );
      for (const dependency of node.dependencies) {
        lines.push(`  ${this.#mermaidId(dependency)} --> ${this.#mermaidId(node.id)}`);
      }
    }
    return lines.join("\n");
  }

  async #assertAcyclic(namespace: string): Promise<void> {
    const nodes = await this.list(namespace);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Task graph cycle detected at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const node of nodes) visit(node.id);
  }

  #mermaidId(id: string): string {
    return `n_${stableHash("task-node-mermaid:v1", id).slice(0, 12)}`;
  }
}

export function createTaskGraphService(store: ZvecStore): TaskGraphService {
  return new DefaultTaskGraphService(store);
}
