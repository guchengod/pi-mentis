import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultConfig } from "@pi-mentis/pi-mentis-core";

import { resolveWebSource } from "../src/web-source.js";

const limits = createDefaultConfig(process.cwd()).performance.resources;

function htmlResponse(html: string, url: string): Response {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "x-test-url": url },
  });
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

async function collect(url: string) {
  const values = [];
  for await (const value of resolveWebSource(url, "test", limits)) values.push(value);
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ordered website source resolution", () => {
  it("uses an external mdBook table of contents in its declared order", async () => {
    const documents = new Map<string, string>([
      [
        "https://docs.example.test/book/",
        '<html><head><script src="toc.js"></script></head><body><main>Landing</main></body></html>',
      ],
      [
        "https://docs.example.test/book/toc.js",
        `this.innerHTML = '<ol><li><a href="preface.html">Preface</a></li><li><a href="ch01.html">1. Start</a></li><li><a href="ch02.html">2. Finish</a></li></ol>';`,
      ],
      [
        "https://docs.example.test/book/preface.html",
        "<html><body><main><h1>Preface</h1><p>Welcome.</p></main></body></html>",
      ],
      [
        "https://docs.example.test/book/ch01.html",
        "<html><body><main><h1>Start</h1><p>Chapter one.</p></main></body></html>",
      ],
      [
        "https://docs.example.test/book/ch02.html",
        "<html><body><main><h1>Finish</h1><p>Chapter two.</p></main></body></html>",
      ],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        const body = documents.get(url);
        if (body === undefined) return new Response("missing", { status: 404 });
        return url.endsWith("toc.js")
          ? new Response(body, { status: 200, headers: { "content-type": "text/javascript" } })
          : htmlResponse(body, url);
      }),
    );

    const pages = await collect("https://docs.example.test/book/");

    expect(pages.map((page) => page.source.canonicalUri)).toEqual([
      "https://docs.example.test/book/preface.html",
      "https://docs.example.test/book/ch01.html",
      "https://docs.example.test/book/ch02.html",
    ]);
    expect(pages.map((page) => page.input.title)).toEqual(["Preface", "1. Start", "2. Finish"]);
    expect(pages.map((page) => page.source.attributes?.["pageOrder"])).toEqual([1, 2, 3]);
    expect(pages[0]?.source.attributes).toMatchObject({
      collectionUri: "https://docs.example.test/book/",
      pageCount: 3,
      discovery: "menu",
    });
  });

  it("follows rel=next chapters when the sidebar is not rendered", async () => {
    const documents = new Map<string, string>([
      [
        "https://book.example.test/guide/",
        '<main><h1>One</h1></main><a rel="next" href="two.html">Next</a>',
      ],
      [
        "https://book.example.test/guide/two.html",
        '<main><h1>Two</h1></main><a href="three.html" rel="next prefetch">Next</a>',
      ],
      ["https://book.example.test/guide/three.html", "<main><h1>Three</h1></main>"],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        const body = documents.get(url);
        return body === undefined
          ? new Response("missing", { status: 404 })
          : htmlResponse(body, url);
      }),
    );

    const pages = await collect("https://book.example.test/guide/");

    expect(pages.map((page) => page.input.title)).toEqual(["One", "Two", "Three"]);
    expect(pages.every((page) => page.source.attributes?.["discovery"] === "next-chain")).toBe(
      true,
    );
  });

  it("keeps sidebar crawling in the original origin and documentation path", async () => {
    const seed = `
      <aside class="docs-sidebar"><a href="intro.html">Intro</a>
      <a href="chapter.html#part">Chapter</a>
      <a href="/other/private.html">Other product</a>
      <a href="https://elsewhere.example/page.html">External</a>
      <a href="assets/app.js">Asset</a></aside>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url === "https://docs.example.test/manual/") return htmlResponse(seed, url);
        if (url.endsWith("intro.html")) return htmlResponse("<main><h1>Intro</h1></main>", url);
        if (url.endsWith("chapter.html")) return htmlResponse("<main><h1>Chapter</h1></main>", url);
        return new Response("missing", { status: 404 });
      }),
    );

    const pages = await collect("https://docs.example.test/manual/");

    expect(pages.map((page) => page.source.canonicalUri)).toEqual([
      "https://docs.example.test/manual/intro.html",
      "https://docs.example.test/manual/chapter.html",
    ]);
  });

  it("expands sitemap indexes while preserving sitemap and page order", async () => {
    const documents = new Map<string, { body: string; type: string }>([
      [
        "https://wiki.example.test/guide/",
        { body: "<main><h1>Guide</h1></main>", type: "text/html" },
      ],
      [
        "https://wiki.example.test/sitemap.xml",
        {
          body: `<sitemapindex><sitemap><loc>https://wiki.example.test/guide/part-1.xml</loc></sitemap><sitemap><loc>https://wiki.example.test/guide/part-2.xml</loc></sitemap></sitemapindex>`,
          type: "application/xml",
        },
      ],
      [
        "https://wiki.example.test/guide/part-1.xml",
        {
          body: `<urlset><url><loc>https://wiki.example.test/guide/intro</loc></url><url><loc>https://wiki.example.test/guide/setup</loc></url></urlset>`,
          type: "application/xml",
        },
      ],
      [
        "https://wiki.example.test/guide/part-2.xml",
        {
          body: `<urlset><url><loc>https://wiki.example.test/guide/reference</loc></url></urlset>`,
          type: "application/xml",
        },
      ],
      [
        "https://wiki.example.test/guide/intro",
        { body: "<main><h1>Intro</h1></main>", type: "text/html" },
      ],
      [
        "https://wiki.example.test/guide/setup",
        { body: "<main><h1>Setup</h1></main>", type: "text/html" },
      ],
      [
        "https://wiki.example.test/guide/reference",
        { body: "<main><h1>Reference</h1></main>", type: "text/html" },
      ],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const document = documents.get(requestUrl(input));
        return document === undefined
          ? new Response("missing", { status: 404 })
          : new Response(document.body, {
              status: 200,
              headers: { "content-type": document.type },
            });
      }),
    );

    const pages = await collect("https://wiki.example.test/guide/");

    expect(pages.map((page) => page.source.canonicalUri)).toEqual([
      "https://wiki.example.test/guide/intro",
      "https://wiki.example.test/guide/setup",
      "https://wiki.example.test/guide/reference",
    ]);
    expect(pages.every((page) => page.source.attributes?.["discovery"] === "sitemap")).toBe(true);
  });

  it("rejects private-network sources before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect("http://127.0.0.1/private")).rejects.toMatchObject({
      code: "UNSUPPORTED_KNOWLEDGE_SOURCE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
