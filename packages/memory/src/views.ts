import { systemClock, type Clock } from "@pi-mentis/pi-mentis-core";
import {
  StateRevisionConflictError,
  ZvecStateStore,
  type ZvecStore,
} from "@pi-mentis/pi-mentis-zvec";

import { adaptLegacyMemory } from "./legacy-memory-adapter.js";
import type { MemoryRecord, PiScopeContext } from "./types.js";

export type ViewKind = "project" | "user" | "topic" | "task" | "capability";
export type ViewState = "active" | "stale" | "rebuilding" | "failed";

export interface ViewFact {
  readonly recordKey: string;
  readonly value: string;
  readonly values: Readonly<Record<string, string>>;
  readonly currentMemoryIds: readonly string[];
  readonly historicalMemoryIds: readonly string[];
  readonly authority: number;
  readonly updatedAt: number;
}

export interface MaterializedView {
  readonly id: string;
  readonly kind: ViewKind;
  readonly scopeId: string;
  readonly namespace: string;
  readonly state: ViewState;
  readonly revision: number;
  readonly facts: Readonly<Record<string, ViewFact>>;
  readonly memberMemoryIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly failure?: string;
}

function identityNamespace(context: PiScopeContext | undefined): string {
  return [
    context?.tenantId ?? "local",
    context?.userId ?? "local",
    context?.appId ?? "pi",
    context?.agentId ?? "pi-mentis",
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function viewTargets(record: Omit<MemoryRecord, "embedding">): readonly {
  readonly kind: ViewKind;
  readonly scopeId: string;
}[] {
  if (record.scope.kind === "project" || record.scope.kind === "repository") {
    return [{ kind: "project", scopeId: record.scope.id }];
  }
  if (record.scope.kind === "user") return [{ kind: "user", scopeId: record.scope.id }];
  if (record.scope.kind === "topic") return [{ kind: "topic", scopeId: record.scope.id }];
  if (record.scope.kind === "task") return [{ kind: "task", scopeId: record.scope.id }];
  return [];
}

function isCurrent(record: Omit<MemoryRecord, "embedding">): boolean {
  return record.status === "active";
}

export class HierarchicalViewService {
  readonly #store: ZvecStore;
  readonly #state: ZvecStateStore;
  readonly #clock: Clock;
  readonly #ttlMs: number;

  constructor(store: ZvecStore, options: { readonly clock?: Clock; readonly ttlMs?: number } = {}) {
    this.#store = store;
    this.#state = new ZvecStateStore(store, "mentis_views_v1");
    this.#clock = options.clock ?? systemClock;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
  }

  async get(
    kind: ViewKind,
    scopeId: string,
    context?: PiScopeContext,
  ): Promise<MaterializedView | undefined> {
    const id = this.#id(kind, scopeId, identityNamespace(context));
    const stored = await this.#state.get<MaterializedView>(id);
    if (stored === undefined) return undefined;
    if (stored.value.expiresAt > this.#clock.now()) return stored.value;
    return { ...stored.value, state: "stale" };
  }

  async applyMemory(record: Omit<MemoryRecord, "embedding">): Promise<readonly MaterializedView[]> {
    const views: MaterializedView[] = [];
    for (const target of viewTargets(record)) {
      views.push(await this.#upsert(target.kind, target.scopeId, record));
    }
    return views;
  }

  async enqueueMemory(record: Omit<MemoryRecord, "embedding">): Promise<string | undefined> {
    if (
      viewTargets(record).length === 0 ||
      record.status === "pending" ||
      record.status === "rejected" ||
      record.provenance.epistemicState === "hypothesis" ||
      record.sensitivity === "secret"
    )
      return undefined;
    const views = await this.applyMemory(record);
    return views[0]?.id;
  }

  async #upsert(
    kind: ViewKind,
    scopeId: string,
    record: Omit<MemoryRecord, "embedding">,
  ): Promise<MaterializedView> {
    const namespace = identityNamespace(record.scopeContext);
    const id = this.#id(kind, scopeId, namespace);
    for (let attempt = 0; attempt < 8; attempt++) {
      const stored = await this.#state.get<MaterializedView>(id);
      const now = this.#clock.now();
      const historical = isCurrent(record) ? [] : [record.id];
      const current = isCurrent(record) ? [record.id] : [];
      const fact: ViewFact = {
        recordKey: record.id,
        value: record.content,
        values: { [record.id]: record.content },
        currentMemoryIds: current,
        historicalMemoryIds: historical,
        authority: record.authority,
        updatedAt: now,
      };
      const facts = { ...(stored?.value.facts ?? {}), [record.id]: fact };
      const view: MaterializedView = {
        id,
        kind,
        scopeId,
        namespace,
        state: "active",
        revision: (stored?.value.revision ?? 0) + 1,
        facts,
        memberMemoryIds: [
          ...new Set(
            Object.values(facts).flatMap((item) => [
              ...item.currentMemoryIds,
              ...item.historicalMemoryIds,
            ]),
          ),
        ],
        createdAt: stored?.value.createdAt ?? now,
        updatedAt: now,
        expiresAt: now + this.#ttlMs,
      };
      try {
        await this.#state.put(
          {
            id,
            kind: `view:${kind}`,
            namespace,
            value: view as unknown as Readonly<Record<string, unknown>>,
          },
          { expectedRevision: stored?.revision ?? 0, now },
        );
        return view;
      } catch (error: unknown) {
        if (!(error instanceof StateRevisionConflictError) || attempt === 7) throw error;
      }
    }
    throw new Error(`Unable to update view ${id}`);
  }

  async repair(): Promise<{
    readonly inspected: number;
    readonly repaired: number;
    readonly failed: number;
  }> {
    const states = (
      await Promise.all(
        (["project", "user", "topic", "task", "capability"] as const).map((kind) =>
          this.#state.list<MaterializedView>({ kind: `view:${kind}`, limit: 10_000 }),
        ),
      )
    ).flat();
    let repaired = 0;
    let failed = 0;
    for (const state of states) {
      try {
        const records = await this.#store.fetchVectors("memory", state.value.memberMemoryIds);
        const facts: Record<string, ViewFact> = {};
        for (const [id, stored] of records) {
          const record = adaptLegacyMemory(
            JSON.parse(String(stored.fields["payload"] ?? "{}")) as Readonly<
              Record<string, unknown>
            >,
          );
          facts[id] = {
            recordKey: id,
            value: record.content,
            values: { [id]: record.content },
            currentMemoryIds: isCurrent(record) ? [id] : [],
            historicalMemoryIds: isCurrent(record) ? [] : [id],
            authority: record.authority,
            updatedAt: this.#clock.now(),
          };
        }
        const now = this.#clock.now();
        await this.#state.put(
          {
            id: state.id,
            kind: `view:${state.value.kind}`,
            namespace: state.value.namespace,
            value: {
              ...state.value,
              state: "active",
              facts,
              revision: state.value.revision + 1,
              updatedAt: now,
              expiresAt: now + this.#ttlMs,
            } as unknown as Readonly<Record<string, unknown>>,
          },
          { expectedRevision: state.revision, now },
        );
        repaired++;
      } catch {
        failed++;
      }
    }
    return { inspected: states.length, repaired, failed };
  }

  async flush(): Promise<void> {}

  #id(kind: ViewKind, scopeId: string, namespace: string): string {
    return this.#state.id(`view:${kind}`, namespace, scopeId);
  }
}
