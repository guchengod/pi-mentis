/**
 * A tokenizer-independent estimate for model-visible text.
 *
 * ASCII word runs are usually encoded at roughly four characters per token,
 * while non-ASCII code points and punctuation are counted individually. This
 * is intentionally an estimate: use {@link utf8TokenUpperBound} when exceeding
 * a provider context limit must be impossible.
 */
export function estimateModelTokens(text: string): number {
  const normalized = text.normalize("NFKC");
  let tokens = 0;
  let asciiWordLength = 0;
  const flushAsciiWord = (): void => {
    if (asciiWordLength === 0) return;
    tokens += Math.ceil(asciiWordLength / 4);
    asciiWordLength = 0;
  };

  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isAsciiWord =
      (codePoint >= 48 && codePoint <= 57) ||
      (codePoint >= 65 && codePoint <= 90) ||
      codePoint === 95 ||
      (codePoint >= 97 && codePoint <= 122);
    if (isAsciiWord) {
      asciiWordLength += 1;
      continue;
    }
    flushAsciiWord();
    const isCommonWhitespace =
      codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint === 32;
    if (!isCommonWhitespace && !/^\s$/u.test(character)) tokens += 1;
  }
  flushAsciiWord();
  return Math.max(1, tokens);
}

/** UTF-8 bytes used as a conservative tokenizer-independent safety bound. */
export function utf8TokenUpperBound(text: string): number {
  return Math.max(1, Buffer.byteLength(text.normalize("NFKC"), "utf8"));
}
