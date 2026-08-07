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
}

export interface PredicateRegistrySnapshot {
  readonly schemaVersion: string;
  readonly definitions: readonly PredicateDefinition[];
}

export function buildPredicateSemanticText(definition: PredicateDefinition): string {
  return [
    definition.id,
    definition.description,
    definition.retrievalDescription,
    ...(definition.examples ?? []),
  ].join("\n");
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
  }),
  definition({
    id: "user_name",
    description: "The user's name or preferred form of address.",
    retrievalDescription: "Relevant when identifying or addressing the current user.",
    subjectTypes: USER,
    valueType: "string",
    cardinality: "single",
    temporalBehavior: "current",
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
    examples: [
      "Prefer simple direct implementations and avoid unnecessary abstraction.",
      "Follow my usual coding habits when designing this module.",
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
