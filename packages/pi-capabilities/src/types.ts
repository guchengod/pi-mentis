import type { OperationOptions, SourceLocation } from "@pi-mentis/pi-mentis-core";

export interface JsonSchema {
  readonly [key: string]: unknown;
}

export interface CapabilityRequirement {
  readonly name: string;
  readonly description: string;
}

export interface CapabilityExample {
  readonly description: string;
  readonly code?: string;
}

export interface CapabilityRecord {
  readonly id: string;
  readonly kind:
    | "pi-api"
    | "event"
    | "tool"
    | "command"
    | "extension"
    | "skill"
    | "mcp-tool"
    | "prompt-template";
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly requirements: readonly CapabilityRequirement[];
  readonly constraints: readonly string[];
  readonly examples: readonly CapabilityExample[];
  readonly packageName: string;
  readonly packageVersion: "0.83.0" | string;
  readonly installed: boolean;
  readonly sourceRefs: readonly SourceLocation[];
}

export interface CapabilityRequest {
  readonly goal: string;
  readonly constraints?: readonly string[];
}

export interface CapabilityPlan {
  readonly reusable: readonly CapabilityRecord[];
  readonly partial: readonly CapabilityRecord[];
  readonly gaps: readonly string[];
  readonly recommendation: "skill" | "extension" | "mcp" | "combination" | "reuse";
  readonly implementationConstraints: readonly string[];
  readonly validationPlan: readonly string[];
}

export interface CapabilityPlanner {
  analyze(request: CapabilityRequest, options?: OperationOptions): Promise<CapabilityPlan>;
}
