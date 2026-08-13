import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function beforeAgentStartHandler(
  sourceFile: ts.SourceFile,
  extensionPath: string,
): ts.ArrowFunction {
  let handler: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "on" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "before_agent_start" &&
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
    throw new Error(`before_agent_start handler was not found in ${extensionPath}`);
  return handler;
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

  it("keeps integrated context persistence out of foreground recall", () => {
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
    const nestedBodies: string[] = [];
    const inspect = (node: ts.Node): void => {
      if (node !== handler && ts.isFunctionLike(node)) {
        nestedBodies.push(node.getText(sourceFile));
        return;
      }
      ts.forEachChild(node, inspect);
    };
    inspect(handler.body);
    const foregroundOnly = nestedBodies.reduce(
      (text, nested) => text.replace(nested, ""),
      foreground,
    );

    for (const blockingContextCall of [
      "projectIdentityCache.getOrResolve",
      ".inferTopic(",
      ".observeTopicLabel(",
      ".resolveTask(",
      ".latestSnapshot(",
      ".persistSnapshot(",
    ]) {
      expect(foregroundOnly).not.toContain(blockingContextCall);
    }
    expect(foreground).toContain("sources: decision.sources");
    expect(foreground).toContain("allowRemoteEmbedding: decision.allowRemoteEmbedding");
    expect(foreground).toContain("AUTO_RECALL_FOREGROUND_BUDGET_MS");
  });
});
