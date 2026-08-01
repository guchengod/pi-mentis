# Parsers

Detection priority is magic bytes, trusted MIME, extension, then conservative text
sniffing. Real parsers cover text, Markdown/MDX, JSON/JSONL, YAML, TOML, CSV, HTML, XML,
source code, PDF, DOCX, XLSX, PPTX, EPUB, ZIP, EML, and MBOX. Source resolution covers
files, directories, workspaces, Git trees, HTTPS URLs, Pi packages, Skills, and MCP
schemas. Archive limits prevent Zip Slip and expansion bombs; XML DTDs, private-network
URLs, symlink loops, oversized inputs, and binary disguise are rejected.

HTML URLs are resolved as ordered documentation collections when the site exposes an
explicit sidebar/table of contents, an mdBook-style `toc.js`/`toc.html`, sequential
`rel=next` chapter links, or a sitemap. Crawling remains on the same origin and within
the URL's documentation path, excludes assets/search/print pages, deduplicates canonical
URLs, and records `collectionUri`, `pageOrder`, `pageCount`, and discovery strategy on
every page. A collection is limited by `performance.resources.maxWebPages` (default
1,000) and `maxWebBytes` (default 512 MiB); non-HTML URLs and sites without a
discoverable collection remain single sources.

All parsers produce a shared AST. Structure-aware packing targets 420/650 tokens for
documents and preserves headings, pages, sheets, symbols, and stable semantic keys.
