import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREDICATE_REGISTRY,
  PredicateRegistry,
  buildPredicateSemanticText,
  predicateDefinition,
} from "../src/predicate-registry.js";

const sample = {
  id: "sample_preference",
  description: "A sample preference.",
  retrievalDescription: "Relevant when the sample affects a decision.",
  subjectTypes: ["user" as const],
  valueType: "preference" as const,
  cardinality: "set" as const,
  temporalBehavior: "evolving" as const,
  memoryDomains: ["user" as const],
  examples: ["A semantic example."],
};

describe("PredicateRegistry", () => {
  it("registers definitions and exposes its schema version", () => {
    const registry = new PredicateRegistry("test:v1");
    registry.register(sample);
    expect(registry.schemaVersion).toBe("test:v1");
    expect(registry.get(sample.id)).toEqual(sample);
  });

  it("rejects duplicate predicate ids", () => {
    const registry = new PredicateRegistry("test:v1", [sample]);
    expect(() => registry.register(sample)).toThrow(/already registered/);
  });

  it("builds semantic text without creating matching rules", () => {
    const text = buildPredicateSemanticText(sample);
    expect(text).toContain(sample.description);
    expect(text).toContain(sample.retrievalDescription);
    expect(text).toContain("A semantic example.");
  });

  it("is the source of cardinality and retrieval metadata", () => {
    const definition = predicateDefinition("project_build_command");
    expect(definition?.cardinality).toBe("single");
    expect(definition?.valueType).toBe("command");
    expect(DEFAULT_PREDICATE_REGISTRY.list().length).toBeGreaterThan(30);
  });
});
