import type { ComponentVersion, ResourceLimits, SourceLocation } from "@pi-mentis/pi-mentis-core";

export interface KnowledgeSourceRef {
  readonly id: string;
  readonly canonicalUri: string;
  readonly namespace: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface DocumentMetadata {
  readonly title: string;
  readonly mediaType: string;
  readonly language?: string;
  readonly authors?: readonly string[];
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

interface BaseNode {
  readonly location?: SourceLocation;
}

export interface HeadingNode extends BaseNode {
  readonly type: "heading";
  readonly level: number;
  readonly text: string;
}

export interface ParagraphNode extends BaseNode {
  readonly type: "paragraph";
  readonly text: string;
}

export interface CodeBlockNode extends BaseNode {
  readonly type: "code";
  readonly language?: string;
  readonly text: string;
}

export interface SymbolNode extends BaseNode {
  readonly type: "symbol";
  readonly name: string;
  readonly kind: string;
  readonly text: string;
}

export interface TableNode extends BaseNode {
  readonly type: "table";
  readonly rows: readonly (readonly string[])[];
  readonly sheet?: string;
}

export interface ListNode extends BaseNode {
  readonly type: "list";
  readonly items: readonly string[];
}

export interface QuoteNode extends BaseNode {
  readonly type: "quote";
  readonly text: string;
}

export interface ImageNode extends BaseNode {
  readonly type: "image";
  readonly alt: string;
  readonly source?: string;
}

export interface LinkNode extends BaseNode {
  readonly type: "link";
  readonly text: string;
  readonly href: string;
}

export interface MetadataNode extends BaseNode {
  readonly type: "metadata";
  readonly key: string;
  readonly value: string;
}

export type DocumentNode =
  | HeadingNode
  | ParagraphNode
  | CodeBlockNode
  | SymbolNode
  | TableNode
  | ListNode
  | QuoteNode
  | ImageNode
  | LinkNode
  | MetadataNode;

export interface StructuredDocument {
  readonly id: string;
  readonly source: KnowledgeSourceRef;
  readonly metadata: DocumentMetadata;
  readonly nodes: readonly DocumentNode[];
}

export interface SourceProbe {
  readonly canonicalUri: string;
  readonly filename?: string;
  readonly extension?: string;
  readonly mediaType?: string;
  readonly magic: Uint8Array;
}

export interface ParserInput {
  readonly source: KnowledgeSourceRef;
  readonly filename?: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly title?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface ParserOptions {
  readonly limits: ResourceLimits;
  readonly signal?: AbortSignal;
}

export type ParsedDocumentEvent =
  | { readonly type: "document"; readonly document: StructuredDocument }
  | {
      readonly type: "progress";
      readonly completed: number;
      readonly total?: number;
      readonly phase: string;
    }
  | { readonly type: "diagnostic"; readonly code: string; readonly message: string };

export interface KnowledgeParser<TOptions extends ParserOptions = ParserOptions> {
  readonly id: string;
  readonly version: string;
  readonly priority: number;
  readonly cost: "light" | "io-heavy" | "cpu-heavy" | "external";
  supports(probe: SourceProbe): boolean | Promise<boolean>;
  parse(input: ParserInput, options: TOptions): AsyncIterable<ParsedDocumentEvent>;
}

export interface ParserSelection {
  readonly parser: KnowledgeParser;
  readonly component: ComponentVersion;
}

export interface KnowledgeChunkDraft {
  readonly semanticKey: string;
  readonly text: string;
  readonly searchableText: string;
  readonly ordinal: number;
  readonly headingPath: readonly string[];
  readonly tokenCount: number;
  readonly location?: SourceLocation;
  readonly symbol?: { readonly name: string; readonly kind: string };
}
