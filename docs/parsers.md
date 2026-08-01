# Parsers

Detection priority is magic bytes, trusted MIME, extension, then conservative text
sniffing. Real parsers cover text, Markdown/MDX, JSON/JSONL, YAML, TOML, CSV, HTML, XML,
source code, PDF, DOCX, XLSX, PPTX, EPUB, ZIP, EML, and MBOX. Source resolution covers
files, directories, workspaces, Git trees, HTTPS URLs, Pi packages, Skills, and MCP
schemas. Archive limits prevent Zip Slip and expansion bombs; XML DTDs, private-network
URLs, symlink loops, oversized inputs, and binary disguise are rejected.

All parsers produce a shared AST. Structure-aware packing targets 420/650 tokens for
documents and preserves headings, pages, sheets, symbols, and stable semantic keys.
