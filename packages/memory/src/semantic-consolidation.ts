import { boundedText } from "./cognitive-shared.js";
import { detectSecrets } from "./secret-detector.js";
import type { MemoryCandidateProposal } from "./memory-candidates.js";
import type { TaskEpisodeDigest } from "./task-episode.js";
import type { ProcedureFamily } from "./types.js";

export interface ProcedureProposal {
  readonly family?: ProcedureFamily;
  readonly problemCues: readonly string[];
  readonly generalizedSteps: readonly string[];
  readonly prerequisites: readonly string[];
  readonly successCriteria: readonly string[];
  readonly appliesWhen: readonly string[];
  readonly excludesWhen: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly confidence: number;
}

export interface EpisodeConsolidationProposal {
  readonly assertions: readonly MemoryCandidateProposal[];
  readonly procedure?: ProcedureProposal;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function strings(
  value: unknown,
  maximum: number,
  maxCharacters: number,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value.slice(0, maximum).map((item) => boundedText(item as string, maxCharacters));
}

function confidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function procedureFamily(value: unknown): ProcedureFamily | undefined {
  const entry = object(value);
  if (entry === undefined) return undefined;
  const domain = entry["domain"];
  const failureMode = entry["failureMode"];
  const trigger = entry["trigger"];
  const semanticRole = entry["semanticRole"];
  const intendedBehavior = entry["intendedBehavior"];
  if (
    typeof domain !== "string" ||
    typeof failureMode !== "string" ||
    typeof trigger !== "string" ||
    typeof semanticRole !== "string" ||
    typeof intendedBehavior !== "string" ||
    [domain, failureMode, trigger, semanticRole, intendedBehavior].some(
      (item) => item.trim().length === 0 || item.length > 80,
    )
  ) {
    return undefined;
  }
  return { domain, failureMode, trigger, semanticRole, intendedBehavior };
}

export function parseEpisodeConsolidationProposal(
  value: unknown,
  options: { readonly maxAssertions: number; readonly candidateMaxCharacters: number },
): EpisodeConsolidationProposal {
  const root = object(value);
  if (root === undefined || !Array.isArray(root["assertions"])) {
    throw new Error("Episode consolidation response must contain assertions");
  }
  const allowedScopes = new Set(["user", "project", "repository", "task", "topic"]);
  const assertions: MemoryCandidateProposal[] = [];
  for (const raw of root["assertions"].slice(0, options.maxAssertions)) {
    const entry = object(raw);
    const content = entry?.["content"];
    const scopeHint = entry?.["scopeHint"];
    const proposalConfidence = confidence(entry?.["confidence"]);
    const durability = confidence(entry?.["durability"]);
    const evidenceIds = strings(entry?.["evidenceIds"], 16, 200);
    const rawSupport = entry?.["support"];
    if (
      typeof content !== "string" ||
      typeof scopeHint !== "string" ||
      !allowedScopes.has(scopeHint) ||
      proposalConfidence === undefined ||
      durability === undefined ||
      evidenceIds === undefined ||
      evidenceIds.length === 0 ||
      !Array.isArray(rawSupport) ||
      rawSupport.length === 0 ||
      rawSupport.some((raw) => {
        const support = object(raw);
        return (
          typeof support?.["evidenceId"] !== "string" ||
          !["entailed", "contradicted", "insufficient"].includes(String(support?.["relation"]))
        );
      })
    ) {
      throw new Error("Episode consolidation assertion is invalid");
    }
    const bounded = boundedText(content, options.candidateMaxCharacters);
    if (bounded === "" || detectSecrets(bounded).sensitive) continue;
    assertions.push({
      content: bounded,
      scopeHint: scopeHint as MemoryCandidateProposal["scopeHint"],
      confidence: proposalConfidence,
      durability,
      evidenceIds,
      support: rawSupport.map((raw) => {
        const support = object(raw) as Readonly<Record<string, unknown>>;
        return {
          evidenceId: support["evidenceId"] as string,
          relation: support["relation"] as "entailed" | "contradicted" | "insufficient",
        };
      }),
    });
  }
  const rawProcedure = object(root["procedure"]);
  if (rawProcedure === undefined) return { assertions };
  const family = procedureFamily(rawProcedure["family"]);
  const problemCues = strings(rawProcedure["problemCues"], 12, 300);
  const generalizedSteps = strings(rawProcedure["generalizedSteps"], 16, 400);
  const prerequisites = strings(rawProcedure["prerequisites"], 12, 300);
  const successCriteria = strings(rawProcedure["successCriteria"], 12, 300);
  const appliesWhen = strings(rawProcedure["appliesWhen"], 12, 300);
  const excludesWhen = strings(rawProcedure["excludesWhen"], 12, 300);
  const evidenceIds = strings(rawProcedure["evidenceIds"], 32, 200);
  const procedureConfidence = confidence(rawProcedure["confidence"]);
  if (
    problemCues === undefined ||
    problemCues.length === 0 ||
    generalizedSteps === undefined ||
    generalizedSteps.length === 0 ||
    prerequisites === undefined ||
    successCriteria === undefined ||
    successCriteria.length === 0 ||
    appliesWhen === undefined ||
    excludesWhen === undefined ||
    evidenceIds === undefined ||
    evidenceIds.length === 0 ||
    procedureConfidence === undefined ||
    [...problemCues, ...generalizedSteps, ...prerequisites, ...successCriteria].some(
      (text) => detectSecrets(text).sensitive,
    )
  ) {
    throw new Error("Episode consolidation procedure is invalid");
  }
  return {
    assertions,
    procedure: {
      ...(family === undefined ? {} : { family }),
      problemCues,
      generalizedSteps,
      prerequisites,
      successCriteria,
      appliesWhen,
      excludesWhen,
      evidenceIds,
      confidence: procedureConfidence,
    },
  };
}

export function validateConsolidationEvidence(
  digest: TaskEpisodeDigest,
  evidenceIds: readonly string[],
  requireVerified: boolean,
): boolean {
  const evidence = new Map(digest.evidence.map((entry) => [entry.id, entry]));
  return (
    evidenceIds.length > 0 &&
    evidenceIds.every((id) => evidence.has(id)) &&
    (!requireVerified || evidenceIds.some((id) => evidence.get(id)?.verified === true))
  );
}
