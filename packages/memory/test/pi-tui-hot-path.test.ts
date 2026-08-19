import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function eventHandler(
  sourceFile: ts.SourceFile,
  extensionPath: string,
  eventName: string,
): ts.ArrowFunction {
  let handler: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "on" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === eventName &&
      node.arguments[1] !== undefined &&
      ts.isArrowFunction(node.arguments[1])
    ) {
      handler = node.arguments[1];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (handler === undefined)
    throw new Error(`${eventName} handler was not found in ${extensionPath}`);
  return handler;
}

function beforeAgentStartHandler(
  sourceFile: ts.SourceFile,
  extensionPath: string,
): ts.ArrowFunction {
  return eventHandler(sourceFile, extensionPath, "before_agent_start");
}

describe("Pi TUI foreground path", () => {
  it("keeps before_agent_start free of foreground awaits", () => {
    const filename = fileURLToPath(
      new URL("../../pi-memory-extension/src/index.ts", import.meta.url),
    );
    const sourceFile = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const handler = beforeAgentStartHandler(sourceFile, filename);
    let foregroundAwait = false;
    const inspect = (node: ts.Node): void => {
      if (node !== handler && ts.isFunctionLike(node)) return;
      if (ts.isAwaitExpression(node)) foregroundAwait = true;
      ts.forEachChild(node, inspect);
    };
    inspect(handler.body);

    expect(
      handler.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
    ).toBe(false);
    expect(foregroundAwait).toBe(false);
  });

  it("keeps integrated automatic recall synchronous and capsule-only", () => {
    const filename = fileURLToPath(
      new URL("../../pi-context-extension/src/index.ts", import.meta.url),
    );
    const sourceFile = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const handler = beforeAgentStartHandler(sourceFile, filename);
    const foreground = handler.body.getText(sourceFile);
    let foregroundAwait = false;
    const inspect = (node: ts.Node): void => {
      if (node !== handler && ts.isFunctionLike(node)) return;
      if (ts.isAwaitExpression(node)) foregroundAwait = true;
      ts.forEachChild(node, inspect);
    };
    inspect(handler.body);

    expect(
      handler.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
    ).toBe(false);
    expect(foregroundAwait).toBe(false);
    expect(foreground).toContain(
      "capsuleMessage(capsule, event.prompt, config.retrieval.automaticRecallTokens)",
    );
    expect(foreground).toContain("memorySystemPrompt");
    expect(foreground).not.toContain("createMentisMemorySystemPrompt");
    const supportFilename = fileURLToPath(
      new URL("../../pi-extension-support/src/memory-tools.ts", import.meta.url),
    );
    expect(readFileSync(supportFilename, "utf8")).toContain(
      "unknown, uncertain, historical, indexed, or missing context",
    );
    expect(foreground).not.toMatch(/runtime|zvec|retrieval\.search|embedding|rerank/iu);
  });

  it("does not await sidecar startup in Pi session_start", () => {
    const filename = fileURLToPath(
      new URL("../../pi-context-extension/src/index.ts", import.meta.url),
    );
    const sourceFile = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const handler = eventHandler(sourceFile, filename, "session_start");
    let foregroundAwait = false;
    const inspect = (node: ts.Node): void => {
      if (node !== handler && ts.isFunctionLike(node)) return;
      if (ts.isAwaitExpression(node)) foregroundAwait = true;
      ts.forEachChild(node, inspect);
    };
    inspect(handler.body);

    expect(
      handler.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
    ).toBe(false);
    expect(foregroundAwait).toBe(false);
    expect(handler.body.getText(sourceFile)).toContain("sessionReady = (async () =>");
  });

  it("batches inline tool results and spools large result bodies outside IPC", () => {
    const filename = fileURLToPath(
      new URL("../../pi-context-extension/src/index.ts", import.meta.url),
    );
    const sourceFile = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const handler = eventHandler(sourceFile, filename, "tool_result");
    const foreground = handler.body.getText(sourceFile);

    expect(foreground).toContain("recoverFullToolResult(envelope)");
    expect(foreground).toContain("pendingInlineToolResults.push(recoveredEnvelope)");
    expect(foreground).toContain(
      "createToolResultSpool(config.storage.rootDir, recoveredEnvelope.text)",
    );
    expect(foreground).toContain('"capture.toolResultSpool"');
    expect(foreground).toContain("!currentTurnCanSearchMemory && !isFullRead");
    expect(foreground).not.toContain('"capture.toolResult",');
  });

  it("binds large-read deduplication and replacement to the current context lineage", () => {
    for (const relative of [
      "../../pi-context-extension/src/index.ts",
      "../../pi-memory-extension/src/index.ts",
    ]) {
      const filename = fileURLToPath(new URL(relative, import.meta.url));
      const sourceFile = ts.createSourceFile(
        filename,
        readFileSync(filename, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(eventHandler(sourceFile, filename, "session_tree").body.getText(sourceFile)).toContain(
        "completedLargeReads.clear()",
      );
      expect(
        eventHandler(sourceFile, filename, "session_compact").body.getText(sourceFile),
      ).toContain("completedLargeReads.clear()");
      expect(eventHandler(sourceFile, filename, "tool_result").body.getText(sourceFile)).toContain(
        "!currentTurnCanSearchMemory && !isFullRead",
      );
    }
  });

  it("keeps the standalone Sidecar free of Pi runtime imports", () => {
    const filename = fileURLToPath(
      new URL("../../pi-extension-support/src/index.ts", import.meta.url),
    );
    const sourceFile = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const runtimeImports = sourceFile.statements.filter(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "@earendil-works/pi-coding-agent" &&
        statement.importClause?.isTypeOnly !== true,
    );

    expect(runtimeImports).toHaveLength(0);
  });
});
