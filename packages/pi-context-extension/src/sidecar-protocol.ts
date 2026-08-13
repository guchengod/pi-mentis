import type { MentisContextSnapshot, SearchHit } from "@pi-mentis/pi-mentis-core";
import type {
  PiScopeContext,
  ToolResultEnvelope,
  OffloadedToolResult,
} from "@pi-mentis/pi-mentis-memory-core";
export type { PiScopeContext } from "@pi-mentis/pi-mentis-memory-core";
import type {
  PublicRecallResult,
  PublicRememberResult,
} from "@pi-mentis/pi-mentis-pi-extension-support";

export const SIDECAR_PROTOCOL_VERSION = 1 as const;

export type ToolResultEnvelopeMetadata = Omit<ToolResultEnvelope, "text">;

export interface MemoryCapsuleEntry {
  readonly id: string;
  readonly text: string;
  readonly kind: SearchHit["kind"] | "profile";
  readonly authority: number;
  readonly scopeKind?: string;
  readonly updatedAt?: number;
  readonly terms: readonly string[];
}

export interface MemoryCapsule {
  readonly protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly revision: number;
  readonly generatedAt: number;
  readonly entries: readonly MemoryCapsuleEntry[];
}

export type SidecarRequest =
  | {
      readonly method: "initialize";
      readonly params: { readonly cwd: string; readonly piPackageRoot: string };
    }
  | {
      readonly method: "session.open";
      readonly params: {
        readonly clientSessionId: string;
        readonly cwd: string;
        readonly branchId: string;
        readonly parentBranchId?: string;
        readonly sessionMode: MentisContextSnapshot["conversation"]["sessionMode"];
      };
    }
  | {
      readonly method: "memory.remember";
      readonly params: {
        readonly clientSessionId: string;
        readonly content: string;
        readonly scopeContext: PiScopeContext;
        readonly contextSnapshot?: MentisContextSnapshot;
        readonly relationshipCandidateIds?: readonly string[];
      };
    }
  | {
      readonly method: "memory.recall";
      readonly params: {
        readonly clientSessionId: string;
        readonly request: { readonly query?: string; readonly id?: string };
        readonly scopeContext: PiScopeContext;
        readonly contextSnapshot?: MentisContextSnapshot;
      };
    }
  | {
      readonly method: "capture.toolResult";
      readonly params: {
        readonly clientSessionId: string;
        readonly envelope: ToolResultEnvelope;
      };
    }
  | {
      readonly method: "capture.toolResultSpool";
      readonly params: {
        readonly clientSessionId: string;
        readonly envelope: ToolResultEnvelopeMetadata;
        readonly spoolId: string;
      };
    }
  | {
      readonly method: "knowledge.command";
      readonly params: {
        readonly clientSessionId: string;
        readonly action: string;
        readonly arguments: readonly string[];
        readonly cwd: string;
      };
    }
  | { readonly method: "status"; readonly params: { readonly clientSessionId?: string } }
  | { readonly method: "shutdown"; readonly params: Record<string, never> };

export type SidecarNotification =
  | {
      readonly method: "session.branch";
      readonly params: {
        readonly clientSessionId: string;
        readonly branchId: string;
        readonly parentBranchId?: string;
      };
    }
  | {
      readonly method: "capture.start";
      readonly params: {
        readonly clientSessionId: string;
        readonly goal: string;
        readonly scope: PiScopeContext;
      };
    }
  | {
      readonly method: "capture.steer";
      readonly params: { readonly clientSessionId: string; readonly goal: string };
    }
  | {
      readonly method: "capture.toolStarted";
      readonly params: {
        readonly clientSessionId: string;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly input: Readonly<Record<string, unknown>>;
      };
    }
  | {
      readonly method: "capture.toolResult";
      readonly params: {
        readonly clientSessionId: string;
        readonly envelope: ToolResultEnvelope;
      };
    }
  | {
      readonly method: "capture.toolResults";
      readonly params: {
        readonly clientSessionId: string;
        readonly envelopes: readonly ToolResultEnvelope[];
      };
    }
  | {
      readonly method: "capture.compact";
      readonly params: {
        readonly clientSessionId: string;
        readonly summary: string;
        readonly reason: "manual" | "threshold" | "overflow";
        readonly willRetry: boolean;
      };
    }
  | {
      readonly method: "agent.settled";
      readonly params: {
        readonly clientSessionId: string;
        readonly prompt: string;
        readonly scopeContext: PiScopeContext;
      };
    }
  | {
      readonly method: "input.activity";
      readonly params: { readonly clientSessionId: string };
    }
  | {
      readonly method: "session.close";
      readonly params: { readonly clientSessionId: string };
    }
  | {
      readonly method: "reason.response";
      readonly params: {
        readonly requestId: string;
        readonly result?: unknown;
        readonly error?: string;
      };
    }
  | { readonly method: "shutdown"; readonly params: Record<string, never> };

export interface SidecarRequestMessage {
  readonly type: "request";
  readonly id: string;
  readonly protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  readonly request: SidecarRequest;
}

export interface SidecarNotificationMessage {
  readonly type: "notification";
  readonly protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  readonly notification: SidecarNotification;
}

export interface SidecarResponseMessage {
  readonly type: "response";
  readonly id: string;
  readonly protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  readonly result?: unknown;
  readonly error?: string;
}

export interface SidecarEventMessage {
  readonly type: "event";
  readonly protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  readonly event:
    | { readonly name: "ready"; readonly version: string }
    | { readonly name: "capsule.updated"; readonly capsule: MemoryCapsule }
    | {
        readonly name: "context.updated";
        readonly clientSessionId: string;
        readonly scopeContext: PiScopeContext;
      }
    | {
        readonly name: "reason.request";
        readonly requestId: string;
        readonly incomingContent: string;
        readonly candidate: {
          readonly id: string;
          readonly content: string;
          readonly status: "current" | "historical" | "conflicted";
          readonly match: "exact" | "profile" | "view" | "lexical" | "semantic" | "anchored";
        };
      }
    | { readonly name: "warning"; readonly message: string };
}

export type SidecarInboundMessage = SidecarResponseMessage | SidecarEventMessage;
export type SidecarOutboundMessage = SidecarRequestMessage | SidecarNotificationMessage;

export interface SessionOpenResult {
  readonly scopeContext: PiScopeContext;
  readonly capsule?: MemoryCapsule;
}

export type SidecarMethodResult<M extends SidecarRequest["method"]> = M extends "initialize"
  ? { readonly ready: true; readonly protocolVersion: 1 }
  : M extends "session.open"
    ? SessionOpenResult
    : M extends "memory.remember"
      ? PublicRememberResult
      : M extends "memory.recall"
        ? PublicRecallResult
        : M extends "capture.toolResult" | "capture.toolResultSpool"
          ? OffloadedToolResult | undefined
          : unknown;
