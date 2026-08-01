import { AmbiguousParserError, UnsupportedKnowledgeSourceError } from "@pi-mentis/pi-mentis-core";

import type { KnowledgeParser, ParserSelection, SourceProbe } from "./types.js";

export class ParserRegistry {
  readonly #parsers: KnowledgeParser[] = [];

  register(parser: KnowledgeParser): () => void {
    if (this.#parsers.some((existing) => existing.id === parser.id)) {
      throw new Error(`Parser ${parser.id} is already registered`);
    }
    this.#parsers.push(parser);
    return () => {
      const index = this.#parsers.indexOf(parser);
      if (index >= 0) this.#parsers.splice(index, 1);
    };
  }

  async select(probe: SourceProbe): Promise<ParserSelection> {
    const matches: KnowledgeParser[] = [];
    for (const parser of this.#parsers) {
      if (await parser.supports(probe)) matches.push(parser);
    }
    if (matches.length === 0) {
      throw new UnsupportedKnowledgeSourceError(
        `No parser supports ${probe.mediaType ?? probe.filename ?? probe.canonicalUri}`,
        { operation: "parser-select", retryable: false },
      );
    }
    matches.sort((left, right) => right.priority - left.priority);
    const winner = matches[0];
    const second = matches[1];
    if (winner === undefined) throw new Error("Parser selection invariant failed");
    if (second !== undefined && winner.priority === second.priority) {
      throw new AmbiguousParserError(
        `Parsers ${winner.id} and ${second.id} have equal priority for ${probe.canonicalUri}`,
        { operation: "parser-select", retryable: false },
      );
    }
    return {
      parser: winner,
      component: { id: winner.id, version: winner.version },
    };
  }

  list(): readonly KnowledgeParser[] {
    return [...this.#parsers].sort((left, right) => right.priority - left.priority);
  }
}
