import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function beforeAgentStartHandler(sourceFile: ts.SourceFile): ts.ArrowFunction {
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
  if (handler === undefined) throw new Error("before_agent_start handler was not found");
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
    const handler = beforeAgentStartHandler(sourceFile);
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
});
