import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".html",
  ".htm",
  ".xml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".py",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".css",
  ".scss",
  ".sql",
  ".sh",
]);

export function extensionOf(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  const extension = path.extname(filename).toLowerCase();
  return extension === "" ? undefined : extension;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function detectMediaType(
  bytes: Uint8Array,
  filename?: string,
  trustedMediaType?: string,
): string {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const extension = extensionOf(filename);
    if (extension === ".docx")
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (extension === ".xlsx")
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (extension === ".pptx")
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    if (extension === ".epub") return "application/epub+zip";
    return "application/zip";
  }
  if (trustedMediaType !== undefined && trustedMediaType !== "application/octet-stream") {
    return trustedMediaType.split(";")[0]?.trim().toLowerCase() ?? trustedMediaType;
  }
  const extension = extensionOf(filename);
  const extensionTypes: Readonly<Record<string, string>> = {
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".toml": "application/toml",
    ".csv": "text/csv",
    ".html": "text/html",
    ".htm": "text/html",
    ".xml": "application/xml",
    ".eml": "message/rfc822",
    ".mbox": "application/mbox",
  };
  if (extension !== undefined && extensionTypes[extension] !== undefined) {
    return extensionTypes[extension];
  }
  if (extension !== undefined && TEXT_EXTENSIONS.has(extension)) {
    return extension === ".md" || extension === ".mdx" ? "text/markdown" : "text/plain";
  }
  const prefix = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 512))
    .trimStart();
  if (prefix.startsWith("{") || prefix.startsWith("[")) return "application/json";
  if (prefix.startsWith("<!DOCTYPE html") || /^<html[\s>]/i.test(prefix)) return "text/html";
  if (prefix.startsWith("<?xml")) return "application/xml";
  const binary = bytes.subarray(0, 8_192).some((byte) => byte === 0);
  return binary ? "application/octet-stream" : "text/plain";
}
