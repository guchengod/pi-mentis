import { stableHash } from "@pi-mentis/pi-mentis-core";

import type { ScalarCollectionName } from "./schema.js";
import { decodeStoredPayload, type StoredRecord, type ZvecStore } from "./store.js";

export interface StateRecord<T extends object> {
  readonly id: string;
  readonly kind: string;
  readonly namespace: string;
  readonly status: string;
  readonly revision: number;
  readonly value: T;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PutStateOptions {
  readonly status?: string;
  readonly expectedRevision?: number;
  readonly now?: number;
}

export interface MutateStateOptions {
  readonly maxRetries?: number;
  readonly now?: number;
}

export interface StateMutation<T extends object> {
  readonly value: T;
  readonly status?: string;
  readonly now?: number;
}

export class StateRevisionConflictError extends Error {
  constructor(
    readonly id: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`State ${id} revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "StateRevisionConflictError";
  }
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function decode<T extends object>(payload: Readonly<Record<string, unknown>>): StateRecord<T> {
  const value = payload["value"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("State record value is not an object");
  }
  return payload as unknown as StateRecord<T>;
}

/**
 * Revisioned state built on a real scalar Zvec collection. The storage writer lock guarantees one
 * process owns mutations; the keyed promise chain supplies deterministic CAS inside that process.
 */
export class ZvecStateStore {
  readonly #store: ZvecStore;
  readonly #collection: ScalarCollectionName;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(store: ZvecStore, collection: ScalarCollectionName = "mentis_state_v1") {
    this.#store = store;
    this.#collection = collection;
  }

  async get<T extends object>(id: string): Promise<StateRecord<T> | undefined> {
    const payload = (await this.#store.fetchScalar(this.#collection, [id])).get(id);
    return payload === undefined ? undefined : decode<T>(payload);
  }

  async list<T extends object>(input: {
    readonly kind: string;
    readonly namespace?: string;
    readonly status?: string;
    readonly limit?: number;
  }): Promise<readonly StateRecord<T>[]> {
    const filter = [
      `kind = ${quote(input.kind)}`,
      ...(input.namespace === undefined ? [] : [`namespace = ${quote(input.namespace)}`]),
      ...(input.status === undefined ? [] : [`status = ${quote(input.status)}`]),
    ].join(" AND ");
    const documents = await this.#store.filterScalar(
      this.#collection,
      filter,
      input.limit ?? 10_000,
    );
    return documents.map((document) => decode<T>(decodeStoredPayload(document)));
  }

  async put<T extends object>(
    input: {
      readonly id: string;
      readonly kind: string;
      readonly namespace: string;
      readonly value: T;
    },
    options: PutStateOptions = {},
  ): Promise<StateRecord<T>> {
    return this.#exclusive(input.id, async () => {
      const existing = await this.get<T>(input.id);
      const actualRevision = existing?.revision ?? 0;
      if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) {
        throw new StateRevisionConflictError(input.id, options.expectedRevision, actualRevision);
      }
      const now = options.now ?? Date.now();
      const state: StateRecord<T> = {
        ...input,
        status: options.status ?? existing?.status ?? "active",
        revision: actualRevision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const record: StoredRecord = {
        id: input.id,
        kind: input.kind,
        namespace: input.namespace,
        status: state.status,
        payload: state as unknown as Readonly<Record<string, unknown>>,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      };
      await this.#store.upsertScalar(this.#collection, [record]);
      return state;
    });
  }

  /**
   * Applies a pure reducer with optimistic concurrency control. Reducers may be replayed after a
   * revision conflict, so callers must keep side effects outside the reducer and derive duplicate
   * protection from stable observation/outcome identities.
   */
  async mutate<T extends object>(
    input: {
      readonly id: string;
      readonly kind: string;
      readonly namespace: string;
      readonly reduce: (current: StateRecord<T> | undefined) => StateMutation<T>;
    },
    options: MutateStateOptions = {},
  ): Promise<StateRecord<T>> {
    const maxRetries = Math.max(0, options.maxRetries ?? 8);
    for (let attempt = 0; ; attempt++) {
      const current = await this.get<T>(input.id);
      const mutation = input.reduce(current);
      try {
        return await this.put(
          {
            id: input.id,
            kind: input.kind,
            namespace: input.namespace,
            value: mutation.value,
          },
          {
            expectedRevision: current?.revision ?? 0,
            ...(mutation.status === undefined ? {} : { status: mutation.status }),
            now: mutation.now ?? options.now ?? Date.now(),
          },
        );
      } catch (error) {
        if (!(error instanceof StateRevisionConflictError) || attempt >= maxRetries) throw error;
      }
    }
  }

  async remove(id: string, expectedRevision?: number): Promise<boolean> {
    return this.#exclusive(id, async () => {
      const existing = await this.get(id);
      if (existing === undefined) return false;
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        throw new StateRevisionConflictError(id, expectedRevision, existing.revision);
      }
      await this.#store.deleteScalar(this.#collection, [id]);
      return true;
    });
  }

  id(kind: string, namespace: string, logicalKey: string): string {
    return `state:${stableHash("mentis-state:v1", kind, namespace, logicalKey)}`;
  }

  async #exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}
