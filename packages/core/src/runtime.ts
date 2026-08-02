import { ProviderConflictError, RuntimeProtocolMismatchError } from "./errors.js";
import type { Awaitable } from "./types.js";

export const RUNTIME_SYMBOL = Symbol.for("@pi-mentis/pi-mentis/runtime/v1");

export const ProviderPriority = {
  standalone: 100,
  integrated: 200,
  explicitOverride: 300,
} as const;

export type ProviderPriority = (typeof ProviderPriority)[keyof typeof ProviderPriority];

export type ProviderState =
  "declared" | "initializing" | "active" | "shadowed" | "failed" | "disposing" | "disposed";

export type CapabilityKind = "knowledge" | "memory" | "retrieval" | "embedding" | "reranker";

export interface CapabilityProvider<T> {
  readonly id: string;
  readonly version: string;
  readonly priority: ProviderPriority;
  initialize(signal?: AbortSignal): Promise<T>;
  dispose?(value: T): Awaitable<void>;
}

export interface ProviderSnapshot {
  readonly kind: CapabilityKind;
  readonly id: string;
  readonly version: string;
  readonly priority: ProviderPriority;
  readonly state: ProviderState;
  readonly error?: string;
}

export interface RuntimeSnapshot {
  readonly protocolVersion: 1;
  readonly ready: boolean;
  readonly providers: readonly ProviderSnapshot[];
}

export interface RegistrationHandle {
  readonly providerId: string;
  readonly kind: CapabilityKind;
  dispose(): Promise<void>;
}

export type RuntimeListener = (snapshot: RuntimeSnapshot) => void;

type Services = {
  knowledge: unknown;
  memory: unknown;
  retrieval: unknown;
  embedding: unknown;
  reranker: unknown;
};

const PROVIDER_DISPOSE_TIMEOUT_MS = 5_000;

async function disposeWithinTimeout<T>(provider: CapabilityProvider<T>, value: T): Promise<void> {
  if (provider.dispose === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      provider.dispose(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Provider ${provider.id} disposal exceeded ${PROVIDER_DISPOSE_TIMEOUT_MS}ms`,
              ),
            ),
          PROVIDER_DISPOSE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ProviderEntry<T> {
  readonly sequence: number;
  readonly kind: CapabilityKind;
  readonly provider: CapabilityProvider<T>;
  state: ProviderState;
  value?: T;
  error?: string;
}

export interface PersistentIntelligenceRuntime {
  readonly protocolVersion: 1;
  registerKnowledge<T>(provider: CapabilityProvider<T>): RegistrationHandle;
  registerMemory<T>(provider: CapabilityProvider<T>): RegistrationHandle;
  registerRetrieval<T>(provider: CapabilityProvider<T>): RegistrationHandle;
  registerEmbedding<T>(provider: CapabilityProvider<T>): RegistrationHandle;
  registerReranker<T>(provider: CapabilityProvider<T>): RegistrationHandle;
  getKnowledge<T>(): T | undefined;
  getMemory<T>(): T | undefined;
  getRetrieval<T>(): T | undefined;
  getEmbedding<T>(): T | undefined;
  getReranker<T>(): T | undefined;
  snapshot(): RuntimeSnapshot;
  subscribe(listener: RuntimeListener): () => void;
  ready(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

class Runtime implements PersistentIntelligenceRuntime {
  readonly protocolVersion = 1 as const;
  readonly #entries = new Map<CapabilityKind, ProviderEntry<unknown>[]>();
  readonly #listeners = new Set<RuntimeListener>();
  readonly #services: Partial<Services> = {};
  #sequence = 0;
  #ready = false;
  #readyPromise: Promise<void> | undefined;

  registerKnowledge<T>(provider: CapabilityProvider<T>): RegistrationHandle {
    return this.#register("knowledge", provider);
  }

  registerMemory<T>(provider: CapabilityProvider<T>): RegistrationHandle {
    return this.#register("memory", provider);
  }

  registerRetrieval<T>(provider: CapabilityProvider<T>): RegistrationHandle {
    return this.#register("retrieval", provider);
  }

  registerEmbedding<T>(provider: CapabilityProvider<T>): RegistrationHandle {
    return this.#register("embedding", provider);
  }

  registerReranker<T>(provider: CapabilityProvider<T>): RegistrationHandle {
    return this.#register("reranker", provider);
  }

  getKnowledge<T>(): T | undefined {
    return this.#services.knowledge as T | undefined;
  }

  getMemory<T>(): T | undefined {
    return this.#services.memory as T | undefined;
  }

  getRetrieval<T>(): T | undefined {
    return this.#services.retrieval as T | undefined;
  }

  getEmbedding<T>(): T | undefined {
    return this.#services.embedding as T | undefined;
  }

  getReranker<T>(): T | undefined {
    return this.#services.reranker as T | undefined;
  }

  snapshot(): RuntimeSnapshot {
    return {
      protocolVersion: 1,
      ready: this.#ready,
      providers: [...this.#entries.values()].flat().map((entry) => ({
        kind: entry.kind,
        id: entry.provider.id,
        version: entry.provider.version,
        priority: entry.provider.priority,
        state: entry.state,
        ...(entry.error === undefined ? {} : { error: entry.error }),
      })),
    };
  }

  subscribe(listener: RuntimeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async ready(signal?: AbortSignal): Promise<void> {
    this.#readyPromise ??= this.#activate(signal);
    await this.#readyPromise;
  }

  async dispose(): Promise<void> {
    for (const kind of ["retrieval", "memory", "knowledge", "reranker", "embedding"] as const) {
      const entries = this.#entries.get(kind) ?? [];
      for (const entry of entries) {
        if (entry.state !== "active" || entry.value === undefined) continue;
        entry.state = "disposing";
        this.#emit();
        try {
          await disposeWithinTimeout(entry.provider, entry.value);
          entry.state = "disposed";
          delete entry.error;
        } catch (error: unknown) {
          entry.state = "failed";
          entry.error = error instanceof Error ? error.message : String(error);
        }
        entry.value = undefined;
      }
    }
    for (const kind of Object.keys(this.#services) as CapabilityKind[]) {
      delete this.#services[kind];
    }
    for (const entries of this.#entries.values()) {
      for (const entry of entries) {
        if (entry.state === "declared" || entry.state === "shadowed") entry.state = "disposed";
      }
    }
    this.#ready = false;
    this.#readyPromise = undefined;
    this.#emit();
  }

  #register<T>(kind: CapabilityKind, provider: CapabilityProvider<T>): RegistrationHandle {
    if (this.#readyPromise !== undefined) {
      throw new ProviderConflictError(
        `Cannot declare ${kind} provider ${provider.id} after runtime activation began`,
        { operation: "provider-register", provider: provider.id, retryable: false },
      );
    }
    const entries = this.#entries.get(kind) ?? [];
    const duplicate = entries.find(
      (entry) => entry.provider.id === provider.id && entry.provider.version === provider.version,
    );
    if (duplicate !== undefined) {
      return this.#handle(duplicate);
    }
    entries.push({
      sequence: this.#sequence++,
      kind,
      provider: provider as CapabilityProvider<unknown>,
      state: "declared",
    });
    this.#entries.set(kind, entries);
    this.#emit();
    return this.#handle(entries.at(-1) as ProviderEntry<unknown>);
  }

  #handle(entry: ProviderEntry<unknown>): RegistrationHandle {
    return {
      providerId: entry.provider.id,
      kind: entry.kind,
      dispose: async () => {
        let failure: unknown;
        if (entry.state === "active" && entry.value !== undefined) {
          entry.state = "disposing";
          this.#emit();
          try {
            await disposeWithinTimeout(entry.provider, entry.value);
          } catch (error: unknown) {
            failure = error;
          } finally {
            delete this.#services[entry.kind];
          }
        }
        entry.state = "disposed";
        entry.value = undefined;
        this.#emit();
        if (failure !== undefined) throw failure;
      },
    };
  }

  async #activate(signal: AbortSignal | undefined): Promise<void> {
    for (const kind of ["embedding", "reranker", "knowledge", "memory", "retrieval"] as const) {
      const entries = this.#entries.get(kind) ?? [];
      const candidates = [...entries].sort(
        (left, right) =>
          right.provider.priority - left.provider.priority || left.sequence - right.sequence,
      );
      const grouped = new Map<number, ProviderEntry<unknown>[]>();
      for (const candidate of candidates) {
        const group = grouped.get(candidate.provider.priority) ?? [];
        group.push(candidate);
        grouped.set(candidate.provider.priority, group);
      }
      const highest = candidates.at(0)?.provider.priority;
      if (highest !== undefined) {
        const competing = grouped.get(highest) ?? [];
        const identities = new Set(
          competing.map((entry) => `${entry.provider.id}@${entry.provider.version}`),
        );
        if (identities.size > 1) {
          throw new ProviderConflictError(
            `Conflicting ${kind} providers have the same priority: ${[...identities].join(", ")}`,
            { operation: "provider-arbitration", retryable: false },
          );
        }
      }
      for (const candidate of candidates) {
        if (candidate.state === "disposed") continue;
        candidate.state = "initializing";
        this.#emit();
        try {
          const value = await candidate.provider.initialize(signal);
          candidate.value = value;
          candidate.state = "active";
          this.#services[kind] = value;
          for (const shadowed of candidates) {
            if (shadowed !== candidate && shadowed.state === "declared") {
              shadowed.state = "shadowed";
            }
          }
          this.#emit();
          break;
        } catch (error: unknown) {
          candidate.state = "failed";
          candidate.error = error instanceof Error ? error.message : String(error);
          this.#emit();
        }
      }
    }
    this.#ready = true;
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

type RuntimeGlobal = typeof globalThis & {
  [RUNTIME_SYMBOL]?: PersistentIntelligenceRuntime;
};

export function getOrCreateRuntime(): PersistentIntelligenceRuntime {
  const target = globalThis as RuntimeGlobal;
  const existing = target[RUNTIME_SYMBOL];
  if (existing !== undefined) {
    if (existing.protocolVersion !== 1) {
      throw new RuntimeProtocolMismatchError(
        `Runtime protocol ${existing.protocolVersion} is incompatible with protocol 1`,
        { operation: "runtime-acquire", retryable: false },
      );
    }
    return existing;
  }
  const runtime = new Runtime();
  target[RUNTIME_SYMBOL] = runtime;
  return runtime;
}

export async function resetRuntimeForTests(): Promise<void> {
  const target = globalThis as RuntimeGlobal;
  await target[RUNTIME_SYMBOL]?.dispose();
  delete target[RUNTIME_SYMBOL];
}

export async function resetGlobalRuntime(): Promise<void> {
  await resetRuntimeForTests();
}
