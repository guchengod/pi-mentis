import { stableHash, systemClock, type Clock } from "@pi-mentis/pi-mentis-core";
import {
  StateRevisionConflictError,
  ZvecStateStore,
  type ZvecStore,
  type StoredRecord,
} from "@pi-mentis/pi-mentis-zvec";

import type { MemoryRecord, PiScopeContext } from "./types.js";

export type ViewKind = "project" | "user" | "topic" | "task" | "capability";
export type ViewState = "active" | "stale" | "rebuilding" | "failed";

export interface ViewFact {
  readonly factKey: string;
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

export interface ViewDelta {
  readonly id: string;
  readonly viewKind: ViewKind;
  readonly scopeId: string;
  readonly namespace: string;
  readonly factKey: string;
  readonly memoryId: string;
  readonly value: string;
  readonly authority: number;
  readonly operation: "set" | "coexist" | "historical" | "supersede" | "retract" | "conflict";
  readonly replacedMemoryIds: readonly string[];
  readonly createdAt: number;
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
  const context = record.scopeContext;
  const inferredTopicId = context?.topicIds?.[0];
  const targets: Array<{ readonly kind: ViewKind; readonly scopeId: string }> = [];
  // An explicit atomic-memory scope is authoritative. Context facets describe where the
  // observation happened; they must never widen a project:A record into the caller's current
  // project (or fan a topic record into sibling topics).
  if (record.scope.kind === "project" || record.scope.kind === "repository")
    targets.push({ kind: "project", scopeId: record.scope.id });
  else if (record.scope.kind === "user") targets.push({ kind: "user", scopeId: record.scope.id });
  else if (record.scope.kind === "topic") targets.push({ kind: "topic", scopeId: record.scope.id });
  else if (record.scope.kind === "task") targets.push({ kind: "task", scopeId: record.scope.id });
  else if (record.domain === "user" && context?.userId !== undefined)
    targets.push({ kind: "user", scopeId: context.userId });
  else if (
    record.domain === "topic" &&
    context?.topicIds?.length === 1 &&
    inferredTopicId !== undefined
  )
    targets.push({ kind: "topic", scopeId: inferredTopicId });
  else if (record.domain === "task" && context?.taskId !== undefined)
    targets.push({ kind: "task", scopeId: context.taskId });
  if (record.domain === "capability") {
    targets.push({ kind: "capability", scopeId: context?.capabilitySnapshotId ?? record.scope.id });
  }
  return targets;
}

export class HierarchicalViewService {
  readonly #store: ZvecStore;
  readonly #state: ZvecStateStore;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #pending = new Set<Promise<void>>();
  readonly #refreshes = new Map<string, Promise<void>>();

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
    onStale?: (view: MaterializedView) => Promise<void>,
  ): Promise<MaterializedView | undefined> {
    const namespace = identityNamespace(context);
    const id = this.#id(kind, scopeId, namespace);
    const stored = await this.#state.get<MaterializedView>(id);
    if (stored === undefined) return undefined;
    if (stored.value.expiresAt > this.#clock.now()) return stored.value;
    const stale: MaterializedView = { ...stored.value, state: "stale" };
    this.#queueRefresh(stale, onStale);
    return stale;
  }

  async applyMemory(record: Omit<MemoryRecord, "embedding">): Promise<readonly MaterializedView[]> {
    if (record.factKey === undefined) return [];
    const namespace = identityNamespace(record.scopeContext);
    const operation: ViewDelta["operation"] =
      record.temporalState === "retracted"
        ? "retract"
        : record.temporalState === "historical"
          ? "historical"
          : record.temporalState === "conflicted"
            ? "conflict"
            : record.supersedesIds.length > 0
              ? "supersede"
              : record.cardinality === "set" ||
                  record.cardinality === "ordered" ||
                  record.cardinality === "event"
                ? "coexist"
                : "set";
    const views: MaterializedView[] = [];
    for (const target of viewTargets(record)) {
      const delta: ViewDelta = {
        id: `view-delta:${stableHash("mentis-view-delta:v1", target.kind, target.scopeId, record.id, String(record.revision))}`,
        viewKind: target.kind,
        scopeId: target.scopeId,
        namespace,
        factKey: record.factKey,
        memoryId: record.id,
        value: record.content,
        authority: record.authority,
        operation,
        replacedMemoryIds: record.supersedesIds,
        createdAt: this.#clock.now(),
      };
      views.push(await this.applyDelta(delta));
    }
    return views;
  }

  async enqueueMemory(record: Omit<MemoryRecord, "embedding">): Promise<string | undefined> {
    if (
      record.factKey === undefined ||
      viewTargets(record).length === 0 ||
      record.status === "pending" ||
      record.status === "rejected" ||
      record.branchClaimState === "hypothesis" ||
      record.branchClaimState === "abandoned"
    ) {
      return undefined;
    }
    const now = this.#clock.now();
    const jobId = `view-job:${stableHash("mentis-view-job:v1", record.id, String(record.revision))}`;
    await this.#writeJob(jobId, "queued", record, now);
    const work = this.#runJob(jobId, record).finally(() => this.#pending.delete(work));
    this.#pending.add(work);
    queueMicrotask(() => void work.catch(() => undefined));
    return jobId;
  }

  async repair(): Promise<{
    readonly inspected: number;
    readonly repaired: number;
    readonly failed: number;
  }> {
    const documents = await this.#store.filterScalar(
      "jobs_v1",
      'kind = "view-delta" AND (status = "queued" OR status = "running" OR status = "failed")',
      10_000,
    );
    let repaired = 0;
    let failed = 0;
    for (const document of documents) {
      const payload = document.fields["payload"];
      if (typeof payload !== "string") {
        failed++;
        continue;
      }
      const job = JSON.parse(payload) as { readonly record?: Omit<MemoryRecord, "embedding"> };
      if (job.record === undefined) {
        failed++;
        continue;
      }
      try {
        await this.#runJob(document.id, job.record);
        repaired++;
      } catch {
        failed++;
      }
    }
    const views = (
      await Promise.all(
        (["project", "user", "topic", "task", "capability"] as const).map((kind) =>
          this.#state.list<MaterializedView>({ kind: `view:${kind}`, limit: 10_000 }),
        ),
      )
    ).flat();
    for (const view of views) {
      if (view.value.state === "active" && view.value.expiresAt > this.#clock.now()) continue;
      try {
        await this.#refreshView(view.id);
        repaired++;
      } catch (error: unknown) {
        await this.#markFailedById(view.id, error).catch(() => undefined);
        failed++;
      }
    }
    return { inspected: documents.length + views.length, repaired, failed };
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  async applyDelta(delta: ViewDelta): Promise<MaterializedView> {
    const atomic = (await this.#store.fetchVectors("memory", [delta.memoryId])).get(delta.memoryId);
    const rawPayload = atomic?.fields["payload"];
    if (atomic === undefined || typeof rawPayload !== "string") {
      throw new Error(`View delta ${delta.id} references missing atomic memory ${delta.memoryId}`);
    }
    const payload = JSON.parse(rawPayload) as {
      readonly factKey?: string;
      readonly content?: string;
      readonly status?: string;
    };
    if (payload.factKey !== delta.factKey || payload.content !== delta.value) {
      throw new Error(
        `View delta ${delta.id} attempts to create a fact not present in atomic memory`,
      );
    }
    if (
      ["pending", "rejected", "tombstoned"].includes(payload.status ?? "") &&
      delta.operation !== "retract"
    ) {
      throw new Error(`View delta ${delta.id} references a non-readable atomic memory`);
    }
    const id = this.#id(delta.viewKind, delta.scopeId, delta.namespace);
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await this.#state.get<MaterializedView>(id);
      const now = this.#clock.now();
      const current = existing?.value.facts[delta.factKey];
      const historical = new Set([
        ...(current?.historicalMemoryIds ?? []),
        ...delta.replacedMemoryIds,
        ...(delta.operation === "supersede" ? (current?.currentMemoryIds ?? []) : []),
        ...(delta.operation === "historical" ? [delta.memoryId] : []),
      ]);
      let currentIds = current?.currentMemoryIds ?? [];
      if (delta.operation === "set" || delta.operation === "supersede")
        currentIds = [delta.memoryId];
      else if (delta.operation === "coexist" || delta.operation === "conflict") {
        currentIds = [...new Set([...currentIds, delta.memoryId])];
      } else if (delta.operation === "retract") currentIds = [];
      const fact: ViewFact = {
        factKey: delta.factKey,
        value:
          delta.operation === "retract" || delta.operation === "historical"
            ? (current?.value ?? delta.value)
            : delta.value,
        values: {
          ...(current?.values ?? {}),
          [delta.memoryId]: delta.value,
        },
        currentMemoryIds: currentIds,
        historicalMemoryIds: [...historical].filter((memoryId) => !currentIds.includes(memoryId)),
        authority: Math.max(current?.authority ?? 0, delta.authority),
        updatedAt: now,
      };
      const facts = { ...(existing?.value.facts ?? {}), [delta.factKey]: fact };
      const memberMemoryIds = [
        ...new Set(
          Object.values(facts).flatMap((item) => [
            ...item.currentMemoryIds,
            ...item.historicalMemoryIds,
          ]),
        ),
      ];
      const view: MaterializedView = {
        id,
        kind: delta.viewKind,
        scopeId: delta.scopeId,
        namespace: delta.namespace,
        state: "active",
        revision: (existing?.value.revision ?? 0) + 1,
        facts,
        memberMemoryIds,
        createdAt: existing?.value.createdAt ?? now,
        updatedAt: now,
        expiresAt: now + this.#ttlMs,
      };
      try {
        await this.#state.put(
          {
            id,
            kind: `view:${delta.viewKind}`,
            namespace: delta.namespace,
            value: view as unknown as Readonly<Record<string, unknown>>,
          },
          { expectedRevision: existing?.revision ?? 0, now },
        );
        return view;
      } catch (error: unknown) {
        if (!(error instanceof StateRevisionConflictError) || attempt === 7) throw error;
      }
    }
    throw new Error(`Unable to apply view delta ${delta.id}`);
  }

  async markFailed(
    kind: ViewKind,
    scopeId: string,
    context: PiScopeContext,
    error: unknown,
  ): Promise<void> {
    const namespace = identityNamespace(context);
    const id = this.#id(kind, scopeId, namespace);
    const existing = await this.#state.get<MaterializedView>(id);
    if (existing === undefined) return;
    await this.#state.put(
      {
        id,
        kind: `view:${kind}`,
        namespace,
        value: {
          ...existing.value,
          state: "failed",
          failure: error instanceof Error ? error.message : String(error),
          updatedAt: this.#clock.now(),
        } as unknown as Readonly<Record<string, unknown>>,
      },
      { expectedRevision: existing.revision, now: this.#clock.now() },
    );
  }

  #queueRefresh(
    stale: MaterializedView,
    onStale?: (view: MaterializedView) => Promise<void>,
  ): void {
    if (this.#refreshes.has(stale.id)) return;
    const refresh = (async () => {
      try {
        await this.#refreshView(stale.id);
        await onStale?.(stale);
      } catch (error: unknown) {
        await this.#markFailedById(stale.id, error).catch(() => undefined);
      }
    })().finally(() => {
      this.#refreshes.delete(stale.id);
      this.#pending.delete(refresh);
    });
    this.#refreshes.set(stale.id, refresh);
    this.#pending.add(refresh);
    queueMicrotask(() => void refresh.catch(() => undefined));
  }

  async #refreshView(id: string): Promise<void> {
    const existing = await this.#state.get<MaterializedView>(id);
    if (existing === undefined) return;
    const now = this.#clock.now();
    await this.#state.put(
      {
        id,
        kind: `view:${existing.value.kind}`,
        namespace: existing.value.namespace,
        value: {
          ...existing.value,
          state: "rebuilding",
          updatedAt: now,
        } as unknown as Readonly<Record<string, unknown>>,
      },
      { expectedRevision: existing.revision, now },
    );
    const rebuilding = await this.#state.get<MaterializedView>(id);
    if (rebuilding === undefined) return;
    const atomic = await this.#store.fetchVectors("memory", rebuilding.value.memberMemoryIds);
    const payloads = new Map<
      string,
      { readonly content?: string; readonly authority?: number; readonly status?: string }
    >();
    for (const [memoryId, record] of atomic) {
      const raw = record.fields["payload"];
      if (typeof raw !== "string") continue;
      payloads.set(memoryId, JSON.parse(raw));
    }
    const facts: Record<string, ViewFact> = {};
    for (const [factKey, fact] of Object.entries(rebuilding.value.facts)) {
      const currentMemoryIds = fact.currentMemoryIds.filter((memoryId) => {
        const status = payloads.get(memoryId)?.status;
        return status === "active" || status === "conflicted";
      });
      const historicalMemoryIds = fact.historicalMemoryIds.filter((memoryId) => {
        const status = payloads.get(memoryId)?.status;
        return status === "superseded" || status === "conflicted" || status === "expired";
      });
      if (currentMemoryIds.length === 0 && historicalMemoryIds.length === 0) continue;
      const selected = payloads.get(currentMemoryIds.at(-1) ?? historicalMemoryIds.at(-1) ?? "");
      facts[factKey] = {
        ...fact,
        value: selected?.content ?? fact.value,
        values: Object.fromEntries(
          [...currentMemoryIds, ...historicalMemoryIds].map((memoryId) => [
            memoryId,
            payloads.get(memoryId)?.content ?? fact.values?.[memoryId] ?? fact.value,
          ]),
        ),
        currentMemoryIds,
        historicalMemoryIds,
        authority: Math.max(
          0,
          ...[...currentMemoryIds, ...historicalMemoryIds].map(
            (memoryId) => payloads.get(memoryId)?.authority ?? 0,
          ),
        ),
        updatedAt: this.#clock.now(),
      };
    }
    const memberMemoryIds = [
      ...new Set(
        Object.values(facts).flatMap((fact) => [
          ...fact.currentMemoryIds,
          ...fact.historicalMemoryIds,
        ]),
      ),
    ];
    const refreshedAt = this.#clock.now();
    await this.#state.put(
      {
        id,
        kind: `view:${rebuilding.value.kind}`,
        namespace: rebuilding.value.namespace,
        value: {
          ...rebuilding.value,
          state: "active",
          revision: rebuilding.value.revision + 1,
          facts,
          memberMemoryIds,
          updatedAt: refreshedAt,
          expiresAt: refreshedAt + this.#ttlMs,
          failure: undefined,
        } as unknown as Readonly<Record<string, unknown>>,
      },
      { expectedRevision: rebuilding.revision, now: refreshedAt },
    );
  }

  async #markFailedById(id: string, error: unknown): Promise<void> {
    const existing = await this.#state.get<MaterializedView>(id);
    if (existing === undefined) return;
    await this.#state.put(
      {
        id,
        kind: `view:${existing.value.kind}`,
        namespace: existing.value.namespace,
        value: {
          ...existing.value,
          state: "failed",
          failure: error instanceof Error ? error.message : String(error),
          updatedAt: this.#clock.now(),
        } as unknown as Readonly<Record<string, unknown>>,
      },
      { expectedRevision: existing.revision, now: this.#clock.now() },
    );
  }

  #id(kind: ViewKind, scopeId: string, namespace: string): string {
    return this.#state.id(`view:${kind}`, namespace, scopeId);
  }

  async #runJob(jobId: string, record: Omit<MemoryRecord, "embedding">): Promise<void> {
    const now = this.#clock.now();
    await this.#writeJob(jobId, "running", record, now);
    try {
      const result = await this.applyMemory(record);
      await this.#writeJob(jobId, "completed", record, this.#clock.now(), {
        viewIds: result.map((view) => view.id),
      });
    } catch (error: unknown) {
      await this.#writeJob(jobId, "failed", record, this.#clock.now(), {
        failure: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async #writeJob(
    jobId: string,
    status: "queued" | "running" | "completed" | "failed",
    record: Omit<MemoryRecord, "embedding">,
    now: number,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const existing = (await this.#store.fetchScalar("jobs_v1", [jobId])).get(jobId);
    const createdAt = typeof existing?.["createdAt"] === "number" ? existing["createdAt"] : now;
    const stored: StoredRecord = {
      id: jobId,
      kind: "view-delta",
      namespace: identityNamespace(record.scopeContext),
      status,
      payload: { jobId, status, record, createdAt, updatedAt: now, ...extra },
      createdAt,
      updatedAt: now,
    };
    await this.#store.upsertScalar("jobs_v1", [stored]);
  }
}
