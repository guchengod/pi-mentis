import type { MemoryDomain, TemporalCardinality } from "./types.js";

export type MemorySubjectType =
  "user" | "project" | "repository" | "task" | "environment" | "agent";

export type PredicateValueType =
  | "string"
  | "set"
  | "command"
  | "technology"
  | "procedure"
  | "decision"
  | "requirement"
  | "event"
  | "preference"
  | "fact";

export type PredicateTemporalBehavior = "current" | "historical" | "evolving" | "event";

export interface PredicateDefinition {
  readonly id: string;
  readonly description: string;
  readonly retrievalDescription: string;
  readonly subjectTypes: readonly MemorySubjectType[];
  readonly valueType: PredicateValueType;
  readonly cardinality: TemporalCardinality;
  readonly temporalBehavior: PredicateTemporalBehavior;
  readonly memoryDomains: readonly MemoryDomain[];
  readonly examples?: readonly string[];
  /**
   * Value type constraints for structural compatibility rerank. When absent,
   * any value type is accepted.
   */
  readonly valueShape?:
    | "personal_name"
    | "tool_name"
    | "language_name"
    | "port_number"
    | "command_string"
    | "natural_language"
    | "enum_value"
    | "boolean_value"
    | "numeric_value"
    | "ordered_sequence"
    | "event_description"
    | "open_text";
  /**
   * True for generic fallback predicates that should be selected when no
   * specialized predicate clears the confidence/margin threshold.
   */
  readonly isGeneric?: boolean;
  /**
   * Relation type — the semantic relation this predicate expresses
   * (e.g. "preference", "identity_name", "configuration", "procedure",
   * "event", "decision"). This is a structural ontology field, NOT a
   * natural-language boundary description. Defines what the predicate IS,
   * not what it is NOT.
   */
  readonly relationType?:
    | "preference"
    | "identity_name"
    | "configuration"
    | "procedure"
    | "event"
    | "decision"
    | "command"
    | "fact"
    | "requirement";
  /**
   * Object type — the semantic type of the object/value this predicate's
   * fact is about (e.g. "package_management_tool", "programming_language",
   * "personal_name", "scalar_value", "ordered_sequence"). This is a
   * structural ontology field defining what the value MUST be.
   */
  readonly objectType?: string;
}

export interface PredicateRegistrySnapshot {
  readonly schemaVersion: string;
  readonly definitions: readonly PredicateDefinition[];
}

export function buildPredicateSemanticText(definition: PredicateDefinition): string {
  const parts = [
    definition.id,
    definition.description,
    definition.retrievalDescription,
    ...(definition.examples ?? []),
  ];
  // Structural ontology fields participate in the embedding text so the
  // embedding encodes what the predicate IS (relation + object type), not
  // a case blacklist of what it is not.
  if (definition.relationType !== undefined) {
    parts.push(`relation: ${definition.relationType}`);
  }
  if (definition.objectType !== undefined) {
    parts.push(`object: ${definition.objectType}`);
  }
  return parts.join("\n");
}

export class PredicateRegistry {
  readonly #definitions = new Map<string, PredicateDefinition>();
  readonly schemaVersion: string;

  constructor(schemaVersion: string, definitions: readonly PredicateDefinition[] = []) {
    if (schemaVersion.trim() === "")
      throw new Error("Predicate registry schema version is required");
    this.schemaVersion = schemaVersion;
    for (const definition of definitions) this.register(definition);
  }

  register(definition: PredicateDefinition): void {
    if (definition.id.trim() === "") throw new Error("Predicate id is required");
    if (this.#definitions.has(definition.id)) {
      throw new Error(`Predicate ${definition.id} is already registered`);
    }
    this.#definitions.set(definition.id, Object.freeze({ ...definition }));
  }

  get(id: string): PredicateDefinition | undefined {
    return this.#definitions.get(id);
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  list(): readonly PredicateDefinition[] {
    return [...this.#definitions.values()];
  }

  snapshot(): PredicateRegistrySnapshot {
    return { schemaVersion: this.schemaVersion, definitions: this.list() };
  }
}

type DefinitionInput = Omit<PredicateDefinition, "memoryDomains"> & {
  readonly memoryDomains?: readonly MemoryDomain[];
};

function definition(input: DefinitionInput): PredicateDefinition {
  return { ...input, memoryDomains: input.memoryDomains ?? ["user"] };
}

const USER = ["user"] as const;
const AGENT = ["agent"] as const;
const PROJECT = ["project", "repository"] as const;
const TASK = ["task"] as const;
const ENVIRONMENT = ["environment", "project", "repository"] as const;

export const DEFAULT_PREDICATE_DEFINITIONS = [
  definition({
    id: "assistant_alias",
    description: "The assistant name or alias chosen by the user.",
    retrievalDescription:
      "Relevant when the assistant identity or preferred form of address is needed.",
    subjectTypes: AGENT,
    valueType: "string",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["user"],
    relationType: "identity_name",
    objectType: "assistant_alias",
  }),
  definition({
    id: "user_name",
    description: "The user's name or preferred form of address.",
    retrievalDescription: "Relevant when identifying or addressing the current user.",
    subjectTypes: USER,
    valueType: "string",
    cardinality: "single",
    temporalBehavior: "current",
    valueShape: "personal_name",
    relationType: "identity_name",
    objectType: "personal_name",
  }),
  definition({
    id: "response_style",
    description: "The user's preferred response style and presentation.",
    retrievalDescription:
      "Relevant when deciding answer structure, tone, brevity, or ordering of conclusions and explanations.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "single",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "response_presentation",
    examples: ["Lead with the conclusion and then explain the reasons."],
  }),
  definition({
    id: "language_preference",
    description: "The user's preferred human language for communication.",
    retrievalDescription: "Relevant when choosing the language used to communicate with the user.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "single",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "human_language",
  }),
  definition({
    id: "programming_language_preference",
    description: "Programming languages the user prefers or avoids.",
    retrievalDescription:
      "Relevant when selecting an implementation language or adapting code examples to the user's technical preferences.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    valueShape: "language_name",
    relationType: "preference",
    objectType: "programming_language",
  }),
  definition({
    id: "package_manager_preference",
    description: "The user's package manager preferences.",
    retrievalDescription:
      "Relevant when selecting or discussing dependency and package management tooling.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "single",
    temporalBehavior: "evolving",
    valueShape: "tool_name",
    relationType: "preference",
    objectType: "package_management_tool",
    examples: ["Prefer pnpm for JavaScript projects."],
  }),
  definition({
    id: "general_package_manager_preference",
    description: "The user's default package manager across projects.",
    retrievalDescription:
      "Relevant when a package manager must be chosen without a project-specific requirement.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "single",
    temporalBehavior: "evolving",
    valueShape: "tool_name",
    relationType: "preference",
    objectType: "package_management_tool",
  }),
  definition({
    id: "code_style_preference",
    description: "The user's long-term preferences for code implementation and design.",
    retrievalDescription:
      "Relevant when implementation simplicity, abstraction level, interface shape, readability, or coding habits should influence a design.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    valueShape: "natural_language",
    relationType: "preference",
    objectType: "code_implementation_style",
    examples: [
      "Prefer simple direct implementations over unnecessary abstraction.",
    ],
  }),
  definition({
    id: "architecture_preference",
    description: "The user's recurring software architecture preferences.",
    retrievalDescription:
      "Relevant when choosing boundaries, layers, components, or an overall architecture according to the user's habits.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "architecture_style",
  }),
  definition({
    id: "abstraction_preference",
    description: "The user's preferred degree of abstraction and indirection.",
    retrievalDescription:
      "Relevant when deciding whether to introduce interfaces, providers, layers, factories, or generalized abstractions.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "abstraction_level",
  }),
  definition({
    id: "testing_preference",
    description: "The user's preferred testing strategy and rigor.",
    retrievalDescription:
      "Relevant when selecting test levels, coverage, fixtures, mocks, or validation depth.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "testing_strategy",
  }),
  definition({
    id: "error_handling_preference",
    description: "The user's preferred error handling and failure semantics.",
    retrievalDescription:
      "Relevant when choosing error propagation, retries, fallbacks, diagnostics, or fail-closed behavior.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "error_handling_approach",
  }),
  definition({
    id: "documentation_preference",
    description: "The user's preferences for documentation and comments.",
    retrievalDescription:
      "Relevant when deciding documentation format, detail, examples, or code-comment style.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "documentation_style",
  }),
  definition({
    id: "review_preference",
    description: "The user's preferences for code and design review.",
    retrievalDescription:
      "Relevant when prioritizing review findings, evidence, scope, or reporting style.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "review_approach",
  }),
  definition({
    id: "deployment_preference",
    description: "The user's general deployment preferences.",
    retrievalDescription:
      "Relevant when selecting release, hosting, rollout, or operational approaches without a project-specific requirement.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "deployment_approach",
  }),
  definition({
    id: "database_preference",
    description: "The user's database and data-storage preferences.",
    retrievalDescription:
      "Relevant when selecting a database, storage model, indexing strategy, or persistence tradeoff.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    relationType: "preference",
    objectType: "database_technology",
  }),
  definition({
    id: "project_package_manager",
    description: "The package manager selected by a project.",
    retrievalDescription:
      "Relevant when operating on dependencies or commands in the current project.",
    subjectTypes: PROJECT,
    valueType: "technology",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["project"],
    relationType: "configuration",
    objectType: "package_management_tool",
  }),
  definition({
    id: "project_build_command",
    description: "The canonical project build command.",
    retrievalDescription: "Relevant when building, packaging, or validating the current project.",
    subjectTypes: PROJECT,
    valueType: "command",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["project"],
    relationType: "command",
    objectType: "build_command",
  }),
  definition({
    id: "project_test_command",
    description: "The canonical project unit-test command.",
    retrievalDescription: "Relevant when running or explaining the project's tests.",
    subjectTypes: PROJECT,
    valueType: "command",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["project"],
    relationType: "command",
    objectType: "test_command",
  }),
  definition({
    id: "project_integration_test_command",
    description: "The canonical project integration-test command.",
    retrievalDescription: "Relevant when validating interactions across project components.",
    subjectTypes: PROJECT,
    valueType: "command",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["project"],
    relationType: "command",
    objectType: "integration_test_command",
  }),
  definition({
    id: "project_lint_command",
    description: "The canonical project lint command.",
    retrievalDescription: "Relevant when checking source-code lint rules.",
    subjectTypes: PROJECT,
    valueType: "command",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["project"],
    relationType: "command",
    objectType: "lint_command",
  }),
  definition({
    id: "project_typecheck_command",
    description: "The canonical project typecheck command.",
    retrievalDescription: "Relevant when validating static types.",
    subjectTypes: PROJECT,
    valueType: "command",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["project"],
    relationType: "command",
    objectType: "typecheck_command",
  }),
  definition({
    id: "project_format_command",
    description: "The canonical project formatting command.",
    retrievalDescription: "Relevant when formatting project files or checking formatting.",
    subjectTypes: PROJECT,
    valueType: "command",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["project"],
    relationType: "command",
    objectType: "format_command",
  }),
  definition({
    id: "project_database",
    description: "The database selected by a project.",
    retrievalDescription: "Relevant when working with the current project's persistence layer.",
    subjectTypes: PROJECT,
    valueType: "technology",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["project"],
    relationType: "configuration",
    objectType: "database_technology",
  }),
  definition({
    id: "project_deployment_target",
    description: "The deployment target selected by a project.",
    retrievalDescription:
      "Relevant when building, releasing, or operating the project in its target environment.",
    subjectTypes: PROJECT,
    valueType: "technology",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["project"],
    relationType: "configuration",
    objectType: "deployment_target",
  }),
  definition({
    id: "project_purpose",
    description: "The durable purpose and goal of a project.",
    retrievalDescription:
      "Relevant when work must align with what the project is intended to accomplish.",
    subjectTypes: PROJECT,
    valueType: "fact",
    cardinality: "single",
    temporalBehavior: "evolving",
    memoryDomains: ["project"],
    relationType: "fact",
    objectType: "project_purpose",
  }),
  definition({
    id: "architecture_decision",
    description: "A project-specific architecture decision and its rationale.",
    retrievalDescription:
      "Relevant when current implementation choices depend on a prior design decision.",
    subjectTypes: PROJECT,
    valueType: "decision",
    cardinality: "set",
    temporalBehavior: "evolving",
    memoryDomains: ["project"],
    relationType: "decision",
    objectType: "architecture_decision",
  }),
  definition({
    id: "runtime",
    description: "The runtime used by a project or environment.",
    retrievalDescription: "Relevant when commands or behavior depend on the active runtime.",
    subjectTypes: ENVIRONMENT,
    valueType: "technology",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["environment"],
    relationType: "configuration",
    objectType: "runtime_technology",
  }),
  definition({
    id: "runtime_version",
    description: "The active runtime version.",
    retrievalDescription:
      "Relevant when compatibility or commands depend on a specific runtime version.",
    subjectTypes: ENVIRONMENT,
    valueType: "fact",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["environment"],
    relationType: "configuration",
    objectType: "runtime_version",
  }),
  definition({
    id: "language",
    description: "A programming language used by the current project.",
    retrievalDescription:
      "Relevant when project implementation or tooling depends on its languages.",
    subjectTypes: PROJECT,
    valueType: "technology",
    cardinality: "set",
    temporalBehavior: "evolving",
    memoryDomains: ["project"],
    relationType: "configuration",
    objectType: "programming_language",
  }),
  definition({
    id: "storage_engine",
    description: "The storage engine used by a project or environment.",
    retrievalDescription:
      "Relevant when operating or changing the current persistence architecture.",
    subjectTypes: ENVIRONMENT,
    valueType: "technology",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["environment", "project"],
    relationType: "configuration",
    objectType: "storage_technology",
  }),
  definition({
    id: "task_goal",
    description: "The durable goal of a task.",
    retrievalDescription:
      "Relevant when continuing work or checking whether a result satisfies the task.",
    subjectTypes: TASK,
    valueType: "requirement",
    cardinality: "single",
    temporalBehavior: "evolving",
    memoryDomains: ["task"],
    relationType: "requirement",
    objectType: "task_goal",
  }),
  definition({
    id: "task_status",
    description: "A task progress or completion event.",
    retrievalDescription: "Relevant when reviewing task progress, changes, or completion history.",
    subjectTypes: TASK,
    valueType: "event",
    cardinality: "event",
    temporalBehavior: "event",
    memoryDomains: ["task"],
    relationType: "event",
    objectType: "task_progress_event",
  }),
  definition({
    id: "task_blocker",
    description: "A current blocker preventing task progress.",
    retrievalDescription:
      "Relevant when diagnosing why a task cannot proceed or what must change next.",
    subjectTypes: TASK,
    valueType: "fact",
    cardinality: "single",
    temporalBehavior: "current",
    memoryDomains: ["task"],
    relationType: "fact",
    objectType: "task_blocker",
  }),
  definition({
    id: "capability_state",
    description: "A verified capability state of the agent or environment.",
    retrievalDescription: "Relevant when deciding whether a capability is available and verified.",
    subjectTypes: ["agent", "environment"],
    valueType: "fact",
    cardinality: "set",
    temporalBehavior: "evolving",
    memoryDomains: ["capability"],
    relationType: "fact",
    objectType: "capability_availability",
  }),
  definition({
    id: "verified_procedure",
    description: "A procedure verified to work in a particular context.",
    retrievalDescription:
      "Relevant when repeating a workflow with evidence-backed steps and constraints.",
    subjectTypes: ["project", "repository", "environment", "agent"],
    valueType: "procedure",
    cardinality: "set",
    temporalBehavior: "evolving",
    memoryDomains: ["procedure"],
    relationType: "procedure",
    objectType: "verified_workflow",
  }),
  definition({
    id: "known_failure",
    description: "A known failure mode, cause, and mitigation.",
    retrievalDescription:
      "Relevant when symptoms resemble a previously observed error or operational failure.",
    subjectTypes: ["project", "repository", "environment", "agent"],
    valueType: "event",
    cardinality: "event",
    temporalBehavior: "event",
    memoryDomains: ["episodic", "procedure"],
    relationType: "event",
    objectType: "failure_mode",
  }),
  // ── Generic Fallback Predicates ──────────────────────────────────
  // Selected when no specialized predicate clears the confidence/margin
  // threshold. These provide a STABLE fact identity (not a content-hash
  // fallback) so corrections and updates can be linked to the same fact.
  definition({
    id: "generic_setting",
    description:
      "A user-specific configuration value, default, or setting that does not fit a specialized predicate.",
    retrievalDescription:
      "Relevant when the user has a specific default, setting, or configuration value that should be recalled.",
    subjectTypes: USER,
    valueType: "fact",
    cardinality: "single",
    temporalBehavior: "current",
    valueShape: "open_text",
    isGeneric: true,
    relationType: "configuration",
    objectType: "scalar_value",
    examples: [
      "The default retry count for API calls is 3.",
    ],
  }),
  definition({
    id: "generic_preference",
    description:
      "A user preference, convention, or habit that does not fit a specialized predicate.",
    retrievalDescription:
      "Relevant when a user preference or convention should influence behavior.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    valueShape: "natural_language",
    isGeneric: true,
    relationType: "preference",
    objectType: "user_convention",
    examples: [
      "I prefer naming branches after the feature rather than using dates.",
    ],
  }),
  definition({
    id: "naming_preference",
    description:
      "The user's preferences for naming artifacts — branches, files, scripts, experiments, or other named entities.",
    retrievalDescription:
      "Relevant when naming something according to the user's established conventions.",
    subjectTypes: USER,
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    valueShape: "natural_language",
    relationType: "preference",
    objectType: "naming_convention",
    examples: [
      "Branch names should be feature-based, not date-based.",
    ],
  }),
  definition({
    id: "user_procedure",
    description:
      "An ordered sequence of steps the user wants followed for a specific workflow. The order of steps matters and is not interchangeable.",
    retrievalDescription:
      "Relevant when the user has a defined ordered procedure, troubleshooting flow, or step-by-step workflow to follow.",
    subjectTypes: USER,
    valueType: "procedure",
    cardinality: "ordered",
    temporalBehavior: "evolving",
    valueShape: "ordered_sequence",
    memoryDomains: ["procedure"],
    relationType: "procedure",
    objectType: "ordered_workflow",
    examples: [
      "Troubleshooting flow: first check logs, then inspect config, then restart service.",
    ],
  }),
  definition({
    id: "generic_event",
    description:
      "A specific event that occurred at a point in time — an episodic occurrence with a date and outcome.",
    retrievalDescription:
      "Relevant when recalling what happened during a specific past event, drill, or incident.",
    subjectTypes: USER,
    valueType: "event",
    cardinality: "event",
    temporalBehavior: "event",
    valueShape: "event_description",
    memoryDomains: ["episodic"],
    isGeneric: true,
    relationType: "event",
    objectType: "dated_occurrence",
    examples: [
      "A recovery drill on 2026-08-07: first attempt failed, configuration adjusted, second attempt succeeded.",
    ],
  }),
] as const satisfies readonly PredicateDefinition[];

export type KnownPredicate = (typeof DEFAULT_PREDICATE_DEFINITIONS)[number]["id"];

export const DEFAULT_PREDICATE_REGISTRY = new PredicateRegistry(
  "predicate-registry:v1",
  DEFAULT_PREDICATE_DEFINITIONS,
);

export function predicateDefinition(id: string): PredicateDefinition | undefined {
  return DEFAULT_PREDICATE_REGISTRY.get(id);
}
