import path from "node:path";

import {
  UnsupportedKnowledgeSourceError,
  contentHash,
  sourceId,
  throwIfAborted,
  type ResourceLimits,
} from "@pi-mentis/pi-mentis-core";

import { detectMediaType } from "./detection.js";
import type { KnowledgeSourceRef, ParserInput } from "./types.js";

const HTML_DECODER = new TextDecoder("utf-8", { fatal: false });
const MAX_REDIRECTS = 5;
const NAVIGATION_MARKER =
  /(?:sidebar|table-of-contents|table_of_contents|toc\b|menu\b|navigation|book-summary|docs-nav|wiki-wrapper)/i;
const EXCLUDED_PATH =
  /(?:^|\/)(?:404|search|print)(?:\.html?)?\/?$|\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|json|map|mp3|mp4|ogg|otf|png|rss|svg|ttf|webmanifest|webp|woff2?|xml|zip)$/i;

export interface ResolvedWebInput {
  readonly source: KnowledgeSourceRef;
  readonly input: ParserInput;
  readonly fingerprint: string;
}

interface FetchedPage {
  readonly url: URL;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly html?: string;
}

interface DiscoveredPage {
  readonly url: URL;
  readonly title?: string;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_match, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function plainText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (["localhost", "::1", "0.0.0.0"].includes(normalized)) return true;
  if (/^(?:fc|fd|fe8|fe9|fea|feb)/i.test(normalized.replace(/^\[/, ""))) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (ipv4 === null) return normalized.endsWith(".local");
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function assertPublicHttpUrl(url: URL): void {
  if (!["http:", "https:"].includes(url.protocol) || isPrivateHostname(url.hostname)) {
    throw new UnsupportedKnowledgeSourceError(`URL source is not allowed: ${url.href}`, {
      operation: "url-resolve",
      retryable: false,
    });
  }
}

function normalizedUrl(rawUrl: string | URL, base?: URL): URL {
  const url = base === undefined ? new URL(rawUrl) : new URL(rawUrl, base);
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$)/i.test(name)) url.searchParams.delete(name);
  }
  return url;
}

async function fetchPage(
  rawUrl: string | URL,
  limits: ResourceLimits,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  let url = normalizedUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    throwIfAborted(signal, "url-resolve");
    assertPublicHttpUrl(url);
    const response = await fetch(url, {
      headers: {
        accept: "text/html, text/*, application/json, application/xml;q=0.9",
        "user-agent": "Pi-Mentis/0.1 (+https://github.com/guchengod/pi-mentis)",
      },
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (location === null) break;
      url = normalizedUrl(location, url);
      continue;
    }
    if (!response.ok) {
      throw new UnsupportedKnowledgeSourceError(
        `URL source returned HTTP ${response.status}: ${url.href}`,
        { operation: "url-resolve", retryable: response.status >= 500 },
      );
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > limits.maxFileBytes) {
      throw new UnsupportedKnowledgeSourceError("URL source exceeds the configured size limit", {
        operation: "url-resolve",
        retryable: false,
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limits.maxFileBytes) {
      throw new UnsupportedKnowledgeSourceError(
        `Source contains ${bytes.byteLength} bytes; limit is ${limits.maxFileBytes}`,
        { operation: "url-resolve", retryable: false },
      );
    }
    const finalUrl = normalizedUrl(response.url || url.href);
    assertPublicHttpUrl(finalUrl);
    const mediaType = detectMediaType(
      bytes,
      finalUrl.pathname,
      response.headers.get("content-type") ?? undefined,
    );
    return {
      url: finalUrl,
      bytes,
      mediaType,
      ...(mediaType === "text/html" ? { html: HTML_DECODER.decode(bytes) } : {}),
    };
  }
  throw new UnsupportedKnowledgeSourceError(`URL source redirected too many times: ${url.href}`, {
    operation: "url-resolve",
    retryable: false,
  });
}

function siteScope(seed: URL): string {
  const wiki = /^(.*\/wiki)(?:\/|$)/i.exec(seed.pathname);
  if (wiki?.[1] !== undefined) return `${wiki[1].replace(/\/$/, "")}/`;
  if (seed.pathname.endsWith("/")) return seed.pathname;
  return seed.pathname.slice(0, seed.pathname.lastIndexOf("/") + 1) || "/";
}

function isInScope(candidate: URL, seed: URL, scope: string): boolean {
  if (candidate.origin !== seed.origin || !candidate.pathname.startsWith(scope)) return false;
  if (EXCLUDED_PATH.test(candidate.pathname)) return false;
  return !/^(?:mailto|tel|javascript):/i.test(candidate.protocol);
}

function anchorLinks(markup: string, base: URL, scope: string): DiscoveredPage[] {
  const pages: DiscoveredPage[] = [];
  for (const match of markup.matchAll(
    /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi,
  )) {
    const href = decodeHtml(match[2] ?? "").trim();
    if (href === "" || href.startsWith("#")) continue;
    let url: URL;
    try {
      url = normalizedUrl(href, base);
    } catch {
      continue;
    }
    if (!isInScope(url, base, scope)) continue;
    const title = plainText(match[4] ?? "");
    pages.push({ url, ...(title === "" ? {} : { title }) });
  }
  return pages;
}

function navigationSections(html: string): string[] {
  const sections: string[] = [];
  for (const match of html.matchAll(/<(nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi)) {
    sections.push(match[0]);
  }
  if (NAVIGATION_MARKER.test(html)) {
    for (const match of html.matchAll(
      /<([a-z][\w:-]*)\b[^>]*(?:class|id|role)\s*=\s*["'][^"']*(?:sidebar|toc|menu|navigation|book-summary|wiki-wrapper)[^"']*["'][^>]*>/gi,
    )) {
      const start = match.index ?? 0;
      sections.push(html.slice(start, Math.min(html.length, start + 512 * 1024)));
    }
  }
  return sections;
}

function deduplicatePages(pages: readonly DiscoveredPage[]): DiscoveredPage[] {
  const seen = new Set<string>();
  const result: DiscoveredPage[] = [];
  for (const page of pages) {
    const key = page.url.href.replace(/\/(?:index\.html?)?$/i, "/");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(page);
  }
  return result;
}

function menuResourceUrls(html: string, base: URL): URL[] {
  const urls: URL[] = [];
  for (const match of html.matchAll(
    /<(?:script|iframe)\b[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi,
  )) {
    const value = match[1] ?? "";
    if (!/(?:^|\/)(?:toc|menu|summary|_sidebar)(?:\.min)?\.(?:js|html?)$/i.test(value)) continue;
    try {
      const url = normalizedUrl(decodeHtml(value), base);
      if (url.origin === base.origin) urls.push(url);
    } catch {
      // Ignore malformed optional navigation resources.
    }
  }
  return urls;
}

function nextPage(html: string, base: URL, scope: string): DiscoveredPage | undefined {
  for (const match of html.matchAll(/<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>/gi)) {
    const attributes = `${match[1] ?? ""} ${match[3] ?? ""}`;
    if (!/\brel\s*=\s*["'][^"']*\bnext\b/i.test(attributes)) continue;
    try {
      const url = normalizedUrl(decodeHtml(match[2] ?? ""), base);
      if (isInScope(url, base, scope)) return { url };
    } catch {
      // Ignore malformed next links.
    }
  }
  return undefined;
}

function pageTitle(html: string, fallback: string): string {
  const primary =
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    html;
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(primary)?.[1];
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return plainText(heading ?? title ?? fallback) || fallback;
}

async function discoverMenu(
  seed: FetchedPage,
  scope: string,
  limits: ResourceLimits,
  signal?: AbortSignal,
): Promise<DiscoveredPage[]> {
  if (seed.html === undefined) return [];
  const direct = navigationSections(seed.html).flatMap((section) =>
    anchorLinks(section, seed.url, scope),
  );
  const external: DiscoveredPage[] = [];
  for (const menuUrl of menuResourceUrls(seed.html, seed.url)) {
    try {
      const menu = await fetchPage(menuUrl, limits, signal);
      const markup = menu.html ?? HTML_DECODER.decode(menu.bytes);
      external.push(...anchorLinks(markup, seed.url, scope));
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
    }
  }
  return deduplicatePages(external.length > 1 ? external : direct);
}

async function discoverSitemap(
  seed: FetchedPage,
  scope: string,
  limits: ResourceLimits,
  signal?: AbortSignal,
): Promise<DiscoveredPage[]> {
  const pending = deduplicatePages([
    { url: new URL("/sitemap.xml", seed.url) },
    { url: new URL(`${scope}sitemap.xml`.replace(/\/{2,}/g, "/"), seed.url.origin) },
  ]);
  const visited = new Set<string>();
  const pages: DiscoveredPage[] = [];
  let sitemapBytes = 0;
  while (pending.length > 0 && visited.size < 32) {
    const candidate = pending.shift();
    if (candidate === undefined || visited.has(candidate.url.href)) continue;
    visited.add(candidate.url.href);
    try {
      const sitemap = await fetchPage(candidate.url, limits, signal);
      sitemapBytes += sitemap.bytes.byteLength;
      if (sitemapBytes > limits.maxWebBytes) return [];
      const xml = HTML_DECODER.decode(sitemap.bytes);
      for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
        try {
          const url = normalizedUrl(decodeHtml(match[1] ?? ""), seed.url);
          if (url.origin !== seed.url.origin) continue;
          if (/\.xml$/i.test(url.pathname)) {
            if (!visited.has(url.href)) pending.push({ url });
          } else if (isInScope(url, seed.url, scope)) {
            pages.push({ url });
          }
        } catch {
          // Ignore malformed sitemap entries.
        }
      }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
    }
  }
  return deduplicatePages(pages);
}

function resolvedInput(
  page: FetchedPage,
  namespace: string,
  collectionUri: string,
  order: number,
  total: number,
  discovery: string,
  discoveredTitle?: string,
): ResolvedWebInput {
  const canonicalUri = page.url.href;
  const attributes = {
    collectionUri,
    pageOrder: order + 1,
    pageCount: total,
    discovery,
  };
  const source = {
    id: sourceId(namespace, canonicalUri),
    canonicalUri,
    namespace,
    attributes,
  };
  const filename = path.posix.basename(page.url.pathname) || page.url.hostname;
  return {
    source,
    input: {
      source,
      filename,
      mediaType: page.mediaType,
      bytes: page.bytes,
      ...(discoveredTitle === undefined
        ? page.html === undefined
          ? {}
          : { title: pageTitle(page.html, filename) }
        : { title: discoveredTitle }),
      attributes,
    },
    fingerprint: contentHash(page.bytes),
  };
}

export async function* resolveWebSource(
  rawUrl: string,
  namespace: string,
  limits: ResourceLimits,
  signal?: AbortSignal,
): AsyncIterable<ResolvedWebInput> {
  const seed = await fetchPage(rawUrl, limits, signal);
  if (seed.html === undefined) {
    yield resolvedInput(seed, namespace, seed.url.href, 0, 1, "single-page");
    return;
  }

  const scope = siteScope(seed.url);
  let pages = await discoverMenu(seed, scope, limits, signal);
  let discovery = "menu";
  const fetched = new Map<string, FetchedPage>([[seed.url.href, seed]]);

  if (pages.length <= 1) {
    const chain: DiscoveredPage[] = [{ url: seed.url }];
    const seen = new Set<string>([seed.url.href]);
    let current = seed;
    while (current.html !== undefined && chain.length < limits.maxWebPages) {
      const next = nextPage(current.html, current.url, scope);
      if (next === undefined || seen.has(next.url.href)) break;
      seen.add(next.url.href);
      const fetchedNext = await fetchPage(next.url, limits, signal);
      fetched.set(fetchedNext.url.href, fetchedNext);
      chain.push({ url: fetchedNext.url });
      current = fetchedNext;
    }
    if (
      chain.length === limits.maxWebPages &&
      current.html !== undefined &&
      nextPage(current.html, current.url, scope) !== undefined
    ) {
      throw new UnsupportedKnowledgeSourceError(
        `Website exposes more than ${limits.maxWebPages} sequential pages`,
        { operation: "url-crawl", retryable: false },
      );
    }
    if (chain.length > 1) {
      pages = chain;
      discovery = "next-chain";
    } else {
      const sitemap = await discoverSitemap(seed, scope, limits, signal);
      pages = sitemap.length > 1 ? sitemap : chain;
      discovery = sitemap.length > 1 ? "sitemap" : "single-page";
    }
  }

  pages = deduplicatePages(pages);
  if (pages.length > limits.maxWebPages) {
    throw new UnsupportedKnowledgeSourceError(
      `Website exposes ${pages.length} pages; limit is ${limits.maxWebPages}`,
      { operation: "url-crawl", retryable: false },
    );
  }

  let expandedBytes = 0;
  for (const [order, page] of pages.entries()) {
    throwIfAborted(signal, "url-crawl");
    const document = fetched.get(page.url.href) ?? (await fetchPage(page.url, limits, signal));
    expandedBytes += document.bytes.byteLength;
    if (expandedBytes > limits.maxWebBytes) {
      throw new UnsupportedKnowledgeSourceError(
        `Website content exceeds the configured size limit of ${limits.maxWebBytes} bytes`,
        { operation: "url-crawl", retryable: false },
      );
    }
    yield resolvedInput(
      document,
      namespace,
      seed.url.href,
      order,
      pages.length,
      discovery,
      page.title,
    );
  }
}
