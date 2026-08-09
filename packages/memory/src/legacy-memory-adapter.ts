import type { LegacyMemoryMetadata, MemoryRecord, MemoryRelationships } from "./types.js";

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function relationships(payload: Readonly<Record<string, unknown>>): MemoryRelationships {
  const current = payload["relationships"];
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    const value = current as Readonly<Record<string, unknown>>;
    return {
      reinforcesIds: strings(value["reinforcesIds"]),
      supersedesIds: strings(value["supersedesIds"]),
      retractsIds: strings(value["retractsIds"]),
      conflictsWithIds: strings(value["conflictsWithIds"]),
      coexistsWithIds: strings(value["coexistsWithIds"]),
    };
  }
  return {
    reinforcesIds: [],
    supersedesIds: strings(payload["supersedesIds"]),
    retractsIds: [],
    conflictsWithIds: strings(payload["conflictsWithIds"]),
    coexistsWithIds: [],
  };
}

export function isLegacyMemory(payload: Readonly<Record<string, unknown>>): boolean {
  return payload["schemaVersion"] !== 2;
}

export function legacyMetadata(
  payload: Readonly<Record<string, unknown>>,
): LegacyMemoryMetadata | undefined {
  if (!isLegacyMemory(payload)) return undefined;
  const value = <T extends string>(key: string): T | undefined =>
    typeof payload[key] === "string" ? (payload[key] as T) : undefined;
  return {
    ...(value("predicate") === undefined ? {} : { predicate: value("predicate") }),
    ...(value("type") === undefined ? {} : { type: value("type") }),
    ...(value("domain") === undefined ? {} : { domain: value("domain") }),
    ...(value("cardinality") === undefined ? {} : { cardinality: value("cardinality") }),
    ...(value("factKey") === undefined ? {} : { factKey: value("factKey") }),
    ...(value("semanticKey") === undefined ? {} : { semanticKey: value("semanticKey") }),
    ...(value("memberFactKey") === undefined ? {} : { memberFactKey: value("memberFactKey") }),
    ...(value("setMemberKey") === undefined ? {} : { setMemberKey: value("setMemberKey") }),
    ...(value("branchClaimState") === undefined
      ? {}
      : { branchClaimState: value("branchClaimState") }),
    ...(value("temporalState") === undefined ? {} : { temporalState: value("temporalState") }),
    raw: payload,
  } as LegacyMemoryMetadata;
}

/** Creates a V2 read view without mutating or rewriting the stored legacy row. */
export function adaptLegacyMemory(
  payload: Readonly<Record<string, unknown>>,
): Omit<MemoryRecord, "embedding"> {
  if (!isLegacyMemory(payload)) return payload as unknown as Omit<MemoryRecord, "embedding">;
  const {
    predicate: _predicate,
    type: _type,
    domain: _domain,
    cardinality: _cardinality,
    factKey: _factKey,
    semanticKey: _semanticKey,
    memberFactKey: _memberFactKey,
    setMemberKey: _setMemberKey,
    supersedesIds: _supersedesIds,
    conflictsWithIds: _conflictsWithIds,
    branchClaimState: _branchClaimState,
    temporalState: _temporalState,
    contentOrigin: _contentOrigin,
    applicability: _applicability,
    premises: _premises,
    ...classlessPayload
  } = payload;
  void _predicate;
  void _type;
  void _domain;
  void _cardinality;
  void _factKey;
  void _semanticKey;
  void _memberFactKey;
  void _setMemberKey;
  void _supersedesIds;
  void _conflictsWithIds;
  void _branchClaimState;
  void _temporalState;
  void _contentOrigin;
  void _applicability;
  void _premises;
  const branch =
    typeof payload["branchClaimState"] === "string" ? payload["branchClaimState"] : undefined;
  const origin =
    typeof payload["contentOrigin"] === "string" ? payload["contentOrigin"] : "external";
  return {
    ...classlessPayload,
    schemaVersion: 2,
    relationships: relationships(payload),
    provenance: {
      origin,
      epistemicState:
        branch === "hypothesis" ? "hypothesis" : branch === "verified" ? "verified" : "asserted",
      ...(typeof (payload["scopeContext"] as { readonly branchId?: unknown } | undefined)
        ?.branchId === "string"
        ? { branchId: (payload["scopeContext"] as { readonly branchId: string }).branchId }
        : {}),
      ...(branch === "hypothesis" ? { branchLocal: true } : {}),
    },
    legacy: legacyMetadata(payload),
  } as unknown as Omit<MemoryRecord, "embedding">;
}
