import { ArchiveParser } from "./archive-parser.js";
import { MailParser } from "./mail-parser.js";
import { PdfParser } from "./pdf-parser.js";
import { ParserRegistry } from "./registry.js";
import { TextParser } from "./text-parser.js";

export * from "./archive-parser.js";
export * from "./chunker.js";
export * from "./detection.js";
export * from "./mail-parser.js";
export * from "./pdf-parser.js";
export * from "./registry.js";
export * from "./source.js";
export * from "./text-parser.js";
export * from "./types.js";
export * from "./web-source.js";

export function createDefaultParserRegistry(): ParserRegistry {
  const registry = new ParserRegistry();
  registry.register(new PdfParser());
  registry.register(new ArchiveParser());
  registry.register(new MailParser());
  registry.register(new TextParser());
  return registry;
}
