import { expect, test } from "vitest";
import { parseSymbols } from "./symbols.js";

test("parseSymbols finds top-level functions, classes, methods, and exported consts with 1-based inclusive ranges", async () => {
  const source = [
    "export function alpha() {",
    "  return 1;",
    "}",
    "",
    "export class Beta {",
    "  gamma() {",
    "    return 2;",
    "  }",
    "}",
    "",
    "export const delta = 3;",
  ].join("\n");
  const symbols = await parseSymbols(source, "ts");
  const byName = (n: string) => symbols.find((s) => s.name === n);
  expect(byName("alpha")).toMatchObject({ kind: "function", startLine: 1, endLine: 3 });
  expect(byName("Beta")).toMatchObject({ kind: "class", startLine: 5, endLine: 9 });
  expect(byName("gamma")).toMatchObject({ kind: "method", startLine: 6, endLine: 8, qualifiedName: "Beta.gamma" });
  expect(byName("delta")).toMatchObject({ kind: "const", startLine: 11, endLine: 11 });
});

test("parseSymbols disambiguates duplicate method names by qualifiedName", async () => {
  const source = ["class A { run() { return 1; } }", "class B { run() { return 2; } }"].join("\n");
  const symbols = await parseSymbols(source, "ts");
  const runs = symbols.filter((s) => s.name === "run");
  expect(runs.map((s) => s.qualifiedName).sort()).toEqual(["A.run", "B.run"]);
});
