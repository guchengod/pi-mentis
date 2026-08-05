import type {
  ComponentVersion,
  EvidenceAuthority,
  JobReceipt,
  OperationOptions,
  SearchResult,
  SourceLocation,
} from "@pi-mentis/pi-mentis-core";
import type { EmbeddingSpaceIdentity } from "@pi-mentis/pi-mentis-inference";
import type { KnowledgeSourceInput } from "@pi-mentis/pi-mentis-file-parsers";

export interface KnowledgeSecurityScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly agentId: string;
}

export interface KnowledgeSource {
  readonly id: string;
  readonly kind: KnowledgeSourceInput["kind"];
  readonly canonicalUri: string;
  readonly namespace: string;
  readonly authority: EvidenceAuthority;
  readonly state: "active" | "syncing" | "partial" | "failed" | "removed";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly fingerprint: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface KnowledgeDocument {
  readonly id: string;
  readonly sourceId: string;
  readonly canonicalUri: string;
  readonly title: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly metadataHash: string;
  readonly parser: ComponentVersion;
  readonly chunker: ComponentVersion;
  readonly embeddingSpace: EmbeddingSpaceIdentity;
  readonly revision: number;
  readonly activeRevision: number;
  readonly status: "preparing" | "active" | "stale" | "failed" | "tombstoned";
  readonly indexedAt: number;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface CodeSymbolRef {
  readonly name: string;
  readonly kind: string;
}

export interface KnowledgeChunk {
  readonly id: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly canonicalUri: string;
  readonly semanticKey: string;
  readonly text: string;
  readonly searchableText: string;
  readonly embeddingSpaceId: string;
  readonly embedding: Float32Array;
  readonly revision: number;
  readonly ordinal: number;
  readonly headingPath: readonly string[];
  readonly tokenCount: number;
  readonly contentHash: string;
  readonly location?: SourceLocation;
  readonly symbol?: CodeSymbolRef;
  readonly authority: EvidenceAuthority;
  readonly namespace: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sourceAttributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface IngestKnowledgeCommand {
  readonly source: KnowledgeSourceInput;
  readonly namespace?: string;
  readonly authority?: EvidenceAuthority;
  readonly scopeContext?: KnowledgeSecurityScope;
}

export interface IngestKnowledgeResult {
  readonly sourceIds: readonly string[];
  readonly documentIds: readonly string[];
  readonly chunkCount: number;
  readonly unchanged: number;
  readonly diagnostics: readonly string[];
}

export interface KnowledgeQuery {
  readonly text: string;
  readonly namespace?: string;
  readonly limit?: number;
  readonly scopeContext?: KnowledgeSecurityScope;
}

export interface SearchOptions extends OperationOptions {
  readonly timeoutMs?: number;
  readonly includeVector?: boolean;
}

export type KnowledgeSearchResult = SearchResult;

export interface RemoveKnowledgeCommand {
  readonly sourceId: string;
  readonly scopeContext: KnowledgeSecurityScope;
}

export interface RemoveKnowledgeResult {
  readonly sourceId: string;
  readonly removedChunks: number;
}

export interface SyncKnowledgeSourceCommand {
  readonly source: KnowledgeSourceInput;
  readonly namespace?: string;
  readonly scopeContext?: KnowledgeSecurityScope;
}

export interface EnqueueOptions extends OperationOptions {
  readonly priority?: "user" | "background";
  readonly onDone?: (result: IngestKnowledgeResult | Error) => void;
}

export interface InspectKnowledgeQuery {
  readonly documentId: string;
  readonly scopeContext: KnowledgeSecurityScope;
}

export interface KnowledgeDocumentView {
  readonly document: KnowledgeDocument;
  readonly chunks: readonly Omit<KnowledgeChunk, "embedding">[];
}

export interface KnowledgeCapabilities {
  readonly sourceKinds: readonly KnowledgeSourceInput["kind"][];
  readonly mediaTypes: readonly string[];
  readonly supportsIncrementalSync: true;
  readonly supportsEmbeddingMigration: true;
}

export interface KnowledgeJobRecoveryResult {
  readonly inspected: number;
  readonly recovered: number;
  readonly dead: number;
  readonly invalid: number;
}

export interface KnowledgeService {
  ingest(
    command: IngestKnowledgeCommand,
    options?: OperationOptions,
  ): Promise<IngestKnowledgeResult>;
  enqueueIngest(command: IngestKnowledgeCommand, options?: EnqueueOptions): Promise<JobReceipt>;
  search(query: KnowledgeQuery, options?: SearchOptions): Promise<KnowledgeSearchResult>;
  remove(
    command: RemoveKnowledgeCommand,
    options?: OperationOptions,
  ): Promise<RemoveKnowledgeResult>;
  sync(command: SyncKnowledgeSourceCommand, options?: EnqueueOptions): Promise<JobReceipt>;
  inspect(query: InspectKnowledgeQuery): Promise<KnowledgeDocumentView | undefined>;
  recoverJobs(options?: OperationOptions): Promise<KnowledgeJobRecoveryResult>;
  capabilities(): KnowledgeCapabilities;
}
