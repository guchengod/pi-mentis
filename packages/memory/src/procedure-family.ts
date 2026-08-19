import { stableHash } from "@pi-mentis/pi-mentis-core";

import type { ProcedureFamily } from "./types.js";

const ALIASES: Readonly<Record<string, string>> = {
  configuration: "config",
  config_initialization: "initialization_failure",
  initialization_failed: "initialization_failure",
  init_failure: "initialization_failure",
  missing: "value_missing",
  missing_value: "value_missing",
  absent_value: "value_missing",
  undefined_value: "value_missing",
  optional_value: "optional",
  required_value: "required",
  default: "fallback",
  use_default: "fallback",
  default_fallback: "fallback",
  validation_error: "reject",
  fail_fast: "reject",
};

function canonicalField(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 80);
  return ALIASES[normalized] ?? normalized;
}

export function canonicalProcedureFamily(family: ProcedureFamily): ProcedureFamily {
  const canonical = {
    domain: canonicalField(family.domain),
    failureMode: canonicalField(family.failureMode),
    trigger: canonicalField(family.trigger),
    semanticRole: canonicalField(family.semanticRole),
    intendedBehavior: canonicalField(family.intendedBehavior),
  };
  // The first supported cross-surface family deliberately collapses concrete
  // config identifiers into semantic roles. Concrete cues remain on the
  // Experience for evidence and applicability, never in family identity.
  if (
    canonical.domain === "config" &&
    canonical.failureMode === "initialization_failure" &&
    canonical.semanticRole === "optional"
  ) {
    return { ...canonical, trigger: "value_missing", intendedBehavior: "fallback" };
  }
  if (
    canonical.domain === "config" &&
    canonical.failureMode === "initialization_failure" &&
    canonical.semanticRole === "required"
  ) {
    return { ...canonical, trigger: "value_missing", intendedBehavior: "reject" };
  }
  return canonical;
}

export function procedureFamilyKey(family: ProcedureFamily): string {
  const canonical = canonicalProcedureFamily(family);
  return `procedure-family:${stableHash(
    "procedure-family:v1",
    canonical.domain,
    canonical.failureMode,
    canonical.trigger,
    canonical.semanticRole,
    canonical.intendedBehavior,
  )}`;
}

export function procedureFamilyLabel(family: ProcedureFamily): string {
  const canonical = canonicalProcedureFamily(family);
  return [
    canonical.domain,
    canonical.failureMode,
    canonical.trigger,
    canonical.semanticRole,
    canonical.intendedBehavior,
  ].join("/");
}
