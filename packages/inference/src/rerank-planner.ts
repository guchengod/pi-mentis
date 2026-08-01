import { RerankBudgetExceededError } from "@pi-mentis/pi-mentis-core";

import type { RerankDocument } from "./contracts.js";

export interface TokenEstimator {
  count(text: string): number;
}

export class ConservativeUtf8TokenEstimator implements TokenEstimator {
  count(text: string): number {
    // A byte-based upper bound is conservative across known text tokenizers and
    // avoids treating JavaScript character count as a token count.
    return Math.max(1, Buffer.byteLength(text.normalize("NFKC"), "utf8"));
  }
}

export interface RerankBudget {
  readonly modelContextTokens: number;
  readonly reservedOutputTokens: number;
  readonly queryTokens: number;
  readonly instructionTokens: number;
  readonly protocolOverheadTokens: number;
  readonly availableDocumentTokens: number;
}

export interface RerankBatch {
  readonly documents: readonly RerankDocument[];
  readonly estimatedInputTokens: number;
}

export interface RerankBudgetOptions {
  readonly modelContextTokens: number;
  readonly reservedOutputTokens?: number;
  readonly protocolOverheadTokens?: number;
  readonly safetyMarginTokens?: number;
}

export function createRerankBudget(
  query: string,
  instruction: string | undefined,
  estimator: TokenEstimator,
  options: RerankBudgetOptions,
): RerankBudget {
  const queryTokens = estimator.count(query);
  const instructionTokens = instruction === undefined ? 0 : estimator.count(instruction);
  const reservedOutputTokens = options.reservedOutputTokens ?? 256;
  const protocolOverheadTokens = options.protocolOverheadTokens ?? 128;
  const safetyMarginTokens =
    options.safetyMarginTokens ?? Math.ceil(options.modelContextTokens * 0.05);
  const availableDocumentTokens =
    options.modelContextTokens -
    queryTokens -
    instructionTokens -
    protocolOverheadTokens -
    reservedOutputTokens -
    safetyMarginTokens;
  if (availableDocumentTokens <= 0) {
    throw new RerankBudgetExceededError(
      "Rerank query, instruction, protocol, and safety margin exceed the model context",
      { operation: "rerank-budget", retryable: false },
    );
  }
  return {
    modelContextTokens: options.modelContextTokens,
    reservedOutputTokens,
    queryTokens,
    instructionTokens,
    protocolOverheadTokens,
    availableDocumentTokens,
  };
}

function truncateAtParagraph(
  document: RerankDocument,
  maximumTokens: number,
  estimator: TokenEstimator,
): RerankDocument {
  const paragraphs = document.text.split(/\n{2,}/);
  const selected: string[] = [];
  let tokens = 0;
  for (const paragraph of paragraphs) {
    const paragraphTokens = estimator.count(paragraph);
    if (tokens + paragraphTokens > maximumTokens) break;
    selected.push(paragraph);
    tokens += paragraphTokens;
  }
  if (selected.length === 0) {
    throw new RerankBudgetExceededError(
      `Rerank document ${document.id} has no paragraph that fits the token budget`,
      { operation: "rerank-batch-plan", documentId: document.id, retryable: false },
    );
  }
  return { ...document, text: selected.join("\n\n"), tokenCount: tokens };
}

export function planRerankBatches(
  documents: readonly RerankDocument[],
  budget: RerankBudget,
  estimator: TokenEstimator,
): readonly RerankBatch[] {
  const batches: RerankBatch[] = [];
  let current: RerankDocument[] = [];
  let tokens = 0;
  for (const rawDocument of documents) {
    let document = rawDocument;
    let documentTokens = rawDocument.tokenCount ?? estimator.count(rawDocument.text);
    if (documentTokens > budget.availableDocumentTokens) {
      document = truncateAtParagraph(rawDocument, budget.availableDocumentTokens, estimator);
      documentTokens = document.tokenCount ?? estimator.count(document.text);
    }
    if (current.length > 0 && tokens + documentTokens > budget.availableDocumentTokens) {
      batches.push({
        documents: current,
        estimatedInputTokens:
          budget.queryTokens + budget.instructionTokens + budget.protocolOverheadTokens + tokens,
      });
      current = [];
      tokens = 0;
    }
    current.push(document);
    tokens += documentTokens;
  }
  if (current.length > 0) {
    batches.push({
      documents: current,
      estimatedInputTokens:
        budget.queryTokens + budget.instructionTokens + budget.protocolOverheadTokens + tokens,
    });
  }
  return batches;
}

export function normalizeBatchScores(
  batches: readonly (readonly { readonly documentId: string; readonly relevanceScore: number }[])[],
): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  for (const batch of batches) {
    if (batch.length === 0) continue;
    const values = batch.map((item) => item.relevanceScore);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const range = maximum - minimum;
    for (const item of batch) {
      scores.set(item.documentId, range === 0 ? 1 : (item.relevanceScore - minimum) / range);
    }
  }
  return scores;
}
