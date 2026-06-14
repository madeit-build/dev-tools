import path from "node:path";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { Parser, Language, Query } from "web-tree-sitter";

const require = createRequire(import.meta.url);

test("web-tree-sitter loads the TS grammar and reports symbol line ranges", async () => {
  await Parser.init();
  const parser = new Parser();

  const wasmPath = path.join(
    path.dirname(require.resolve("tree-sitter-wasms/package.json")),
    "out",
    "tree-sitter-typescript.wasm",
  );

  const TS = await Language.load(wasmPath);
  parser.setLanguage(TS);

  const source = [
    "export function alpha() {",
    "  return 1;",
    "}",
    "",
    "class Beta {}",
  ].join("\n");

  const tree = parser.parse(source);
  if (tree === null) throw new Error("parser.parse returned null");

  const query = new Query(
    TS,
    "(function_declaration name: (identifier) @name) (class_declaration name: (type_identifier) @name)",
  );
  const captures = query.captures(tree.rootNode);
  const names = captures.map((c) => c.node.text);

  expect(names).toContain("alpha");
  expect(names).toContain("Beta");

  const alphaCapture = captures.find((c) => c.node.text === "alpha");
  if (alphaCapture === undefined) throw new Error("alpha capture not found");

  const alphaDecl = alphaCapture.node.parent;
  if (alphaDecl === null) throw new Error("alpha parent node not found");

  expect(alphaDecl.startPosition.row + 1).toBe(1);
  expect(alphaDecl.endPosition.row + 1).toBe(3);
});
